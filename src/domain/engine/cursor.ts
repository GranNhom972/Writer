// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Cursor, selection and navigation. (OpenOffice: `SwPaM` / `SwCursor`,
 * `sw/source/core/crsr/pam.cxx`, `swcrsr.cxx`.)
 *
 * `SwPaM` holds two positions: the **Mark** (the anchor, set at the start of the
 * gesture) and the **Point** (the head, the one the arrow keys move). A selection can
 * therefore be "backwards", with the Point before the Mark; editing operations work on
 * the normalized form (`SwPaM::Normalize`) and the display on the raw form. That is what
 * makes shrinking a selection upwards and then downwards come back to exactly the same
 * state.
 */

import { paragraphIndex, paragraphText } from '../document/document';
import { clamp } from '../document/runs';
import type {
  DocumentPosition,
  DocumentSelection,
  WriterDocumentState,
} from '../document/types';
import { graphemeBoundaries, graphemes, type TextMeasurer } from './measure';
import { isBlank, type LayoutLine, type ParagraphLayout } from './lineBreak';
import type { DocumentLayout, PlacedParagraph, PlacedTable } from './paginate';

export function makePosition(blockId: string, offset: number): DocumentPosition {
  return { blockId, offset };
}

export function collapsedSelection(position: DocumentPosition): DocumentSelection {
  return { anchor: position, focus: position, isCollapsed: true, desiredX: null };
}

export function makeSelection(
  anchor: DocumentPosition,
  focus: DocumentPosition,
  desiredX: number | null = null,
): DocumentSelection {
  return {
    anchor,
    focus,
    isCollapsed: samePosition(anchor, focus),
    desiredX,
  };
}

export function samePosition(a: DocumentPosition, b: DocumentPosition): boolean {
  return a.blockId === b.blockId && a.offset === b.offset;
}

/**
 * Document order of two positions (`SwPosition::operator<`).
 *
 * Writer compares the node index first and then the content index; the rank of the
 * paragraph in the flat index plays the role of the node index here.
 */
export function comparePositions(
  doc: WriterDocumentState,
  a: DocumentPosition,
  b: DocumentPosition,
): number {
  if (a.blockId === b.blockId) return a.offset - b.offset;
  const { order } = paragraphIndex(doc);
  const rankA = order.indexOf(a.blockId);
  const rankB = order.indexOf(b.blockId);
  if (rankA === -1 || rankB === -1) return 0;
  return rankA - rankB;
}

