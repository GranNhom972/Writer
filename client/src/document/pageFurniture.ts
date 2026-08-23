/**
 * En-tête et pied de page.
 *
 * Ils ne sont pas du contenu de flux : ils se répètent à l'identique sur chaque
 * page. On les stocke donc à part du texte, dans les métadonnées répliquées du
 * document (même canal que le titre) — ce qui les rend collaboratifs sans
 * perturber la pagination du corps.
 *
 * Module pur : aucune dépendance à React ni au DOM, testable tel quel.
 */

export type FurnitureAlign = 'left' | 'center' | 'right';

/** Les deux bandes d'une feuille. */
export type FurnitureBand = 'header' | 'footer';

export type FurnitureBlockKind = 'text' | 'image';

/**
 * Présentation du numéro de page.
 *
 * Un seul gabarit imposé — « Page 2 / 7 » — obligeait à retaper le numéro à la
 * main dans la ligne de pied dès qu'on en voulait un autre, ce qui faisait
 * perdre la substitution automatique. Le format est donc un réglage.
 */
export type PageNumberFormat = 'simple' | 'page' | 'fraction' | 'page-sur' | 'tiret';

export const PAGE_NUMBER_FORMATS: readonly { valeur: PageNumberFormat; exemple: string }[] = [
  { valeur: 'simple', exemple: '2' },
  { valeur: 'page', exemple: 'Page 2' },
  { valeur: 'fraction', exemple: '2 / 7' },
  { valeur: 'page-sur', exemple: 'Page 2 / 7' },
  { valeur: 'tiret', exemple: '— 2 —' },
];

/**
 * Un élément libre posé dans une bande.
 *
 * Writer connaît la même distinction : le texte de l'en-tête coule dans le cadre
 * (`SwHeaderFrm`), tandis qu'un logo est un objet ancré (`SwFlyFrm`) dont la
 * position est donnée en absolu par `SwFmtHoriOrient`/`SwFmtVertOrient`. C'est
 * ce second mécanisme que reprennent les blocs : ils ne coulent pas, ils sont
 * posés où on les a mis.
 */
export interface FurnitureBlock {
  id: string;
  band: FurnitureBand;
  kind: FurnitureBlockKind;
  /**
   * Bord gauche, en fraction de la largeur utile (0 = marge gauche, 1 = marge
   * droite). Une fraction plutôt que des millimètres : le bloc garde sa place
   * relative quand les marges du document changent.
   */
  x: number;
  /** Bord haut, en millimètres depuis le haut de la bande. */
  y: number;
  /** Texte du bloc, jetons compris. Vide pour une image. */
  text: string;
  /** Adresse de l'image. Vide pour un texte. */
  src: string;
  /** Description de l'image, pour qui ne la voit pas. */
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
}

export interface PageFurniture {
  /** Texte de l'en-tête ; vide = pas d'en-tête. */
  header: string;
  /** Texte du pied de page ; vide = pas de pied. */
  footer: string;
  /** Affiche le numéro de page dans le pied. */
  pageNumber: boolean;
  /** Présentation de ce numéro. */
  pageNumberFormat: PageNumberFormat;
  /** Affiche l'en-tête et le pied sur la première page (page de garde). */
  onFirstPage: boolean;

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

  /** Blocs libres posés dans l'une ou l'autre bande. */
  blocks: FurnitureBlock[];
}

