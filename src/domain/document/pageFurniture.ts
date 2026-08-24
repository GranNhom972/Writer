/**
 * En-tête et pied de page physiques pour OpenOffice Writer (`SwHeaderFrm` & `SwFooterFrm`).
 *
 * Inspiré directement de l'architecture d'Apache OpenOffice (`aoo-4.1.16/main/sw/source/core/layout/hffrm.cxx`,
 * `pagedesc.cxx`, `pagedesc.hxx`) :
 *  - Structure 3 zones tabulées (Gauche / Centre / Droite) ou ligne simple (`SwTabCols`) ;
 *  - Différenciation des pages paires et impaires (`HEADERSHARE` / `FOOTERSHARE` / `PD_LEFT`, `PD_RIGHT`, `PD_MIRROR`) ;
 *  - Différenciation ou omission sur la première page (`onFirstPage` / `differentFirstPage`) ;
 *  - Filets séparateurs et bordures configurables (`SwBorderAttrs` / `SwPageFtnInfo`) ;
 *  - Couleur de fond / trame de la bande (`SvxBrushItem`) ;
 *  - Calcul dynamique de hauteur (`FormatSize` / `ATT_MIN_SIZE`) et distance au corps de texte (`DEF_DIST_WRITER`) ;
 *  - Éléments et logos libres ancrés (`SwFlyFrm`) avec positionnement magnétique ;
 *  - Jetons dynamiques étendus ({page}, {pages}, {titre}, {auteur}, {date}, {heure}) et numérotations arabes, romaines, alphabétiques.
 *
 * Module pur : aucune dépendance à React ni au DOM.
 */

export type FurnitureAlign = 'left' | 'center' | 'right';

/** Les deux bandes d'une feuille physique. */
export type FurnitureBand = 'header' | 'footer';

export type FurnitureBlockKind = 'text' | 'image';

/**
 * Présentation du numéro de page.
 */
export type PageNumberFormat =
  | 'simple'
  | 'page'
  | 'fraction'
  | 'page-sur'
  | 'tiret'
  | 'roman-upper'
  | 'roman-lower'
  | 'alpha-upper'
  | 'alpha-lower';

export const PAGE_NUMBER_FORMATS: readonly { valeur: PageNumberFormat; exemple: string }[] = [
  { valeur: 'simple', exemple: '2' },
  { valeur: 'page', exemple: 'Page 2' },
  { valeur: 'fraction', exemple: '2 / 7' },
  { valeur: 'page-sur', exemple: 'Page 2 sur 7' },
  { valeur: 'tiret', exemple: '— 2 —' },
  { valeur: 'roman-upper', exemple: 'II' },
  { valeur: 'roman-lower', exemple: 'ii' },
  { valeur: 'alpha-upper', exemple: 'B' },
  { valeur: 'alpha-lower', exemple: 'b' },
];

export type SeparatorLineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * Un élément libre posé dans une bande (`SwFlyFrm`).
 */
export interface FurnitureBlock {
  id: string;
  band: FurnitureBand;
  kind: FurnitureBlockKind;
  /**
   * Bord gauche, en fraction de la largeur utile (0 = marge gauche, 1 = marge droite).
   */
  x: number;
  /** Bord haut, en millimètres depuis le haut de la bande. */
  y: number;
  /** Texte du bloc, jetons compris. Vide pour une image. */
  text: string;
  /** Adresse de l'image. Vide pour un texte. */
  src: string;
  /** Description de l'image. */
  alt: string;
  widthMm: number;
  heightMm: number;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Couleur du texte, en notation `#rrggbb`. */
  color: string;
  /** Découpe / rognage de l'image (0 à 80 %). */
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  /** Spécifique pour n'apparaître que sur pages impaires ('odd'), paires ('even'), première page ('first') ou toutes ('all'). */
  targetPageType?: 'all' | 'odd' | 'even' | 'first';
}

export interface PageFurniture {
  /** Texte principal / ligne simple de l'en-tête (pages impaires ou toutes pages). */
  header: string;
  /** Texte principal / ligne simple du pied de page (pages impaires ou toutes pages). */
  footer: string;

  /** 3 Zones OpenOffice pour l'en-tête (Gauche / Centre / Droite). */
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;

  /** 3 Zones OpenOffice pour le pied de page (Gauche / Centre / Droite). */
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;

  /** Affiche le numéro de page dans le pied. */
  pageNumber: boolean;
  /** Présentation de ce numéro. */
  pageNumberFormat: PageNumberFormat;
  /** Numéro de page initial (décalage). */
  startPageNumber?: number;

  /** Affiche l'en-tête et le pied sur la première page (page de garde). */
  onFirstPage: boolean;

