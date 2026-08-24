/**
 * Couche 1 — modèle du document.
 *
 * Transposition directe du modèle StarWriter (`aoo-4.1.16/main/sw`) :
 *
 *   SwDoc        → WriterDocumentState  (tableau ordonné de nœuds de contenu)
 *   SwNodes      → WriterDocumentState.blocks
 *   SwTxtNode    → ParagraphNode        (chaîne brute + liste d'attributs)
 *   SwpHints     → ParagraphNode.runs   (plages de formatage de caractère)
 *   SwAttrSet    → attributs de paragraphe (alignment, lineSpacing, retraits)
 *   SwTable*     → TableNode / TableCellNode
 *   SwPaM        → DocumentSelection    (Point and Mark)
 *   SwPageDesc   → PageSetup
 *
 * Différence assumée avec le C++ : là où `SwpHints` conserve des plages
 * *chevauchantes* (`[start,end)` par attribut), on stocke des **runs disjoints**
 * déjà aplatis. Les deux représentations sont équivalentes ; la seconde se rend
 * directement en DOM sans étape d'aplatissement, ce qui est le seul usage ici.
 * L'invariant correspondant (`SwpHints::MergePortions`, thints.cxx:2684) est
 * conservé : **deux runs adjacents de formatage identique sont toujours fusionnés**.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

/** Plage de texte homogène. Inspiré de `SwTxtAttr` / `SwpHints`. */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeThrough?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  backgroundColor?: string;
  linkHref?: string;
  /** Code LaTeX de la formule mathématique si ce run représente un objet mathématique. */
  mathLatex?: string;
  /** Vrai si la formule est affichée centrée sur sa propre ligne (display mode). */
  mathDisplay?: boolean;
}

/**
 * Attributs de caractère d'un run, sans son texte.
 *
 * `SwAttrSet` distingue de la même façon le contenu et son jeu d'attributs :
 * c'est ce qui permet de comparer deux plages et de les fusionner.
 */
export type RunFormatting = Omit<TextRun, 'text'>;

/** Les clés de formatage de caractère, dans l'ordre de comparaison. */
export const RUN_FORMAT_KEYS = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'fontFamily',
  'fontSizePt',
  'color',
  'backgroundColor',
  'linkHref',
  'mathLatex',
  'mathDisplay',
] as const satisfies readonly (keyof RunFormatting)[];

export type RunFormatKey = (typeof RUN_FORMAT_KEYS)[number];

export type Alignment = 'left' | 'center' | 'right' | 'justify';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Nature d'une liste. `task` ajoute une case à cocher, comme dans Write. */
export type ListKind = 'bullet' | 'ordered' | 'task';

/** Profondeur maximale d'imbrication — `MAXLEVEL` de `sw/inc/swtypes.hxx`. */
export const MAX_LIST_LEVEL = 10;

/**
 * Nœud paragraphe ou titre. Inspiré de `SwTxtNode`.
 *
 * `runs` porte le texte ; la concaténation des `text` est la chaîne brute du
 * nœud, et un offset de curseur s'exprime dans cette chaîne (jamais dans un run
 * particulier), exactement comme `SwIndex` indexe `SwTxtNode::m_Text`.
 */
export interface ParagraphNode {
  id: string;
  type: 'paragraph' | 'heading';
  headingLevel?: HeadingLevel;
  styleName?: string;
  runs: TextRun[];
  alignment?: Alignment;
  /** Facteur d'interligne : 1.0, 1.15, 1.5, 2.0. */
  lineSpacing?: number;
  marginTopPt?: number;
  marginBottomPt?: number;
  indentLeftPt?: number;
  indentRightPt?: number;
  firstLineIndentPt?: number;
  /** Saut de page explicite **avant** ce bloc (`SwFmtPageDesc` / `SVX_BREAK_PAGE_BEFORE`). */
  pageBreakBefore?: boolean;
  /**
   * Nombre minimal de lignes conservées en bas de page lors d'une coupure
   * (`SvxOrphansItem`, widorp.cxx). 0 ou 1 désactive la règle.
   */
  orphans?: number;
  /** Nombre minimal de lignes reportées en haut de page (`SvxWidowsItem`). */
  widows?: number;
  /** Interdit la coupure du paragraphe entre deux pages (`SvxFmtSplitItem`). */
  keepTogether?: boolean;

