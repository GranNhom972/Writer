// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Découpage du flux en pages physiques. Transposition de `SwLayAction`
 * (`sw/source/core/layout/layact.cxx`), `SwFlowFrm::MoveFwd` et
 * `WidowsAndOrphans` (`sw/source/core/text/widorp.cxx`).
 *
 * Le principe de Writer, conservé ici : un cadre qui ne tient plus dans la
 * hauteur restante est **reporté** sur la page suivante, et un cadre trop grand
 * pour une page entière est **coupé** — un paragraphe entre deux lignes, un
 * tableau entre deux lignes de tableau (`SwTabFrm::Split`), jamais au milieu
 * d'une ligne.
 *
 * Les règles de veuves et d'orphelines de `WidowsAndOrphans` s'expriment ainsi :
 *   – orphelines : au moins N lignes restent en bas de la page qu'on quitte ;
 *   – veuves     : au moins N lignes passent en haut de la page suivante ;
 *   – aucune des deux ne peut être satisfaite → le paragraphe entier bascule.
 */

import { computeListMarkers } from '../document/lists';
import {
  figureNumbering,
  gridColumnsOf,
  paragraphIndex,
  tableColumnWidths,
} from '../document/document';
import { pageGeometry, type PageGeometry } from '../document/pageSetup';
import { ptToPx } from '../document/units';
import {
  isTable,
  isToc,
  type DocumentDefaults,
  type ParagraphNode,
  type TableNode,
  type WriterDocumentState,
} from '../document/types';
import {
  captionHeightPx,
  CAPTION_FONT_RATIO,
  layoutParagraph,
  type LayoutContext,
  type ParagraphLayout,
} from './lineBreak';
import {
  captionText,
  hasCaption,
  imageCaptionOf,
  imageKey,
} from '../document/images';
import type { TextMeasurer } from './measure';
import { expandToc } from './tox';
import {
  collectFlyFrames,
  projectedExclusions,
  paragraphExclusions,
  type FlyFrame,
  type FlyPlacement,
} from './flyLayout';

/** Valeurs par défaut du style « Standard » de Writer. */
export const DEFAULT_ORPHANS = 2;
export const DEFAULT_WIDOWS = 2;
/** Marge intérieure d'une cellule quand elle n'en fixe pas (`SwTableBox`). */
export const DEFAULT_CELL_PADDING_PT = 3;

/* -- Zone de notes de bas de page (`SwFtnContFrm`) --------------------------
 *
 * Writer réduit la hauteur utile du corps de texte de la hauteur qu'occupent
 * les notes appelées depuis cette page, filet de séparation compris
 * (`SwFtnBossFrm::GetVarSpace`, ftnfrm.cxx). Sans cette réserve, les dernières
 * lignes du corps se peindraient **sous** les notes.
 */

/** Corps d'une note : Writer descend de deux crans sous la taille du texte. */
export const FOOTNOTE_FONT_SIZE_PT = 8;
/** Interligne des notes, plus serrée que celle du corps. */
export const FOOTNOTE_LINE_SPACING = 1.15;
/** Filet de séparation et son air : hauteur fixe au-dessus de la première note. */
export const FOOTNOTE_SEPARATOR_PX = 12;
/** Air entre deux notes consécutives. */
export const FOOTNOTE_GAP_PX = 2;

export interface LaidOutFootnote {
  index: number;
  id: string;
  text: string;
  /** Hauteur réservée pour cette note, filet exclu. */
  heightPx: number;
}