  /** Pages paires et impaires différenciées (`HEADERSHARE` / `FOOTERSHARE`). */
  differentEvenOdd?: boolean;
  /** Contenu de l'en-tête pour les pages paires (verso / gauche). */
  headerEven?: string;
  headerEvenLeft?: string;
  headerEvenCenter?: string;
  headerEvenRight?: string;
  headerEvenAlign?: FurnitureAlign;

  /** Contenu du pied pour les pages paires (verso / gauche). */
  footerEven?: string;
  footerEvenLeft?: string;
  footerEvenCenter?: string;
  footerEvenRight?: string;
  footerEvenAlign?: FurnitureAlign;

  /** Première page différente (si `onFirstPage` est actif mais avec contenu spécifique). */
  differentFirstPage?: boolean;
  firstPageHeader?: string;
  firstPageHeaderLeft?: string;
  firstPageHeaderCenter?: string;
  firstPageHeaderRight?: string;
  firstPageFooter?: string;
  firstPageFooterLeft?: string;
  firstPageFooterCenter?: string;
  firstPageFooterRight?: string;

  /** Filets séparateurs (bordures). */
  headerSeparator?: boolean;
  headerSeparatorWidthPt?: number;
  headerSeparatorColor?: string;
  headerSeparatorStyle?: SeparatorLineStyle;

  footerSeparator?: boolean;
  footerSeparatorWidthPt?: number;
  footerSeparatorColor?: string;
  footerSeparatorStyle?: SeparatorLineStyle;

  /** Couleur de fond de bande (`SvxBrushItem`). */
  headerBackground?: string;
  footerBackground?: string;

  /** Distance entre le bord haut de la feuille et l'en-tête, en millimètres. */
  headerMm: number;
  /** Distance entre le bord bas de la feuille et le pied, en millimètres. */
  footerMm: number;
  headerAlign: FurnitureAlign;
  footerAlign: FurnitureAlign;
  /** Corps de l'en-tête et du pied, en points. */
  fontSizePt: number;

  /** Marges du corps de texte, en millimètres. */
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;

  /** Blocs libres posés dans l'une ou l'autre bande (`SwFlyFrm`). */
  blocks: FurnitureBlock[];
}

export const DEFAULT_FURNITURE: PageFurniture = {
  header: '',
  footer: '',
  headerLeft: '',
  headerCenter: '',
  headerRight: '',
  footerLeft: '',
  footerCenter: '',
  footerRight: '',
  pageNumber: false,
  pageNumberFormat: 'page-sur',
  startPageNumber: 1,
  onFirstPage: true,
  differentEvenOdd: false,
  headerEven: '',
  footerEven: '',
  headerEvenLeft: '',
  headerEvenCenter: '',
  headerEvenRight: '',
  headerEvenAlign: 'right',
  footerEvenLeft: '',
  footerEvenCenter: '',
  footerEvenRight: '',
  footerEvenAlign: 'left',
  differentFirstPage: false,
  firstPageHeader: '',
  firstPageFooter: '',
  headerSeparator: false,
  headerSeparatorWidthPt: 0.75,
  headerSeparatorColor: '#d0d5dd',
  headerSeparatorStyle: 'solid',
  footerSeparator: false,
  footerSeparatorWidthPt: 0.75,
  footerSeparatorColor: '#d0d5dd',
  footerSeparatorStyle: 'solid',
  headerBackground: '',
  footerBackground: '',
  headerMm: 12,
  footerMm: 12,
  headerAlign: 'left',
  footerAlign: 'right',
  fontSizePt: 9,
  marginTopMm: 25,
  marginBottomMm: 25,
  marginLeftMm: 25,
  marginRightMm: 25,
  blocks: [],
};

export const PAGE_GAP_MM = 5;

/** Millimètres par point typographique (72 pt = 1 pouce = 25,4 mm). */
const MM_PAR_POINT = 25.4 / 72;

const FURNITURE_LEADING = 1.3;

export const FURNITURE_DIST_MM = 5;

/** Hauteur d'une ligne de texte à ce corps, en millimètres. */
export function lineHeightMm(fontSizePt: number): number {
  return Math.round(fontSizePt * FURNITURE_LEADING * MM_PAR_POINT * 10) / 10;
}

/** Bornes des réglages. */
export const FURNITURE_LIMITS = {
  distanceMm: { min: 5, max: 40 },
  marginMm: { min: 10, max: 60 },
  fontSizePt: { min: 6, max: 16 },
  blockFontSizePt: { min: 6, max: 48 },
  blockWidthMm: { min: 5, max: 180 },
  blockYMm: { min: 0, max: 60 },
  separatorWidthPt: { min: 0.25, max: 6 },
} as const;

export const MAX_BLOCKS_PER_BAND = 12;
export const MAX_BLOCK_TEXT_LENGTH = 200;
export const DEFAULT_BLOCK_COLOR = '#475467';
export const DEFAULT_SEPARATOR_COLOR = '#d0d5dd';

