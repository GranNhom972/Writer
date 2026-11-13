// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Splitting a paragraph into lines. (OpenOffice: `SwTxtGuess::Guess`,
 * `sw/source/core/text/guess.cxx`, and `SwTxtFormatter`.)
 *
 * The original algorithm, in order:
 *
 *  1. everything that is left fits in the line → finish it there;
 *  2. otherwise `nCutPos` = the **first character that no longer fits**;
 *  3. if that character is a space: cut there, step back over the trailing spaces (they
 *     overflow without counting), then move forward over the following spaces, so the next
 *     line never starts with a space;
 *  4. otherwise, look for the last **break opportunity** before `nCutPos`;
 *  5. none found → forced break inside the word ("break cut").
 *
 * What is not reproduced: dictionary hyphenation (`XHyphenator`), hanging punctuation and kana
 * compression. Step 5 replaces them, and the structure stays ready to welcome them.
 */

import { cmToPx, ptToPx } from '../document/units';
import { runFormatting, runsText } from '../document/runs';
import { effectiveIndentLeftPt, LIST_INDENT_PT, type ListMarker } from '../document/lists';
import type {
  Alignment,
  DocumentDefaults,
  ListKind,
  ParagraphNode,
  RunFormatting,
} from '../document/types';
import { resolveAlignment, resolveBlockSpacing, resolveColor, resolveFont, resolveLineSpacing } from './style';
import type { FontMetrics, FontSpec, TextMeasurer } from './measure';
import { measureMathExact } from '../math/render';
import {
  captionText,
  hasCaption,
  imageCaptionGapPt,
  imageCaptionOf,
  imageKey,
  imageMarginPt,
  isImageFormatting,
} from '../document/images';
import { MIN_BAND_WIDTH_PX, nextClearY, usableBands, type FlyExclusion } from './flyLayout';

/** Writer's default tab stop: 1.25 cm. */
export const DEFAULT_TAB_STOP_PX = cmToPx(1.25);

/** A space where the line may be broken (`CH_BLANK`, `CH_FULL_BLANK`). */
export function isBlank(char: string): boolean {
  // The non-breaking space is deliberately left out: that is its whole purpose.
  return char === ' ' || char === '　';
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** Punctuation that cannot start a line (the kinsoku rule). */
const NO_LINE_START = '、。，．！？」』）»)]}!?,.;:';

/** A piece of a line ready to paint: same font, same formatting. */
export interface LayoutSegment {
  startOffset: number;
  endOffset: number;
  text: string;
  formatting: RunFormatting;
  font: FontSpec;
  color: string;
  /** X coordinate of the left edge, relative to the left edge of the content area. */
  leftPx: number;
  widthPx: number;
  /** True for a segment produced by a tab (computed width). */
  isTab: boolean;
  /**
   * Height reserved for the caption of an image, white space included.
   *
   * Carried by the segment because the engine is the one that measured it and already counted it
   * in the line height. Recomputing it at render time would make the display depend on a second
   * derivation, which would end up diverging from the authoritative one.
   */
  captionHeightPx?: number;
  /**
   * Word spacing of **this** segment, when the line has several of them.
   *
   * A line that a frame cuts in two (`SwFlyPortion`) is justified piece by piece: the part on the
   * left of the frame is stretched up to the frame, the part on its right up to the margin, and
   * the two stretches differ. Absent: the line's `wordSpacingPx` applies.
   */
  wordSpacingPx?: number;
  /**
   * The blank a floating frame takes in the line (`SwFlyPortion`): no text, no offset of its own,
   * only a width that carries the text over to the other side of the frame. Painted and hit-tested
   * like a tab (`isTab` is true).
   */
  flyGap?: true;
}

/** Word spacing that applies to a segment: its own, or failing that the line's. */
export function segmentWordSpacing(line: LayoutLine, segment: LayoutSegment): number {
  return segment.wordSpacingPx ?? line.wordSpacingPx;
}

export interface LayoutLine {
  index: number;
  /** First offset of the line, in the paragraph's raw string. */
  startOffset: number;
  /** End of the **painted** content: trailing spaces are excluded. */
  endOffset: number;
  /** Offset where the next line starts (swallowed spaces included). */
  nextOffset: number;
  segments: LayoutSegment[];
  leftPx: number;
  widthPx: number;
  heightPx: number;
  ascentPx: number;
  /** Y coordinate of the top of the line, relative to the top of the paragraph's content. */
  topPx: number;
  /** Word spacing added by justification, in pixels. */
  wordSpacingPx: number;
  isLast: boolean;
}

/**
 * Y coordinate of line `index` within the piece of paragraph that starts at line `fromLine`.
 *
 * The **only** rule for stacking lines. A line is not always right below the previous one: one that
 * a frame blocks over the whole width (`surround: none`, or `ideal` with no room left beside it) is
 * moved down below the frame by the formatter, and `topPx` says by how much. Adding up heights
 * instead dropped that move: the engine put the text under the image, the screen painted it over.
 *
 * A piece carried over to another page starts at its own first line: what came before stayed on the
 * previous page.
 */
export function lineTopInPiece(layout: Pick<ParagraphLayout, 'lines'>, fromLine: number, index: number): number {
  const base = fromLine === 0 ? 0 : (layout.lines[fromLine]?.topPx ?? 0);
  return (layout.lines[index]?.topPx ?? 0) - base;
}

/** Height that lines `[fromLine, toLine)` take on the page, moves below frames included. */
export function piecesHeight(layout: Pick<ParagraphLayout, 'lines'>, fromLine: number, toLine: number): number {
  const last = layout.lines[toLine - 1];
  if (!last || toLine <= fromLine) return 0;
  return lineTopInPiece(layout, fromLine, toLine - 1) + last.heightPx;
}

/** Bullet or number painted in front of the first line of a list item. */
export interface LayoutMarker {
  kind: ListKind;
  text: string;
  checked: boolean;
  /** X coordinate of the left edge, relative to the left edge of the content area. */
  leftPx: number;
  widthPx: number;
  font: FontSpec;
  color: string;
}

export interface ParagraphLayout {
  blockId: string;
  lines: LayoutLine[];
  /** Absent outside a list. */
  marker: LayoutMarker | null;
  marginTopPx: number;
  marginBottomPx: number;
  /** Height of the content alone, margins excluded. */
  contentHeightPx: number;
  /** Total height taken in the flow. */
  heightPx: number;
  alignment: Alignment;
}

export interface LayoutContext {
  measurer: TextMeasurer;
  defaults: DocumentDefaults;
  /** Width of the printable area of the page. */
  contentWidthPx: number;
  tabStopPx?: number;
  /** List marker, computed upstream by `computeListMarkers`. */
  marker?: ListMarker | undefined;
  /**
   * Horizontal intervals forbidden by the floating frames that cross this paragraph, in its
   * local frame of reference (`SwTxtFly`, txtfly.cxx).
   *
   * Absent in the usual case: a document with no floating frame therefore pays nothing for this
   * feature, the fill loop falling back on the full width without one more test per character.
   */
  exclusions?: readonly FlyExclusion[] | undefined;
  /**
   * Figure numbers of the document, and the paragraph being laid out.
   *
   * The caption of an image takes height: it must therefore be measured here, with its number,
   * otherwise the text that follows would run over it. The number is not in the run (it is derived
   * from the order of the document, see `figureNumbering`), hence these two fields, which only exist
   * to report it.
   */
  figureNumbers?: ReadonlyMap<string, number> | undefined;
  blockId?: string | undefined;
}

/** Font size of a caption, relative to the document's font size. */
export const CAPTION_FONT_RATIO = 0.85;
/** Line spacing of a caption. */
export const CAPTION_LINE_RATIO = 1.3;
/**
 * White space between the image and its caption.
 *
 * It is **no longer** part of the measured height of the caption: it used to be counted in it and
 * then subtracted at display time, so it ended up at the bottom of the frame instead of separating
 * the image from its text. It is now placed where it belongs, and is adjustable
 * (`imageCaptionGapPt`).
 */

/**
 * Height taken by the caption of an image, white space included.
 *
 * The caption is framed on the **width of the image** and wraps as many times as needed: this is
 * what Writer does, whose caption lives in a frame the width of its own. Measuring here, and not at
 * render time, is what guarantees that the next line of text is placed below the caption and not on
 * top of it.
 */
export function captionHeightPx(
  text: string,
  imageWidthPx: number,
  fontSizePx: number,
  measurer: TextMeasurer,
): number {
  if (text.trim().length === 0) return 0;
  const font: FontSpec = {
    fontFamily: 'Liberation Sans, Arimo, Arial, sans-serif',
    fontSizePx,
    bold: false,
    italic: false,
  };
  const lineHeight = fontSizePx * CAPTION_LINE_RATIO;
  const usable = Math.max(1, imageWidthPx);

  // Wrap at the word, like the line filler: counting characters would give a wrong number of lines
  // from the first long word.
  let lines = 1;
  let current = '';
  for (const word of text.split(/\s+/)) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (measurer.measure(candidate, font) <= usable || current.length === 0) {
      current = candidate;
    } else {
      lines += 1;
      current = word;
    }
  }

  return lines * lineHeight;
}

