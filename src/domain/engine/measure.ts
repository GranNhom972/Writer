/**
 * Mesure du texte. Équivalent de `SwFntObj` / `OutputDevice::GetTextWidth`.
 *
 * Writer mesure via le périphérique de sortie ; nous mesurons via un contexte
 * Canvas 2D, avec une contrainte de plus : **notre mesure doit être celle que le
 * navigateur rendra**, sinon le curseur, calculé par le moteur, dériverait des
 * glyphes, peints par le navigateur.
 *
 * D'où deux décisions liées :
 *  1. la largeur d'un texte est la **somme des largeurs de ses grappes de
 *     graphèmes**, mises en cache ;
 *  2. le rendu désactive crénage et ligatures (`font-kerning: none`,
 *     `font-variant-ligatures: none`, cf. editor.css).
 *
 * Sans (2), la somme des avances individuelles ne vaut pas la largeur rendue et
 * l'écart s'accumule le long de la ligne. Avec, l'égalité est exacte, et le
 * moteur reste seul juge de la géométrie.
 */

/** Fonte résolue, prête à mesurer. */
export interface FontSpec {
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
}

export interface FontMetrics {
  ascentPx: number;
  descentPx: number;
  /** Interligne naturelle de la fonte, avant application du facteur du paragraphe. */
  naturalLineHeightPx: number;
}

export interface TextMeasurer {
  /** Largeur d'une chaîne, en pixels CSS. */
  measure(text: string, font: FontSpec): number;
  /**
   * Largeurs cumulées : `prefix[i]` = largeur de `text.slice(0, i)`.
   * Longueur du tableau : `text.length + 1`.
   */
  prefixWidths(text: string, font: FontSpec): Float64Array;
  metrics(font: FontSpec): FontMetrics;
}

export function fontKey(font: FontSpec): string {
  return `${font.bold ? 'b' : ''}${font.italic ? 'i' : ''}|${font.fontSizePx}|${font.fontFamily}`;
}

/** Chaîne `font` au sens CSS/Canvas. */
export function fontToCss(font: FontSpec): string {
  const style = font.italic ? 'italic ' : '';
  const weight = font.bold ? '700 ' : '400 ';
  return `${style}${weight}${font.fontSizePx}px ${font.fontFamily}`;
}

/**
 * Découpe en grappes de graphèmes.
 *
 * Mesurer par unité de code UTF-16 couperait un emoji en deux moitiés sans
 * largeur propre. `Intl.Segmenter` donne les vraies grappes ; à défaut, itérer
 * par point de code traite déjà correctement les paires de substitution.
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
 * Frontières de grappes, en offsets d'unités de code UTF-16.
 *
 * Contient toujours `0` et `text.length`. C'est la seule table dont a besoin la
 * navigation au curseur : se déplacer, c'est sauter d'une frontière à la
 * suivante, ce qui rend impossible de couper un emoji composé — et `👨‍👩‍👧`
 * en est un, huit unités de code liées par des jointeurs sans chasse.
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

  // Repli sans `Intl.Segmenter` : points de code, marques combinantes et
  // séquences liées par un jointeur de largeur nulle.
  let at = 0;
  while (at < text.length) {
    const code = text.codePointAt(at) ?? 0;
    let next = at + (code > 0xffff ? 2 : 1);
    for (;;) {
      const following = text.codePointAt(next);
      if (following === undefined) break;
      if (following === ZWJ) {
        // Un jointeur soude ce qui suit à la grappe courante.
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

/** Socle commun : cache par fonte puis par grappe, et cumul des largeurs. */
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
      // Les positions *à l'intérieur* d'une grappe reçoivent la largeur de son
      // début : le curseur ne peut donc pas se poser au milieu d'un emoji.
      for (let i = 1; i < grapheme.length; i += 1) prefix[cursor + i] = width;
      cursor += grapheme.length;
      prefix[cursor] = next;
      width = next;
    }

    return prefix;
  }
}

/** Mesure réelle, par contexte Canvas 2D. */
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
    // Les métriques de la fonte elle-même, pas celles du texte mesuré : on veut
    // une hauteur de ligne stable, indépendante des glyphes présents.
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
  // jsdom fournit `getContext` mais pas toujours `measureText` : sans cette
  // vérification l'échec surviendrait à la première mesure, loin d'ici.
  return ctx && typeof ctx.measureText === 'function' ? ctx : null;
}

/**
 * Mesure analytique, sans Canvas.
 *
 * Table d'avances approchant une fonte à empattements. Elle sert aux tests et
 * au Web Worker : le moteur doit rester exécutable là où il n'y a pas de DOM,
 * exigence de la couche 2 du cahier des charges. Les largeurs sont exprimées en fraction
 * de cadratin, donc indépendantes du corps.
 */
const EM_WIDTHS: Readonly<Record<string, number>> = {
  ' ': 0.25, '\u00a0': 0.25 /* insécable */, '\t': 1,
  i: 0.278, j: 0.278, l: 0.278, t: 0.278, f: 0.333, r: 0.333, I: 0.333,
  m: 0.778, w: 0.722, M: 0.889, W: 0.944,
  '.': 0.25, ',': 0.25, ';': 0.278, ':': 0.278, "'": 0.18, '"': 0.4,
  '(': 0.333, ')': 0.333, '-': 0.333, '!': 0.333,
};
const EM_DEFAULT_LOWER = 0.5;
const EM_DEFAULT_UPPER = 0.7;
const EM_DEFAULT_OTHER = 0.5;
/** Un idéogramme occupe un cadratin plein. */
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

    // Le gras élargit légèrement, l'italique ne change pas l'avance.
    const weight = font.bold ? 1.04 : 1;
    return em * font.fontSizePx * weight;
  }

  override metrics(font: FontSpec): FontMetrics {
    const ascentPx = font.fontSizePx * 0.891;
    const descentPx = font.fontSizePx * 0.216;
    return { ascentPx, descentPx, naturalLineHeightPx: ascentPx + descentPx };
  }
}

/** Mesureur adapté à l'environnement : Canvas si disponible, sinon analytique. */
export function createMeasurer(): TextMeasurer {
  const ctx = createCanvasContext();
  return ctx ? new CanvasTextMeasurer(ctx) : new MetricTextMeasurer();
}