function borner(valeur: unknown, defaut: number, bornes: { min: number; max: number }): number {
  const nombre = typeof valeur === 'number' ? valeur : Number.parseFloat(String(valeur));
  if (!Number.isFinite(nombre)) return defaut;
  return Math.min(bornes.max, Math.max(bornes.min, Math.round(nombre * 10) / 10));
}

function alignement(valeur: unknown, defaut: FurnitureAlign): FurnitureAlign {
  return valeur === 'left' || valeur === 'center' || valeur === 'right' ? valeur : defaut;
}

function styleFilet(valeur: unknown): SeparatorLineStyle {
  return valeur === 'dashed' || valeur === 'dotted' ? valeur : 'solid';
}

function formatNumero(valeur: unknown): PageNumberFormat {
  return PAGE_NUMBER_FORMATS.some((f) => f.valeur === valeur)
    ? (valeur as PageNumberFormat)
    : DEFAULT_FURNITURE.pageNumberFormat;
}

export function isSafeImageSrc(valeur: unknown): boolean {
  if (typeof valeur !== 'string' || valeur.length === 0 || valeur.length > 2000000) return false;
  if (/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(valeur)) return true;
  if (/^\/api\/v1\/documents\/[0-9a-fA-F-]{36}\/assets\/[0-9a-fA-F-]{36}\.(png|jpg|gif|webp)$/.test(valeur)) {
    return true;
  }
  try {
    const protocole = new URL(valeur).protocol;
    return protocole === 'http:' || protocole === 'https:';
  } catch {
    return false;
  }
}

function couleur(valeur: unknown, defaut = DEFAULT_BLOCK_COLOR): string {
  if (typeof valeur === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(valeur)) {
    return valeur.toLowerCase();
  }
  return defaut;
}

function fraction(valeur: unknown): number {
  const nombre = typeof valeur === 'number' ? valeur : Number.parseFloat(String(valeur));
  if (!Number.isFinite(nombre)) return 0;
  return Math.min(1, Math.max(0, Math.round(nombre * 1000) / 1000));
}

export function newBlockId(): string {
  const alea = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof alea?.randomUUID === 'function') return alea.randomUUID();
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBlock(band: FurnitureBand, kind: FurnitureBlockKind): FurnitureBlock {
  return {
    id: newBlockId(),
    band,
    kind,
    x: kind === 'image' ? 0 : 0.35,
    y: 0,
    text: kind === 'text' ? 'Texte' : '',
    src: '',
    alt: '',
    widthMm: 30,
    heightMm: 15,
    fontSizePt: 10,
    bold: false,
    italic: false,
    underline: false,
    color: DEFAULT_BLOCK_COLOR,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0,
    cropLeft: 0,
    targetPageType: 'all',
  };
}

export function blockHeightMm(bloc: FurnitureBlock): number {
  if (bloc.kind === 'image') {
    const cT = bloc.cropTop ?? 0;
    const cB = bloc.cropBottom ?? 0;
    const cropH = Math.max(0.01, (100 - cT - cB) / 100);
    return Math.round(bloc.heightMm * cropH * 10) / 10;
  }
  return lineHeightMm(bloc.fontSizePt);
}

function readBlock(source: unknown): FurnitureBlock | null {
  if (typeof source !== 'object' || source === null) return null;
  const brut = source as Record<string, unknown>;

  const kind: FurnitureBlockKind = brut['kind'] === 'image' ? 'image' : 'text';
  const band: FurnitureBand = brut['band'] === 'footer' ? 'footer' : 'header';
  const src = isSafeImageSrc(brut['src']) ? String(brut['src']) : '';

  if (kind === 'image' && src === '') return null;

  const texte = (valeur: unknown, max: number): string =>
    typeof valeur === 'string' ? valeur.slice(0, max) : '';

  const crop = (valeur: unknown): number => {
    const n = typeof valeur === 'number' ? valeur : Number.parseFloat(String(valeur));
    if (!Number.isFinite(n)) return 0;
    return Math.min(80, Math.max(0, Math.round(n * 10) / 10));
  };

  const targetPageType =
    brut['targetPageType'] === 'odd' ||
    brut['targetPageType'] === 'even' ||
    brut['targetPageType'] === 'first'
      ? brut['targetPageType']
      : 'all';

  return {
    id: typeof brut['id'] === 'string' && brut['id'].length <= 64 ? brut['id'] : newBlockId(),
    band,
    kind,
    x: fraction(brut['x']),
    y: borner(brut['y'], 0, FURNITURE_LIMITS.blockYMm),
    text: kind === 'text' ? texte(brut['text'], MAX_BLOCK_TEXT_LENGTH) : '',
    src,
    alt: texte(brut['alt'], MAX_BLOCK_TEXT_LENGTH),
    widthMm: borner(brut['widthMm'], 30, FURNITURE_LIMITS.blockWidthMm),
    heightMm: borner(brut['heightMm'], 15, FURNITURE_LIMITS.blockWidthMm),
    fontSizePt: borner(brut['fontSizePt'], 10, FURNITURE_LIMITS.blockFontSizePt),
    bold: brut['bold'] === true,
    italic: brut['italic'] === true,
    underline: brut['underline'] === true,
    color: couleur(brut['color']),
    cropTop: crop(brut['cropTop']),
    cropRight: crop(brut['cropRight']),
    cropBottom: crop(brut['cropBottom']),
    cropLeft: crop(brut['cropLeft']),
    targetPageType,
  };
}