/** Pre-computed measurements of a paragraph: advances per offset and fonts per run. */
interface ParagraphMetrics {
  text: string;
  /** Index of the run each offset belongs to. */
  runAt: Int32Array;
  /**
   * Cumulative advances, **excluding tabs**: the advance of a tab depends on the current position, so
   * it cannot be part of a running total. The line filler therefore never measures across a tab.
   */
  cum: Float64Array;
  fonts: FontSpec[];
  colors: string[];
  formats: RunFormatting[];
  metrics: FontMetrics[];
  /** Caption height per run: zero except on a captioned image. */
  captionHeights: number[];
}

/**
 * Estimates the real horizontal width of a LaTeX formula, taking into account the vertical stacking
 * of fractions, matrices and radicals.
 */
export function estimateLatexWidth(latex: string, em: number): number {
  if (!latex || !latex.trim()) return em * 1.2;

  let str = latex.trim();

  // Handle matrices / environments
  const matrixMatch = str.match(/\\begin\{(matrix|pmatrix|bmatrix|vmatrix|cases)\}([\s\S]*?)\\end\{\1\}/);
  if (matrixMatch && matrixMatch[2]) {
    const rows = matrixMatch[2].split('\\\\');
    let maxCols = 0;
    const colWidths: number[] = [];
    for (const row of rows) {
      const cells = row.split('&');
      maxCols = Math.max(maxCols, cells.length);
      cells.forEach((cell, idx) => {
        const cellW = estimateLatexWidth(cell.trim(), em);
        colWidths[idx] = Math.max(colWidths[idx] ?? 0, cellW);
      });
    }
    const tableWidth = colWidths.reduce((sum, w) => sum + w, 0) + Math.max(0, maxCols - 1) * (em * 0.7) + em * 0.8;
    const before = str.slice(0, matrixMatch.index);
    const after = str.slice((matrixMatch.index ?? 0) + matrixMatch[0].length);
    return estimateLatexWidth(before, em) + tableWidth + estimateLatexWidth(after, em);
  }

  // Handle the fractions \frac{num}{den}, \dfrac, \tfrac (vertical stacking)
  const fracRegex = /\\(frac|dfrac|tfrac)\s*\{((?:[^{}]|{[^{}]*})*)\}\s*\{((?:[^{}]|{[^{}]*})*)\}/;
  let fracMatch = str.match(fracRegex);
  while (fracMatch) {
    const num = fracMatch[2] ?? '';
    const den = fracMatch[3] ?? '';
    const numW = estimateLatexWidth(num, em * 0.85);
    const denW = estimateLatexWidth(den, em * 0.85);
    const fracW = Math.max(numW, denW) + em * 0.25;

    const idx = fracMatch.index ?? 0;
    str = str.slice(0, idx) + `__FRAC_${Math.round(fracW)}__` + str.slice(idx + fracMatch[0].length);
    fracMatch = str.match(fracRegex);
  }

  // Handle square roots \sqrt{content} or \sqrt[n]{content}
  const sqrtRegex = /\\sqrt(?:\[[^\]]*\])?\s*\{((?:[^{}]|{[^{}]*})*)\}/;
  let sqrtMatch = str.match(sqrtRegex);
  while (sqrtMatch) {
    const inner = sqrtMatch[1] ?? '';
    const innerW = estimateLatexWidth(inner, em);
    const sqrtW = innerW + em * 0.75;

    const idx = sqrtMatch.index ?? 0;
    str = str.slice(0, idx) + `__SQRT_${Math.round(sqrtW)}__` + str.slice(idx + sqrtMatch[0].length);
    sqrtMatch = str.match(sqrtRegex);
  }

  // Compute the remaining width
  let totalWidth = 0;
  const placeholderRegex = /__(FRAC|SQRT)_(\d+)__/g;
  let lastIdx = 0;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = placeholderRegex.exec(str)) !== null) {
    const beforeText = str.slice(lastIdx, pMatch.index);
    totalWidth += estimateSimpleMathTextWidth(beforeText, em);
    totalWidth += Number(pMatch[2]);
    lastIdx = pMatch.index + pMatch[0].length;
  }
  const tailText = str.slice(lastIdx);
  totalWidth += estimateSimpleMathTextWidth(tailText, em);

  return Math.max(em * 1.0, totalWidth);
}