/** Un cadre flottant posé sur une page, prêt à peindre. */
export interface LaidOutFly {
  fly: FlyFrame;
  /** Position sur la page, relative au haut de la zone de contenu. */
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

export interface PlacedParagraph {
  kind: 'paragraph';
  blockId: string;
  paragraph: ParagraphNode;
  layout: ParagraphLayout;
  /** Lignes posées sur cette page : `[fromLine, toLine)`. */
  fromLine: number;
  toLine: number;
  /** Ordonnée du haut, relative au haut de la zone de contenu de la page. */
  topPx: number;
  /**
   * Décalage horizontal du bloc. Nul au fil du document ; à l'intérieur d'un
   * tableau, c'est le bord gauche de la cellule, marge intérieure comprise.
   * Sans lui, le curseur d'une cellule se peindrait dans la marge gauche de la
   * page — le moteur calcule les lignes relativement à leur conteneur.
   */
  leftPx: number;
  heightPx: number;
  /** Le paragraphe commence sur une page précédente. */
  isContinuation: boolean;
  /** Le paragraphe se poursuit sur la page suivante. */
  continues: boolean;
}

export interface PlacedCell {
  cellId: string;
  rowIndex: number;
  cellIndex: number;
  leftPx: number;
  widthPx: number;
  layouts: ParagraphLayout[];
  paragraphs: ParagraphNode[];
  paddingPx: number;
  /** Colonnes couvertes par une fusion horizontale. */
  colSpan?: number;
  /** Lignes couvertes par une fusion verticale. */
  rowSpan?: number;
  /** Cellule absorbée par la fusion d'une voisine : ni mesurée, ni peinte. */
  covered?: boolean;
}

/**
 * Hauteur du cadre d'une cellule, fusion verticale comprise.
 *
 * Le pendant vertical de `colSpan` : une maîtresse qui couvre trois lignes
 * porte le cadre des trois. Peinte à la hauteur de sa seule ligne, elle
 * laissait les deux suivantes sans bordure — les cellules `covered` ne peignant
 * rien par ailleurs, la grille s'ouvrait sur toute la zone fusionnée.
 *
 * La somme porte sur les lignes **effectivement posées** : un tableau scindé
 * par la pagination n'a pas ses lignes suivantes sur la page courante, et le
 * cadre s'arrête alors au bas de la page — le rendu attendu.
 *
 * Vit ici, dans le moteur, et non dans la feuille : l'écran et l'export PDF
 * peignent la même grille et doivent la calculer par la même fonction. Les deux
 * portaient d'ailleurs le même défaut, chacun de son côté.
 */
export function cellFrameHeightPx(
  rows: readonly PlacedRow[],
  rowPos: number,
  cell: PlacedCell,
): number {
  const span = cell.rowSpan ?? 1;
  if (span <= 1) return rows[rowPos]?.heightPx ?? 0;
  let total = 0;
  for (let i = rowPos; i < Math.min(rowPos + span, rows.length); i += 1) {
    total += rows[i]?.heightPx ?? 0;
  }
  return total;
}

export interface PlacedRow {
  rowId: string;
  rowIndex: number;
  topPx: number;
  heightPx: number;
  cells: PlacedCell[];
  isHeader: boolean;
}

export interface PlacedTable {
  kind: 'table';
  blockId: string;
  table: TableNode;
  rows: PlacedRow[];
  topPx: number;
  heightPx: number;
  isContinuation: boolean;
  continues: boolean;
}

export type PlacedBlock = PlacedParagraph | PlacedTable;

export interface LaidOutPage {
  index: number;
  blocks: PlacedBlock[];
  /** Hauteur réellement occupée — sert au banc d'essai de débordement. */
  usedHeightPx: number;
  /** Notes de bas de page associées aux appels de notes placés sur cette page (SwFtnFrm). */
  footnotes?: LaidOutFootnote[];
  /** Hauteur totale réservée à la zone de notes, filet compris. */
  footnoteAreaHeightPx?: number;
  /** Cadres flottants à peindre sur cette page (`SwFlyFreeFrm`). */
  flies?: LaidOutFly[];
  /**
   * Les trois partitions que la peinture consomme, posées ici une fois pour
   * toutes plutôt que refiltrées à chaque rendu.
   *
   * `A4Page` en tirait cinq `filter` par feuille et par rendu — deux sur les
   * cadres pour séparer les calques `hell` et `heaven`, trois sur les blocs
   * pour retrouver les mêmes tableaux. Autant de tableaux neufs, donc autant
   * de props d'identité changeante sous un composant mémoïsé, et cinq
   * parcours par feuille sur le chemin de la frappe.
   *
   * Le moteur connaît déjà `imageInFront` et `kind` : la partition lui revient.
   */
  fliesHell: readonly LaidOutFly[];
  fliesHeaven: readonly LaidOutFly[];
  tables: readonly PlacedTable[];
}

/** Partitions vides partagées — voir `LaidOutPage`. */
const AUCUN_FLY: readonly LaidOutFly[] = Object.freeze([]);
const AUCUN_TABLEAU: readonly PlacedTable[] = Object.freeze([]);

/**
 * Calcule les partitions de peinture d'une page.
 *
 * Appelée une fois les cadres flottants rattachés : `attachFlies` peut encore
 * ajouter des cadres après la clôture de la page.
 */
function partitionnerPage(page: LaidOutPage): void {
  let hell: LaidOutFly[] | null = null;
  let heaven: LaidOutFly[] | null = null;
  for (const laid of page.flies ?? AUCUN_FLY) {
    if (laid.fly.run.imageInFront) (heaven ??= []).push(laid);
    else (hell ??= []).push(laid);
  }
  let tables: PlacedTable[] | null = null;
  for (const block of page.blocks) {
    if (block.kind === 'table') (tables ??= []).push(block);
  }
  page.fliesHell = hell ?? AUCUN_FLY;
  page.fliesHeaven = heaven ?? AUCUN_FLY;
  page.tables = tables ?? AUCUN_TABLEAU;
}

export interface DocumentLayout {
  pages: LaidOutPage[];
  geometry: PageGeometry;
  /** Mise en page de chaque paragraphe, cellules comprises, par identifiant. */
  paragraphLayouts: Map<string, ParagraphLayout>;
  /** Où chaque paragraphe a été posé — un élément par page traversée. */
  placements: Map<string, { pageIndex: number; placed: PlacedParagraph }[]>;
  /**
   * Ligne de sommaire engendrée → identifiant du titre visé.
   *
   * Sans cette table, une ligne de table des matières ne serait qu'un
   * paragraphe de texte : c'est elle qui la rend cliquable.
   */
  tocTargets: Map<string, string>;
  /**
   * Numéro de figure de chaque image auto-numérotée, par `blockId:offset`.
   *
   * Publié par la mise en page plutôt que recalculé au rendu : les deux
   * partiraient du même document, mais deux dérivations séparées finiraient par
   * diverger — et c'est la hauteur mesurée ici qui fait autorité.
   */
  figureNumbers: Map<string, number>;
  /** Identifiants des paragraphes engendrés par un sommaire, donc non éditables. */
  generatedBlockIds: Set<string>;
  /**
   * Ordre de lecture **réellement mis en page**, paragraphes engendrés compris.
   *
   * Distinct de `paragraphIndex(doc).order`, et la différence est celle qui
   * compte : l'index du document écarte les sommaires, parce qu'un curseur ne
   * doit pas pouvoir s'y poser. C'est juste pour l'édition, et faux pour la
   * peinture — une sélection qui traverse un sommaire doit le montrer surligné,
   * comme le fait Writer, où un `SwTOXBase` est protégé en écriture et non en
   * sélection.
   *
   * Publié par la mise en page parce qu'elle seule connaît cet ordre : les
   * lignes d'un sommaire n'existent qu'ici, développées juste avant la pose.
   */
  readingOrder: readonly string[];
}

export interface PaginateOptions {
  measurer: TextMeasurer;
  tabStopPx?: number;
}

/**
 * État de remplissage de la page courante.
 *
 * Le compteur `y` avance avec le corps du texte ; `footnoteHeight` grandit par
 * le bas à mesure que des appels de note sont posés. `remaining` est ce qui
 * sépare les deux — c'est la transposition directe de `SwFtnBossFrm::GetVarSpace`
 * (ftnfrm.cxx), où la hauteur disponible d'une page est sa hauteur utile moins
 * celle qu'occupe déjà son conteneur de notes.
 */
class PageBuilder {
  readonly pages: LaidOutPage[] = [];
  private blocks: PlacedBlock[] = [];
  private y = 0;
  private footnotes: LaidOutFootnote[] = [];
  private footnoteIds = new Set<string>();
  private footnoteHeight = 0;
  private flies: LaidOutFly[] = [];

  constructor(private readonly contentHeightPx: number) {}

  get top(): number {
    return this.y;
  }

