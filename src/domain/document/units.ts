// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Layout units.
 *
 * Writer computes in **twips** (1/1440 inch) because it targets printing. Here the
 * target is the screen: we compute in **CSS pixels**, whose definition is precisely
 * metric (96 px = 1 inch), so the conversion stays exact and printing follows with no
 * extra scale factor.
 */

export const PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
/** 1 twip = 1/1440 inch: Writer's internal unit, useful for ODF imports. */
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