export function blocksOf(
  furniture: PageFurniture,
  band: FurnitureBand,
  pageNumber?: number,
): FurnitureBlock[] {
  const all = furniture.blocks.filter((bloc) => bloc.band === band);
  if (pageNumber === undefined) return all;

  const isFirst = pageNumber === 1;
  const isEven = pageNumber % 2 === 0;

  return all.filter((bloc) => {
    const t = bloc.targetPageType ?? 'all';
    if (t === 'all') return true;
    if (t === 'first') return isFirst;
    if (t === 'even') return isEven;
    if (t === 'odd') return !isEven;
    return true;
  });
}

/** 3 Zones pour une page donnée */
export interface ThreeZoneContent {
  left: string;
  center: string;
  right: string;
  hasContent: boolean;
}

export function getThreeZones(
  furniture: PageFurniture,
  band: FurnitureBand,
  pageNumber = 1,
): ThreeZoneContent {
  const isFirst = pageNumber === 1;
  const isEven = pageNumber % 2 === 0;

  if (isFirst && furniture.differentFirstPage) {
    if (band === 'header') {
      const left = furniture.firstPageHeaderLeft?.trim() ?? '';
      const center = furniture.firstPageHeaderCenter?.trim() ?? '';
      const right = furniture.firstPageHeaderRight?.trim() ?? '';
      const fallback = furniture.firstPageHeader?.trim() ?? '';
      const align = furniture.headerAlign;
      const finalLeft = left || (align === 'left' ? fallback : '');
      const finalCenter = center || (align === 'center' ? fallback : '');
      const finalRight = right || (align === 'right' ? fallback : '');
      return { left: finalLeft, center: finalCenter, right: finalRight, hasContent: !!(finalLeft || finalCenter || finalRight) };
    } else {
      const left = furniture.firstPageFooterLeft?.trim() ?? '';
      const center = furniture.firstPageFooterCenter?.trim() ?? '';
      const right = furniture.firstPageFooterRight?.trim() ?? '';
      const fallback = furniture.firstPageFooter?.trim() ?? '';
      const align = furniture.footerAlign;
      const finalLeft = left || (align === 'left' ? fallback : '');
      const finalCenter = center || (align === 'center' ? fallback : '');
      const finalRight = right || (align === 'right' ? fallback : '');
      return { left: finalLeft, center: finalCenter, right: finalRight, hasContent: !!(finalLeft || finalCenter || finalRight) };
    }
  }

  if (isEven && furniture.differentEvenOdd) {
    if (band === 'header') {
      const left = furniture.headerEvenLeft?.trim() ?? '';
      const center = furniture.headerEvenCenter?.trim() ?? '';
      const right = furniture.headerEvenRight?.trim() ?? '';
      const fallback = furniture.headerEven?.trim() ?? '';
      const align = furniture.headerEvenAlign ?? furniture.headerAlign;
      const finalLeft = left || (align === 'left' ? fallback : '');
      const finalCenter = center || (align === 'center' ? fallback : '');
      const finalRight = right || (align === 'right' ? fallback : '');
      return { left: finalLeft, center: finalCenter, right: finalRight, hasContent: !!(finalLeft || finalCenter || finalRight) };
    } else {
      const left = furniture.footerEvenLeft?.trim() ?? '';
      const center = furniture.footerEvenCenter?.trim() ?? '';
      const right = furniture.footerEvenRight?.trim() ?? '';
      const fallback = furniture.footerEven?.trim() ?? '';
      const align = furniture.footerEvenAlign ?? furniture.footerAlign;
      const finalLeft = left || (align === 'left' ? fallback : '');
      const finalCenter = center || (align === 'center' ? fallback : '');
      const finalRight = right || (align === 'right' ? fallback : '');
      return { left: finalLeft, center: finalCenter, right: finalRight, hasContent: !!(finalLeft || finalCenter || finalRight) };
    }
  }

  // Cas nominal (pages impaires ou toutes pages)
  if (band === 'header') {
    const left = furniture.headerLeft?.trim() ?? '';
    const center = furniture.headerCenter?.trim() ?? '';
    const right = furniture.headerRight?.trim() ?? '';
    const fallback = furniture.header.trim();
    const align = furniture.headerAlign;
    const finalLeft = left || (align === 'left' ? fallback : '');
    const finalCenter = center || (align === 'center' ? fallback : '');
    const finalRight = right || (align === 'right' ? fallback : '');
    return { left: finalLeft, center: finalCenter, right: finalRight, hasContent: !!(finalLeft || finalCenter || finalRight) };
  } else {
    const left = furniture.footerLeft?.trim() ?? '';
    const center = furniture.footerCenter?.trim() ?? '';
    const right = furniture.footerRight?.trim() ?? '';
    const fallback = furniture.footer.trim();
    const pageNumStr = furniture.pageNumber ? '{page}' : '';
    const align = furniture.footerAlign;

    const baseLeft = left || (align === 'left' ? fallback : '');
    const baseCenter = center || (align === 'center' ? fallback : '');
    const baseRight = right || (align === 'right' ? fallback : '');

    const finalRight = baseRight || (!baseLeft && !baseCenter && pageNumStr ? pageNumStr : '');
    const finalLeft = baseLeft;
    const finalCenter = baseCenter;

    return { left: finalLeft, center: finalCenter, right: finalRight, hasContent: !!(finalLeft || finalCenter || finalRight) };
  }
}

