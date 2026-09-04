/**
 * Unités de mise en page.
 *
 * Writer calcule en **twips** (1/1440 pouce) parce qu'il vise l'impression.
 * Ici la cible est l'écran : on calcule en **pixels CSS**, dont la définition
 * est justement métrique (96 px = 1 pouce), donc la conversion reste exacte et
 * le rendu à l'impression suit sans facteur d'échelle supplémentaire.
 */

export const PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
/** 1 twip = 1/1440 pouce — l'unité interne de Writer, utile aux imports ODF. */
export const TWIPS_PER_INCH = 1440;

export function mmToPx(mm: number): number {
  return (mm * PX_PER_INCH) / MM_PER_INCH;
}

export function pxToMm(px: number): number {
  return (px * MM_PER_INCH) / PX_PER_INCH;
}

export function ptToPx(pt: number): number {
  return (pt * PX_PER_INCH) / PT_PER_INCH;
}

export function pxToPt(px: number): number {
  return (px * PT_PER_INCH) / PX_PER_INCH;
}

export function mmToPt(mm: number): number {
  return (mm * PT_PER_INCH) / MM_PER_INCH;
}

export function ptToMm(pt: number): number {
  return (pt * MM_PER_INCH) / PT_PER_INCH;
}

export function twipsToPx(twips: number): number {
  return (twips * PX_PER_INCH) / TWIPS_PER_INCH;
}

export function cmToPx(cm: number): number {
  return mmToPx(cm * 10);
}