function estimateSimpleMathTextWidth(text: string, em: number): number {
  if (!text) return 0;

  let width = 0;
  let s = text
    .replace(/\\(left|right|displaystyle|textstyle|mathbf|mathit|mathrm|mathbb|mathcal)\b/g, '')
    .replace(/[{}\\]/g, ' ');

  // Replace the usual symbol commands (\alpha, \pm, \int, \sum, etc.) with 1 glyph
  s = s.replace(/\\[a-zA-Z]+/g, 'X');

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') {
      width += em * 0.25;
    } else if (c === '=' || c === '+' || c === '-' || c === '<' || c === '>') {
      width += em * 0.65;
    } else if (c === '^' || c === '_') {
      width += em * 0.1;
    } else if (/[0-9]/.test(c)) {
      width += em * 0.5;
    } else {
      width += em * 0.55;
    }
  }

  return width;
}

/**
 * Estimates the geometry (height, baseline and width) of a math formula. It lets the engine reserve
 * the right vertical space for fractions, radicals, matrices and integrals without overlapping the
 * neighboring lines.
 */
export function estimateMathMetrics(
  latex: string,
  display: boolean,
  font: FontSpec,
): { widthPx: number; heightPx: number; ascentPx: number } {
  if (typeof document !== 'undefined') {
    const exact = measureMathExact(latex, display, font);
    if (exact.widthPx > 0) return exact;
  }

  // KaTeX font scale factor: about 1.22 inline and about 1.38 in centered block mode
  const mathScale = display ? 1.38 : 1.22;
  const em = font.fontSizePx * mathScale;
  const isComplex = /\\(frac|sqrt|sum|prod|int|iint|iiint|cases|matrix|pmatrix|bmatrix|vmatrix|begin)/.test(latex);
  const isMatrix = /\\begin\{(matrix|pmatrix|bmatrix|vmatrix|cases)\}/.test(latex);

  let heightPx: number;
  let ascentPx: number;

  if (display) {
    if (isMatrix) {
      heightPx = Math.max(72, em * 3.8);
    } else if (isComplex) {
      heightPx = Math.max(52, em * 2.8);
    } else {
      heightPx = Math.max(42, em * 2.2);
    }
    ascentPx = heightPx * 0.65;
  } else {
    if (isMatrix) {
      heightPx = Math.max(em * 1.6, em * 3.0);
      ascentPx = heightPx * 0.65;
    } else if (isComplex) {
      heightPx = Math.max(em * 1.5, em * 2.1);
      ascentPx = em * 1.35;
    } else {
      heightPx = Math.max(em * 1.25, em * 1.4);
      ascentPx = em * 1.0;
    }
  }

  const widthPx = estimateLatexWidth(latex, em);

  return { widthPx, heightPx, ascentPx };
}

