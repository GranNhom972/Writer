// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * List numbering (OpenOffice: `SwNumRule` and `SwNodeNum`,
 * `sw/source/core/doc/number.cxx`, `sw/source/core/SwNumberTree/`).
 *
 * No counter is stored in the document: the number of an item is **recomputed** by
 * walking what precedes it, exactly as Writer rebuilds its numbering tree
 * (`SwNodeNum::GetNumberVector`).
 *
 * It is the only way to be correct: a remembered number would be wrong as soon as an
 * item is inserted, deleted or moved in the middle of the list, and everything after it
 * would have to be renumbered on every keystroke.
 */

import {
  isParagraph,
  isTable,
  MAX_LIST_LEVEL,
  type ListKind,
  type ParagraphNode,
  type WriterDocumentState,
} from './types';

/**
 * Indent per level, in points.
 *
 * `SwNumRule::aDefNumIndents` is 1440/4 twips for the first level and then a quarter of
 * an inch per level: 0.25 inch = 18 pt.
 */
export const LIST_INDENT_PT = 18;

/** Bullets per level, in a cycle: the sequence Writer uses by default. */
const BULLETS = ['•', '◦', '▪', '‣'] as const;

/** What has to be painted in front of a list item. */
export interface ListMarker {
  kind: ListKind;
  level: number;
  /** Text of the marker: "•", "3.", "b)"... Empty for a checkbox. */
  text: string;
  /** State of the box, for a checklist. */
  checked: boolean;
  /** Numeric value of the item, for ordered lists. */
  value: number;
}

/** Is a paragraph part of a list? */
export function isListItem(paragraph: ParagraphNode): boolean {
  return paragraph.listKind !== undefined;
}

/** Effective level, clamped to Writer's maximum depth. */
export function listLevelOf(paragraph: ParagraphNode): number {
  const level = paragraph.listLevel ?? 0;
  return Math.max(0, Math.min(MAX_LIST_LEVEL - 1, Math.floor(level)));
}

/**
 * Total indent of a paragraph's text, numbering included.
 *
 * A list item is shifted by one step per level **in addition** to its own indent: the
 * two add up, as `SvxLRSpaceItem` adds to the indent of the numbering rule.
 */
export function effectiveIndentLeftPt(paragraph: ParagraphNode): number {
  const own = paragraph.indentLeftPt ?? 0;
  if (!isListItem(paragraph)) return own;
  return own + (listLevelOf(paragraph) + 1) * LIST_INDENT_PT;
}

/** Lower-case Roman numerals (`SVX_NUM_ROMAN_LOWER`). */
function toRoman(value: number): string {
  const table: readonly [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let reste = Math.max(1, Math.floor(value));
  let out = '';
  for (const [poids, signe] of table) {
    while (reste >= poids) {
      out += signe;
      reste -= poids;
    }
  }
  return out;
}

/** Alphabetic numbering (`SVX_NUM_CHARS_LOWER_LETTER`): a…z, aa…az, ba… */
function toLetters(value: number): string {
  let reste = Math.max(1, Math.floor(value));
  let out = '';
  while (reste > 0) {
    reste -= 1;
    out = String.fromCharCode(97 + (reste % 26)) + out;
    reste = Math.floor(reste / 26);
  }
  return out;
}

/**
 * Shape of the number depending on the level.
 *
 * Writer alternates formats by level so that a nested list stays readable: "1.", then
 * "a)", then "i.". Three formats are enough, and the cycle starts again beyond that.
 */
export function formatOrdered(level: number, value: number): string {
  switch (level % 3) {
    case 0:
      return `${value}.`;
    case 1:
      return `${toLetters(value)})`;
    default:
      return `${toRoman(value)}.`;
  }
}

export function bulletFor(level: number): string {
  return BULLETS[level % BULLETS.length]!;
}

/**
 * Computes the marker of every list item in the document.
 *
 * A single pass, in reading order. Counters are kept per level: going into a deeper
 * level does not touch the counter of the level above, and coming back out resets
 * everything below it to zero. This is the behavior of a `SwNumberTree`.
 */
export function computeListMarkers(doc: WriterDocumentState): Map<string, ListMarker> {
  const markers = new Map<string, ListMarker>();
  const counters: number[] = new Array(MAX_LIST_LEVEL).fill(0);
  let currentListId: string | null = null;

  const visit = (paragraph: ParagraphNode): void => {
    const kind = paragraph.listKind;

    if (kind === undefined) {
      // Leaving a list closes its counters: the normal text that follows separates two
      // distinct lists.
      currentListId = null;
      counters.fill(0);
      return;
    }

    const listId = paragraph.listId ?? '';
    if (listId !== currentListId) {
      currentListId = listId;
      counters.fill(0);
    }

    const level = listLevelOf(paragraph);
    // Going back up one level cancels the numbering of the deeper levels.
    for (let deeper = level + 1; deeper < counters.length; deeper += 1) counters[deeper] = 0;

    if (paragraph.listRestart) {
      counters[level] = Math.max(1, paragraph.listStartValue ?? 1);
    } else {
      counters[level] = (counters[level] ?? 0) + 1;
    }

    const value = counters[level]!;
    markers.set(paragraph.id, {
      kind,
      level,
      text: kind === 'ordered' ? formatOrdered(level, value) : kind === 'bullet' ? bulletFor(level) : '',
      checked: paragraph.listChecked === true,
      value,
    });
  };

  for (const block of doc.blocks) {
    // A table of contents has no numbering of its own: its lines are generated at
    // pagination time and therefore do not enter the list counter.
    if (isParagraph(block)) {
      visit(block);
      continue;
    }
    if (!isTable(block)) continue;
    // Each cell is a separate container: a list in it does not continue the one of the
    // document body, and two cells do not share a counter.
    for (const row of block.rows) {
      for (const cell of row.cells) {
        currentListId = null;
        counters.fill(0);
        for (const inner of cell.blocks) visit(inner);
      }
    }
    currentListId = null;
    counters.fill(0);
  }

  return markers;
}