/** Selection put the right way round: start before end (`SwPaM::Normalize`). */
export function normalizeSelection(
  doc: WriterDocumentState,
  selection: DocumentSelection,
): { start: DocumentPosition; end: DocumentPosition } {
  return comparePositions(doc, selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

/** Clamps a position within the real limits of its paragraph. */
export function clampPosition(
  doc: WriterDocumentState,
  position: DocumentPosition,
): DocumentPosition {
  const { byId, order } = paragraphIndex(doc);
  const found = byId.get(position.blockId);
  if (!found) {
    const fallbackId = order[0];
    if (!fallbackId) return position;
    return { blockId: fallbackId, offset: 0 };
  }
  const length = paragraphText(found.paragraph).length;
  return { blockId: position.blockId, offset: clamp(position.offset, 0, length) };
}

/* ------------------------------------------------------ text navigation */

export type HorizontalGranularity = 'character' | 'word';
export type Direction = -1 | 1;

/**
 * Moves by one **grapheme cluster**, not by one code unit.
 *
 * `SwIndex` advances by one `sal_Unicode`, which was enough for the UCS-2 of the time. In
 * modern UTF-16, advancing by one unit would cut an emoji in two and make it invalid, so
 * we advance by cluster, as the `XBreakIterator` of `SwCursor::GoNextCell` does.
 */
export function stepGrapheme(text: string, offset: number, direction: Direction): number {
  const bounds = graphemeBoundaries(text);
  const at = clamp(offset, 0, text.length);

  if (direction > 0) {
    for (const bound of bounds) if (bound > at) return bound;
    return text.length;
  }
  for (let i = bounds.length - 1; i >= 0; i -= 1) {
    const bound = bounds[i]!;
    if (bound < at) return bound;
  }
  return 0;
}

/** Does a position fall on a cluster boundary? */
export function isGraphemeBoundary(text: string, offset: number): boolean {
  return graphemeBoundaries(text).includes(clamp(offset, 0, text.length));
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

/**
 * Start of the next / previous word (`SwCursor::GoNextWord`, `GoPrevWord`).
 *
 * Going right: cross the current word and then the blanks, to land at the **start** of the
 * next word. Going left: cross the blanks and then the word, to land at the start of the
 * current word. It is asymmetric on purpose: it is the behavior expected from `Ctrl+→` /
 * `Ctrl+←`.
 */
export function stepWord(text: string, offset: number, direction: Direction): number {
  let position = clamp(offset, 0, text.length);

  if (direction > 0) {
    while (position < text.length && isWordChar(text[position]!)) {
      position = stepGrapheme(text, position, 1);
    }
    while (position < text.length && !isWordChar(text[position]!)) {
      position = stepGrapheme(text, position, 1);
    }
    return position;
  }

  while (position > 0 && !isWordChar(text[position - 1]!)) {
    position = stepGrapheme(text, position, -1);
  }
  while (position > 0 && isWordChar(text[position - 1]!)) {
    position = stepGrapheme(text, position, -1);
  }
  return position;
}

/** Bounds of the word under the cursor, for a double click. */
export function wordRangeAt(text: string, offset: number): { start: number; end: number } {
  const at = clamp(offset, 0, text.length);
  if (text.length === 0) return { start: 0, end: 0 };

  // On a blank, select the run of blanks: this is what Writer does, and it keeps a double
  // click between two words from grabbing nothing.
  const probe = text[at] ?? text[at - 1] ?? '';
  const inWord = isWordChar(probe);

  let start = at;
  while (start > 0 && isWordChar(text[start - 1]!) === inWord && (text[start - 1] !== '\n')) {
    start = stepGrapheme(text, start, -1);
  }
  let end = at;
  while (end < text.length && isWordChar(text[end]!) === inWord && text[end] !== '\n') {
    end = stepGrapheme(text, end, 1);
  }
  return { start, end };
}

/**
 * Horizontal move, crossing paragraph boundaries included.
 *
 * Going from one paragraph to the next costs **one** step: the boundary between two text
 * nodes is a position in its own right, exactly as in `SwNodes` where `nContent == 0` of
 * the next node is distinct from `nContent == Len()` of the previous one.
 */
export function moveHorizontal(
  doc: WriterDocumentState,
  position: DocumentPosition,
  direction: Direction,
  granularity: HorizontalGranularity = 'character',
): DocumentPosition {
  const { order, byId } = paragraphIndex(doc);
  const found = byId.get(position.blockId);
  if (!found) return position;

  const text = paragraphText(found.paragraph);
  const offset = clamp(position.offset, 0, text.length);

  if (direction > 0 && offset >= text.length) {
    const at = order.indexOf(position.blockId);
    const nextId = at >= 0 ? order[at + 1] : undefined;
    return nextId ? { blockId: nextId, offset: 0 } : position;
  }
  if (direction < 0 && offset <= 0) {
    const at = order.indexOf(position.blockId);
    const previousId = at > 0 ? order[at - 1] : undefined;
    if (!previousId) return position;
    const previous = byId.get(previousId)!;
    return { blockId: previousId, offset: paragraphText(previous.paragraph).length };
  }

  // Atomic crossing of math formulas (SwpHints / non-breakable objects)
  let runStart = 0;
  for (const run of found.paragraph.runs) {
    const runEnd = runStart + run.text.length;
    if (run.mathLatex) {
      if (direction < 0) {
        if (offset > runStart && offset <= runEnd) {
          return { blockId: position.blockId, offset: runStart };
        }
      } else {
        if (offset >= runStart && offset < runEnd) {
          return { blockId: position.blockId, offset: runEnd };
        }
      }
    }
    runStart = runEnd;
  }

  const next =
    granularity === 'word'
      ? stepWord(text, offset, direction)
      : stepGrapheme(text, offset, direction);
  return { blockId: position.blockId, offset: next };
}

/* --------------------------------------------------------- visual geometry */

/** The line of a paragraph that contains the given offset. */
export function lineIndexAt(layout: ParagraphLayout, offset: number): number {
  const lines = layout.lines;
  if (lines.length === 0) return 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (offset >= lines[i]!.startOffset) return i;
  }
  return 0;
}

/**
 * Width that is **actually painted** for the line, justification included.
 *
 * `widthPx` is the width of the segments as they were measured, so that of the line
 * *before* justification. A justified line is then stretched: `wordSpacingPx` is added to
 * each of its blanks, and the rendering hands that to `word-spacing` (see `ParagraphView`).
 * Its end is therefore further right than `widthPx` says, by the whole stretch, up to the
 * width of the column.
 *
 * Mixing the two left the **tail of every justified line** outside the rectangle: on
 * `Ctrl+A`, the last word of the line stayed white in the middle of a highlighted
 * paragraph. The same gap put the `End` cursor before that word, and made a click that
 * landed on it jump to the end of the line.
 *
 * The rest of this module already counts the blanks the same way to place an offset in a
 * justified line (`caretXOnLine`, `offsetFromX`): this function applies the same rule to
 * the right edge, rather than adding to the model a second width that would end up
 * diverging from the first.
 */
function paintedLineWidth(line: LayoutLine): number {
  if (line.wordSpacingPx <= 0) return line.widthPx;
  let blanks = 0;
  for (const segment of line.segments) {
    blanks += countBlanksIn(segment.text, 0, segment.text.length);
  }
  return line.widthPx + blanks * line.wordSpacingPx;
}

/** X coordinate of the cursor on its line, relative to the left edge of the content. */
export function caretXOnLine(
  line: LayoutLine,
  offset: number,
  measurer: TextMeasurer,
): number {
  // Beyond the painted content (trailing spaces swallowed), the cursor sits at the right
  // edge: those spaces overflow into the margin and no longer advance.
  if (offset >= line.endOffset) return line.leftPx + paintedLineWidth(line);
  if (offset <= line.startOffset) return line.leftPx;

  for (const segment of line.segments) {
    if (offset >= segment.endOffset) continue;
    if (offset <= segment.startOffset) return segment.leftPx;
    if (segment.isTab) return segment.leftPx;
    if (segment.formatting.mathLatex) {
      return offset <= segment.startOffset ? segment.leftPx : segment.leftPx + segment.widthPx;
    }

    const inner = offset - segment.startOffset;
    const prefix = measurer.prefixWidths(segment.text, segment.font);
    const blanks = countBlanksIn(segment.text, 0, inner);
    return segment.leftPx + (prefix[inner] ?? 0) + blanks * line.wordSpacingPx;
  }

  return line.leftPx + paintedLineWidth(line);
}

function countBlanksIn(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to && i < text.length; i += 1) if (isBlank(text[i]!)) count += 1;
  return count;
}

export interface CaretGeometry {
  pageIndex: number;
  /** Coordinates relative to the content area of the page. */
  xPx: number;
  topPx: number;
  heightPx: number;
  lineIndex: number;
}

/**
 * Where to paint the cursor.
 *
 * Returns `null` when the position matches nothing that has been laid out. That is the case
 * of a stale layout from one render to the next; the caller then refrains from painting
 * rather than show a cursor in the wrong place.
 */
export function caretGeometry(
  layout: DocumentLayout,
  position: DocumentPosition,
  measurer: TextMeasurer,
): CaretGeometry | null {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  const placements = layout.placements.get(position.blockId);
  if (!paragraphLayout || !placements || placements.length === 0) return null;

  const lineIndex = lineIndexAt(paragraphLayout, position.offset);
  const entry =
    placements.find(({ placed }) => lineIndex >= placed.fromLine && lineIndex < placed.toLine) ??
    placements[placements.length - 1]!;

  const line = paragraphLayout.lines[lineIndex];
  if (!line) return null;

  let caretHeight = line.heightPx;
  let caretTopOffset = 0;

  // If the line contains a formula but the cursor is in ordinary text, fit the cursor height
  // to the text font and align it on the baseline.
  let activeSegment = line.segments.find(
    (s) => position.offset >= s.startOffset && position.offset <= s.endOffset,
  );
  if (!activeSegment && line.segments.length > 0) {
    activeSegment = line.segments[line.segments.length - 1];
  }

  if (activeSegment && !activeSegment.formatting.mathLatex) {
    const textCaretHeight = activeSegment.font.fontSizePx * 1.2;
    if (textCaretHeight < line.heightPx) {
      caretHeight = textCaretHeight;
      caretTopOffset = Math.max(0, line.ascentPx - activeSegment.font.fontSizePx * 0.95);
    }
  }

  return {
    pageIndex: entry.pageIndex,
    xPx: entry.placed.leftPx + caretXOnLine(line, position.offset, measurer),
    topPx: paragraphTop(entry.placed) + lineTopWithin(paragraphLayout, entry.placed, lineIndex) + caretTopOffset,
    heightPx: caretHeight,
    lineIndex,
  };
}

function paragraphTop(placed: PlacedParagraph): number {
  return placed.topPx + (placed.isContinuation ? 0 : placed.layout.marginTopPx);
}

/** Y coordinate of a line within the piece of paragraph placed on this page. */
function lineTopWithin(
  layout: ParagraphLayout,
  placed: PlacedParagraph,
  lineIndex: number,
): number {
  let top = 0;
  for (let i = placed.fromLine; i < lineIndex; i += 1) top += layout.lines[i]?.heightPx ?? 0;
  return top;
}

/**
 * Document position matching a point on the page: the mouse click.
 *
 * Looks for the line whose vertical band contains `y`, or failing that the closest one:
 * clicking in the bottom margin of a page must put the cursor at the end of the text, not
 * fail.
 */
export function positionFromPoint(
  layout: DocumentLayout,
  pageIndex: number,
  xPx: number,
  yPx: number,
  measurer: TextMeasurer,
): DocumentPosition | null {
  // A cell is a **box**, not a neighborhood of text.
  //
  // The search below takes the closest line, all cells together. But the text of a cell is
  // short and left-aligned: clicking in the right half of a wide cell put the cursor closer
  // to the line of the **next** cell than to its own, and the cursor jumped to another box.
  // So when the point falls in a cell, we only consider the paragraphs of that cell: its box
  // is the authority.
  const cellIds = paragraphsOfCellAt(layout, pageIndex, xPx, yPx);

  let best: { distance: number; position: DocumentPosition } | null = null;

  for (const [blockId, entries] of layout.placements) {
    if (cellIds && !cellIds.has(blockId)) continue;
    for (const entry of entries) {
      if (entry.pageIndex !== pageIndex) continue;
      const placed = entry.placed;
      const paragraphLayout = placed.layout;
      let top = paragraphTop(placed);

      for (let i = placed.fromLine; i < placed.toLine; i += 1) {
        const line = paragraphLayout.lines[i];
        if (!line) continue;
        const bottom = top + line.heightPx;
        // Vertical distance to the line's strip: zero if the point falls inside it.
        const vertical = yPx < top ? top - yPx : yPx > bottom ? yPx - bottom : 0;
        // On a vertical tie we decide horizontally; otherwise, on a page with two cells side by
        // side, the click would always go to the first one.
        const localX = xPx - placed.leftPx;
        const lineRight = line.leftPx + paintedLineWidth(line);
        const horizontal =
          localX < line.leftPx
            ? line.leftPx - localX
            : localX > lineRight
              ? localX - lineRight
              : 0;
        const distance = vertical * 1000 + horizontal;

        if (!best || distance < best.distance) {
          best = {
            distance,
            position: {
              blockId: placed.blockId,
              offset: offsetFromX(line, localX, measurer),
            },
          };
        }
        top = bottom;
      }
    }
  }

  return best?.position ?? null;
}

/**
 * Ids of the paragraphs of the cell that contains the point, or `null`.
 *
 * `null` (the point is in no cell) lets the search sweep the whole page, which is still the
 * right behavior for the text flow and for a click in the margin.
 */
function paragraphsOfCellAt(
  layout: DocumentLayout,
  pageIndex: number,
  xPx: number,
  yPx: number,
): Set<string> | null {
  const page = layout.pages[pageIndex];
  if (!page) return null;

  for (const block of page.blocks) {
    if (block.kind !== 'table') continue;
    const table = block as PlacedTable;

    for (const row of table.rows) {
      const top = table.topPx + row.topPx;
      if (yPx < top || yPx > top + row.heightPx) continue;

      for (const cell of row.cells) {
        // A covered cell has neither area nor cursor: it is its master that covers the point, and
        // it has already gone through this loop.
        if (cell.covered || cell.widthPx <= 0) continue;
        if (xPx < cell.leftPx || xPx > cell.leftPx + cell.widthPx) continue;

        const ids = new Set(cell.paragraphs.map((paragraph) => paragraph.id));
        // A cell with no paragraph can take nothing: better to hand back to the general search than
        // to block the click.
        return ids.size > 0 ? ids : null;
      }
    }
  }

  return null;
}

/** Offset closest to the x coordinate `xPx` on a given line. */
export function offsetFromX(
  line: LayoutLine,
  xPx: number,
  measurer: TextMeasurer,
): number {
  if (xPx <= line.leftPx) return line.startOffset;
  // The painted right edge; otherwise a click on the last word of a justified line, which
  // falls beyond the measured width, would jump to the end of the line instead of landing in
  // the word.
  if (xPx >= line.leftPx + paintedLineWidth(line)) return line.endOffset;

  for (const segment of line.segments) {
    const right = segment.leftPx + segment.widthPx;
    if (xPx > right) continue;

    if (segment.isTab || segment.formatting.mathLatex) {
      // A tab or a formula is indivisible: we go to the nearest side.
      return xPx - segment.leftPx < segment.widthPx / 2
        ? segment.startOffset
        : segment.endOffset;
    }

    const prefix = measurer.prefixWidths(segment.text, segment.font);
    const local = xPx - segment.leftPx;
    let bestOffset = segment.startOffset;
    let bestDistance = Number.POSITIVE_INFINITY;
    let consumed = 0;

    // We test both edges of each cluster and keep the nearest one: the cursor therefore always
    // lands **between** two graphemes, never inside one.
    for (const grapheme of graphemes(segment.text)) {
      for (const candidate of [consumed, consumed + grapheme.length]) {
        const width = (prefix[candidate] ?? 0) +
          countBlanksIn(segment.text, 0, candidate) * line.wordSpacingPx;
        const distance = Math.abs(local - width);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestOffset = segment.startOffset + candidate;
        }
      }
      consumed += grapheme.length;
    }
    return bestOffset;
  }

  return line.endOffset;
}

