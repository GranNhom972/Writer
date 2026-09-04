/**
 * Longueurs XSL-FO du format OpenDocument.
 *
 * ODF hérite ses unités de XSL-FO : une valeur est un nombre suivi de son
 * unité (`2.54cm`, `12pt`, `1in`). Writer les convertit en twips à la lecture
 * (`sax::Converter::convertMeasure`) ; on convertit en **points**, l'unité dans
 * laquelle le modèle exprime déjà corps de police, marges et retraits.
 */

import { MM_PER_INCH, PT_PER_INCH, PX_PER_INCH, ptToMm } from '../document/units';

const LENGTH = /^\s*(-?\d+(?:\.\d+)?)\s*(cm|mm|in|pt|pc|px|twip)?\s*$/i;

/** Facteurs vers le point typographique (1 pt = 1/72 pouce). */
const TO_POINTS: Readonly<Record<string, number>> = {
  pt: 1,
  pc: 12,
  in: PT_PER_INCH,
  cm: (PT_PER_INCH * 10) / MM_PER_INCH,
  mm: PT_PER_INCH / MM_PER_INCH,
  // Le pixel d'ODF est celui de CSS : 96 par pouce.
  px: PT_PER_INCH / PX_PER_INCH,
  twip: 1 / 20,
};

/** Convertit une longueur ODF en points, ou `null` si la valeur est illisible. */
export function parseLengthPt(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = LENGTH.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const factor = TO_POINTS[(match[2] ?? 'pt').toLowerCase()];
  return factor === undefined ? null : amount * factor;
}

export function parseLengthMm(value: string | null | undefined): number | null {
  const pt = parseLengthPt(value);
  return pt === null ? null : ptToMm(pt);
}

/** Sérialise en centimètres — l'unité qu'écrit Writer dans ses fichiers. */
export function formatCm(pt: number): string {
  return `${round(ptToMm(pt) / 10)}cm`;
}

export function formatPt(pt: number): string {
  return `${round(pt)}pt`;
}

export function formatMmAsCm(mm: number): string {
  return `${round(mm / 10)}cm`;
}

/** Pourcentage ODF (`150%`) vers facteur (`1.5`). */
export function parsePercent(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount / 100 : null;
}

function round(value: number): string | number {
  // Quatre décimales : la précision de Writer dans ses propres fichiers, et
  // assez pour qu'un aller-retour ne dérive pas visiblement.
  return Number(value.toFixed(4));
}