  get remaining(): number {
    return this.contentHeightPx - this.y - this.footnoteHeight;
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  push(block: PlacedBlock, heightPx: number): void {
    this.blocks.push(block);
    this.y += heightPx;
  }

  addFly(fly: LaidOutFly): void {
    this.flies.push(fly);
  }

  /**
   * Hauteur qu'ajouterait la prise en charge de ces notes, sans les prendre.
   *
   * Sert à la boucle de convergence de `placeParagraph` : retenir une ligne de
   * plus peut faire descendre une note sur cette page, donc réduire la place
   * disponible, donc retenir une ligne de moins.
   */
  peekFootnoteHeight(entries: readonly LaidOutFootnote[]): number {
    let extra = 0;
    let first = this.footnoteIds.size === 0;
    for (const entry of entries) {
      if (this.footnoteIds.has(entry.id)) continue;
      if (first) {
        extra += FOOTNOTE_SEPARATOR_PX;
        first = false;
      }
      extra += entry.heightPx + FOOTNOTE_GAP_PX;
    }
    return extra;
  }

  /** Prend en charge ces notes sur la page courante (`SwFtnBossFrm::AppendFtn`). */
  reserveFootnotes(entries: readonly LaidOutFootnote[]): void {
    for (const entry of entries) {
      if (this.footnoteIds.has(entry.id)) continue;
      if (this.footnoteIds.size === 0) this.footnoteHeight += FOOTNOTE_SEPARATOR_PX;
      this.footnoteIds.add(entry.id);
      this.footnotes.push(entry);
      this.footnoteHeight += entry.heightPx + FOOTNOTE_GAP_PX;
    }
  }

  /** Ferme la page courante et en ouvre une neuve. */
  break(): void {
    const page: LaidOutPage = {
      index: this.pages.length,
      blocks: this.blocks,
      usedHeightPx: this.y,
      fliesHell: AUCUN_FLY,
      fliesHeaven: AUCUN_FLY,
      tables: AUCUN_TABLEAU,
    };
    if (this.footnotes.length > 0) {
      page.footnotes = [...this.footnotes].sort((a, b) => a.index - b.index);
      page.footnoteAreaHeightPx = this.footnoteHeight;
    }
    if (this.flies.length > 0) page.flies = this.flies;

    this.pages.push(page);
    this.blocks = [];
    this.y = 0;
    this.footnotes = [];
    this.footnoteIds = new Set();
    this.footnoteHeight = 0;
    this.flies = [];
  }

  finish(): LaidOutPage[] {
    if (this.blocks.length > 0 || this.pages.length === 0) this.break();
    return this.pages;
  }
}

/**
 * Répartit le document en pages.
 *
 * Fonction pure : mêmes entrées, mêmes pages. C'est ce qui permet de la faire
 * tourner dans un Web Worker et de la tester sans navigateur.
 *
 * ## Deux passes, et pourquoi exactement deux
 *
 * Deux informations ne sont connues qu'**après** la mise en page, alors que la
 * mise en page en dépend :
 *
 *   – le numéro de page d'un titre, dont une table des matières a besoin ;
 *   – la page d'ancrage d'un cadre `to-page`, dont l'habillage a besoin.
 *
 * Writer résout la même circularité en régénérant puis en re-disposant
 * (`SwDoc::UpdateTOX` suivi de `SwLayAction`). On fait de même, et la boucle
 * s'arrête après deux passes **par construction** : ni le nombre de lignes d'un
 * sommaire ni la géométrie d'un cadre ne dépendent des valeurs injectées. La
 * seconde passe ne change donc que des chiffres, jamais des hauteurs — la
 * troisième serait identique à la seconde.
 *
 * Un document sans sommaire ni cadre de page ne fait qu'une seule passe.
 */
export function paginateDocument(
  doc: WriterDocumentState,
  options: PaginateOptions,
): DocumentLayout {
  // La légende d'un cadre flottant compte dans sa hauteur : le texte la
  // contourne comme il contourne l'image.
  const figureNumbersForFlies = figureNumbering(doc);
  // Les cadres sont posés **avant** la première passe : leur alignement se
  // résout sur la géométrie de la feuille, qui ne dépend d'aucun placement.
  const flyGeometry = pageGeometry(doc.pageSetup);
  const flies = collectFlyFrames(doc, flyGeometry, (run, blockId, offset, widthPx) =>
    hasCaption(run)
      ? captionHeightPx(
          captionText(
            imageCaptionOf(run),
            figureNumbersForFlies.get(imageKey(blockId, offset)) ?? null,
          ),
          widthPx,
          ptToPx(doc.defaults.fontSizePt) * CAPTION_FONT_RATIO,
          options.measurer,
        )
      : 0,
  );
  const hasToc = doc.blocks.some(isToc);

  const first = layoutPass(doc, options, flies, new Map(), new Map());
  /*
   * Une seconde passe dès qu'il y a un cadre, et non plus seulement pour ceux
   * ancrés à la page.
   *
   * Un cadre dépasse presque toujours de son ancre — une image de huit
   * centimètres dans un paragraphe de deux lignes déborde nécessairement sur ce
   * qui suit —, et le texte suivant ne peut le contourner que si l'on sait où
   * le cadre est **tombé**. C'est ce que la première passe apprend.
   */
  if (!hasToc && flies.length === 0) return first;

  return layoutPass(doc, options, flies, headingPages(doc, first), flyPlacements(first));
}

/** Page 1-indexée de chaque titre du flux principal, d'après une passe faite. */
function headingPages(
  doc: WriterDocumentState,
  layout: DocumentLayout,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const block of doc.blocks) {
    if (isTable(block) || isToc(block) || block.type !== 'heading') continue;
    const placement = layout.placements.get(block.id)?.[0];
    if (placement) out.set(block.id, placement.pageIndex + 1);
  }
  return out;
}

/**
 * Page et ordonnée de l'ancre de chaque paragraphe, d'après une passe faite.
 *
 * La **première** occurrence seule : un paragraphe coupé entre deux pages
 * ancre ses cadres là où il commence, comme `SwFlyFrm::AnchorFrm` les ancre au
 * `SwTxtFrm` maître et non à sa suite.
 */
function flyPlacements(layout: DocumentLayout): Map<string, FlyPlacement> {
  const out = new Map<string, FlyPlacement>();
  for (const [blockId, entries] of layout.placements) {
    const first = entries[0];
    if (first) out.set(blockId, { pageIndex: first.pageIndex, topPx: first.placed.topPx });
  }
  return out;
}

/* ------------------------------------------- partage des mises en page */

/**
 * Une mise en page de paragraphe déjà calculée, et le contexte qui l'a produite.
 */
interface VarianteLayout {
  /** Comparés par identité : ce sont des objets immuables du document. */
  defaults: DocumentDefaults;
  signature: string;
  layout: ParagraphLayout;
}

/**
 * Mises en page conservées d'une pagination à l'autre.
 *
 * Le premier niveau est le **mesureur**, qui vit aussi longtemps que la session
 * d'édition : changer de mesureur — donc de métriques — doit repartir de zéro.
 * Le second est le **nœud de paragraphe**, immuable : une frappe remplace le
 * nœud modifié et laisse tous les autres intacts, si bien que l'appartenance au
 * cache dit exactement « ce paragraphe n'a pas changé ».
 *
 * Deux `WeakMap` imbriquées : rien ici ne retient un document ni un paragraphe
 * en vie, et la pile d'annulation garde naturellement chaudes les versions
 * qu'elle référence encore.
 */
const layoutsMemoises = new WeakMap<TextMeasurer, WeakMap<ParagraphNode, VarianteLayout[]>>();

/**
 * Nombre de contextes distincts conservés pour un même paragraphe.
 *
 * Un paragraphe est mis en page une fois par passe, et `paginateDocument` en
 * fait au plus deux (sommaire et cadres flottants) ; en cellule de tableau la
 * largeur diffère encore. Quatre couvre ces cas avec de la marge, et borne le
 * cache à une taille constante par paragraphe.
 */
const MAX_VARIANTES = 4;

/**
 * Empreinte des entrées de contexte qui ne sont pas des identités stables.
 *
 * `marker`, `exclusions` et `figureNumbers` sont reconstruits à chaque passe :
 * les comparer par identité rejetterait toujours le cache. Ce sont en revanche
 * des valeurs plates et courtes, qu'une chaîne décrit intégralement.
 */
function signatureContexte(ctx: LayoutContext, figures: string): string {
  const m = ctx.marker;
  const marqueur = m ? `${m.kind}/${m.level}/${m.text}/${m.checked ? 1 : 0}/${m.value}` : '';
  let exclusions = '';
  for (const e of ctx.exclusions ?? []) {
    exclusions += `${e.topPx},${e.bottomPx},${e.leftPx},${e.rightPx};`;
  }
  return `${ctx.contentWidthPx}|${ctx.tabStopPx ?? ''}|${marqueur}|${exclusions}|${figures}`;
}

/**
 * Numéros de figure qui concernent ce paragraphe, et eux seuls.
 *
 * `layoutParagraph` ne consulte la table que par `imageKey(blockId, offset)` :
 * les numéros des autres paragraphes n'entrent donc pas dans le résultat, et
 * les faire entrer dans l'empreinte invaliderait tout le document dès qu'une
 * image est insérée n'importe où.
 */
function figuresDuParagraphe(ctx: LayoutContext): string {
  if (!ctx.figureNumbers || !ctx.blockId) return '';
  const prefixe = `${ctx.blockId}:`;
  let out = '';
  for (const [cle, valeur] of ctx.figureNumbers) {
    if (cle.startsWith(prefixe)) out += `${cle}=${valeur};`;
  }
  return out;
}

/**
 * Met en page un paragraphe, en réutilisant le résultat s'il est déjà connu.
 *
 * Deux gains, de natures différentes :
 *
 *  - **le calcul** : le découpage en lignes et la mesure des grappes sont le
 *    poste dominant d'une pagination. Une frappe ne modifie qu'un paragraphe ;
 *    recomposer les autres à l'identique était du travail pur perdu, payé à
 *    chaque caractère et proportionnel à la longueur du document.
 *  - **l'identité** : le résultat rendu est l'objet **précédent**, et non un
 *    équivalent. C'est ce qui rend `React.memo(ParagraphView)` opérant — un
 *    objet neuf à chaque passe, même de contenu identique, échoue à la
 *    comparaison superficielle et force le rendu de tout le document.
 *
 * La justesse tient à l'immuabilité : le nœud de paragraphe n'est jamais
 * modifié en place, et l'empreinte couvre tout ce dont dépend le résultat.
 */
function layoutParagraphMemoise(
  paragraph: ParagraphNode,
  ctx: LayoutContext,
): ParagraphLayout {
  let parParagraphe = layoutsMemoises.get(ctx.measurer);
  if (!parParagraphe) {
    parParagraphe = new WeakMap<ParagraphNode, VarianteLayout[]>();
    layoutsMemoises.set(ctx.measurer, parParagraphe);
  }

  const signature = signatureContexte(ctx, figuresDuParagraphe(ctx));
  const variantes = parParagraphe.get(paragraph);
  if (variantes) {
    for (const variante of variantes) {
      if (variante.defaults === ctx.defaults && variante.signature === signature) {
        return variante.layout;
      }
    }
  }

  const layout = layoutParagraph(paragraph, ctx);
  const entree: VarianteLayout = { defaults: ctx.defaults, signature, layout };
  if (!variantes) {
    parParagraphe.set(paragraph, [entree]);
  } else {
    // Les variantes les plus récentes en tête : la plus utile est la dernière
    // posée, et la plus ancienne sort quand le plafond est atteint.
    variantes.unshift(entree);
    if (variantes.length > MAX_VARIANTES) variantes.length = MAX_VARIANTES;
  }
  return layout;
}

/** Une passe complète de mise en page. */
function layoutPass(
  doc: WriterDocumentState,
  options: PaginateOptions,
  flies: readonly FlyFrame[],
  headingPageNumbers: ReadonlyMap<string, number>,
  flyAnchorPlacements: ReadonlyMap<string, FlyPlacement>,
): DocumentLayout {
  const geometry = pageGeometry(doc.pageSetup);
  const baseCtx: LayoutContext = {
    measurer: options.measurer,
    defaults: doc.defaults,
    contentWidthPx: geometry.contentWidthPx,
    ...(options.tabStopPx !== undefined ? { tabStopPx: options.tabStopPx } : {}),
  };

  // Les marqueurs de liste sont calculés une fois pour le document entier :
  // le numéro d'un élément dépend de ce qui le précède, il ne peut donc pas se
  // déduire d'un paragraphe pris isolément.
  const markers = computeListMarkers(doc);
  // Numéros de figure : dérivés une fois par passe de mise en page, jamais
  // conservés dans le document (cf. `figureNumbering`).
  const figureNumbers = figureNumbering(doc);

  const paragraphLayouts = new Map<string, ParagraphLayout>();
  const placements = new Map<string, { pageIndex: number; placed: PlacedParagraph }[]>();
  const tocTargets = new Map<string, string>();
  const generatedBlockIds = new Set<string>();
  const builder = new PageBuilder(geometry.contentHeightPx);

  const footnotes: FootnoteContext = {
    refs: collectDocumentFootnotes(doc),
    heights: new Map(),
  };
  footnotes.heights = measureFootnotes(footnotes.refs, options.measurer, doc, geometry);

  const layoutOf = (paragraph: ParagraphNode, ctx: LayoutContext): ParagraphLayout => {
    const marker = markers.get(paragraph.id);
    const own = paragraphExclusions(flies, paragraph, ctx.contentWidthPx);
    // Les cadres venus d'ailleurs — ancrés à la page, ou à un paragraphe voisin
    // dont ils débordent — n'ont de position connue qu'après une première passe.
    const ailleurs = flyAnchorPlacements.size
      ? projectedExclusions(
          flies,
          builder.pages.length,
          flyAnchorPlacements,
          builder.top,
          ctx.contentWidthPx,
          paragraph.id,
        )
      : [];
    const exclusions = own.length + ailleurs.length > 0 ? [...own, ...ailleurs] : undefined;

    let effective = ctx;
    if (marker) effective = { ...effective, marker };
    if (exclusions) effective = { ...effective, exclusions };
    // Le paragraphe et la table des numéros : la mesure d'une légende a besoin
    // des deux pour connaître le texte qu'elle doit replier.
    effective = { ...effective, blockId: paragraph.id, figureNumbers };
    return layoutParagraphMemoise(paragraph, effective);
  };

  const record = (placed: PlacedParagraph): void => {
    const list = placements.get(placed.blockId) ?? [];
    list.push({ pageIndex: builder.pages.length, placed });
    placements.set(placed.blockId, list);
  };

  // Un sommaire n'est pas un nœud de texte : il se développe en paragraphes
  // concrets juste avant la mise en page, comme `SwDoc::UpdateTOX` peuple le
  // `SwSection` d'un `SwTOXBase` avant que `SwLayAction` ne le dispose.
  const stream = expandBlocks(doc, baseCtx, headingPageNumbers, tocTargets, generatedBlockIds);

  for (const block of stream) {
    if (block.pageBreakBefore && !builder.isEmpty) builder.break();

    if (isTable(block)) {
      placeTable(block, builder, baseCtx, geometry, paragraphLayouts, record, layoutOf, footnotes);
      continue;
    }

    const layout = layoutOf(block, baseCtx);
    paragraphLayouts.set(block.id, layout);
    placeParagraph(block, layout, builder, geometry, record, footnotes);
  }

  const pages = builder.finish();

  // Les cadres flottants se posent une fois les pages closes : leur page est
  // celle de leur ancre, information qui n'existe qu'après placement.
  attachFlies(pages, flies, placements, geometry);

  for (const page of pages) partitionnerPage(page);

  return {
    pages,
    geometry,
    paragraphLayouts,
    placements,
    tocTargets,
    generatedBlockIds,
    figureNumbers,
    /*
     * L'ordre de pose, lu dans la table des mises en page.
     *
     * `paragraphLayouts` est alimentée au fil du parcours du flux développé —
     * un paragraphe quand on l'atteint, les paragraphes d'un tableau quand on
     * mesure ses lignes — et une `Map` conserve l'ordre d'insertion. Ses clés
     * sont donc déjà l'ordre de lecture, sommaire développé compris.
     */
    readingOrder: [...paragraphLayouts.keys()],
  };
}

/**
 * Développe les blocs de sommaire, laisse les autres intacts.
 *
 * Le document lui-même n'est pas modifié : la table des matières reste un
 * `TocNode` compact dans l'AST, et seule la mise en page voit des paragraphes.
 * C'est ce qui garantit qu'elle ne peut pas se désynchroniser du corps.
 */
function expandBlocks(
  doc: WriterDocumentState,
  ctx: LayoutContext,
  headingPageNumbers: ReadonlyMap<string, number>,
  tocTargets: Map<string, string>,
  generatedBlockIds: Set<string>,
): (ParagraphNode | TableNode)[] {
  // Le type de retour exclut `TocNode` : après cette fonction, plus aucun bloc
  // de sommaire ne subsiste, et le reste de la pagination n'a donc pas de cas
  // supplémentaire à connaître.
  if (!doc.blocks.some(isToc)) return doc.blocks as (ParagraphNode | TableNode)[];

  const out: (ParagraphNode | TableNode)[] = [];
  for (const block of doc.blocks) {
    if (!isToc(block)) {
      out.push(block);
      continue;
    }

    const { paragraphs, targets } = expandToc(doc, block, headingPageNumbers, ctx);
    for (const [lineId, targetId] of targets) tocTargets.set(lineId, targetId);

    paragraphs.forEach((paragraph, index) => {
      generatedBlockIds.add(paragraph.id);
      // Le saut de page éventuel du sommaire est porté par sa première ligne :
      // c'est elle qui ouvrira la nouvelle page.
      out.push(index === 0 && block.pageBreakBefore ? { ...paragraph, pageBreakBefore: true } : paragraph);
    });
  }
  return out;
}

/** Pose chaque cadre flottant sur la page de son ancre. */
function attachFlies(
  pages: LaidOutPage[],
  flies: readonly FlyFrame[],
  placements: ReadonlyMap<string, { pageIndex: number; placed: PlacedParagraph }[]>,
  geometry: PageGeometry,
): void {
  if (flies.length === 0) return;

  for (const fly of flies) {
    const placement = placements.get(fly.anchorBlockId)?.[0];
    if (!placement) continue;
    const page = pages[placement.pageIndex];
    if (!page) continue;

    // Un cadre ancré au paragraphe se pose relativement à celui-ci ; un cadre
    // ancré à la page se pose relativement au haut de la zone de contenu.
    const topPx =
      fly.anchor === 'to-para' ? placement.placed.topPx + fly.topPx : fly.topPx;

    /*
     * Le cadre est retenu sur la **feuille**, non dans la colonne de texte.
     *
     * `SwFlyFreeFrm::CheckClip` borne de même : il empêche un cadre de sortir
     * de la page, et le laisse déborder dans la marge. Serrer ici à la colonne
     * rendrait `imageHoriRelation: 'page'` inopérant — un cadre aligné sur le
     * bord de la feuille reviendrait aussitôt contre le texte.
     */
    const minLeftPx = -geometry.contentLeftPx;
    const maxLeftPx = minLeftPx + geometry.pageWidthPx - fly.widthPx;

    const laid: LaidOutFly = {
      fly,
      leftPx: Math.max(minLeftPx, Math.min(fly.leftPx, Math.max(minLeftPx, maxLeftPx))),
      topPx,
      widthPx: fly.widthPx,
      heightPx: fly.heightPx,
    };
    // `push` et non une recopie : recréer le tableau à chaque cadre rendait le
    // rattachement quadratique en nombre de cadres sur une même page.
    if (page.flies) page.flies.push(laid);
    else page.flies = [laid];
  }
}

/**
 * Hauteur réservée par chaque note de bas de page.
 *
 * Une note est un paragraphe à part entière, disposé dans une colonne de la
 * largeur de la page et dans un corps réduit (`SwFtnFrm` utilise le style
 * « Footnote »). On la met donc en page pour de vrai plutôt que d'estimer : une
 * note de trois lignes qu'on aurait comptée pour une déborderait de la feuille.
 */
function measureFootnotes(
  refs: ReadonlyMap<string, FootnoteReference>,
  measurer: TextMeasurer,
  doc: WriterDocumentState,
  geometry: PageGeometry,
): Map<string, number> {
  const out = new Map<string, number>();
  if (refs.size === 0) return out;

  const ctx: LayoutContext = {
    measurer,
    defaults: { ...doc.defaults, fontSizePt: FOOTNOTE_FONT_SIZE_PT, lineSpacing: FOOTNOTE_LINE_SPACING },
    contentWidthPx: geometry.contentWidthPx,
  };

  for (const ref of refs.values()) {
    // Le numéro en exposant précède le texte et compte dans la largeur.
    const paragraph: ParagraphNode = {
      id: `__ftn_${ref.id}`,
      type: 'paragraph',
      runs: [{ text: `${ref.index}. ${ref.text}` }],
      marginTopPt: 0,
      marginBottomPt: 0,
    };
    out.set(ref.id, layoutParagraph(paragraph, ctx).contentHeightPx);
  }

  return out;
}

export interface FootnoteReference {
  id: string;
  index: number;
  text: string;
}

/** Ce que la pagination doit savoir des notes : leur numéro et leur hauteur. */
interface FootnoteContext {
  refs: ReadonlyMap<string, FootnoteReference>;
  heights: ReadonlyMap<string, number>;
}

/**
 * Numérote les notes du document dans l'ordre de lecture.
 *
 * La numérotation est **globale et continue** (`FTNNUM_DOC`), le choix par
 * défaut de Writer : elle ne dépend donc pas de la pagination, ce qui la rend
 * stable d'une passe à l'autre. Une numérotation par page (`FTNNUM_PAGE`)
 * imposerait au contraire de renuméroter après chaque changement de mise en
 * page, et donc de re-paginer après avoir renuméroté.
 */
export function collectDocumentFootnotes(doc: WriterDocumentState): Map<string, FootnoteReference> {
  const map = new Map<string, FootnoteReference>();
  const { order, byId } = paragraphIndex(doc);
  let counter = 1;
  for (const id of order) {
    const node = byId.get(id)?.paragraph;
    if (!node) continue;
    for (const run of node.runs) {
      if (run.footnoteText && run.footnoteId && !map.has(run.footnoteId)) {
        map.set(run.footnoteId, {
          id: run.footnoteId,
          index: counter,
          text: run.footnoteText,
        });
        counter += 1;
      }
    }
  }
  return map;
}

/**
 * Notes appelées par les lignes `[from, to)` d'un paragraphe.
 *
 * C'est la granularité qui compte : une note n'est due par une page que si
 * **la ligne portant son appel** y a été posée. Compter le paragraphe entier
 * réserverait sur la première page l'espace de notes appelées trois pages plus
 * loin.
 */
function footnotesInLines(
  layout: ParagraphLayout,
  from: number,
  to: number,
  refs: ReadonlyMap<string, FootnoteReference>,
  heights: ReadonlyMap<string, number>,
): LaidOutFootnote[] {
  const out: LaidOutFootnote[] = [];
  const seen = new Set<string>();

  for (let i = from; i < to; i += 1) {
    const line = layout.lines[i];
    if (!line) continue;
    for (const segment of line.segments) {
      const id = segment.formatting.footnoteId;
      if (!id || seen.has(id)) continue;
      const ref = refs.get(id);
      if (!ref) continue;
      seen.add(id);
      out.push({ id: ref.id, index: ref.index, text: ref.text, heightPx: heights.get(id) ?? 0 });
    }
  }

  return out;
}

/** Somme des hauteurs des lignes `[from, to)`. */
function linesHeight(layout: ParagraphLayout, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i += 1) total += layout.lines[i]?.heightPx ?? 0;
  return total;
}