/**
 * Vertical move by one line. `desiredX` remembers the original x coordinate so that several
 * successive `↓` presses do not drift to the left while crossing short lines
 * (`SwCrsrShell` keeps the same x coordinate).
 */
export function moveVertical(
  layout: DocumentLayout,
  position: DocumentPosition,
  direction: Direction,
  desiredX: number | null,
  measurer: TextMeasurer,
): { position: DocumentPosition; desiredX: number } | null {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  if (!paragraphLayout) return null;

  const lineIndex = lineIndexAt(paragraphLayout, position.offset);
  const currentLine = paragraphLayout.lines[lineIndex];
  if (!currentLine) return null;

  const here = lineBox(layout, position.blockId, lineIndex);
  if (!here) return null;

  /*
   * `targetX` is a **page** x coordinate, not a paragraph one.
   *
   * The paragraph's frame of reference was enough as long as the neighbor was deduced from
   * the document order. It is no longer enough once the neighbor is found by geometry: two
   * cells of the same row have the same relative x coordinate and only differ by the origin
   * of their box. Measuring in page coordinates also fixes, in the same stroke, the cursor
   * drifting between two paragraphs with different indents.
   */
  const targetX = desiredX ?? here.leftPx + caretXOnLine(currentLine, position.offset, measurer);
  const targetLineIndex = lineIndex + direction;

  if (targetLineIndex >= 0 && targetLineIndex < paragraphLayout.lines.length) {
    const line = paragraphLayout.lines[targetLineIndex]!;
    return {
      position: {
        blockId: position.blockId,
        offset: offsetFromX(line, targetX - here.leftPx, measurer),
      },
      desiredX: targetX,
    };
  }

  // Leaving the paragraph: we look for the neighboring line **by geometry**.
  //
  // The document order does not work. `paragraphIndex` flattens the cells in reading order,
  // so the "next" paragraph of a cell is the one in the cell **to its right**: `Down` moved
  // the cursor sideways in a table, and `Up` brought it back to the left. It is geometry, and
  // only geometry, that tells what lies under the cursor.
  const found = nearestLineVertically(layout, here, direction, targetX, position.blockId);
  if (!found) return null;

  return {
    position: { blockId: found.blockId, offset: offsetFromX(found.line, targetX - found.leftPx, measurer) },
    desiredX: targetX,
  };
}

