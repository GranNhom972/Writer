// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Page geometry (OpenOffice: `SwPageDesc` / `SwPageFrm`).
 *
 * `SwPageFrm` distinguishes the **frame** (the whole sheet) from the **Prt** ("print
 * area": what is left once the margins and the header and footer bands are removed).
 * The second is what bounds the pagination, hence `printableHeightPx`, on which the
 * whole split into pages depends.
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

/** Effective dimensions of the sheet, orientation included. */
export function sheetSizeMm(setup: PageSetup): { widthMm: number; heightMm: number } {
  return setup.orientation === 'landscape'
    ? { widthMm: setup.heightMm, heightMm: setup.widthMm }
    : { widthMm: setup.widthMm, heightMm: setup.heightMm };
}

export interface PageGeometry {
  /** The whole sheet. */
  pageWidthPx: number;
  pageHeightPx: number;
  /** Left and top edge of the printable area. */
  contentLeftPx: number;
  contentTopPx: number;
  /** Printable area: the `Prt` of `SwPageFrm`. */
  contentWidthPx: number;
  contentHeightPx: number;
  headerHeightPx: number;
  footerHeightPx: number;
}

/**
 * Printable area:
 * `height - top margin - bottom margin - header - footer`, following the A4 layout
 * rules.
 *
 * The values are clamped to a strictly positive minimum: margins larger than the
 * sheet would give a zero or negative height, and pagination would loop without ever
 * placing a single line.
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