function measureParagraph(paragraph: ParagraphNode, ctx: LayoutContext): ParagraphMetrics {
  const text = runsText(paragraph.runs);
  const runAt = new Int32Array(text.length);
  const cum = new Float64Array(text.length + 1);
  const fonts: FontSpec[] = [];
  const colors: string[] = [];
  const formats: RunFormatting[] = [];
  const metrics: FontMetrics[] = [];
  const captionHeights: number[] = [];

  let offset = 0;
  paragraph.runs.forEach((run, runIndex) => {
    const formatting = runFormatting(run);
    const font = resolveFont(formatting, paragraph, ctx);
    formats.push(formatting);
    fonts.push(font);
    colors.push(resolveColor(formatting, ctx, paragraph));

    if (isImageFormatting(formatting)) {
      // An image frame has no baseline of its own: `SwFlyCntFrm` sits on the text's baseline and rises by
      // as much (`SwTxtFrm::CalcBaseOfstForFly`). All of its height is therefore ascent, and the descent is
      // zero. A floating frame counts neither in width nor in height inside the line: it is placed outside
      // the flow, and the text is carved out around it by the exclusions of `flyLayout`. Giving it its
      // size here would in addition reserve an empty space in the middle of the text.
      const flottant = Boolean(formatting.imageAnchor && formatting.imageAnchor !== 'as-char');
      // The margin is part of the box: it really pushes the text away.
      const margePx = flottant ? 0 : ptToPx(imageMarginPt(formatting));
      const widthPx = flottant ? 0 : ptToPx(formatting.imageWidthPt ?? 0);
      const imageHeightPx = flottant ? 0 : ptToPx(formatting.imageHeightPt ?? 0);

      // The caption is part of the frame: its height adds to that of the image, otherwise the next line
      // would land on top of it.
      const legende = hasCaption(formatting)
        ? captionText(
            imageCaptionOf(formatting),
            ctx.figureNumbers?.get(imageKey(ctx.blockId ?? '', offset)) ?? null,
          )
        : '';
      const texteLegende = captionHeightPx(
        legende,
        widthPx,
        ptToPx(ctx.defaults.fontSizePt) * CAPTION_FONT_RATIO,
        ctx.measurer,
      );
      // The gap only exists if there is a caption to separate from the image.
      const captionPx =
        texteLegende > 0 ? texteLegende + ptToPx(imageCaptionGapPt(formatting)) : 0;
      const heightPx = imageHeightPx + captionPx + margePx * 2;
      captionHeights[runIndex] = captionPx;

      metrics.push({
        ascentPx: heightPx,
        descentPx: 0,
        naturalLineHeightPx: heightPx,
      });

      // The run is worth a single replacement character: all of its width falls on that one advance, which
      // prevents the cursor from being inserted inside it.
      const charCount = Math.max(1, run.text.length);
      const step = (widthPx + margePx * 2) / charCount;
      for (let i = 0; i < run.text.length; i += 1) {
        runAt[offset + i] = runIndex;
        cum[offset + i + 1] = cum[offset + i]! + step;
      }
    } else if (formatting.mathLatex) {
      const mathGeom = estimateMathMetrics(formatting.mathLatex, Boolean(formatting.mathDisplay), font);
      metrics.push({
        ascentPx: mathGeom.ascentPx,
        descentPx: mathGeom.heightPx - mathGeom.ascentPx,
        naturalLineHeightPx: mathGeom.heightPx,
      });

      const totalMathWidth = mathGeom.widthPx;
      const charCount = Math.max(1, run.text.length);
      const step = totalMathWidth / charCount;

      for (let i = 0; i < run.text.length; i += 1) {
        runAt[offset + i] = runIndex;
        cum[offset + i + 1] = cum[offset + i]! + step;
      }
    } else {
      metrics.push(ctx.measurer.metrics(font));
      const prefix = ctx.measurer.prefixWidths(run.text, font);
      for (let i = 0; i < run.text.length; i += 1) {
        runAt[offset + i] = runIndex;
        const advance = prefix[i + 1]! - prefix[i]!;
        const char = run.text[i]!;
        cum[offset + i + 1] = cum[offset + i]! + (char === '\t' || char === '\n' ? 0 : advance);
      }
    }
    offset += run.text.length;
  });

  return { text, runAt, cum, fonts, colors, formats, metrics, captionHeights };
}

/** Width of `[from, to)`, valid as long as the interval does not cross a tab. */
function width(m: ParagraphMetrics, from: number, to: number): number {
  return m.cum[to]! - m.cum[from]!;
}

/**
 * Largest `j` in `[from, limit]` such that `[from, j)` fits in `available`.
 *
 * A binary search on the cumulative advances. This is the role of `SwTxtSizeInfo::GetTxtBreak`,
 * which the output device resolves in one pass; here the running totals are already there, so we
 * might as well use them.
 */
function fittingEnd(
  m: ParagraphMetrics,
  from: number,
  limit: number,
  available: number,
): number {
  if (width(m, from, limit) <= available) return limit;
  let low = from;
  let high = limit;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(m, from, mid) <= available) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Last break opportunity in `(lineStart, cutPos]`, or `-1`.
 *
 * Replaces `XBreakIterator::getLineBreak`. The opportunities kept: after a space, after a hyphen or a
 * slash, and between ideographs, except in front of punctuation that cannot open a line.
 */
function findBreakOpportunity(m: ParagraphMetrics, lineStart: number, cutPos: number): number {
  const { text } = m;
  for (let p = cutPos; p > lineStart; p -= 1) {
    // Never break inside an atomic math object
    const runIdxBefore = m.runAt[p - 1];
    const runIdxAfter = m.runAt[p];
    if (
      runIdxBefore !== undefined &&
      runIdxAfter !== undefined &&
      runIdxBefore === runIdxAfter &&
      (m.formats[runIdxBefore]?.mathLatex || isImageFormatting(m.formats[runIdxBefore]!))
    ) {
      continue;
    }

    const before = text[p - 1]!;
    if (isBlank(before)) return p;

    const after = text[p];
    if (after === undefined) continue;
    if (NO_LINE_START.includes(after)) continue;

    if (before === '-' || before === '/' || before === '–' || before === '—') {
      // Do not break "12 - 3" right after the hyphen of an isolated numeric range: the break is correct
      // there, but not in the middle of a negative number stuck to its sign.
      return p;
    }
    if (isCjk(before.codePointAt(0) ?? 0) || isCjk(after.codePointAt(0) ?? 0)) return p;
  }
  return -1;
}

/** Next tab stop strictly to the right of `x`. */
function nextTabStop(x: number, tabStopPx: number): number {
  return (Math.floor(x / tabStopPx) + 1) * tabStopPx;
}

/** Moves forward by at least one grapheme cluster, to guarantee progress. */
function advanceOneGrapheme(text: string, from: number): number {
  const code = text.codePointAt(from);
  if (code === undefined) return from + 1;
  return from + (code > 0xffff ? 2 : 1);
}

interface LineBreakResult {
  /** End of the painted content, trailing spaces removed. */
  endOffset: number;
  /** Start of the next line. */
  nextOffset: number;
  /**
   * Nothing fitted: the cut was forced (a single cluster, or a word longer than the room). A band
   * on the left of a frame then gives up its place and the word jumps over the frame.
   */
  forced?: true;
  /** The line stops on a deliberate line break (`\n`): nothing more goes on it, frame or not. */
  hard?: true;
}

/**
 * Decides where to cut the line that begins at `lineStart`.
 *
 * `startX` makes it possible to resume after a tab: the available width is no longer the whole line
 * but what is left of it.
 */
