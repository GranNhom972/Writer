/**
 * Palette du document — générée, pas recopiée.
 *
 * Une palette écrite à la main dérive : les nuances ne sont plus homogènes d'une
 * teinte à l'autre et les noms deviennent approximatifs. Ici, une teinte de base
 * par colonne, des niveaux de clarté partagés, donc :
 *  - un rythme visuel identique sur chaque colonne ;
 *  - un **nom accessible dérivé automatiquement** pour chacune des 80 pastilles
 *    (une pastille sans nom est inutilisable au lecteur d'écran).
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
  /** Clarté de la ligne « pure ». */
  lightness: number;
}

/** Dix colonnes, comme les palettes bureautiques usuelles. */
const BASE_HUES: readonly BaseHue[] = [
  { name: 'Rouge', hue: 0, saturation: 0.78, lightness: 0.5 },
  { name: 'Orange', hue: 24, saturation: 0.85, lightness: 0.5 },
  { name: 'Jaune', hue: 45, saturation: 0.9, lightness: 0.5 },
  // « Vert pomme » et non « Vert clair » : ce dernier entrerait en collision avec
  // la nuance claire de la colonne « Vert », et deux pastilles de même nom sont
  // indistinguables au lecteur d'écran.
  { name: 'Vert pomme', hue: 90, saturation: 0.6, lightness: 0.42 },
  { name: 'Vert', hue: 140, saturation: 0.6, lightness: 0.38 },
  { name: 'Turquoise', hue: 178, saturation: 0.62, lightness: 0.38 },
  { name: 'Bleu ciel', hue: 205, saturation: 0.72, lightness: 0.45 },
  { name: 'Bleu', hue: 222, saturation: 0.72, lightness: 0.46 },
  { name: 'Violet', hue: 270, saturation: 0.52, lightness: 0.48 },
  { name: 'Magenta', hue: 320, saturation: 0.65, lightness: 0.48 },
];

/** Niveaux de clarté, du plus clair au plus foncé, appliqués à chaque colonne. */
const LEVELS: readonly { suffix: string; lightness: number | null }[] = [
  { suffix: 'très clair', lightness: 0.88 },
  { suffix: 'clair', lightness: 0.76 },
  { suffix: 'pâle', lightness: 0.64 },
  { suffix: '', lightness: null }, // ligne pure : la clarté propre de la teinte
  { suffix: 'foncé', lightness: 0.36 },
  { suffix: 'très foncé', lightness: 0.26 },
  { suffix: 'profond', lightness: 0.17 },
];

/** Première ligne : dégradé de gris, du noir au blanc. */
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
    // Les nuances très claires ou très foncées sont désaturées : sans cela, un
    // « jaune profond » vire au vert et un « bleu très clair » devient fluo.
    const distance = Math.abs(lightness - base.lightness);
    const saturation = Math.max(0.18, base.saturation - distance * 0.35);

    return {
      value: toHex(hslToRgb(base.hue, saturation, lightness)),
      name: level.suffix ? `${base.name} ${level.suffix}` : base.name,
    };
  });
}

/** Grille complète : 8 lignes × 10 colonnes. */
export const DOCUMENT_PALETTE: readonly Swatch[][] = [greyRow(), ...LEVELS.map(hueRow)];

/** Surligneurs : teintes claires uniquement, pour rester lisibles sous du texte. */
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

/** Nom d'une couleur arbitraire (couleur personnalisée), pour l'`aria-label`. */
export function describeColor(hex: string): string {
  const known = DOCUMENT_PALETTE.flat().find(
    (swatch) => swatch.value.toLowerCase() === hex.toLowerCase(),
  );
  return known?.name ?? `Couleur personnalisée ${hex.toUpperCase()}`;
}