export const DEFAULT_FURNITURE: PageFurniture = {
  header: '',
  footer: '',
  pageNumber: false,
  pageNumberFormat: 'page-sur',
  onFirstPage: true,
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

/**
 * Gouttière entre deux feuilles, en millimètres.
 *
 * Writer sépare ses `SwPageFrm` d'un blanc constant : `GAPBETWEENPAGES` vaut
 * 284 twips (`sw/inc/swtypes.hxx`), soit 5 mm, et `SwRootFrm::CheckViewLayout`
 * l'ajoute à la hauteur de chaque page pour poser la suivante. Sans cette
 * gouttière, les feuilles se touchent et le document ressemble à un rouleau
 * continu plutôt qu'à une pile de pages.
 *
 * Elle appartient au MODÈLE, pas au décor : la pagination doit compter
 * `hauteurPage + gouttière` d'une feuille à l'autre, sinon le texte et les
 * cadres dérivent l'un de l'autre d'une gouttière par page.
 */
export const PAGE_GAP_MM = 5;

/** Millimètres par point typographique (72 pt = 1 pouce = 25,4 mm). */
const MM_PAR_POINT = 25.4 / 72;

/**
 * Interligne de l'en-tête et du pied. DOIT rester égal au `line-height` de
 * `.page-guide__header` : c'est de lui qu'on déduit la place à réserver.
 */
const FURNITURE_LEADING = 1.3;

/**
 * Écart entre la bande et le corps de texte, en millimètres.
 *
 * Writer ne colle pas le corps sous l'en-tête : il réserve la hauteur de la
 * bande PLUS un écart (`nH += nDist`, `svx/source/dialog/hdft.cxx`), et propose
 * 5 mm par défaut (`DEF_DIST_WRITER`). C'est cet écart qui laisse respirer le
 * filet ; sans lui la première ligne du texte vient s'y appuyer.
 */
const FURNITURE_DIST_MM = 5;

/** Hauteur d'une ligne de texte à ce corps, en millimètres. */
export function lineHeightMm(fontSizePt: number): number {
  return Math.round(fontSizePt * FURNITURE_LEADING * MM_PAR_POINT * 10) / 10;
}

/** Bornes des réglages : au-delà, la page devient inutilisable. */
export const FURNITURE_LIMITS = {
  distanceMm: { min: 5, max: 40 },
  marginMm: { min: 10, max: 60 },
  fontSizePt: { min: 6, max: 16 },
  /** Corps d'un bloc libre : plus large que la ligne de base, qui reste discrète. */
  blockFontSizePt: { min: 6, max: 48 },
  /** Largeur d'une image, en millimètres. */
  blockWidthMm: { min: 5, max: 180 },
  /** Descente d'un bloc dans sa bande, en millimètres. */
  blockYMm: { min: 0, max: 60 },
} as const;

/** Blocs par bande. Au-delà, la bande n'est plus une bande mais une page. */
export const MAX_BLOCKS_PER_BAND = 12;

/** Longueur d'un texte de bloc. */
export const MAX_BLOCK_TEXT_LENGTH = 200;

export const DEFAULT_BLOCK_COLOR = '#475467';

function borner(valeur: unknown, defaut: number, bornes: { min: number; max: number }): number {
  const nombre = typeof valeur === 'number' ? valeur : Number.parseFloat(String(valeur));
  if (!Number.isFinite(nombre)) return defaut;
  return Math.min(bornes.max, Math.max(bornes.min, Math.round(nombre * 10) / 10));
}

function alignement(valeur: unknown, defaut: FurnitureAlign): FurnitureAlign {
  return valeur === 'left' || valeur === 'center' || valeur === 'right' ? valeur : defaut;
}

function formatNumero(valeur: unknown): PageNumberFormat {
  return PAGE_NUMBER_FORMATS.some((f) => f.valeur === valeur)
    ? (valeur as PageNumberFormat)
    : DEFAULT_FURNITURE.pageNumberFormat;
}

/**
 * Adresse d'image acceptable.
 *
 * Cette valeur vient des métadonnées répliquées — donc du réseau — et finit dans
 * un attribut `src`. Seules deux formes sont admises : une image déposée sur
 * notre propre serveur, ou une adresse http(s). Tout le reste est écarté, à
 * commencer par `javascript:` : un participant malveillant ne DOIT pas pouvoir
 * faire exécuter du script chez les autres en posant un logo.
 */
export function isSafeImageSrc(valeur: unknown): boolean {
  if (typeof valeur !== 'string' || valeur.length === 0 || valeur.length > 2048) return false;
  // Chemin d'objet servi par notre API : la seule forme relative acceptée.
  if (/^\/api\/v1\/documents\/[0-9a-fA-F-]{36}\/assets\/[0-9a-fA-F-]{36}\.(png|jpg|gif|webp)$/.test(valeur)) {
    return true;
  }
  try {
    // Sans base, à dessein : `new URL(x, base)` résout aussi les chemins relatifs,
    // si bien que `/api/v1/documents/../../etc/passwd` ressortait en `https:` et
    // passait pour une adresse valide. Une adresse absolue, ou rien.
    const protocole = new URL(valeur).protocol;
    return protocole === 'http:' || protocole === 'https:';
  } catch {
    return false;
  }
}

/** Couleur exploitable telle quelle dans une feuille de style. */
function couleur(valeur: unknown): string {
  return typeof valeur === 'string' && /^#[0-9a-fA-F]{6}$/.test(valeur)
    ? valeur.toLowerCase()
    : DEFAULT_BLOCK_COLOR;
}

function fraction(valeur: unknown): number {
  const nombre = typeof valeur === 'number' ? valeur : Number.parseFloat(String(valeur));
  if (!Number.isFinite(nombre)) return 0;
  return Math.min(1, Math.max(0, Math.round(nombre * 1000) / 1000));
}

/**
 * Un identifiant de bloc, stable et sans dépendance.
 *
 * `crypto.randomUUID` n'existe pas dans tous les contextes où ce module tourne
 * (jsdom ancien, contexte non sécurisé) : on retombe sur l'horloge et le hasard.
 */
export function newBlockId(): string {
  const alea = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof alea?.randomUUID === 'function') return alea.randomUUID();
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Un bloc neuf, posé au milieu de sa bande. */
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
  };
}

