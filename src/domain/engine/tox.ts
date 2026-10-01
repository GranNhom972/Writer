// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Table of contents: generation. (OpenOffice: `SwDoc::UpdateTOX`, `sw/source/core/tox/tox.cxx`,
 * and the `SwForm` line model, `sw/inc/tox.hxx`, tokens `TOKEN_ENTRY_TEXT`, `TOKEN_TAB_STOP`,
 * `TOKEN_PAGE_NUMS`.)
 *
 * A line of a Writer table of contents reads as a sequence of tokens:
 *
 *     [chapter number] [entry text] [dotted tab] [page]
 *
 * The tab is a **right-aligned tab stop with a fill character** (`SvxTabStop` of type
 * `SVX_TAB_ADJUST_RIGHT`, fill char `.`). Writer's text formatter resolves this tab stop at
 * layout time, when the remaining width is finally known.
 *
 * We do the same thing, at the same moment: generation receives the text measurer and builds
 * the fill character by character. This is why this module lives in `engine/` and not in
 * `document/`: it needs a column width and a font, two things layer 1 knows nothing about.
 *
 * ## Why two pagination passes
 *
 * The page number of a heading is only known once the document has been paginated, and the
 * document can only be paginated once the table of contents is written. Writer settles this by
 * regenerating and then laying out again (`UpdateTOX` followed by `SwLayAction`).
 *
 * Here the loop converges in exactly two passes, by construction: the **number of lines** of
 * the table of contents does not depend on the displayed numbers, since an entry takes one line
 * whether its page is 3 or 137. The geometry is therefore identical between the two passes and
 * only the digits change. That is what allows `paginateDocument` to stop after the second one
 * without a convergence test.
 */

import { ptToPx } from '../document/units';
import { createParagraph } from '../document/document';
import { tocEntries, tocLineId, tocTitleId } from '../document/tox';
import { makeRun } from '../document/runs';
import type {
  HeadingLevel,
  ParagraphNode,
  TocNode,
  WriterDocumentState,
} from '../document/types';
import { resolveFont } from './style';
import type { TextMeasurer } from './measure';
import type { LayoutContext } from './lineBreak';

/** Indent per heading level, in points. `SwForm` uses 0.5 cm per step. */
const TOC_LEVEL_INDENT_PT = 14;

/** Fill character of the tab stop, the one from `SwForm::SetPattern`. */
const LEADER_CHAR = '.';

/** Space kept between the text and the dots, and between the dots and the number. */
const LEADER_GAP_PT = 4;

export interface TocExpansion {
  /** Generated paragraphs, title of the table of contents included. */
  paragraphs: ParagraphNode[];
  /** Line → id of the heading it points to, to make the entry clickable. */
  targets: Map<string, string>;
}

/**
 * Expands a table-of-contents block into concrete paragraphs.
 *
 * `pageNumbers` maps the id of a heading to its **1-indexed** page. An entry that is missing
 * from the table is rendered without a number: that is the case of the first pass, where
 * pagination has not happened yet.
 */
export function expandToc(
  doc: WriterDocumentState,
  toc: TocNode,
  pageNumbers: ReadonlyMap<string, number>,
  ctx: LayoutContext,
): TocExpansion {
  const entries = tocEntries(doc, toc);
  const paragraphs: ParagraphNode[] = [];
  const targets = new Map<string, string>();

  if (toc.title.trim()) {
    paragraphs.push(
      createParagraph(toc.title, {
        id: tocTitleId(toc.id),
        headingLevel: 1,
      }),
    );
  }

  entries.forEach((entry, index) => {
    const id = tocLineId(toc.id, index);
    const indentPt = (entry.level - 1) * TOC_LEVEL_INDENT_PT;
    const pageNumber = pageNumbers.get(entry.blockId);

    const paragraph: ParagraphNode = {
      id,
      type: 'paragraph',
      runs: buildEntryRuns(entry.text, entry.level, pageNumber, toc, ctx, indentPt),
      marginTopPt: 0,
      marginBottomPt: 0,
    };
    if (indentPt > 0) paragraph.indentLeftPt = indentPt;

    paragraphs.push(paragraph);
    targets.set(id, entry.blockId);
  });

  // A table of contents with no heading at all stays visible, with an explanatory line: an
  // empty, silent table would make people think something is broken.
  if (entries.length === 0) {
    const id = tocLineId(toc.id, 0);
    paragraphs.push({
      id,
      type: 'paragraph',
      runs: [makeRun('(Aucun titre — appliquez un style Titre 1 à 6 pour peupler la table.)', { italic: true })],
      marginTopPt: 0,
      marginBottomPt: 0,
    });
  }

  return { paragraphs, targets };
}

/**
 * Builds the runs of a line: text, dot leader, page number.
 *
 * The fill is computed character by character rather than set in CSS: it is the only way to
 * get the same result on screen, in print and in the binary PDF, which share no rendering
 * engine.
 */
function buildEntryRuns(
  text: string,
  level: HeadingLevel,
  pageNumber: number | undefined,
  toc: TocNode,
  ctx: LayoutContext,
  indentPt: number,
): ReturnType<typeof makeRun>[] {
  const label = makeRun(text);

  if (!toc.showPageNumbers || pageNumber === undefined) {
    return [label];
  }

  const numberText = String(pageNumber);
  const numberRun = makeRun(numberText);

  if (!toc.useDotLeader) {
    return [label, makeRun('\t'), numberRun];
  }

  const font = resolveFont({}, { type: 'paragraph' }, { defaults: ctx.defaults });
  const available =
    ctx.contentWidthPx -
    ptToPx(indentPt) -
    ctx.measurer.measure(text, font) -
    ctx.measurer.measure(numberText, font) -
    ptToPx(LEADER_GAP_PT) * 2;

  const dots = leaderDots(available, font, ctx.measurer);

  // No room for even one dot: the line makes do with a space. Without this guard, a heading wider
  // than the column would produce a negative fill, so an empty string that glues the number to
  // the text.
  if (dots.length === 0) return [label, makeRun(' '), numberRun];

  void level;
  return [label, makeRun(` ${dots} `, { color: '#888888' }), numberRun];
}

/** Number of fill dots that fit in `availablePx`. */
function leaderDots(
  availablePx: number,
  font: { fontFamily: string; fontSizePx: number; bold: boolean; italic: boolean },
  measurer: TextMeasurer,
): string {
  if (availablePx <= 0) return '';
  const dotWidth = measurer.measure(LEADER_CHAR, font);
  if (!Number.isFinite(dotWidth) || dotWidth <= 0) return '';
  const count = Math.floor(availablePx / dotWidth);
  return count > 0 ? LEADER_CHAR.repeat(Math.min(count, 400)) : '';
}