function breakLine(
  m: ParagraphMetrics,
  lineStart: number,
  available: number,
  tabStopPx: number,
): LineBreakResult {
  const { text } = m;
  const total = text.length;
  let pos = lineStart;
  let x = 0;

  for (;;) {
    // The current piece stops at the next tab, the next line break, or the end of the paragraph.
    let stop = total;
    for (let i = pos; i < total; i += 1) {
      const char = text[i]!;
      if (char === '\t' || char === '\n') {
        stop = i;
        break;
      }
    }

    const chunkWidth = width(m, pos, stop);

    if (x + chunkWidth > available) {
      return breakInsideChunk(m, lineStart, pos, stop, available - x);
    }

    x += chunkWidth;
    pos = stop;

    if (pos >= total) return { endOffset: total, nextOffset: total };

    const char = text[pos]!;
    if (char === '\n') {
      // Deliberate line break (`SwBreakPortion`): the line stops before it, and the character itself is
      // not painted.
      return { endOffset: pos, nextOffset: pos + 1, hard: true };
    }

    // Tab: advance to the next tab stop. If the tab stop falls outside the line, the tab itself causes
    // the wrap to the next line.
    const tabX = nextTabStop(x, tabStopPx);
    if (tabX > available) {
      return pos > lineStart
        ? { endOffset: pos, nextOffset: pos + 1 }
        : { endOffset: pos + 1, nextOffset: pos + 1, forced: true };
    }
    x = tabX;
    pos += 1;
  }
}

/** Steps 2 to 5 of `SwTxtGuess::Guess`, applied to a piece with no tab. */
function breakInsideChunk(
  m: ParagraphMetrics,
  lineStart: number,
  chunkStart: number,
  chunkEnd: number,
  available: number,
): LineBreakResult {
  const { text } = m;
  let cutPos = fittingEnd(m, chunkStart, chunkEnd, Math.max(0, available));

  // A column so narrow that not one character fits: advance by one cluster anyway. Without this guard
  // the line would be empty and the calling loop would never make progress.
  if (cutPos <= lineStart) {
    cutPos = advanceOneGrapheme(text, lineStart);
    return { ...cutAt(m, lineStart, chunkEnd, cutPos), forced: true };
  }
  return cutAt(m, lineStart, chunkEnd, cutPos);
}

/** Where the line ends once `cutPos`, the first offset that no longer fits, is known. */
function cutAt(
  m: ParagraphMetrics,
  lineStart: number,
  chunkEnd: number,
  cutPos: number,
): LineBreakResult {
  const { text } = m;
  if (cutPos >= chunkEnd) return { endOffset: chunkEnd, nextOffset: chunkEnd };

  // If cutPos falls in the middle of an atomic object (a formula or an image frame), cut **before** the
  // object rather than inside it.
  const cutRunIdx = m.runAt[cutPos];
  if (
    cutRunIdx !== undefined &&
    (m.formats[cutRunIdx]?.mathLatex || isImageFormatting(m.formats[cutRunIdx]!))
  ) {
    let mathStart = cutPos;
    while (mathStart > 0 && m.runAt[mathStart - 1] === cutRunIdx) mathStart -= 1;
    if (mathStart > lineStart) {
      let endOffset = mathStart;
      while (endOffset > lineStart && isBlank(text[endOffset - 1]!)) endOffset -= 1;
      return { endOffset, nextOffset: mathStart };
    }
  }

  const cutChar = text[cutPos]!;

  if (isBlank(cutChar)) {
    // Space at the cut: step back over the trailing spaces, which overflow into the margin without
    // counting toward the width...
    let endOffset = cutPos;
    while (endOffset > lineStart && isBlank(text[endOffset - 1]!)) endOffset -= 1;
    // ...then swallow those that follow, so that the next line starts on a visible character.
    let nextOffset = cutPos;
    while (nextOffset < text.length && isBlank(text[nextOffset]!)) nextOffset += 1;
    return { endOffset, nextOffset };
  }

  const breakPos = findBreakOpportunity(m, lineStart, cutPos);
  if (breakPos > lineStart) {
    let endOffset = breakPos;
    while (endOffset > lineStart && isBlank(text[endOffset - 1]!)) endOffset -= 1;
    return { endOffset, nextOffset: breakPos };
  }

  // No break opportunity: a word longer than the line, forced break.
  const forced = Math.max(cutPos, advanceOneGrapheme(text, lineStart));
  return { endOffset: forced, nextOffset: forced, forced: true };
}

/** Builds the painted segments of a line, with tabs resolved. */
function buildSegments(
  m: ParagraphMetrics,
  startOffset: number,
  endOffset: number,
  originX: number,
  tabStopPx: number,
): { segments: LayoutSegment[]; widthPx: number } {
  const segments: LayoutSegment[] = [];
  let x = 0;
  let pos = startOffset;

  while (pos < endOffset) {
    const char = m.text[pos]!;

    if (char === '\t') {
      const target = nextTabStop(x, tabStopPx);
      const runIndex = m.runAt[pos]!;
      segments.push({
        startOffset: pos,
        endOffset: pos + 1,
        text: '\t',
        formatting: m.formats[runIndex] ?? {},
        font: m.fonts[runIndex]!,
        color: m.colors[runIndex]!,
        leftPx: originX + x,
        widthPx: target - x,
        isTab: true,
      });
      x = target;
      pos += 1;
      continue;
    }

    // A segment runs up to the change of run, the next tab, or the end of the line, whichever of the
    // three comes first.
    const runIndex = m.runAt[pos]!;
    let stop = pos + 1;
    while (stop < endOffset && m.runAt[stop] === runIndex && m.text[stop] !== '\t') stop += 1;

    const segmentWidth = width(m, pos, stop);
    segments.push({
      startOffset: pos,
      endOffset: stop,
      text: m.text.slice(pos, stop),
      formatting: m.formats[runIndex] ?? {},
      font: m.fonts[runIndex]!,
      color: m.colors[runIndex]!,
      leftPx: originX + x,
      widthPx: segmentWidth,
      isTab: false,
      ...(m.captionHeights[runIndex] ? { captionHeightPx: m.captionHeights[runIndex] } : {}),
    });
    x += segmentWidth;
    pos = stop;
  }

  if (segments.length === 0) {
    // Empty line: a zero-width segment still carries the font, which gives the cursor its height and the
    // next keystroke its formatting. An empty paragraph always keeps a run (see `normalizeRuns`), so
    // `fonts[0]` exists: there is no font-less case to cover.
    const runIndex = Math.max(0, Math.min(m.fonts.length - 1, m.runAt[startOffset] ?? 0));
    segments.push({
      startOffset,
      endOffset: startOffset,
      text: '',
      formatting: m.formats[runIndex] ?? {},
      font: m.fonts[runIndex]!,
      color: m.colors[runIndex] ?? '#000000',
      leftPx: originX,
      widthPx: 0,
      isTab: false,
    });
  }

  return { segments, widthPx: x };
}