/**
 * Nombre de lignes de `[from, …)` qui tiennent dans `available`.
 *
 * Une ligne ne tient que **complètement** : Writer ne coupe pas une ligne en
 * deux entre deux pages, et une demi-ligne en bas de feuille serait illisible.
 */
function fittingLines(layout: ParagraphLayout, from: number, available: number): number {
  let used = 0;
  let count = 0;
  for (let i = from; i < layout.lines.length; i += 1) {
    const height = layout.lines[i]!.heightPx;
    if (used + height > available) break;
    used += height;
    count += 1;
  }
  return count;
}

function placeParagraph(
  paragraph: ParagraphNode,
  layout: ParagraphLayout,
  builder: PageBuilder,
  geometry: PageGeometry,
  record: (placed: PlacedParagraph) => void,
  footnotes: FootnoteContext,
): void {
  const orphans = Math.max(0, paragraph.orphans ?? DEFAULT_ORPHANS);
  const widows = Math.max(0, paragraph.widows ?? DEFAULT_WIDOWS);
  const totalLines = layout.lines.length;

  let cursor = 0;
  let isContinuation = false;

  while (cursor < totalLines) {
    const marginTop = isContinuation ? 0 : layout.marginTopPx;
    const available = builder.remaining - marginTop;

    // Tout le reste tient, marge basse et notes appelées comprises.
    const restHeight = linesHeight(layout, cursor, totalLines);
    const restFootnotes = footnotesInLines(layout, cursor, totalLines, footnotes.refs, footnotes.heights);
    const restFootnoteHeight = builder.peekFootnoteHeight(restFootnotes);

    if (available >= restHeight + layout.marginBottomPx + restFootnoteHeight) {
      const placed = makePlaced(paragraph, layout, cursor, totalLines, builder.top, {
        marginTop,
        marginBottom: layout.marginBottomPx,
        isContinuation,
        continues: false,
      });
      builder.reserveFootnotes(restFootnotes);
      record(placed);
      builder.push(placed, placed.heightPx);
      return;
    }

    let fit = fitWithFootnotes(layout, cursor, Math.max(0, available), builder, footnotes);
    const wouldRemain = totalLines - cursor - fit;

    // Veuves : trop peu de lignes partiraient sur la page suivante — on en
    // retient davantage ici pour que le report atteigne le seuil.
    if (fit > 0 && wouldRemain > 0 && wouldRemain < widows) {
      fit = Math.max(0, totalLines - cursor - widows);
    }

    // Orphelines : trop peu de lignes resteraient ici, ou le paragraphe refuse
    // d'être coupé — il bascule en entier sur la page suivante.
    const refusesSplit = paragraph.keepTogether === true;
    if ((refusesSplit || fit < orphans || fit === 0) && !builder.isEmpty) {
      builder.break();
      continue;
    }

    // Page déjà vide et le paragraphe déborde quand même : on pose ce qui tient,
    // au moins une ligne. Sans cette garde — la même que `bHasToFit` dans
    // `WidowsAndOrphans::FindBreak` — la boucle n'avancerait jamais.
    if (fit === 0) fit = 1;

    const placed = makePlaced(paragraph, layout, cursor, cursor + fit, builder.top, {
      marginTop,
      marginBottom: 0,
      isContinuation,
      continues: true,
    });
    builder.reserveFootnotes(
      footnotesInLines(layout, cursor, cursor + fit, footnotes.refs, footnotes.heights),
    );
    record(placed);
    builder.push(placed, placed.heightPx);
    builder.break();

    cursor += fit;
    isContinuation = true;
  }

  // Paragraphe vide de lignes : impossible en pratique (une ligne existe
  // toujours, même vide), mais la boucle ci-dessus ne poserait rien.
  if (totalLines === 0) {
    const placed = makePlaced(paragraph, layout, 0, 0, builder.top, {
      marginTop: layout.marginTopPx,
      marginBottom: layout.marginBottomPx,
      isContinuation: false,
      continues: false,
    });
    record(placed);
    builder.push(placed, placed.heightPx);
  }

  void geometry;
}

