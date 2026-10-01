// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Floating frames and text wrapping. (OpenOffice: `SwFlyFreeFrm`,
 * `sw/source/core/layout/fly.cxx`, `flylay.cxx`; `SwFmtSurround`, `sw/inc/fmtsrndenum.hxx`;
 * and the usable-band computation of `SwTxtFly`, `sw/source/core/text/txtfly.cxx`.)
 *
 * ## The problem `SwTxtFly` solves
 *
 * An image anchored "as a character" is simple: it takes a width in the line, and the formatter
 * has nothing more to know. A **floating** frame is of another nature: it leaves the flow, sits
 * at a coordinate, and it is up to the text to move aside. Every line it crosses therefore has
 * its usable width cut down, and differently depending on its height inside the frame.
 *
 * `SwTxtFly::GetFrm` answers exactly one question, and so does this module: *for a line going
 * from `top` to `bottom`, what horizontal interval is still available?* The rest (filling the
 * line, justifying it) does not change.
 *
 * ## The chosen formulation: subtracting intervals
 *
 * Rather than treating "text on the left" and "text on the right" separately, each frame
 * declares the horizontal interval it **forbids**, derived from its wrapping mode:
 *
 *   through  → nothing (the text passes underneath)
 *   parallel → the width of the frame, margins included
 *   left     → from the left edge of the frame to the end of the column
 *   right    → from the start of the column to the right edge of the frame
 *   none     → the whole column
 *   ideal    → one of the previous four, chosen from the room that remains
 *
 * The usable band is then the widest interval that survives all the subtractions. This
 * formulation has a concrete advantage over a case-by-case analysis: **two frames that overlap
 * need no extra code**, whereas separate left/right handling would have to arbitrate between
 * them.
 *
 * Pure module: no React import, no DOM access.
 */

import { ptToPx } from '../document/units';
import { paragraphIndex } from '../document/document';
import { DEFAULT_WRAP_MARGIN_PT } from '../document/images';
import type { PageGeometry } from '../document/pageSetup';
import type {
  FlyHoriOrient,
  FlyHoriRelation,
  FlySurround,
  ParagraphNode,
  TextRun,
  WriterDocumentState,
} from '../document/types';

// Convenience re-export: the wrapping margin is a default of the model, but this is where it is
// read, and this is where callers look for it.
export { DEFAULT_WRAP_MARGIN_PT };

/**
 * Minimum width of a band for it to be worth writing in.
 *
 * `SwTxtFly` keeps a comparable threshold: below a few characters, a leftover column produces a
 * vertical mush of one letter per line, less readable than pushing the text below the frame.
 */
export const MIN_BAND_WIDTH_PX = 24;

/** A floating frame resolved to its geometry in pixels. */
export interface FlyFrame {
  /** Share of the height that belongs to the caption. Zero if there is none. */
  captionHeightPx?: number;
  /** Paragraph holding the anchor character. */
  anchorBlockId: string;
  /** Offset of the anchor character in that paragraph. */
  anchorOffset: number;
  surround: FlySurround;
  /** Anchoring to the paragraph or to the page, never `as-char` here. */
  anchor: 'to-para' | 'to-page';
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  /** Wrapping margin, already in pixels. */
  marginPx: number;
  run: TextRun;
}

/** A forbidden horizontal interval, over a vertical slice. */
export interface FlyExclusion {
  topPx: number;
  bottomPx: number;
  /** Bounds of the **forbidden** interval, margins included. */
  leftPx: number;
  rightPx: number;
}

/* ------------------------------------------------- "ideal" wrapping */

/**
 * Minimum width of a text column for it to deserve to exist, in points. `TEXT_MIN` in
 * `txtfly.cxx:2337`: 1134 twips, i.e. 2 cm.
 */
export const IDEAL_TEXT_MIN_PT = 1134 / 20;

/**
 * Width beyond which a frame can no longer be wrapped on both sides. `FRAME_MAX` in
 * `txtfly.cxx:2339`: 850 twips, i.e. 1.5 cm.
 */
export const IDEAL_FRAME_MAX_PT = 850 / 20;

/**
 * Resolves `SURROUND_IDEAL` into a concrete mode.
 *
 * A direct port of `SwTxtFly::GetSurroundForTextWrap` (`txtfly.cxx:2372-2402`). "Ideal"
 * wrapping is not a geometry but an **arbitration**: we measure what is left of the column on
 * each side of the frame, discard the bands that are too narrow to write in (`TEXT_MIN`), and the
 * mode is deduced from what survives: both sides give `parallel`, a single one gives `left` or
 * `right`, none gives `none`.
 *
 * The `FRAME_MAX` rule deserves a word: past 1.5 cm wide, a frame keeps **only its wider side**,
 * even if the other one exceeds the minimum. Two narrow columns on either side of an image are
 * readable in theory and unreadable in practice; Writer decides in favor of one.
 */