/** Height and baseline of a line: the largest of the runs that make it up. */
function lineHeightOf(
  m: ParagraphMetrics,
  startOffset: number,
  endOffset: number,
  spacing: number,
): { heightPx: number; ascentPx: number } {
  const first = m.runAt[startOffset] ?? 0;
  let ascent = m.metrics[first]?.ascentPx ?? 0;
  let natural = m.metrics[first]?.naturalLineHeightPx ?? 0;

  for (let i = startOffset; i < endOffset; i += 1) {
    const metrics = m.metrics[m.runAt[i]!];
    if (!metrics) continue;
    if (metrics.ascentPx > ascent) ascent = metrics.ascentPx;
    if (metrics.naturalLineHeightPx > natural) natural = metrics.naturalLineHeightPx;
  }

  const heightPx = natural * spacing;
  // The extra line spacing goes **above** the text, like the "leading" of a font: the baseline moves
  // down by as much.
  return { heightPx, ascentPx: ascent + (heightPx - natural) / 2 };
}

/** No frames: a shared constant, to avoid one allocation per paragraph. */
const EMPTY_EXCLUSIONS: readonly FlyExclusion[] = [];

/**
 * Maximum number of successive moves down below blocking frames.
 *
 * A safety guard, not a functional limit: `nextClearY` progresses strictly, so the loop always ends.
 * It bounds the cost of a pathological document that stacks dozens of `surround: none` frames in the
 * same place.
 */
const MAX_FLY_DESCENTS = 64;

/**
 * *Probable* height of the line that starts at `offset`, before it is cut.
 *
 * The first character is not enough: a paragraph that holds a floating frame almost always
 * **starts** with its anchor character, which takes no height in the line (`SwFlyCntPortion`
 * never shows, the frame lives on its own layer). Probing with it gave a zero-height line, which
 * no frame ever overlaps: the line then stayed at the top, under the image it should have gone
 * around, and every wrapping mode looked like "in front of the text". The probe therefore takes the
 * first character that does have a height, as the line will once it holds its text.
 */
function probeLineHeight(m: ParagraphMetrics, offset: number, spacing: number): number {
  const total = m.text.length;
  for (let i = offset; i < total; i += 1) {
    const height = lineHeightOf(m, i, i + 1, spacing).heightPx;
    if (height > 0) return height;
  }
  return lineHeightOf(m, offset, Math.min(total, offset + 1), spacing).heightPx;
}

/** A horizontal interval a line may write in, indents already applied. */
interface Band {
  leftPx: number;
  rightPx: number;
}

/**
 * Bands usable by a line, from left to right, cut down to the paragraph's indents. Empty when the
 * frames leave no room at this height: the line then moves down (`nextClearY`).
 *
 * Without frames, a single band: the column between the indents, as before frames existed.
 */
function resolveBands(
  exclusions: readonly FlyExclusion[],
  hasExclusions: boolean,
  topPx: number,
  heightPx: number,
  contentWidthPx: number,
  indentLeftPx: number,
  indentRightPx: number,
): Band[] {
  const minLeft = indentLeftPx;
  const maxRight = contentWidthPx - indentRightPx;
  if (!hasExclusions) return [{ leftPx: minLeft, rightPx: maxRight }];

  const free = usableBands(exclusions, topPx, topPx + Math.max(1, heightPx), contentWidthPx);
  if (free.length === 0) return [];

  const clipped = free
    .map((band) => ({
      leftPx: Math.max(minLeft, band.leftPx),
      rightPx: Math.min(maxRight, band.rightPx),
    }))
    .filter((band) => band.rightPx - band.leftPx >= MIN_BAND_WIDTH_PX);
  if (clipped.length > 0) return clipped;

  // The indents swallow every band: keep the widest, as narrow as it is, rather than push the line
  // down below a frame that does not actually block it.
  let widest = free[0]!;
  for (const band of free) {
    if (band.rightPx - band.leftPx > widest.rightPx - widest.leftPx) widest = band;
  }
  return [{ leftPx: Math.max(minLeft, widest.leftPx), rightPx: Math.min(maxRight, widest.rightPx) }];
}

function sameBands(a: readonly Band[], b: readonly Band[]): boolean {
  return (
    a.length === b.length &&
    a.every((band, i) => band.leftPx === b[i]!.leftPx && band.rightPx === b[i]!.rightPx)
  );
}

/** A piece of a line: the text that goes into one band. */
interface LinePiece {
  band: Band;
  /** First-line indent carried by this piece (only the first piece of the first line has one). */
  indentPx: number;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
}

/**
 * Fills the bands of a line, from left to right, starting at `offset`.
 *
 * Port of what `SwTxtFormatter::BuildPortions` does around a `SwFlyPortion`
 * (`sw/source/core/text/itrform2.cxx`, `CalcFlyWidth`): the text fills the band on the left of the
 * frame, the frame is jumped over, and the **same** line goes on in the band on its right. A word
 * that does not fit into a band before a frame is not cut: it jumps over the frame with the rest.
 *
 * A deliberate line break ends the line wherever it falls, as it does in Writer.
 */