/**
 * Nombre de lignes retenues, la place prise par leurs notes déduite.
 *
 * Le calcul est **circulaire** : retenir une ligne de plus peut faire descendre
 * une note sur cette page, ce qui réduit la place disponible, ce qui peut
 * obliger à retenir une ligne de moins. `SwTxtFrm::CalcFtnFlag` et
 * `SwFtnBossFrm::MoveFtns` bouclent de la même façon.
 *
 * La suite converge : le nombre de lignes retenues décroît strictement à chaque
 * tour, et il est borné par le bas par zéro. La garde compte donc des tours
 * pour se protéger d'un cas pathologique, pas d'une divergence réelle.
 */
function fitWithFootnotes(
  layout: ParagraphLayout,
  from: number,
  available: number,
  builder: PageBuilder,
  footnotes: FootnoteContext,
): number {
  let fit = fittingLines(layout, from, available);

  if (footnotes.refs.size === 0) return fit;

  for (let guard = 0; guard < 8 && fit > 0; guard += 1) {
    const reserve = builder.peekFootnoteHeight(
      footnotesInLines(layout, from, from + fit, footnotes.refs, footnotes.heights),
    );
    if (reserve === 0) return fit;

    const next = fittingLines(layout, from, Math.max(0, available - reserve));
    if (next >= fit) return next;
    fit = next;
  }

  return fit;
}