/**
 * Hauteur du contenu d'une bande, en millimètres — filet non compris.
 * Transposition de `SwHeadFootFrm::FormatSize` d'OpenOffice.
 */
export function bandContentMm(
  furniture: PageFurniture,
  band: FurnitureBand,
  pageNumber = 1,
): number {
  const zones = getThreeZones(furniture, band, pageNumber);
  const hasText = zones.hasContent;
  const ligne = hasText ? lineHeightMm(furniture.fontSizePt) : 0;

  const blocs = blocksOf(furniture, band, pageNumber);
  const bas = blocs.reduce((max, bloc) => Math.max(max, bloc.y + blockHeightMm(bloc)), 0);

  return Math.round(Math.max(ligne, bas) * 10) / 10;
}

/** La bande a-t-elle quoi que ce soit à montrer sur cette page ? */
export function bandIsEmpty(
  furniture: PageFurniture,
  band: FurnitureBand,
  pageNumber = 1,
): boolean {
  const zones = getThreeZones(furniture, band, pageNumber);
  const blocs = blocksOf(furniture, band, pageNumber);
  return !zones.hasContent && blocs.length === 0;
}

export interface ResolvedGeometry {
  marginTopMm: number;
  marginBottomMm: number;
  effectiveMarginTopMm: number;
  effectiveMarginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  headerContentMm: number;
  footerContentMm: number;
  headerBandMm: number;
  footerBandMm: number;
}

/**
 * Calcul exact de la géométrie de page pour Writer (`SwPageFrm::FormatPrt`).
 */
export function resolveGeometry(furniture: PageFurniture, pageNumber = 1): ResolvedGeometry {
  const rawHeaderContentMm = bandContentMm(furniture, 'header', pageNumber);
  const rawFooterContentMm = bandContentMm(furniture, 'footer', pageNumber);

  const baseHeaderMm = Math.max(16, furniture.marginTopMm - FURNITURE_DIST_MM);
  const baseFooterMm = Math.max(16, furniture.marginBottomMm - FURNITURE_DIST_MM);

  const headerContentMm = Math.max(baseHeaderMm, rawHeaderContentMm);
  const footerContentMm = Math.max(baseFooterMm, rawFooterContentMm);

  const reserve = (contenu: number): number =>
    contenu === 0 ? 0 : Math.round((contenu + FURNITURE_DIST_MM) * 10) / 10;

  const headerBandMm = reserve(rawHeaderContentMm);
  const footerBandMm = reserve(rawFooterContentMm);

  const effMarginTopMm = Math.max(
    furniture.marginTopMm,
    headerBandMm === 0 ? 0 : furniture.headerMm + headerBandMm,
  );
  const effMarginBottomMm = Math.max(
    furniture.marginBottomMm,
    footerBandMm === 0 ? 0 : furniture.footerMm + footerBandMm,
  );

  return {
    marginTopMm: effMarginTopMm,
    marginBottomMm: effMarginBottomMm,
    effectiveMarginTopMm: effMarginTopMm,
    effectiveMarginBottomMm: effMarginBottomMm,
    marginLeftMm: furniture.marginLeftMm,
    marginRightMm: furniture.marginRightMm,
    headerContentMm,
    footerContentMm,
    headerBandMm,
    footerBandMm,
  };
}

export const MAX_FURNITURE_LENGTH = 200;

export const FURNITURE_TOKENS: readonly { jeton: string; description: string }[] = [
  { jeton: '{page}', description: 'Numéro de la page' },
  { jeton: '{pages}', description: 'Nombre total de pages' },
  { jeton: '{titre}', description: 'Titre du document' },
  { jeton: '{auteur}', description: 'Auteur du document' },
  { jeton: '{date}', description: 'Date du jour' },
  { jeton: '{heure}', description: 'Heure actuelle' },
];