function fillBands(
  m: ParagraphMetrics,
  bands: readonly Band[],
  offset: number,
  extraIndentPx: number,
  tabStopPx: number,
): LinePiece[] {
  const total = m.text.length;
  const pieces: LinePiece[] = [];
  let pos = offset;

  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i]!;
    const indentPx = pieces.length === 0 ? extraIndentPx : 0;
    const available = Math.max(1, band.rightPx - band.leftPx - indentPx);
    const broken = breakLine(m, pos, available, tabStopPx);

    // Nothing fits before the frame: the band stays empty and the text resumes after the frame.
    if (broken.forced && i < bands.length - 1) continue;

    pieces.push({ band, indentPx, startOffset: pos, endOffset: broken.endOffset, nextOffset: broken.nextOffset });
    pos = broken.nextOffset;
    if (broken.hard || pos >= total) break;
  }

  if (pieces.length > 0) return pieces;

  // Unreachable in practice (the last band always takes something), kept so the caller never
  // receives an empty line: the widest band, forced cut included.
  let widest = bands[0]!;
  for (const band of bands) {
    if (band.rightPx - band.leftPx > widest.rightPx - widest.leftPx) widest = band;
  }
  const available = Math.max(1, widest.rightPx - widest.leftPx - extraIndentPx);
  const broken = breakLine(m, offset, available, tabStopPx);
  return [{ band: widest, indentPx: extraIndentPx, startOffset: offset, endOffset: broken.endOffset, nextOffset: broken.nextOffset }];
}

/** X coordinate of the left edge of the line, alignment applied. */
function alignLine(
  alignment: Alignment,
  lineWidth: number,
  available: number,
  indentLeftPx: number,
  firstLineIndentPx: number,
): number {
  const base = indentLeftPx + firstLineIndentPx;
  switch (alignment) {
    case 'center':
      return base + Math.max(0, available - lineWidth) / 2;
    case 'right':
      return base + Math.max(0, available - lineWidth);
    case 'left':
    case 'justify':
    default:
      return base;
  }
}

/**
 * Paints the pieces of a line: segments, alignment and justification, band by band.
 *
 * A line in a single piece comes out exactly as before frames could cut it. A line cut by a frame
 * gets, between two pieces, a `flyGap` segment as wide as the jump over the frame, and each piece
 * is aligned and justified **within its own band**: Writer stretches the text on the left of a
 * frame up to the frame, not up to the margin.
 */
function placePieces(
  m: ParagraphMetrics,
  pieces: readonly LinePiece[],
  alignment: Alignment,
  isLast: boolean,
  tabStopPx: number,
): { segments: LayoutSegment[]; leftPx: number; widthPx: number; wordSpacingPx: number } {
  const justifies = (i: number) => alignment === 'justify' && (!isLast || i < pieces.length - 1);

  if (pieces.length === 1) {
    const piece = pieces[0]!;
    const available = Math.max(1, piece.band.rightPx - piece.band.leftPx - piece.indentPx);
    const { segments, widthPx } = buildSegments(m, piece.startOffset, piece.endOffset, 0, tabStopPx);
    const leftPx = alignLine(alignment, widthPx, available, piece.band.leftPx, piece.indentPx);

    // Justification: the extra space is spread over the blanks of the line. The last line of a paragraph is
    // excluded, otherwise a lone word would be stretched across the full width.
    let wordSpacingPx = 0;
    if (justifies(0)) {
      const gaps = countBlanks(m.text, piece.startOffset, piece.endOffset);
      if (gaps > 0) wordSpacingPx = Math.max(0, (available - widthPx) / gaps);
    }

    for (const segment of segments) segment.leftPx += leftPx;
    return { segments, leftPx, widthPx, wordSpacingPx };
  }

  const segments: LayoutSegment[] = [];
  let lineLeftPx = 0;
  /** Painted right edge of the previous piece, stretch included. */
  let paintedEndPx = 0;

  pieces.forEach((piece, i) => {
    const available = Math.max(1, piece.band.rightPx - piece.band.leftPx - piece.indentPx);
    const built = buildSegments(m, piece.startOffset, piece.endOffset, 0, tabStopPx);
    const pieceLeftPx = alignLine(alignment, built.widthPx, available, piece.band.leftPx, piece.indentPx);

    let spacingPx = 0;
    if (justifies(i)) {
      const gaps = countBlanks(m.text, piece.startOffset, piece.endOffset);
      if (gaps > 0) spacingPx = Math.max(0, (available - built.widthPx) / gaps);
    }

    if (i === 0) {
      lineLeftPx = pieceLeftPx;
    } else {
      // The jump over the frame (`SwFlyPortion`): from where the previous piece stops being painted
      // to where this one starts. It carries the font of what follows, for the cursor's height.
      const runIndex = Math.max(0, Math.min(m.fonts.length - 1, m.runAt[piece.startOffset] ?? m.fonts.length - 1));
      segments.push({
        startOffset: piece.startOffset,
        endOffset: piece.startOffset,
        text: '',
        formatting: {},
        font: m.fonts[runIndex]!,
        color: m.colors[runIndex] ?? '#000000',
        leftPx: paintedEndPx,
        widthPx: Math.max(0, pieceLeftPx - paintedEndPx),
        isTab: true,
        flyGap: true,
      });
    }

    // Each segment sits where it is really painted: after the stretch of the blanks before it.
    let stretchPx = 0;
    for (const segment of built.segments) {
      segment.leftPx += pieceLeftPx + stretchPx;
      segment.wordSpacingPx = spacingPx;
      stretchPx += countBlanks(segment.text, 0, segment.text.length) * spacingPx;
      segments.push(segment);
    }
    paintedEndPx = (i === 0 ? pieceLeftPx : Math.max(paintedEndPx, pieceLeftPx)) + built.widthPx + stretchPx;
  });

  // Measured width, so that `leftPx` + width + the stretch of every blank lands on the painted
  // right edge, as for a line in a single piece.
  const widthPx = segments.reduce((sum, segment) => sum + segment.widthPx, 0);
  return { segments, leftPx: lineLeftPx, widthPx, wordSpacingPx: 0 };
}