export function resolveIdealSurround(
  /** Left edge of the frame, margins included, in the column's frame of reference. */
  leftPx: number,
  /** Right edge of the frame, margins included. */
  rightPx: number,
  contentWidthPx: number,
): 'none' | 'parallel' | 'left' | 'right' {
  // Frame entirely outside the column: it does not cut it, and the text ignores it on both sides.
  if (rightPx < 0 || leftPx > contentWidthPx) return 'parallel';

  let left = leftPx;
  let right = contentWidthPx - rightPx;

  if (rightPx - leftPx > ptToPx(IDEAL_FRAME_MAX_PT)) {
    if (left < right) left = 0;
    else right = 0;
  }

  const minPx = ptToPx(IDEAL_TEXT_MIN_PT);
  if (left < minPx) left = 0;
  if (right < minPx) right = 0;

  if (left > 0) return right > 0 ? 'parallel' : 'left';
  return right > 0 ? 'right' : 'none';
}

/* --------------------------------------------------- horizontal position */

/**
 * X coordinate of a frame, in the frame of reference of the text column.
 *
 * Counterpart of `SwAnchoredObjectPosition::CalcRelPosX`
 * (`sw/source/core/layout/anchoreddrawobject.cxx`, `objectpositioning/`): the alignment and its
 * reference combine into an x coordinate, once the page is known. `from-left`
 * (`HoriOrientation::NONE`) is the only mode that reads the offset as it is; the others
 * recompute it, which is precisely what is expected of them when the page margin changes.
 *
 * The result is always brought back to the **column's** frame of reference: it is the one in
 * which `lineBreak` subtracts the bands, and mixing two origins would move the text without
 * moving the image.
 */
export function resolveFlyLeft(
  orient: FlyHoriOrient,
  relation: FlyHoriRelation,
  offsetPx: number,
  widthPx: number,
  geometry: Pick<PageGeometry, 'pageWidthPx' | 'contentLeftPx' | 'contentWidthPx'>,
): number {
  // Bounds of the requested reference, expressed in that of the column. The sheet therefore
  // starts at a **negative** x coordinate: that is the left margin, which the column does not
  // cover and where a frame is allowed to overflow.
  const { leftPx, widthPx: frameWidthPx } =
    relation === 'page'
      ? { leftPx: -geometry.contentLeftPx, widthPx: geometry.pageWidthPx }
      : { leftPx: 0, widthPx: geometry.contentWidthPx };

  switch (orient) {
    case 'center':
      return leftPx + (frameWidthPx - widthPx) / 2;
    case 'right':
      return leftPx + frameWidthPx - widthPx;
    case 'left':
      return leftPx;
    case 'from-left':
    default:
      return leftPx + offsetPx;
  }
}

/** Is a frame floating, as opposed to "as a character"? */
export function isFloatingFly(run: TextRun): boolean {
  return (
    run.imageSrc !== undefined &&
    run.imageAnchor !== undefined &&
    run.imageAnchor !== 'as-char'
  );
}

/**
 * Collects the floating frames of the document.
 *
 * A frame with no dimensions is not kept: with no width or height it excludes nothing, and
 * letting it through would force every caller to check again.
 */
