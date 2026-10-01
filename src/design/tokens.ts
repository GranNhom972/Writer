// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/** TypeScript mirror of the tokens that code needs to read. */

/** Number of presence colors exposed by `tokens.css`. */
export const PRESENCE_COLOR_COUNT = 8;

export const A4 = {
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 25,
  marginBottomMm: 25,
  marginLeftMm: 25,
  marginRightMm: 25,
} as const;