/** Hauteur occupée par un bloc dans sa bande, en millimètres. */
export function blockHeightMm(bloc: FurnitureBlock): number {
  if (bloc.kind === 'image') {
    const cT = bloc.cropTop ?? 0;
    const cB = bloc.cropBottom ?? 0;
    const cropH = Math.max(0.01, (100 - cT - cB) / 100);
    return Math.round(bloc.heightMm * cropH * 10) / 10;
  }
  return lineHeightMm(bloc.fontSizePt);
}

/** Lecture défensive d'un bloc. Renvoie `null` si rien d'exploitable n'en sort. */
function readBlock(source: unknown): FurnitureBlock | null {
  if (typeof source !== 'object' || source === null) return null;
  const brut = source as Record<string, unknown>;

  const kind: FurnitureBlockKind = brut['kind'] === 'image' ? 'image' : 'text';
  const band: FurnitureBand = brut['band'] === 'footer' ? 'footer' : 'header';
  const src = isSafeImageSrc(brut['src']) ? String(brut['src']) : '';

  // Une image sans adresse exploitable n'est pas un bloc : elle laisserait un
  // trou dans la bande et un `src` vide dans le rendu.
  if (kind === 'image' && src === '') return null;

  const texte = (valeur: unknown, max: number): string =>
    typeof valeur === 'string' ? valeur.slice(0, max) : '';

  const crop = (valeur: unknown): number => {
    const n = typeof valeur === 'number' ? valeur : Number.parseFloat(String(valeur));
    if (!Number.isFinite(n)) return 0;
    return Math.min(80, Math.max(0, Math.round(n * 10) / 10));
  };

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
  };
}

/** Blocs d'une bande, dans l'ordre de saisie. */
export function blocksOf(furniture: PageFurniture, band: FurnitureBand): FurnitureBlock[] {
  return furniture.blocks.filter((bloc) => bloc.band === band);
}

/**
 * Hauteur du contenu d'une bande, en millimètres — filet non compris.
 *
 * C'est la transposition de `SwHeadFootFrm::FormatSize` : la bande ne se règle
 * pas à une valeur choisie d'avance, elle prend la hauteur de ce qu'elle
 * contient. Un logo de 25 mm repousse donc le corps de texte d'autant, au lieu
 * de déborder dessus.
 */
export function bandContentMm(furniture: PageFurniture, band: FurnitureBand): number {
  const ligne = ligneDeBase(furniture, band) === '' ? 0 : lineHeightMm(furniture.fontSizePt);

  const blocs = blocksOf(furniture, band);
  const bas = blocs.reduce((max, bloc) => Math.max(max, bloc.y + blockHeightMm(bloc)), 0);

  return Math.round(Math.max(ligne, bas) * 10) / 10;
}

/** Le modèle de la ligne de base d'une bande — sans substitution des jetons. */
function ligneDeBase(furniture: PageFurniture, band: FurnitureBand): string {
  if (band === 'header') return furniture.header.trim();
  return furniture.footer.trim() || (furniture.pageNumber ? '{page}' : '');
}

/** La bande a-t-elle quoi que ce soit à montrer ? */
export function bandIsEmpty(furniture: PageFurniture, band: FurnitureBand): boolean {
  return ligneDeBase(furniture, band) === '' && blocksOf(furniture, band).length === 0;
}

export interface ResolvedGeometry {
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  /** Hauteur du contenu de l'en-tête, filet exclu, en millimètres. */
  headerContentMm: number;
  footerContentMm: number;
  /** Réserve prise sur la page : le contenu de la bande, plus l'écart au corps. */
  headerBandMm: number;
  footerBandMm: number;
}

/**
 * L'en-tête doit rester au-dessus du corps de texte, et le pied en dessous :
 * sinon ils se recouvrent. La marge du corps est donc repoussée si nécessaire.
 *
 * Le wrapper de la bande adopte une hauteur minimale stable basée sur la marge,
 * et ne s'agrandit QUE si un élément dépasse cette limite.
 */