export function collectFlyFrames(
  doc: WriterDocumentState,
  /**
   * Page geometry, needed to resolve the alignments.
   *
   * `SwFlyFrm::MakeAll` does the same: the orientation becomes a coordinate **once**, before
   * `SwTxtFly` subtracts anything from it. Resolving later would force every line to redo the
   * calculation, and the two frames of reference (the frame's and the text's) would end up
   * diverging.
   */
  geometry: Pick<PageGeometry, 'pageWidthPx' | 'contentLeftPx' | 'contentWidthPx'>,
  /**
   * Height of a frame's caption, supplied by the caller.
   *
   * It is part of the frame's height, so of the band the text has to go around: without it the
   * lines closed back in on the caption and ran over it.
   *
   * It is a **callback** and not a direct computation: measuring a caption requires `lineBreak`,
   * which already depends on this module. The parameter reverses the dependency instead of making
   * it circular, and callers that do not paint (pure geometry) have nothing to supply.
   */
  captionHeightOf?: (run: TextRun, blockId: string, offset: number, widthPx: number) => number,
): FlyFrame[] {
  const out: FlyFrame[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    for (const run of paragraph.runs) {
      if (!isFloatingFly(run)) {
        offset += run.text.length;
        continue;
      }

      const widthPx = ptToPx(run.imageWidthPt ?? 0);
      const imageHeightPx = ptToPx(run.imageHeightPt ?? 0);

      // The caption adds to the frame, and the text goes around it like the image.
      const captionPx = captionHeightOf ? captionHeightOf(run, blockId, offset, widthPx) : 0;
      const heightPx = imageHeightPx + captionPx;

      if (widthPx > 0 && heightPx > 0) {
        out.push({
          anchorBlockId: blockId,
          anchorOffset: offset,
          captionHeightPx: captionPx,
          surround: run.imageSurround ?? 'parallel',
          anchor: run.imageAnchor === 'to-page' ? 'to-page' : 'to-para',
          leftPx: resolveFlyLeft(
            // With no declared alignment, the x coordinate is the model's: that is
            // `HoriOrientation::NONE`, and it is also what frames written before alignment existed were
            // worth.
            run.imageHoriOrient ?? 'from-left',
            run.imageHoriRelation ?? 'text',
            ptToPx(run.imageXPt ?? 0),
            widthPx,
            geometry,
          ),
          topPx: ptToPx(run.imageYPt ?? 0),
          widthPx,
          heightPx,
          marginPx: ptToPx(run.imageWrapMarginPt ?? DEFAULT_WRAP_MARGIN_PT),
          run,
        });
      }
      offset += run.text.length;
    }
  }

  return out;
}

/**
 * Translates a frame into a forbidden interval, in the frame of reference of a column of width
 * `contentWidthPx`.
 *
 * Returns `null` for a frame that forbids nothing (`through`).
 */
export function exclusionOf(fly: FlyFrame, contentWidthPx: number): FlyExclusion | null {
  if (fly.surround === 'through') return null;

  const top = fly.topPx - fly.marginPx;
  const bottom = fly.topPx + fly.heightPx + fly.marginPx;
  const left = fly.leftPx - fly.marginPx;
  const right = fly.leftPx + fly.widthPx + fly.marginPx;

  // `ideal` has no geometry of its own: it designates whichever of the other four modes the
  // remaining room makes workable. It is resolved here, once the edges are known, margins included:
  // those are what `TEXT_MIN` measures.
  const surround =
    fly.surround === 'ideal'
      ? resolveIdealSurround(left, right, contentWidthPx)
      : fly.surround;

  switch (surround) {
    case 'none':
      return { topPx: top, bottomPx: bottom, leftPx: 0, rightPx: contentWidthPx };
    case 'left':
      // Text on the left only: everything to the right of the frame's left edge is forbidden, frame
      // included.
      return { topPx: top, bottomPx: bottom, leftPx: left, rightPx: contentWidthPx };
    case 'right':
      return { topPx: top, bottomPx: bottom, leftPx: 0, rightPx: right };
    case 'parallel':
    default:
      return { topPx: top, bottomPx: bottom, leftPx: left, rightPx: right };
  }
}

/** Horizontal band usable by a line. */
export interface UsableBand {
  leftPx: number;
  rightPx: number;
  get widthPx(): number;
}

/**
 * Widest free interval for a line occupying `[topPx, bottomPx)`.
 *
 * Returns `null` when no usable interval remains: the caller must then move the line down below
 * the blocking frame (`nextClearY`).
 */
export function usableBand(
  exclusions: readonly FlyExclusion[],
  topPx: number,
  bottomPx: number,
  contentWidthPx: number,
  minWidthPx: number = MIN_BAND_WIDTH_PX,
): { leftPx: number; rightPx: number } | null {
  if (exclusions.length === 0) return { leftPx: 0, rightPx: contentWidthPx };

  // Free intervals, initially the whole column. Each frame that crosses the line vertically takes
  // its share out of them.
  let free: { left: number; right: number }[] = [{ left: 0, right: contentWidthPx }];

  for (const exclusion of exclusions) {
    // Strict vertical overlap: a frame that stops exactly at the top of the line does not get in its
    // way.
    if (exclusion.bottomPx <= topPx || exclusion.topPx >= bottomPx) continue;

    const next: { left: number; right: number }[] = [];
    for (const span of free) {
      // No horizontal intersection: the interval survives as it is.
      if (exclusion.rightPx <= span.left || exclusion.leftPx >= span.right) {
        next.push(span);
        continue;
      }
      if (exclusion.leftPx > span.left) next.push({ left: span.left, right: exclusion.leftPx });
      if (exclusion.rightPx < span.right) next.push({ left: exclusion.rightPx, right: span.right });
    }
    free = next;
    if (free.length === 0) return null;
  }

  let best: { left: number; right: number } | null = null;
  for (const span of free) {
    const width = span.right - span.left;
    if (width < minWidthPx) continue;
    if (!best || width > best.right - best.left) best = span;
  }

  return best ? { leftPx: best.left, rightPx: best.right } : null;
}

