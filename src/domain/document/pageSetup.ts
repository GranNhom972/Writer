/**
 * Géométrie de la page. Transposition de `SwPageDesc` / `SwPageFrm`.
 *
 * `SwPageFrm` distingue le **cadre** (la feuille entière) et le **Prt**
 * (« print area » : ce qui reste une fois les marges et les bandes d'en-tête et
 * de pied retirées). C'est le second qui borne la pagination — d'où
 * `printableHeightPx`, dont dépend tout le découpage en pages.
 */

import { mmToPx } from './units';
import type { PageSetup } from './types';

export const A4_PORTRAIT: PageSetup = {
  format: 'A4',
  widthMm: 210,
  heightMm: 297,
  orientation: 'portrait',
  marginTopMm: 20,
  marginBottomMm: 20,
  marginLeftMm: 25,
  marginRightMm: 25,
  headerHeightMm: 0,
  footerHeightMm: 0,
};

export const LETTER_PORTRAIT: PageSetup = {
  ...A4_PORTRAIT,
  format: 'Letter',
  widthMm: 215.9,
  heightMm: 279.4,
};

/** Dimensions effectives de la feuille, orientation comprise. */
export function sheetSizeMm(setup: PageSetup): { widthMm: number; heightMm: number } {
  return setup.orientation === 'landscape'
    ? { widthMm: setup.heightMm, heightMm: setup.widthMm }
    : { widthMm: setup.widthMm, heightMm: setup.heightMm };
}

export interface PageGeometry {
  /** Feuille entière. */
  pageWidthPx: number;
  pageHeightPx: number;
  /** Bord gauche et haut de la zone imprimable. */
  contentLeftPx: number;
  contentTopPx: number;
  /** Zone imprimable — le `Prt` de `SwPageFrm`. */
  contentWidthPx: number;
  contentHeightPx: number;
  headerHeightPx: number;
  footerHeightPx: number;
}

/**
 * Zone imprimable :
 * `hauteur - marge haute - marge basse - en-tête - pied`, conformément au §4.1
 * du CLAUDE.md.
 *
 * Les valeurs sont bornées à un minimum strictement positif : des marges plus
 * grandes que la feuille donneraient une hauteur nulle ou négative, et la
 * pagination boucle­rait sans jamais poser une seule ligne.
 */
export function pageGeometry(setup: PageSetup): PageGeometry {
  const { widthMm, heightMm } = sheetSizeMm(setup);
  const pageWidthPx = mmToPx(widthMm);
  const pageHeightPx = mmToPx(heightMm);

  const headerHeightPx = mmToPx(Math.max(0, setup.headerHeightMm ?? 0));
  const footerHeightPx = mmToPx(Math.max(0, setup.footerHeightMm ?? 0));
  const marginLeftPx = mmToPx(Math.max(0, setup.marginLeftMm));
  const marginRightPx = mmToPx(Math.max(0, setup.marginRightMm));
  const marginTopPx = mmToPx(Math.max(0, setup.marginTopMm));
  const marginBottomPx = mmToPx(Math.max(0, setup.marginBottomMm));

  const MIN_CONTENT_PX = 1;

  return {
    pageWidthPx,
    pageHeightPx,
    contentLeftPx: marginLeftPx,
    contentTopPx: marginTopPx + headerHeightPx,
    contentWidthPx: Math.max(MIN_CONTENT_PX, pageWidthPx - marginLeftPx - marginRightPx),
    contentHeightPx: Math.max(
      MIN_CONTENT_PX,
      pageHeightPx - marginTopPx - marginBottomPx - headerHeightPx - footerHeightPx,
    ),
    headerHeightPx,
    footerHeightPx,
  };
}