export function readFurniture(source: unknown): PageFurniture {
  if (typeof source !== 'object' || source === null) return DEFAULT_FURNITURE;
  const brut = source as Record<string, unknown>;

  const texte = (valeur: unknown): string =>
    typeof valeur === 'string' ? valeur.slice(0, MAX_FURNITURE_LENGTH) : '';

  return {
    header: texte(brut['header']),
    footer: texte(brut['footer']),
    headerLeft: texte(brut['headerLeft']),
    headerCenter: texte(brut['headerCenter']),
    headerRight: texte(brut['headerRight']),
    footerLeft: texte(brut['footerLeft']),
    footerCenter: texte(brut['footerCenter']),
    footerRight: texte(brut['footerRight']),
    pageNumber: brut['pageNumber'] === true,
    pageNumberFormat: formatNumero(brut['pageNumberFormat']),
    startPageNumber: typeof brut['startPageNumber'] === 'number' ? brut['startPageNumber'] : 1,
    onFirstPage: brut['onFirstPage'] !== false,
    differentEvenOdd: brut['differentEvenOdd'] === true,
    headerEven: texte(brut['headerEven']),
    headerEvenLeft: texte(brut['headerEvenLeft']),
    headerEvenCenter: texte(brut['headerEvenCenter']),
    headerEvenRight: texte(brut['headerEvenRight']),
    headerEvenAlign: alignement(brut['headerEvenAlign'], 'right'),
    footerEven: texte(brut['footerEven']),
    footerEvenLeft: texte(brut['footerEvenLeft']),
    footerEvenCenter: texte(brut['footerEvenCenter']),
    footerEvenRight: texte(brut['footerEvenRight']),
    footerEvenAlign: alignement(brut['footerEvenAlign'], 'left'),
    differentFirstPage: brut['differentFirstPage'] === true,
    firstPageHeader: texte(brut['firstPageHeader']),
    firstPageHeaderLeft: texte(brut['firstPageHeaderLeft']),
    firstPageHeaderCenter: texte(brut['firstPageHeaderCenter']),
    firstPageHeaderRight: texte(brut['firstPageHeaderRight']),
    firstPageFooter: texte(brut['firstPageFooter']),
    firstPageFooterLeft: texte(brut['firstPageFooterLeft']),
    firstPageFooterCenter: texte(brut['firstPageFooterCenter']),
    firstPageFooterRight: texte(brut['firstPageFooterRight']),
    headerSeparator: brut['headerSeparator'] === true,
    headerSeparatorWidthPt: borner(brut['headerSeparatorWidthPt'], 0.75, FURNITURE_LIMITS.separatorWidthPt),
    headerSeparatorColor: couleur(brut['headerSeparatorColor'], DEFAULT_SEPARATOR_COLOR),
    headerSeparatorStyle: styleFilet(brut['headerSeparatorStyle']),
    footerSeparator: brut['footerSeparator'] === true,
    footerSeparatorWidthPt: borner(brut['footerSeparatorWidthPt'], 0.75, FURNITURE_LIMITS.separatorWidthPt),
    footerSeparatorColor: couleur(brut['footerSeparatorColor'], DEFAULT_SEPARATOR_COLOR),
    footerSeparatorStyle: styleFilet(brut['footerSeparatorStyle']),
    headerBackground: typeof brut['headerBackground'] === 'string' ? brut['headerBackground'] : '',
    footerBackground: typeof brut['footerBackground'] === 'string' ? brut['footerBackground'] : '',
    headerMm: borner(brut['headerMm'], DEFAULT_FURNITURE.headerMm, FURNITURE_LIMITS.distanceMm),
    footerMm: borner(brut['footerMm'], DEFAULT_FURNITURE.footerMm, FURNITURE_LIMITS.distanceMm),
    headerAlign: alignement(brut['headerAlign'], DEFAULT_FURNITURE.headerAlign),
    footerAlign: alignement(brut['footerAlign'], DEFAULT_FURNITURE.footerAlign),
    fontSizePt: borner(brut['fontSizePt'], DEFAULT_FURNITURE.fontSizePt, FURNITURE_LIMITS.fontSizePt),
    marginTopMm: borner(brut['marginTopMm'], DEFAULT_FURNITURE.marginTopMm, FURNITURE_LIMITS.marginMm),
    marginBottomMm: borner(brut['marginBottomMm'], DEFAULT_FURNITURE.marginBottomMm, FURNITURE_LIMITS.marginMm),
    marginLeftMm: borner(brut['marginLeftMm'], DEFAULT_FURNITURE.marginLeftMm, FURNITURE_LIMITS.marginMm),
    marginRightMm: borner(brut['marginRightMm'], DEFAULT_FURNITURE.marginRightMm, FURNITURE_LIMITS.marginMm),
    blocks: readBlocks(brut['blocks']),
  };
}

