// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Lengths of the OpenDocument format (XSL-FO).
 *
 * ODF inherits its units from XSL-FO: a value is a number followed by its unit (`2.54cm`, `12pt`,
 * `1in`). Writer converts them to twips when reading (`sax::Converter::convertMeasure`); we convert to
 * **points**, the unit in which the model already expresses font sizes, margins and indents.
 */

import { MM_PER_INCH, PT_PER_INCH, PX_PER_INCH, ptToMm } from '../document/units';

const LENGTH = /^\s*(-?\d+(?:\.\d+)?)\s*(cm|mm|in|pt|pc|px|twip)?\s*$/i;

/** Factors to the typographic point (1 pt = 1/72 inch). */
const TO_POINTS: Readonly<Record<string, number>> = {
  pt: 1,
  pc: 12,
  in: PT_PER_INCH,
  cm: (PT_PER_INCH * 10) / MM_PER_INCH,
  mm: PT_PER_INCH / MM_PER_INCH,
  // ODF's pixel is the CSS one: 96 per inch.
  px: PT_PER_INCH / PX_PER_INCH,
  twip: 1 / 20,
};

/** Converts an ODF length to points, or `null` if the value is unreadable. */
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

/** Serializes in centimeters, the unit Writer writes in its files. */
export function formatCm(pt: number): string {
  return `${round(ptToMm(pt) / 10)}cm`;
}

export function formatPt(pt: number): string {
  return `${round(pt)}pt`;
}

export function formatMmAsCm(mm: number): string {
  return `${round(mm / 10)}cm`;
}

/** ODF percentage (`150%`) to factor (`1.5`). */
export function parsePercent(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount / 100 : null;
}

function round(value: number): string | number {
  // Four decimals: the precision Writer uses in its own files, and enough for a round trip not to drift
  // visibly.
  return Number(value.toFixed(4));
}
