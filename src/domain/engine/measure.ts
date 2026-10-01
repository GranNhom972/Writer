// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Text measurement. (Equivalent of `SwFntObj` / `OutputDevice::GetTextWidth`.)
 *
 * Writer measures through the output device; we measure through a Canvas 2D context, with one
 * more constraint: **our measurement must be the one the browser will render**, otherwise the
 * cursor, computed by the engine, would drift away from the glyphs, painted by the browser.
 *
 * Hence two linked decisions:
 *  1. the width of a text is the **sum of the widths of its grapheme clusters**, cached;
 *  2. the rendering turns off kerning and ligatures (`font-kerning: none`,
 *     `font-variant-ligatures: none`, see editor.css).
 *
 * Without (2), the sum of the individual advances does not equal the rendered width and the gap
 * builds up along the line. With it, the equality is exact, and the engine stays the only judge
 * of the geometry.
 */

/** A resolved font, ready to measure with. */
export interface FontSpec {
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
}

export interface FontMetrics {
  ascentPx: number;
  descentPx: number;
  /** Natural line height of the font, before the paragraph's factor is applied. */
  naturalLineHeightPx: number;
}

export interface TextMeasurer {
  /** Width of a string, in CSS pixels. */
  measure(text: string, font: FontSpec): number;
  /**
   * Cumulative widths: `prefix[i]` = width of `text.slice(0, i)`. Array length:
   * `text.length + 1`.
   */
  prefixWidths(text: string, font: FontSpec): Float64Array;
  metrics(font: FontSpec): FontMetrics;
}

export function fontKey(font: FontSpec): string {
  return `${font.bold ? 'b' : ''}${font.italic ? 'i' : ''}|${font.fontSizePx}|${font.fontFamily}`;
}

/** `font` string in the CSS/Canvas sense. */
export function fontToCss(font: FontSpec): string {
  const style = font.italic ? 'italic ' : '';
  const weight = font.bold ? '700 ' : '400 ';
  return `${style}${weight}${font.fontSizePx}px ${font.fontFamily}`;
}

/**
 * Splitting into grapheme clusters.
 *
 * Measuring per UTF-16 code unit would cut an emoji into two halves with no width of their own.
 * `Intl.Segmenter` gives the real clusters; failing that, iterating by code point already handles
 * surrogate pairs correctly.
 */
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

export function graphemes(text: string): string[] {
  if (text.length === 0) return [];
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

/**
 * Cluster boundaries, as UTF-16 code-unit offsets.
 *
 * Always contains `0` and `text.length`. It is the only table cursor navigation needs: moving
 * means jumping from one boundary to the next, which makes it impossible to cut a composite
 * emoji, and `👨‍👩‍👧` is one: eight code units tied together by zero-width joiners.
 */
export function graphemeBoundaries(text: string): number[] {
  const bounds = [0];
  if (text.length === 0) return bounds;

  if (segmenter) {
    for (const { index, segment } of segmenter.segment(text)) {
      bounds.push(index + segment.length);
    }
    return bounds;
  }

  // Fallback without `Intl.Segmenter`: code points, combining marks and sequences tied by a
  // zero-width joiner.
  let at = 0;
  while (at < text.length) {
    const code = text.codePointAt(at) ?? 0;
    let next = at + (code > 0xffff ? 2 : 1);
    for (;;) {
      const following = text.codePointAt(next);
      if (following === undefined) break;
      if (following === ZWJ) {
        // A joiner welds what follows to the current cluster.
        const joined = text.codePointAt(next + 1);
        if (joined === undefined) break;
        next += 1 + (joined > 0xffff ? 2 : 1);
        continue;
      }
      if (!isCombiningMark(following)) break;
      next += following > 0xffff ? 2 : 1;
    }
    bounds.push(next);
    at = next;
  }
  return bounds;
}

const ZWJ = 0x200d;

function isCombiningMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x1f3fb && code <= 0x1f3ff)
  );
}

/** Common base: cache per font then per cluster, and accumulation of widths. */
abstract class CachingMeasurer implements TextMeasurer {
  private readonly cache = new Map<string, Map<string, number>>();

  protected abstract measureGrapheme(grapheme: string, font: FontSpec): number;

  abstract metrics(font: FontSpec): FontMetrics;

  private widthOf(grapheme: string, font: FontSpec): number {
    const key = fontKey(font);
    let perFont = this.cache.get(key);
    if (!perFont) {
      perFont = new Map();
      this.cache.set(key, perFont);
    }
    const cached = perFont.get(grapheme);
    if (cached !== undefined) return cached;
    const width = this.measureGrapheme(grapheme, font);
    perFont.set(grapheme, width);
    return width;
  }

