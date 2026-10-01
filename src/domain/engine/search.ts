// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Find and replace. (OpenOffice: `SwCursor::Find` and `sw/source/core/crsr/findtxt.cxx`.)
 *
 * The search runs **paragraph by paragraph**. A match can therefore cross a formatting change
 * ("bon**jour**" can still be found, because runs are only a way of cutting up the same
 * string) but never a node boundary, where the text is not contiguous for the reader.
 *
 * Pure module: no React, no DOM.
 */

import { paragraphIndex, paragraphText, replaceParagraph } from '../document/document';
import {
  deleteRangeInRuns,
  formattingAt,
  insertTextInRuns,
  runFormatting,
  runsLength,
  sliceRuns,
} from '../document/runs';
import type {
  DocumentPosition,
  RunFormatting,
  TextRun,
  WriterDocumentState,
} from '../document/types';
import { collapsedSelection, makeSelection } from './cursor';
import type { EditorState } from './edit';

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { matchCase: false, wholeWord: false };

export interface SearchMatch {
  blockId: string;
  start: number;
  end: number;
}

/** Neutralizes special characters: what the user types is text, not a pattern. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegExp(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;

  let pattern = escapeRegExp(query);
  if (options.wholeWord) {
    // `\b` fails on accented letters: "é" is not a word character in the ASCII sense, so "été"
    // would be cut into three. We therefore delimit explicitly with "neither letter nor digit".
    pattern = `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;
  }

  try {
    return new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
  } catch {
    // A pattern that cannot be compiled: we find nothing rather than throw.
    return null;
  }
}

/** All the matches in the document, in reading order. */
export function findMatches(
  doc: WriterDocumentState,
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): SearchMatch[] {
  const regexp = buildRegExp(query, options);
  if (!regexp) return [];

  const matches: SearchMatch[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    const text = paragraphText(paragraph);
    regexp.lastIndex = 0;

    for (;;) {
      const found = regexp.exec(text);
      if (!found) break;
      matches.push({ blockId, start: found.index, end: found.index + found[0].length });
      // An empty match would make `exec` loop in place: we step forward by one.
      if (found[0].length === 0) regexp.lastIndex += 1;
    }
  }

  return matches;
}

/** Document position of the start and the end of a match. */
export function matchRange(match: SearchMatch): { start: DocumentPosition; end: DocumentPosition } {
  return {
    start: { blockId: match.blockId, offset: match.start },
    end: { blockId: match.blockId, offset: match.end },
  };
}

/**
 * Index of the match to treat as current after a move.
 *
 * We start again from the cursor position rather than from a counter: after a keystroke the
 * number of matches may have changed, and a kept index would designate a different match from
 * the one the user is looking at.
 */
export function matchNearest(
  doc: WriterDocumentState,
  matches: readonly SearchMatch[],
  from: DocumentPosition,
): number {
  if (matches.length === 0) return -1;
  const { order } = paragraphIndex(doc);
  const rangDepart = order.indexOf(from.blockId);

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const rang = order.indexOf(match.blockId);
    if (rang > rangDepart || (rang === rangDepart && match.start >= from.offset)) return i;
  }
  // No match after the cursor: the search wraps around to the first one.
  return 0;
}

/**
 * Formatting to give to the replacement text.
 *
 * That of the **first character of the match**, and not that of the position that precedes
 * it: `formattingAt` inherits from the left, which is the right rule for typing but the wrong
 * one here. Replacing a bold word placed right after normal text would have made it lose its
 * bold.
 */
function formattingOfMatch(runs: readonly TextRun[], start: number, end: number): RunFormatting {
  const first = sliceRuns(runs, start, end)[0];
  return first && first.text.length > 0 ? runFormatting(first) : formattingAt(runs, start);
}

/** Selects a match: this is how it is highlighted. */
export function selectMatch(state: EditorState, match: SearchMatch): EditorState {
  const { start, end } = matchRange(match);
  return { ...state, selection: makeSelection(start, end) };
}

/**
 * Replaces one match.
 *
 * The inserted text takes the formatting of the **start** of the match: replacing a bold word
 * with another one leaves it bold, which is what the user expects.
 */
export function replaceMatch(
  state: EditorState,
  match: SearchMatch,
  replacement: string,
): EditorState {
  const paragraph = paragraphIndex(state.doc).byId.get(match.blockId)?.paragraph;
  if (!paragraph) return state;

  const formatting = formattingOfMatch(paragraph.runs, match.start, match.end);
  const vide = deleteRangeInRuns(paragraph.runs, match.start, match.end);
  const runs = replacement
    ? insertTextInRuns(vide, match.start, replacement, formatting)
    : vide;

  return {
    doc: replaceParagraph(state.doc, match.blockId, { ...paragraph, runs }),
    selection: collapsedSelection({
      blockId: match.blockId,
      offset: Math.min(match.start + replacement.length, runsLength(runs)),
    }),
    pendingFormat: null,
  };
}

/**
 * Replaces all the matches, in **one** transformation.
 *
 * The replacement runs from the end to the start of each paragraph: the other way round, each
 * substitution would shift the following matches and their positions would have to be
 * recomputed on every turn.
 */
export function replaceAll(
  state: EditorState,
  query: string,
  options: SearchOptions,
  replacement: string,
): { state: EditorState; count: number } {
  const matches = findMatches(state.doc, query, options);
  if (matches.length === 0) return { state, count: 0 };

  let doc = state.doc;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]!;
    const paragraph = paragraphIndex(doc).byId.get(match.blockId)?.paragraph;
    if (!paragraph) continue;

    const formatting = formattingOfMatch(paragraph.runs, match.start, match.end);
    const vide = deleteRangeInRuns(paragraph.runs, match.start, match.end);
    const runs = replacement
      ? insertTextInRuns(vide, match.start, replacement, formatting)
      : vide;
    doc = replaceParagraph(doc, match.blockId, { ...paragraph, runs });
  }

  return {
    state: { doc, selection: state.selection, pendingFormat: null },
    count: matches.length,
  };
}