/**
 * Lays out a paragraph: splitting into lines, heights, alignment.
 *
 * A pure function: it is what makes the engine runnable in a Web Worker or in a server environment
 * without direct DOM access.
 */
export function layoutParagraph(
  paragraph: ParagraphNode,
  ctx: LayoutContext,
): ParagraphLayout {
  const tabStopPx = ctx.tabStopPx ?? DEFAULT_TAB_STOP_PX;
  const metrics = measureParagraph(paragraph, ctx);

  const spacing = resolveLineSpacing(paragraph, ctx);
  const { topPt, bottomPt } = resolveBlockSpacing(paragraph, ctx);
  const alignment: Alignment = resolveAlignment(paragraph, ctx);

  const indentLeftPx = ptToPx(effectiveIndentLeftPt(paragraph));
  const indentRightPx = ptToPx(paragraph.indentRightPt ?? 0);
  const firstLineIndentPx = ptToPx(paragraph.firstLineIndentPt ?? 0);

  const lines: LayoutLine[] = [];
  const total = metrics.text.length;
  let offset = 0;
  let top = 0;
  let index = 0;

  // Floating frames crossing this paragraph. The usual case, none, short-circuits the whole band
  // computation below.
  const exclusions = ctx.exclusions ?? EMPTY_EXCLUSIONS;
  const hasExclusions = exclusions.length > 0;

  do {
    const isFirst = index === 0;
    const extraIndent = isFirst ? firstLineIndentPx : 0;

    // *Probable* height of the line, before knowing what it will contain: the usable bands depend on
    // the vertical extent of the line, which depends on its content, which depends on the bands. Writer
    // settles the circularity the same way (`SwTxtFrm::FormatLine`): we estimate, we cut, and we only start
    // again once if the estimate turned out too low.
    let probeHeight = probeLineHeight(metrics, offset, spacing);
    const bandsAt = (y: number, height: number): Band[] =>
      resolveBands(exclusions, hasExclusions, y, height, ctx.contentWidthPx, indentLeftPx, indentRightPx);
    let bands = bandsAt(top, probeHeight);

    // No usable band: the line moves down below the frame that blocks it.
    let guard = 0;
    while (bands.length === 0 && guard < MAX_FLY_DESCENTS) {
      const clear = nextClearY(exclusions, top, top + Math.max(1, probeHeight));
      if (clear === null || clear <= top) break;
      top = clear;
      bands = bandsAt(top, probeHeight);
      guard += 1;
    }
    if (bands.length === 0) bands = [{ leftPx: indentLeftPx, rightPx: ctx.contentWidthPx - indentRightPx }];

    let pieces = fillBands(metrics, bands, offset, extraIndent, tabStopPx);
    const measure = (from: readonly LinePiece[]) =>
      lineHeightOf(metrics, offset, Math.max(offset + 1, from[from.length - 1]!.endOffset), spacing);
    let measured = measure(pieces);

    // The line turned out taller than the estimate (an inline image, a formula) and may therefore cross a
    // frame that the bands ignored. A single retry is enough: the second estimate is exact.
    if (hasExclusions && measured.heightPx > probeHeight) {
      probeHeight = measured.heightPx;
      const retry = bandsAt(top, probeHeight);
      if (retry.length > 0 && !sameBands(retry, bands)) {
        bands = retry;
        pieces = fillBands(metrics, bands, offset, extraIndent, tabStopPx);
        measured = measure(pieces);
      }
    }

    const lastPiece = pieces[pieces.length - 1]!;
    const endOffset = lastPiece.endOffset;
    const nextOffset = lastPiece.nextOffset;
    const isLast = nextOffset >= total;

    const { segments, leftPx, widthPx, wordSpacingPx } = placePieces(
      metrics,
      pieces,
      alignment,
      isLast,
      tabStopPx,
    );
    const { heightPx, ascentPx } = measured;

    lines.push({
      index,
      startOffset: offset,
      endOffset,
      nextOffset,
      segments,
      leftPx,
      widthPx,
      heightPx,
      ascentPx,
      topPx: top,
      wordSpacingPx,
      isLast,
    });

    top += heightPx;
    index += 1;
    // `nextOffset` always moves forward, except at the end of the paragraph: the guard prevents the
    // infinite loop a split without progress would cause.
    if (nextOffset <= offset && nextOffset < total) break;
    offset = nextOffset;
  } while (offset < total);

  const marginTopPx = ptToPx(topPt);
  const marginBottomPx = ptToPx(bottomPt);

  return {
    blockId: paragraph.id,
    lines,
    marker: buildMarker(paragraph, ctx, indentLeftPx),
    marginTopPx,
    marginBottomPx,
    contentHeightPx: top,
    heightPx: top + marginTopPx + marginBottomPx,
    alignment,
  };
}

/**
 * Geometry of the list marker.
 *
 * It is placed **outside** the text, one step to the left: this is Writer's default layout, where the
 * number occupies the indent of the previous level and the text starts at that of its own level. The
 * marker therefore does not take part in line wrapping: it never competes with the text.
 */
function buildMarker(
  paragraph: ParagraphNode,
  ctx: LayoutContext,
  indentLeftPx: number,
): LayoutMarker | null {
  const marker = ctx.marker;
  if (!marker) return null;

  const first = paragraph.runs[0];
  const formatting = first ? runFormatting(first) : {};
  // The marker follows the font of the text but never its bold or italic: an italic bullet makes no
  // sense, and Writer does not carry them over either.
  const font = { ...resolveFont(formatting, paragraph, ctx), bold: false, italic: false };

  return {
    kind: marker.kind,
    text: marker.text,
    checked: marker.checked,
    leftPx: Math.max(0, indentLeftPx - ptToPx(LIST_INDENT_PT)),
    widthPx: ptToPx(LIST_INDENT_PT),
    font,
    color: resolveColor(formatting, ctx, paragraph),
  };
}

function countBlanks(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) if (isBlank(text[i]!)) count += 1;
  return count;
}