function readBlocks(source: unknown): FurnitureBlock[] {
  if (!Array.isArray(source)) return [];

  const gardes = { header: 0, footer: 0 };
  const blocs: FurnitureBlock[] = [];

  for (const brut of source) {
    const bloc = readBlock(brut);
    if (bloc === null) continue;
    if (gardes[bloc.band] >= MAX_BLOCKS_PER_BAND) continue;
    gardes[bloc.band] += 1;
    blocs.push(bloc);
  }

  return blocs;
}

export interface FurnitureContext {
  page: number;
  pages: number;
  titre: string;
  auteur?: string;
  /**
   * Date du document, ou **chaîne déjà mise en forme**.
   *
   * Les deux formes sont admises à dessein : le serveur d'export fournit une
   * chaîne pour que le rendu ne dépende pas de la locale de la machine, tandis
   * que l'éditeur passe une `Date` et laisse le navigateur la présenter.
   */
  date?: Date | string;
  /** Heure déjà mise en forme. Déduite de `date` quand elle est absente. */
  heure?: string;
}

function toRoman(num: number): string {
  if (num <= 0 || num > 3999) return String(num);
  const romanLookup: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let res = '';
  let n = num;
  for (const [val, roman] of romanLookup) {
    while (n >= val) {
      res += roman;
      n -= val;
    }
  }
  return res;
}

function toAlpha(num: number): string {
  if (num <= 0) return String(num);
  let res = '';
  let n = num;
  while (n > 0) {
    n--;
    res = String.fromCharCode(65 + (n % 26)) + res;
    n = Math.floor(n / 26);
  }
  return res;
}

/** Remplace les jetons par leurs valeurs pour une page donnée. */
export function renderFurniture(modele: string, contexte: FurnitureContext): string {
  if (!modele) return '';
  const d = typeof contexte.date === 'string'
    ? new Date(contexte.date)
    : (contexte.date instanceof Date ? contexte.date : new Date());
  const dateStr = typeof contexte.date === 'string' ? contexte.date : (isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR'));
  const auteur = contexte.auteur ?? 'Auteur inconnu';
  const heureStr = contexte.heure ?? (isNaN(d.getTime()) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));

  return modele
    .replace(/\{page\}/g, String(contexte.page))
    .replace(/\{pages\}/g, String(contexte.pages))
    .replace(/\{titre\}/g, contexte.titre ?? '')
    .replace(/\{auteur\}/g, auteur)
    .replace(/\{author\}/g, auteur)
    .replace(/\{date\}/g, dateStr)
    .replace(/\{heure\}/g, heureStr)
    .replace(/\{time\}/g, heureStr);
}

export function formatPageNumber(
  a: number | PageNumberFormat,
  b?: number | Pick<FurnitureContext, 'page' | 'pages'>,
  c?: PageNumberFormat,
): string {
  let p = 1;
  let total = 1;
  let format: PageNumberFormat = 'simple';

  if (typeof a === 'number') {
    p = a;
    total = typeof b === 'number' ? b : 1;
    format = c ?? 'simple';
  } else {
    format = a;
    if (b && typeof b === 'object') {
      p = b.page;
      total = b.pages;
    }
  }

  if ((format as string) === 'page-n') format = 'page';

  switch (format) {
    case 'simple':
      return String(p);
    case 'page':
      return `Page ${p}`;
    case 'fraction':
      return `${p} / ${total}`;
    case 'page-sur':
      return `Page ${p} sur ${total}`;
    case 'tiret':
      return `— ${p} —`;
    case 'roman-upper':
      return toRoman(p);
    case 'roman-lower':
      return toRoman(p).toLowerCase();
    case 'alpha-upper':
      return toAlpha(p);
    case 'alpha-lower':
      return toAlpha(p).toLowerCase();
    default:
      return `Page ${p} sur ${total}`;
  }
}

/** Texte du pied, numéro de page compris. */
export function footerLine(furniture: PageFurniture, contexte: FurnitureContext): string {
  const zones = getThreeZones(furniture, 'footer', contexte.page);
  const left = renderFurniture(zones.left, contexte).trim();
  const center = renderFurniture(zones.center, contexte).trim();
  const right = renderFurniture(zones.right, contexte).trim();

  if (left || center || right) {
    const parts = [left, center, right].filter(Boolean);
    return parts.join('  ·  ');
  }

  const texte = renderFurniture(furniture.footer, contexte).trim();
  if (!furniture.pageNumber) return texte;

  const numero = formatPageNumber(furniture.pageNumberFormat, contexte);
  return texte ? `${texte} — ${numero}` : numero;
}

/** L'en-tête et le pied s'affichent-ils sur cette page ? */
export function showsOn(furniture: PageFurniture, page: number): boolean {
  return furniture.onFirstPage || page > 1;
}

