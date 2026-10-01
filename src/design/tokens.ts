// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/** Miroir TypeScript des jetons ayant besoin d'être lus par le code. */

/** Nombre de couleurs de présence exposées par `tokens.css`. */
export const PRESENCE_COLOR_COUNT = 8;

export const A4 = {
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 25,
  marginBottomMm: 25,
  marginLeftMm: 25,
  marginRightMm: 25,
} as const;
