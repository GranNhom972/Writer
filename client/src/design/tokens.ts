/** Miroir TypeScript des jetons ayant besoin d'être lus par le code. */

/** Nombre de couleurs de présence exposées par `tokens.css`. */
export const PRESENCE_COLOR_COUNT = 8;

export type PresenceColor = `var(--presence-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8})`;

/** Millimètres → pixels CSS (96 dpi). Utilisé par le moteur de pagination. */
export const MM_TO_PX = 96 / 25.4;

export const A4 = {
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 25,
  marginBottomMm: 25,
  marginLeftMm: 25,
  marginRightMm: 25,
} as const;