export interface SnapTarget {
  coordMm?: number;
  mm?: number;
  kind?: 'margin' | 'center' | 'edge' | 'block' | 'baseline';
  label?: string;
}

export interface SnapOutcome {
  startMm: number;
  valeurMm: number;
  guides: SnapTarget[];
  reperes: string[];
}

export function snapAxis(
  startMm: number,
  sizeMm: number,
  targets: readonly SnapTarget[],
  thresholdMm: number,
): SnapOutcome {
  const ancres = [0, sizeMm / 2, sizeMm];

  let meilleur: { delta: number; ecart: number } | null = null;
  for (const cible of targets) {
    const cibleMm = cible.mm ?? cible.coordMm ?? 0;
    for (const ancre of ancres) {
      const delta = cibleMm - (startMm + ancre);
      const ecart = Math.abs(delta);
      if (ecart > thresholdMm) continue;
      if (meilleur === null || ecart < meilleur.ecart) meilleur = { delta, ecart };
    }
  }

  if (meilleur === null) {
    return { startMm, valeurMm: startMm, guides: [], reperes: [] };
  }

  const corrige = Math.round((startMm + meilleur.delta) * 10) / 10;
  const guides = targets.filter((cible) => {
    const cibleMm = cible.mm ?? cible.coordMm ?? 0;
    return ancres.some((ancre) => Math.abs(cibleMm - (corrige + ancre)) < 0.1);
  });
  const reperes = guides.map((g) => g.label || g.kind || 'Repère');

  return { startMm: corrige, valeurMm: corrige, guides, reperes };
}

export interface FurniturePreset {
  id: string;
  label: string;
  apercu: string;
  band: FurnitureBand;
  patch: Partial<PageFurniture>;
}

export const FURNITURE_PRESETS: readonly FurniturePreset[] = [
  {
    id: 'header-titre',
    label: 'Titre à gauche',
    apercu: '{titre}',
    band: 'header',
    patch: { headerLeft: '{titre}', headerCenter: '', headerRight: '', header: '{titre}', headerAlign: 'left' },
  },
  {
    id: 'header-titre-date',
    label: 'Titre à gauche & Date à droite',
    apercu: '{titre} | {date}',
    band: 'header',
    patch: { headerLeft: '{titre}', headerCenter: '', headerRight: '{date}', header: '{titre} — {date}', headerAlign: 'left' },
  },
  {
    id: 'header-elegant',
    label: 'Élégant avec filet séparateur',
    apercu: '{titre} (centré avec filet)',
    band: 'header',
    patch: {
      headerLeft: '',
      headerCenter: '{titre}',
      headerRight: '',
      header: '{titre}',
      headerAlign: 'center',
      headerSeparator: true,
      headerSeparatorWidthPt: 0.75,
      headerSeparatorColor: '#98a2b3',
    },
  },
  {
    id: 'header-confidentiel',
    label: 'Mention de diffusion',
    apercu: 'CONFIDENTIEL',
    band: 'header',
    patch: { headerLeft: '', headerCenter: '', headerRight: 'CONFIDENTIEL', header: 'CONFIDENTIEL', headerAlign: 'right' },
  },
  {
    id: 'footer-numero-centre',
    label: 'Numéro centré',
    apercu: '— Page 2 sur 7 —',
    band: 'footer',
    patch: {
      footerLeft: '',
      footerCenter: '{page}',
      footerRight: '',
      footer: '',
      pageNumber: true,
      pageNumberFormat: 'page-sur',
      footerAlign: 'center',
    },
  },
  {
    id: 'footer-titre-numero',
    label: 'Titre à gauche & Numéro à droite',
    apercu: '{titre} | Page 2 sur 7',
    band: 'footer',
    patch: {
      footerLeft: '{titre}',
      footerCenter: '',
      footerRight: 'Page {page} / {pages}',
      footer: '{titre}',
      pageNumber: true,
      pageNumberFormat: 'fraction',
      footerAlign: 'right',
    },
  },
  {
    id: 'footer-filet-complet',
    label: 'Complet avec filet supérieur',
    apercu: '{auteur} | {date} | Page 2/7',
    band: 'footer',
    patch: {
      footerLeft: '{auteur}',
      footerCenter: '{date}',
      footerRight: 'Page {page} / {pages}',
      footer: '{auteur} — {date}',
      pageNumber: true,
      pageNumberFormat: 'fraction',
      footerAlign: 'right',
      footerSeparator: true,
      footerSeparatorWidthPt: 0.75,
      footerSeparatorColor: '#98a2b3',
    },
  },
  {
    id: 'footer-date',
    label: 'Date à gauche & Numéro simple à droite',
    apercu: '{date} | 2',
    band: 'footer',
    patch: {
      footerLeft: '{date}',
      footerCenter: '',
      footerRight: '{page}',
      footer: '{date}',
      pageNumber: true,
      pageNumberFormat: 'simple',
      footerAlign: 'right',
    },
  },
];