function makePlaced(
  paragraph: ParagraphNode,
  layout: ParagraphLayout,
  fromLine: number,
  toLine: number,
  topPx: number,
  spacing: {
    marginTop: number;
    marginBottom: number;
    isContinuation: boolean;
    continues: boolean;
  },
): PlacedParagraph {
  return {
    kind: 'paragraph',
    blockId: paragraph.id,
    paragraph,
    layout,
    fromLine,
    toLine,
    topPx,
    leftPx: 0,
    heightPx:
      spacing.marginTop + linesHeight(layout, fromLine, toLine) + spacing.marginBottom,
    isContinuation: spacing.isContinuation,
    continues: spacing.continues,
  };
}

/* ------------------------------------------------------------------ tableaux */

/**
 * Frontières des colonnes, en pixels, cumulées **puis** arrondies.
 *
 * Le tableau rendu compte `n + 1` bornes pour `n` colonnes : `bornes[i]` est le
 * bord gauche de la colonne `i`, `bornes[i + 1]` son bord droit.
 *
 * L'ordre des deux opérations est tout l'objet de la fonction. Arrondir chaque
 * largeur puis les additionner fait dériver l'erreur d'une colonne à l'autre —
 * jusqu'à un pixel entier d'écart sur la dernière, qui ne tombe alors plus sur
 * le bord de la zone de texte. Cumuler d'abord puis arrondir le cumul borne
 * l'erreur à un demi-pixel **sur chaque borne prise isolément**, sans jamais
 * l'accumuler : `X_n = round(somme des W_i)`.
 *
 * Les largeurs se lisent ensuite par **différence de deux bornes**, jamais par
 * une somme indépendante. C'est ce qui garantit `gauche_i + largeur_i` égal à
 * `gauche_{i+1}` au pixel près : les cellules sont peintes en `border-box` avec
 * une bordure d'un pixel, et le moindre écart sous-pixel entre le bord droit
 * d'une cellule et le bord gauche de sa voisine ouvre une couture claire ou
 * double le trait selon le niveau de zoom.
 */
