// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * The document palette: generated, not copied.
 *
 * A hand-written palette drifts: the shades stop being consistent from one hue to the next and the names become approximate.
 * Here there is one base hue per column and shared lightness levels, so:
 *  - an identical visual rhythm in every column;
 *  - an **accessible name derived automatically** for each of the 80 swatches (a swatch with no name is unusable with a screen
 *    reader).
 */

import { hslToRgb, toHex } from './color';

export interface Swatch {
  value: string;
  name: string;
}

interface BaseHue {
  name: string;
  hue: number;
  saturation: number;
  /** Lightness of the "pure" row. */
  lightness: number;
}

/** Ten columns, like the usual office palettes. */
const BASE_HUES: readonly BaseHue[] = [
  { name: 'Rouge', hue: 0, saturation: 0.78, lightness: 0.5 },
  { name: 'Orange', hue: 24, saturation: 0.85, lightness: 0.5 },
  { name: 'Jaune', hue: 45, saturation: 0.9, lightness: 0.5 },
  // "Vert pomme" (apple green) and not "Vert clair" (light green): the latter would collide with the light shade of the "Vert"
  // (green) column, and two swatches with the same name cannot be told apart by a screen reader.
  { name: 'Vert pomme', hue: 90, saturation: 0.6, lightness: 0.42 },
  { name: 'Vert', hue: 140, saturation: 0.6, lightness: 0.38 },
  { name: 'Turquoise', hue: 178, saturation: 0.62, lightness: 0.38 },
  { name: 'Bleu ciel', hue: 205, saturation: 0.72, lightness: 0.45 },
  { name: 'Bleu', hue: 222, saturation: 0.72, lightness: 0.46 },
  { name: 'Violet', hue: 270, saturation: 0.52, lightness: 0.48 },
  { name: 'Magenta', hue: 320, saturation: 0.65, lightness: 0.48 },
];

/** Lightness levels, from lightest to darkest, applied to every column. */
const LEVELS: readonly { suffix: string; lightness: number | null }[] = [
  { suffix: 'très clair', lightness: 0.88 },
  { suffix: 'clair', lightness: 0.76 },
  { suffix: 'pâle', lightness: 0.64 },
  { suffix: '', lightness: null }, // pure row: the hue's own lightness
  { suffix: 'foncé', lightness: 0.36 },
  { suffix: 'très foncé', lightness: 0.26 },
  { suffix: 'profond', lightness: 0.17 },
];

/** First row: a gradient of greys, from black to white. */
function greyRow(): Swatch[] {
  const steps = [
    { name: 'Noir', l: 0 },
    { name: 'Gris très foncé', l: 0.13 },
    { name: 'Gris foncé', l: 0.26 },
    { name: 'Gris', l: 0.4 },
    { name: 'Gris moyen', l: 0.53 },
    { name: 'Gris clair', l: 0.66 },
    { name: 'Gris très clair', l: 0.78 },
    { name: 'Gris pâle', l: 0.87 },
    { name: 'Blanc cassé', l: 0.95 },
    { name: 'Blanc', l: 1 },
  ];
  return steps.map(({ name, l }) => ({ name, value: toHex(hslToRgb(0, 0, l)) }));
}

function hueRow(level: (typeof LEVELS)[number]): Swatch[] {
  return BASE_HUES.map((base) => {
    const lightness = level.lightness ?? base.lightness;
    // Very light or very dark shades are desaturated: without that, a "deep yellow" turns green and a "very light blue" becomes
    // neon.
    const distance = Math.abs(lightness - base.lightness);
    const saturation = Math.max(0.18, base.saturation - distance * 0.35);

    return {
      value: toHex(hslToRgb(base.hue, saturation, lightness)),
      name: level.suffix ? `${base.name} ${level.suffix}` : base.name,
    };
  });
}

/** The full grid: 8 rows × 10 columns. */
export const DOCUMENT_PALETTE: readonly Swatch[][] = [greyRow(), ...LEVELS.map(hueRow)];

/** Highlighters: light hues only, so they stay readable under text. */
export const HIGHLIGHT_PALETTE: readonly Swatch[][] = [
  [
    { value: '#fff3a3', name: 'Jaune' },
    { value: '#c7f0d2', name: 'Vert' },
    { value: '#cfe4ff', name: 'Bleu' },
    { value: '#e2d6fb', name: 'Violet' },
    { value: '#ffd6e0', name: 'Rose' },
  ],
  [
    { value: '#ffe0c2', name: 'Orange' },
    { value: '#d8f3f6', name: 'Turquoise' },
    { value: '#ffffff', name: 'Blanc' },
    { value: '#e6e8eb', name: 'Gris clair' },
    { value: '#f7c9c9', name: 'Rouge pâle' },
  ],
];

/** Name of an arbitrary color (custom color), for the `aria-label`. */
export function describeColor(hex: string): string {
  const known = DOCUMENT_PALETTE.flat().find(
    (swatch) => swatch.value.toLowerCase() === hex.toLowerCase(),
  );
  return known?.name ?? `Couleur personnalisée ${hex.toUpperCase()}`;
}