export function resolveGeometry(furniture: PageFurniture): ResolvedGeometry {
  const rawHeaderContentMm = bandContentMm(furniture, 'header');
  const rawFooterContentMm = bandContentMm(furniture, 'footer');

  const baseHeaderMm = Math.max(16, furniture.marginTopMm - FURNITURE_DIST_MM);
  const baseFooterMm = Math.max(16, furniture.marginBottomMm - FURNITURE_DIST_MM);

  const headerContentMm = Math.max(baseHeaderMm, rawHeaderContentMm);
  const footerContentMm = Math.max(baseFooterMm, rawFooterContentMm);

  const reserve = (contenu: number): number =>
    contenu === 0 ? 0 : Math.round((contenu + FURNITURE_DIST_MM) * 10) / 10;

  const headerBandMm = reserve(rawHeaderContentMm);
  const footerBandMm = reserve(rawFooterContentMm);

  return {
    marginTopMm: Math.max(
      furniture.marginTopMm,
      headerBandMm === 0 ? 0 : furniture.headerMm + headerBandMm,
    ),
    marginBottomMm: Math.max(
      furniture.marginBottomMm,
      footerBandMm === 0 ? 0 : furniture.footerMm + footerBandMm,
    ),
    marginLeftMm: furniture.marginLeftMm,
    marginRightMm: furniture.marginRightMm,
    headerContentMm,
    footerContentMm,
    headerBandMm,
    footerBandMm,
  };
}

export const MAX_FURNITURE_LENGTH = 200;

/** Jetons remplacés à l'affichage, pour éviter d'apprendre une syntaxe. */
export const FURNITURE_TOKENS: readonly { jeton: string; description: string }[] = [
  { jeton: '{page}', description: 'numéro de la page' },
  { jeton: '{pages}', description: 'nombre total de pages' },
  { jeton: '{titre}', description: 'titre du document' },
  { jeton: '{date}', description: 'date du jour' },
];