function columnBoundariesPx(table: TableNode, contentWidthPx: number): number[] {
  const pourcentages = tableColumnWidths(table);
  const bornes: number[] = [0];
  let cumul = 0;
  for (const pct of pourcentages) {
    cumul += pct;
    bornes.push(Math.round((contentWidthPx * cumul) / 100));
  }
  return bornes;
}

/**
 * Pose un tableau, en le coupant au besoin **entre deux lignes**.
 *
 * `SwTabFrm::Split` procède ainsi, et répète les lignes d'en-tête en haut de
 * chaque morceau (`SwTable::GetRowsToRepeat`) : sans elles, la suite d'un
 * tableau sur la page suivante devient une grille de chiffres sans légende.
 */
function placeTable(
  table: TableNode,
  builder: PageBuilder,
  ctx: LayoutContext,
  geometry: PageGeometry,
  paragraphLayouts: Map<string, ParagraphLayout>,
  record: (placed: PlacedParagraph) => void,
  layoutOf: (paragraph: ParagraphNode, ctx: LayoutContext) => ParagraphLayout,
  footnotes: FootnoteContext,
): void {
  // La grille est une propriété du tableau, pas de la ligne : la calculer dans
  // `measureRow` la reconstruisait — deux tableaux de nombres compris — à
  // chaque ligne, donc à chaque pagination, donc à chaque frappe.
  const bornesPx = columnBoundariesPx(table, geometry.contentWidthPx);
  const measured = table.rows.map((row, rowIndex) =>
    measureRow(table, row.id, rowIndex, bornesPx, ctx, geometry, paragraphLayouts, layoutOf),
  );
  const headerRows = measured.filter((row) => row.isHeader);
  const headerHeight = headerRows.reduce((sum, row) => sum + row.heightPx, 0);

  let cursor = 0;
  let isContinuation = false;

  while (cursor < measured.length) {
    // Sur une suite de tableau, les lignes d'en-tête sont réémises en tête de
    // morceau et occupent la hauteur d'autant.
    const rows: PlacedRow[] = isContinuation ? headerRows.map((row) => ({ ...row })) : [];
    let used = isContinuation ? headerHeight : 0;
    let taken = 0;

    for (let i = cursor; i < measured.length; i += 1) {
      const row = measured[i]!;
      // Une ligne d'en-tête déjà répétée ne se pose pas une seconde fois.
      if (isContinuation && row.isHeader) {
        taken += 1;
        continue;
      }
      const fits = used + row.heightPx <= builder.remaining;
      // Page vide : poser au moins une ligne, sinon rien ne progresse. La
      // coupure d'une ligne de tableau à cheval sur deux pages n'est pas
      // traitée (cf. README, jalon J1).
      if (!fits && !(taken === 0 && builder.isEmpty)) break;
      rows.push({ ...row });
      used += row.heightPx;
      taken += 1;
      if (!fits) break;
    }

    if (taken === 0) {
      builder.break();
      continue;
    }

    let y = 0;
    for (const row of rows) {
      row.topPx = y;
      y += row.heightPx;
    }

    const continues = cursor + taken < measured.length;
    const placed: PlacedTable = {
      kind: 'table',
      blockId: table.id,
      table,
      rows,
      topPx: builder.top,
      heightPx: y,
      isContinuation,
      continues,
    };
    // Chaque paragraphe de cellule est enregistré à sa position absolue sur la
    // page : c'est ce qui permet au curseur et à la sélection de fonctionner
    // dans un tableau sans code particulier.
    for (const row of rows) {
      for (const cell of row.cells) {
        let cellY = builder.top + row.topPx + cell.paddingPx;
        cell.layouts.forEach((layout, index) => {
          const paragraph = cell.paragraphs[index];
          if (!paragraph) return;
          record({
            kind: 'paragraph',
            blockId: paragraph.id,
            paragraph,
            layout,
            fromLine: 0,
            toLine: layout.lines.length,
            topPx: cellY,
            leftPx: cell.leftPx + cell.paddingPx,
            heightPx: layout.heightPx,
            isContinuation: false,
            continues: false,
          });
          cellY += layout.heightPx;
        });
      }
    }

    // Une note appelée depuis une cellule est due par la page qui porte cette
    // ligne de tableau, au même titre qu'une note appelée depuis le corps.
    if (footnotes.refs.size > 0) {
      for (const row of rows) {
        for (const cell of row.cells) {
          for (const layout of cell.layouts) {
            builder.reserveFootnotes(
              footnotesInLines(layout, 0, layout.lines.length, footnotes.refs, footnotes.heights),
            );
          }
        }
      }
    }

    builder.push(placed, y);
    cursor += taken;
    isContinuation = true;
    if (continues) builder.break();
  }
}