/** Where a line sits on its page: vertical strip and horizontal origin. */
function lineBox(
  layout: DocumentLayout,
  blockId: string,
  lineIndex: number,
): { pageIndex: number; top: number; bottom: number; leftPx: number } | null {
  for (const entry of layout.placements.get(blockId) ?? []) {
    const placed = entry.placed;
    if (lineIndex < placed.fromLine || lineIndex >= placed.toLine) continue;
    const top = paragraphTop(placed) + lineTopWithin(placed.layout, placed, lineIndex);
    return {
      pageIndex: entry.pageIndex,
      top,
      bottom: top + (placed.layout.lines[lineIndex]?.heightPx ?? 0),
      leftPx: placed.leftPx,
    };
  }
  return null;
}

/**
 * Closest line vertically, in the requested direction.
 *
 * We first keep the closest **strip** (the smallest `top` below the current line, or the
 * largest `bottom` above it) and then, inside that strip, the line closest horizontally.
 * It is this second tie-break that makes the cursor fall in the right column of a table:
 * the cells of one row share the same strip, and only the x coordinate tells them apart.
 *
 * The search spills over to the neighboring page when the current page offers nothing, so
 * that `Down` at the end of a page moves on to the next one.
 */
function nearestLineVertically(
  layout: DocumentLayout,
  from: { pageIndex: number; top: number; bottom: number },
  direction: Direction,
  targetX: number,
  fromBlockId: string,
): { blockId: string; line: LayoutLine; leftPx: number } | null {
  // A half-pixel tolerance: two neighboring cells compute their y coordinate with different
  // sums and can differ by a rounding.
  const EPSILON = 0.5;

  const scan = (
    pageIndex: number,
    limit: number | null,
  ): { blockId: string; line: LayoutLine; leftPx: number } | null => {
    let best: {
      band: number;
      distance: number;
      blockId: string;
      line: LayoutLine;
      leftPx: number;
    } | null = null;

    for (const [blockId, entries] of layout.placements) {
      for (const entry of entries) {
        if (entry.pageIndex !== pageIndex) continue;
        const placed = entry.placed;
        let top = paragraphTop(placed);

        for (let i = placed.fromLine; i < placed.toLine; i += 1) {
          const line = placed.layout.lines[i];
          if (!line) continue;
          const bottom = top + line.heightPx;
          const lineTop = top;
          top = bottom;

          // The line we start from cannot be its own neighbor.
          if (blockId === fromBlockId && lineTop >= from.top - EPSILON && bottom <= from.bottom + EPSILON) {
            continue;
          }

          if (direction > 0) {
            if (limit !== null && lineTop < limit - EPSILON) continue;
          } else if (limit !== null && bottom > limit + EPSILON) {
            continue;
          }

          // Strip: we always prefer the closest one, whatever the x coordinate.
          const band = direction > 0 ? lineTop : -bottom;
          const left = placed.leftPx + line.leftPx;
          const right = left + paintedLineWidth(line);
          const distance = targetX < left ? left - targetX : targetX > right ? targetX - right : 0;

          const closerBand = !best || band < best.band - EPSILON;
          const sameBandCloserX = best !== null && band <= best.band + EPSILON && distance < best.distance;
          if (closerBand || sameBandCloserX) {
            best = { band, distance, blockId, line, leftPx: placed.leftPx };
          }
        }
      }
    }

    return best ? { blockId: best.blockId, line: best.line, leftPx: best.leftPx } : null;
  };

  const onPage = scan(from.pageIndex, direction > 0 ? from.bottom : from.top);
  if (onPage) return onPage;

  // Nothing on this page: move to the next one, with no strip constraint.
  return scan(from.pageIndex + direction, null);
}