/**
 * First y coordinate, from `topPx`, where the line stops being blocked.
 *
 * It is the bottom of the highest frame among those that block: going lower in one go would
 * needlessly skip white space.
 */
export function nextClearY(
  exclusions: readonly FlyExclusion[],
  topPx: number,
  bottomPx: number,
): number | null {
  let candidate: number | null = null;
  for (const exclusion of exclusions) {
    if (exclusion.bottomPx <= topPx || exclusion.topPx >= bottomPx) continue;
    if (candidate === null || exclusion.bottomPx < candidate) candidate = exclusion.bottomPx;
  }
  // Always make progress: a frame of zero height would otherwise return the same y coordinate and
  // make the formatter's loop spin forever.
  return candidate === null ? null : Math.max(candidate, topPx + 1);
}

/**
 * Exclusions that apply to a paragraph, in its local frame of reference.
 *
 * Only the frames **anchored to this paragraph** are resolved here: a frame anchored to the page
 * only knows its relative position once the paragraph has been placed, so it is pagination that
 * injects them (see `projectedExclusions`).
 */
export function paragraphExclusions(
  flies: readonly FlyFrame[],
  paragraph: ParagraphNode,
  contentWidthPx: number,
): FlyExclusion[] {
  const out: FlyExclusion[] = [];
  for (const fly of flies) {
    if (fly.anchor !== 'to-para' || fly.anchorBlockId !== paragraph.id) continue;
    const exclusion = exclusionOf(fly, contentWidthPx);
    if (exclusion) out.push(exclusion);
  }
  return out;
}

/** Where a frame has actually been placed, once the page is known. */
export interface FlyPlacement {
  /** 0-indexed page that holds the frame. */
  pageIndex: number;
  /** Y coordinate of the frame from the top of this page's content area. */
  topPx: number;
}

/**
 * Exclusions due to frames placed **elsewhere** than in this paragraph, brought back to its frame
 * of reference.
 *
 * ## Why two kinds are needed
 *
 * `paragraphExclusions` only knows one thing: the frames anchored to the paragraph being
 * composed. That is enough as long as a frame does not extend past its anchor, and wrong as soon as
 * it does, which is the usual case: an eight-centimeter image anchored to a two-line paragraph
 * necessarily overflows onto what follows, and the following text used to run straight through it.
 *
 * `SwTxtFly` does not have this problem because it queries the list of frames of the **page**, not
 * that of the anchor. That is what this function does: it projects every frame whose page matches,
 * whatever its anchoring.
 *
 * ## What it asks for in return
 *
 * An **absolute** position, which only a placement that has already been made can give: the page
 * of a frame anchored to a paragraph depends on where that paragraph landed. Hence the `placements`
 * parameter, which pagination fills from its previous pass: the same mechanism, and the same
 * reason, as for the table of contents.
 */
export function projectedExclusions(
  flies: readonly FlyFrame[],
  pageIndex: number,
  placements: ReadonlyMap<string, FlyPlacement>,
  paragraphTopPx: number,
  contentWidthPx: number,
  /**
   * Paragraph being composed. Its own frames are left out: `paragraphExclusions` has already given
   * them, and counting them twice would have no visible effect but would make the list grow on every
   * line.
   */
  currentBlockId?: string,
): FlyExclusion[] {
  const out: FlyExclusion[] = [];
  for (const fly of flies) {
    if (fly.anchorBlockId === currentBlockId) continue;

    const place = placements.get(fly.anchorBlockId);
    if (!place || place.pageIndex !== pageIndex) continue;

    const exclusion = exclusionOf(fly, contentWidthPx);
    if (!exclusion) continue;

    // A page frame is fixed on the sheet; a paragraph frame follows its anchor. Either way we end up
    // with a y coordinate counted from the top of the content area, then brought back to the
    // paragraph's frame of reference.
    const originePx = fly.anchor === 'to-page' ? 0 : place.topPx;
    const decalagePx = originePx - paragraphTopPx;

    out.push({
      ...exclusion,
      topPx: exclusion.topPx + decalagePx,
      bottomPx: exclusion.bottomPx + decalagePx,
    });
  }
  return out;
}