function measureRow(
  table: TableNode,
  rowId: string,
  rowIndex: number,
  /** Bornes de colonnes du tableau — cf. `columnBoundariesPx`. */
  bornesPx: readonly number[],
  ctx: LayoutContext,
  geometry: PageGeometry,
  paragraphLayouts: Map<string, ParagraphLayout>,
  layoutOf: (paragraph: ParagraphNode, ctx: LayoutContext) => ParagraphLayout,
): PlacedRow {
  const row = table.rows[rowIndex]!;
  const cells: PlacedCell[] = [];
  let height = 0;

  const derniereBorne = bornesPx[bornesPx.length - 1] ?? 0;
  const gridCols = gridColumnsOf(row);

  row.cells.forEach((cell, cellIndex) => {
    const gridCol = gridCols[cellIndex] ?? cellIndex;
    const span = Math.max(1, cell.colSpan ?? 1);
    const leftPx = bornesPx[gridCol] ?? 0;

    // Cellule recouverte par une fusion (`SwTableBox` de RowSpan négatif) :
    // elle garde sa place dans la grille mais n'est ni mesurée ni peinte.
    if (cell.covered) {
      cells.push({
        cellId: cell.id,
        rowIndex,
        cellIndex,
        leftPx,
        widthPx: 0,
        layouts: [],
        paragraphs: [],
        paddingPx: 0,
        covered: true,
      });
      return;
    }

    // Différence de deux bornes, et non somme des largeurs traversées : c'est
    // la seule forme qui referme exactement la grille sur la borne suivante.
    let widthPx = (bornesPx[Math.min(gridCol + span, bornesPx.length - 1)] ?? derniereBorne) - leftPx;
    if (widthPx <= 0) {
      widthPx = Math.round((geometry.contentWidthPx * (cell.widthPercent ?? 100)) / 100);
    }

    const paddingPx = ptToPx(cell.paddingPt ?? DEFAULT_CELL_PADDING_PT);
    const innerCtx: LayoutContext = {
      ...ctx,
      contentWidthPx: Math.max(1, widthPx - paddingPx * 2),
    };

    const layouts = cell.blocks.map((paragraph) => {
      const layout = layoutOf(paragraph, innerCtx);
      paragraphLayouts.set(paragraph.id, layout);
      return layout;
    });

    const contentHeight = layouts.reduce((sum, layout) => sum + layout.heightPx, 0);

    // Une cellule fusionnée verticalement répartit sa hauteur sur les lignes
    // qu'elle couvre : la lui imputer entière gonflerait la première ligne et
    // laisserait les suivantes vides.
    const rowSpan = Math.max(1, cell.rowSpan ?? 1);
    height = Math.max(height, (contentHeight + paddingPx * 2) / rowSpan);

    cells.push({
      cellId: cell.id,
      rowIndex,
      cellIndex,
      leftPx,
      widthPx,
      layouts,
      paragraphs: cell.blocks,
      paddingPx,
      ...(span > 1 ? { colSpan: span } : {}),
      ...(rowSpan > 1 ? { rowSpan } : {}),
    });
  });

  return {
    rowId,
    rowIndex,
    topPx: 0,
    heightPx: height,
    cells,
    isHeader: row.isHeader === true,
  };
}