  /* -- Numérotation -------------------------------------------------------
   *
   * Writer ne connaît pas de nœud « liste » : une liste est un **attribut de
   * paragraphe** (`RES_PARATR_LIST_*`, hintids.hxx:178), et c'est la règle de
   * numérotation qui décide de la puce ou du numéro. On transpose tel quel —
   * ce qui a un avantage concret sur une structure imbriquée : changer le
   * niveau d'un élément ne déplace aucun nœud, ce n'est qu'un attribut de plus.
   */

  /** `SwTxtNode::GetNumRule()` : la nature de la liste, absente hors liste. */
  listKind?: ListKind;
  /**
   * `RES_PARATR_LIST_ID` : deux listes séparées par du texte ne partagent pas
   * leur compteur. Sans cet identifiant, la seconde reprendrait à 4 après une
   * première qui s'arrêtait à 3.
   */
  listId?: string;
  /** `RES_PARATR_LIST_LEVEL`, de 0 à `MAX_LIST_LEVEL - 1`. */
  listLevel?: number;
  /** `RES_PARATR_LIST_ISRESTART` : redémarre le compteur à cet élément. */
  listRestart?: boolean;
  /** `RES_PARATR_LIST_RESTARTVALUE` : la valeur à laquelle repartir. */
  listStartValue?: number;
  /** État de la case, pour une liste à cocher. */
  listChecked?: boolean;
}

/** Cellule de tableau. Inspiré de `SwTableBox`. */
export interface TableCellNode {
  id: string;
  blocks: ParagraphNode[];
  colSpan?: number;
  rowSpan?: number;
  widthPercent?: number;
  backgroundColor?: string;
  borderColor?: string;
  paddingPt?: number;
}

/** Ligne de tableau. Inspiré de `SwTableLine`. */
export interface TableRowNode {
  id: string;
  cells: TableCellNode[];
  /** Ligne d'en-tête répétée en haut de chaque page (`SwTable::SetRowsToRepeat`). */
  isHeader?: boolean;
}

/** Tableau. Inspiré de `SwTable`. */
export interface TableNode {
  id: string;
  type: 'table';
  rows: TableRowNode[];
  pageBreakBefore?: boolean;
  borderColor?: string;
  borderWidthPt?: number;
}

export type DocumentBlock = ParagraphNode | TableNode;

/** Discriminant sûr : un bloc est un tableau ou un nœud de texte. */
export function isTable(block: DocumentBlock): block is TableNode {
  return block.type === 'table';
}

export function isParagraph(block: DocumentBlock): block is ParagraphNode {
  return block.type !== 'table';
}

/**
 * Position dans le document. Inspiré de `SwPosition` (nNode + nContent).
 *
 * `offset` compte les **unités de code UTF-16** dans la chaîne brute du
 * paragraphe, comme `SwIndex` compte les `sal_Unicode`. Les fonctions de
 * navigation, elles, se déplacent par **grappe de graphèmes** pour ne jamais
 * couper un emoji ou une lettre accentuée décomposée.
 */
export interface DocumentPosition {
  blockId: string;
  offset: number;
  /** Chemin vers la cellule quand la position est à l'intérieur d'un tableau. */
  cell?: { rowIndex: number; cellIndex: number };
}

/** Curseur et sélection. Inspiré de `SwPaM` : Mark = ancre, Point = tête. */
export interface DocumentSelection {
  /** Mark — l'extrémité fixe, posée au début du geste. */
  anchor: DocumentPosition;
  /** Point — l'extrémité mobile, celle que déplacent les flèches. */
  focus: DocumentPosition;
  isCollapsed: boolean;
  /**
   * Abscisse mémorisée pour les déplacements verticaux successifs
   * (`SwCrsrShell::m_aCharRect` / « sticky x »). En pixels CSS, ou null.
   */
  desiredX?: number | null;
}

/** Géométrie de la page physique. Inspiré de `SwPageDesc` / `SwPageFrm`. */
export interface PageSetup {
  format: 'A4' | 'Letter';
  widthMm: number;
  heightMm: number;
  orientation: 'portrait' | 'landscape';
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  headerHeightMm?: number;
  footerHeightMm?: number;
}

/** Style par défaut du document, appliqué à tout run qui ne le surcharge pas. */
export interface DocumentDefaults {
  fontFamily: string;
  fontSizePt: number;
  lineSpacing: number;
  color: string;
}

import type { PageFurniture } from './pageFurniture';

/** État racine complet. Inspiré de `SwDoc`. */
export interface WriterDocumentState {
  id: string;
  meta: {
    title: string;
    author: string;
    createdAt: string;
    updatedAt: string;
  };
  pageSetup: PageSetup;
  defaults: DocumentDefaults;
  furniture?: PageFurniture;
  blocks: DocumentBlock[];
}
