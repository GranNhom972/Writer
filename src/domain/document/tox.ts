// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Table of contents: the model. (OpenOffice: `SwTOXBase` / `SwTOXMark`,
 * `sw/source/core/tox/tox.cxx`, `sw/inc/tox.hxx`.)
 *
 * Writer never stores the *entries* of a table of contents: `SwTOXBase` only keeps its
 * **definition** (which heading levels to include, with or without page numbers), and
 * `SwDoc::UpdateTOX` regenerates the content on demand. We transpose that choice, for the
 * same reason: frozen entries would drift out of sync with the body of the document at the
 * first keystroke, and a wrong table of contents is worse than none.
 *
 * This module holds the part that is **independent of the layout**: which headings enter
 * the table, in what order, at what level. Page numbers are not here: they only exist once
 * pagination is done, and `engine/tox.ts` resolves them.
 *
 * Pure module: no React import, no DOM access.
 */

import { newId } from './document';
import { headingAnchorName } from './bookmarks';
import { isParagraph, type HeadingLevel, type TocNode, type WriterDocumentState } from './types';

/** Default title, that of Writer's "Contents Heading" style. */
export const DEFAULT_TOC_TITLE = 'Table des matières';

/** Default depth: `SwTOXBase` keeps levels 1 to 3. */
export const DEFAULT_TOC_MAX_LEVEL: HeadingLevel = 3;

export interface TocOptions {
  id?: string;
  title?: string;
  maxLevel?: HeadingLevel;
  showPageNumbers?: boolean;
  useDotLeader?: boolean;
}

/** Creates a table-of-contents block (a `SwTOXBase` of type `TOX_CONTENT`). */
export function createToc(options: TocOptions = {}): TocNode {
  return {
    id: options.id ?? newId('toc'),
    type: 'toc',
    title: options.title ?? DEFAULT_TOC_TITLE,
    maxLevel: options.maxLevel ?? DEFAULT_TOC_MAX_LEVEL,
    showPageNumbers: options.showPageNumbers ?? true,
    useDotLeader: options.useDotLeader ?? true,
  };
}

/** One line of the table of contents, before the page number is resolved. */
export interface TocEntry {
  /** Heading paragraph the entry is derived from. */
  blockId: string;
  /** Heading level, from 1 to `maxLevel`. */
  level: HeadingLevel;
  /** Text of the heading, with whitespace normalized. */
  text: string;
  /** Cross-reference anchor (`__RefHeading__…`), to make the entry clickable. */
  anchorName: string;
}

/**
 * Collects the entries of the table of contents.
 *
 * Only the headings of the **main flow** are kept: a heading placed in a table cell does not
 * enter Writer's table of contents either, since its position means nothing in a document
 * hierarchy.
 *
 * An empty heading is ignored: it would take up a line of the table pointing at nothing
 * readable.
 */
export function tocEntries(doc: WriterDocumentState, toc: TocNode): TocEntry[] {
  const out: TocEntry[] = [];

  for (const block of doc.blocks) {
    if (!isParagraph(block) || block.type !== 'heading') continue;

    const level = block.headingLevel ?? 1;
    if (level > toc.maxLevel) continue;

    const text = headingText(block.runs);
    if (!text) continue;

    out.push({
      blockId: block.id,
      level,
      text,
      anchorName: headingAnchorName(block.id),
    });
  }

  return out;
}

/**
 * Printable text of a heading.
 *
 * Runs carrying an object (image, formula) bring a replacement character U+FFFC that has no
 * business in a table of contents: it is removed, as `SwTOXPara::GetText` ignores non-text
 * portions.
 */
function headingText(runs: readonly { text: string; imageSrc?: string; mathLatex?: string }[]): string {
  let out = '';
  for (const run of runs) {
    if (run.imageSrc !== undefined || run.mathLatex !== undefined) continue;
    out += run.text;
  }
  return out.replace(/￼/g, '').replace(/\s+/g, ' ').trim();
}

/** All the table-of-contents blocks of the document, in order. */
export function tocNodes(doc: WriterDocumentState): TocNode[] {
  return doc.blocks.filter((block): block is TocNode => block.type === 'toc');
}

/** Does the document contain at least one table of contents? */
export function hasToc(doc: WriterDocumentState): boolean {
  return doc.blocks.some((block) => block.type === 'toc');
}

/** Changes the definition of a table of contents (`SwTOXBase::SetLevel`, `SetCreate`). */
export function updateToc(
  doc: WriterDocumentState,
  tocId: string,
  patch: Partial<Omit<TocNode, 'id' | 'type'>>,
): WriterDocumentState {
  let changed = false;
  const blocks = doc.blocks.map((block) => {
    if (block.type !== 'toc' || block.id !== tocId) return block;
    changed = true;
    return { ...block, ...patch };
  });
  return changed ? { ...doc, blocks } : doc;
}

/**
 * Id of the paragraph generated for a line of the table of contents.
 *
 * Derived and not drawn at random: pagination runs on every keystroke, and a new id on each
 * pass would make every line of the table re-render although none of them had changed.
 */
export function tocLineId(tocId: string, index: number): string {
  return `${tocId}__line${index}`;
}

/** Id of the paragraph that carries the title of the table of contents. */
export function tocTitleId(tocId: string): string {
  return `${tocId}__title`;
}

/** Is this paragraph a line generated by a table of contents? */
export function isGeneratedTocParagraph(blockId: string): boolean {
  return blockId.includes('__line') || blockId.endsWith('__title');
}