/** Start / end of the visual line: the `Home` and `End` keys. */
export function lineBounds(
  layout: DocumentLayout,
  position: DocumentPosition,
): { start: number; end: number } | null {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  if (!paragraphLayout) return null;
  const line = paragraphLayout.lines[lineIndexAt(paragraphLayout, position.offset)];
  if (!line) return null;
  return { start: line.startOffset, end: line.endOffset };
}

/** Rectangles to paint for a selection, page by page. */
export interface SelectionRect {
  pageIndex: number;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

export function selectionRects(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  selection: DocumentSelection,
  measurer: TextMeasurer,
): SelectionRect[] {
  if (selection.isCollapsed) return [];
  const { start, end } = normalizeSelection(doc, selection);
  return rangeRects(layout, start, end, measurer);
}

/** Are all the blocks of `[from, to)` of the layout order generated ones? */
function seulementEngendre(layout: DocumentLayout, from: number, to: number): boolean {
  for (let rank = from; rank < to; rank += 1) {
    if (!layout.generatedBlockIds.has(layout.readingOrder[rank]!)) return false;
  }
  return true;
}

/** Is the position at the end of its block's content? */
function auBoutDuBloc(layout: DocumentLayout, position: DocumentPosition): boolean {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  const last = paragraphLayout?.lines[paragraphLayout.lines.length - 1];
  return last ? position.offset >= last.endOffset : false;
}

/**
 * Rectangles covering any range of the document.
 *
 * Selection and search highlighting share this geometry: they are two ranges to paint, only
 * their color differs. Computing them twice in two ways would end up producing two results.
 *
 * The walk follows the **layout order** (`layout.readingOrder`) and not the document index.
 * The index leaves out tables of contents (a cursor must not be able to land in them), and
 * using it here amounted to never painting their lines: `Ctrl+A` left the table of contents
 * white in the middle of a highlighted document, and a page that held nothing but its lines
 * stayed entirely blank. The protection of a `SwTOXBase` is about writing, not about
 * selecting.
 */
export function rangeRects(
  layout: DocumentLayout,
  start: DocumentPosition,
  end: DocumentPosition,
  measurer: TextMeasurer,
): SelectionRect[] {
  const order = layout.readingOrder;
  let startRank = order.indexOf(start.blockId);
  let endRank = order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return [];

  /*
   * A table of contents at the start or the end of the document.
   *
   * Framing the generated lines by two ranks is enough as long as a placeable paragraph exists
   * on each side. A table of contents that **opens** the document has none before it: the first
   * placeable position falls after its lines, so `Ctrl+A` started at the next rank and left the
   * whole table white: the defect fixed above, reappearing at the edge. The same goes for a table
   * of contents that closes the document.
   *
   * The extension requires that the range truly reaches the edge: nothing editable before (or
   * after) *and* starting at the first character (or ending at the last). A selection that stops
   * at the paragraph before a table of contents in the middle therefore does not extend up to it.
   */
  if (start.offset <= 0 && seulementEngendre(layout, 0, startRank)) startRank = 0;
  if (auBoutDuBloc(layout, end) && seulementEngendre(layout, endRank + 1, order.length)) {
    endRank = order.length - 1;
  }

  const rects: SelectionRect[] = [];

  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = order[rank]!;
    const paragraphLayout = layout.paragraphLayouts.get(blockId);
    const placements = layout.placements.get(blockId);
    if (!paragraphLayout || !placements) continue;

    const from = rank === startRank ? start.offset : 0;
    const to = rank === endRank ? end.offset : Number.MAX_SAFE_INTEGER;

    for (const { pageIndex, placed } of placements) {
      let top = paragraphTop(placed);

      for (let i = placed.fromLine; i < placed.toLine; i += 1) {
        const line = paragraphLayout.lines[i]!;
        const lineFrom = Math.max(from, line.startOffset);
        const lineTo = Math.min(to, Math.max(line.endOffset, line.startOffset));

        if (lineFrom <= lineTo && !(lineTo < line.startOffset || lineFrom > line.endOffset)) {
          const left = caretXOnLine(line, lineFrom, measurer);
          const right = caretXOnLine(line, lineTo, measurer);
          // A line that is fully selected but empty must stay visible: it is given the width of a half
          // em, as Writer does to show the selected paragraph break.
          const emptyMark = rank < endRank && line.isLast ? line.heightPx * 0.25 : 0;
          rects.push({
            pageIndex,
            leftPx: placed.leftPx + left,
            topPx: top,
            widthPx: Math.max(right - left, 0) + emptyMark,
            heightPx: line.heightPx,
          });
        }
        top += line.heightPx;
      }
    }
  }

  return rects.filter((rect) => rect.widthPx > 0);
}