/** Lecture défensive : les métadonnées viennent du réseau, pas de notre code. */
export function readFurniture(source: unknown): PageFurniture {
  if (typeof source !== 'object' || source === null) return DEFAULT_FURNITURE;
  const brut = source as Record<string, unknown>;

  const texte = (valeur: unknown): string =>
    typeof valeur === 'string' ? valeur.slice(0, MAX_FURNITURE_LENGTH) : '';

  return {
    header: texte(brut['header']),
    footer: texte(brut['footer']),
    pageNumber: brut['pageNumber'] === true,
    pageNumberFormat: formatNumero(brut['pageNumberFormat']),
    onFirstPage: brut['onFirstPage'] !== false,
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

/**
 * Blocs valides, plafonnés par bande.
 *
 * Le plafond s'applique bande par bande et non au total : sans quoi douze blocs
 * dans l'en-tête interdiraient d'en poser un seul dans le pied.
 */
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
  date?: Date;
}

/** Remplace les jetons par leurs valeurs pour une page donnée. */
export function renderFurniture(modele: string, contexte: FurnitureContext): string {
  const date = contexte.date ?? new Date();

  return modele
    .replace(/\{page\}/g, String(contexte.page))
    .replace(/\{pages\}/g, String(contexte.pages))
    .replace(/\{titre\}/g, contexte.titre)
    .replace(/\{date\}/g, date.toLocaleDateString('fr-FR'));
}

/** Le numéro de page, mis en forme selon le format choisi. */
export function formatPageNumber(
  format: PageNumberFormat,
  contexte: Pick<FurnitureContext, 'page' | 'pages'>,
): string {
  switch (format) {
    case 'simple':
      return String(contexte.page);
    case 'page':
      return `Page ${contexte.page}`;
    case 'fraction':
      return `${contexte.page} / ${contexte.pages}`;
    case 'tiret':
      return `— ${contexte.page} —`;
    default:
      return `Page ${contexte.page} / ${contexte.pages}`;
  }
}

/** Texte du pied, numéro de page compris. */
export function footerLine(furniture: PageFurniture, contexte: FurnitureContext): string {
  const texte = renderFurniture(furniture.footer, contexte).trim();
  if (!furniture.pageNumber) return texte;

  const numero = formatPageNumber(furniture.pageNumberFormat, contexte);
  return texte ? `${texte} — ${numero}` : numero;
}

/** L'en-tête et le pied s'affichent-ils sur cette page ? */
export function showsOn(furniture: PageFurniture, page: number): boolean {
  return furniture.onFirstPage || page > 1;
}


/* --- Magnétisme ------------------------------------------------------------
   Poser un logo « à la marge » ou « au centre » à la souris seule est un jeu
   d'adresse : au millimètre près, on n'y arrive pas, et deux éléments censés
   être alignés ne le sont jamais tout à fait. L'aimantation fait le dernier
   millimètre à notre place et MONTRE sur quoi elle s'appuie.

   Module pur : l'appelant fournit les cibles en millimètres, il reçoit la
   position corrigée et les repères à dessiner. */

/** Une position remarquable sur laquelle un élément peut se caler. */
export interface SnapTarget {
  /** Position de la cible sur l'axe, en millimètres. */
  mm: number;
  /** Nature de la cible — sert à choisir la couleur du repère. */
  kind: 'margin' | 'center' | 'edge' | 'block' | 'baseline';
  /** Libellé annoncé dans le bandeau de position. */
  label?: string;
}

export interface SnapOutcome {
  /** Position corrigée du bord « bas » de l'élément (gauche ou haut). */
  startMm: number;
  /** Repères à tracer, en millimètres sur l'axe. */
  guides: SnapTarget[];
}

/**
 * Aimante un élément sur un axe.
 *
 * Les trois ancres de l'élément — bord bas, milieu, bord haut — sont candidates :
 * c'est ce qui permet de centrer un logo sur la page aussi bien que de le caler
 * sur la marge. On retient la correction la plus faible, puis on redonne TOUS
 * les repères que cette correction satisfait, pour que l'aperçu montre le
 * centrage et l'alignement au même instant quand les deux coïncident.
 */
export function snapAxis(
  startMm: number,
  sizeMm: number,
  targets: readonly SnapTarget[],
  thresholdMm: number,
): SnapOutcome {
  const ancres = [0, sizeMm / 2, sizeMm];

  let meilleur: { delta: number; ecart: number } | null = null;
  for (const cible of targets) {
    for (const ancre of ancres) {
      const delta = cible.mm - (startMm + ancre);
      const ecart = Math.abs(delta);
      if (ecart > thresholdMm) continue;
      if (meilleur === null || ecart < meilleur.ecart) meilleur = { delta, ecart };
    }
  }

  if (meilleur === null) return { startMm, guides: [] };

  const corrige = startMm + meilleur.delta;
  // Tolérance de 0,05 mm : la correction est exacte, mais l'arithmétique
  // flottante ne l'est pas.
  const guides = targets.filter((cible) =>
    ancres.some((ancre) => Math.abs(cible.mm - (corrige + ancre)) < 0.05),
  );

  return { startMm: corrige, guides };
}

/* --- Gabarits --------------------------------------------------------------
   Une bande vide est une page blanche : on sait ce qu'on veut, pas par où
   commencer. Ces dispositions sont des points de départ modifiables, pas des
   verrous — elles n'écrivent que la ligne de base et son alignement. */

export interface FurniturePreset {
  id: string;
  label: string;
  /** Aperçu textuel de la disposition, tel qu'il s'affichera. */
  apercu: string;
  band: FurnitureBand;
  patch: Partial<PageFurniture>;
}

export const FURNITURE_PRESETS: readonly FurniturePreset[] = [
  {
    id: 'header-titre',
    label: 'Titre du document',
    apercu: '{titre}',
    band: 'header',
    patch: { header: '{titre}', headerAlign: 'left' },
  },
  {
    id: 'header-titre-date',
    label: 'Titre et date',
    apercu: '{titre} — {date}',
    band: 'header',
    patch: { header: '{titre} — {date}', headerAlign: 'center' },
  },
  {
    id: 'header-confidentiel',
    label: 'Mention de diffusion',
    apercu: 'CONFIDENTIEL',
    band: 'header',
    patch: { header: 'CONFIDENTIEL', headerAlign: 'right' },
  },
  {
    id: 'footer-numero',
    label: 'Numéro seul',
    apercu: 'Page 2 / 7',
    band: 'footer',
    patch: { footer: '', pageNumber: true, pageNumberFormat: 'page-sur', footerAlign: 'center' },
  },
  {
    id: 'footer-titre-numero',
    label: 'Titre et numéro',
    apercu: '{titre} — 2 / 7',
    band: 'footer',
    patch: { footer: '{titre}', pageNumber: true, pageNumberFormat: 'fraction', footerAlign: 'right' },
  },
  {
    id: 'footer-date',
    label: 'Date et numéro',
    apercu: '{date} — 2',
    band: 'footer',
    patch: { footer: '{date}', pageNumber: true, pageNumberFormat: 'simple', footerAlign: 'right' },
  },
];