  measure(text: string, font: FontSpec): number {
    let total = 0;
    for (const grapheme of graphemes(text)) total += this.widthOf(grapheme, font);
    return total;
  }

  prefixWidths(text: string, font: FontSpec): Float64Array {
    const prefix = new Float64Array(text.length + 1);
    let cursor = 0;
    let width = 0;

    for (const grapheme of graphemes(text)) {
      const next = width + this.widthOf(grapheme, font);
      // The positions *inside* a cluster get the width of its start: the cursor therefore cannot land
      // in the middle of an emoji.
      for (let i = 1; i < grapheme.length; i += 1) prefix[cursor + i] = width;
      cursor += grapheme.length;
      prefix[cursor] = next;
      width = next;
    }

    return prefix;
  }
}

/** Real measurement, through a Canvas 2D context. */
export class CanvasTextMeasurer extends CachingMeasurer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(ctx?: CanvasRenderingContext2D) {
    super();
    const context = ctx ?? createCanvasContext();
    if (!context) throw new Error('Canvas 2D indisponible : utiliser MetricTextMeasurer.');
    this.ctx = context;
  }

  protected override measureGrapheme(grapheme: string, font: FontSpec): number {
    this.ctx.font = fontToCss(font);
    return this.ctx.measureText(grapheme).width;
  }

  override metrics(font: FontSpec): FontMetrics {
    this.ctx.font = fontToCss(font);
    // The metrics of the font itself, not those of the measured text: we want a stable line height,
    // independent of the glyphs present.
    const probe = this.ctx.measureText('Hxdp');
    const ascentPx = probe.fontBoundingBoxAscent || probe.actualBoundingBoxAscent
      || font.fontSizePx * 0.8;
    const descentPx = probe.fontBoundingBoxDescent || probe.actualBoundingBoxDescent
      || font.fontSizePx * 0.2;
    return {
      ascentPx,
      descentPx,
      naturalLineHeightPx: ascentPx + descentPx,
    };
  }
}

function createCanvasContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // jsdom provides `getContext` but not always `measureText`: without this check the failure would
  // only appear at the first measurement, far from here.
  return ctx && typeof ctx.measureText === 'function' ? ctx : null;
}

/**
 * Analytical measurement, without Canvas.
 *
 * A table of advances that approximates a serif font. It serves the tests and the Web Worker: the
 * engine must stay runnable where there is no DOM. Widths are expressed as a fraction of an em, so
 * they do not depend on the font size.
 */
const EM_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 0.25, '\u00a0': 0.25 /* non-breaking */, '\t': 1,
  i: 0.278, j: 0.278, l: 0.278, t: 0.278, f: 0.333, r: 0.333, I: 0.333,
  m: 0.778, w: 0.722, M: 0.889, W: 0.944,
  '.': 0.25, ',': 0.25, ';': 0.278, ':': 0.278, "'": 0.18, '"': 0.4,
  '(': 0.333, ')': 0.333, '-': 0.333, '!': 0.333,
};
const EM_DEFAULT_LOWER = 0.5;
const EM_DEFAULT_UPPER = 0.7;
const EM_DEFAULT_OTHER = 0.5;
/** An ideograph takes one full em. */
const EM_WIDE = 1;

export class MetricTextMeasurer extends CachingMeasurer {
  protected override measureGrapheme(grapheme: string, font: FontSpec): number {
    const first = grapheme.codePointAt(0) ?? 32;
    const char = String.fromCodePoint(first);

    let em = EM_WIDTHS[char];
    if (em === undefined) {
      if (first >= 0x1100 && first <= 0x30ff) em = EM_WIDE;
      else if (first >= 0x4e00 && first <= 0x9fff) em = EM_WIDE;
      else if (first >= 0x1f000) em = EM_WIDE;
      else if (char >= 'a' && char <= 'z') em = EM_DEFAULT_LOWER;
      else if (char >= 'A' && char <= 'Z') em = EM_DEFAULT_UPPER;
      else em = EM_DEFAULT_OTHER;
    }

    // Bold widens slightly, italic does not change the advance.
    const weight = font.bold ? 1.04 : 1;
    return em * font.fontSizePx * weight;
  }

  override metrics(font: FontSpec): FontMetrics {
    const ascentPx = font.fontSizePx * 0.891;
    const descentPx = font.fontSizePx * 0.216;
    return { ascentPx, descentPx, naturalLineHeightPx: ascentPx + descentPx };
  }
}

/** Measurer suited to the environment: Canvas if available, otherwise analytical. */
export function createMeasurer(): TextMeasurer {
  const ctx = createCanvasContext();
  return ctx ? new CanvasTextMeasurer(ctx) : new MetricTextMeasurer();
}
