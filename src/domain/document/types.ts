// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

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

  /** Texte de la note de bas de page si ce run représente un appel de note (SwFtnFrm). */
  footnoteText?: string;
  /** Identifiant unique de la note. */
  footnoteId?: string;

  /* -- Image ancrée « comme caractère » ------------------------------------
   *
   * Writer range une image dans un cadre (`SwFlyFrm`, layout/fly.cxx). Quatre
   * ancrages existent ; un seul coule **dans** la ligne : `FLY_AS_CHAR`, dont
   * le cadre est un `SwFlyCntFrm` (layout/flycnt.cxx) traité par le formateur
   * de texte comme une portion de largeur et de hauteur fixes.
   *
   * C'est cet ancrage-là qui est porté ici, et il l'est donc comme un attribut
   * de run — pas comme un nœud à part. La conséquence est celle du C++ : une
   * image se sélectionne, se copie, se supprime et se justifie exactement comme
   * un caractère, sans que le curseur ni la pagination aient un cas de plus à
   * connaître. Les trois autres ancrages (à la page, au paragraphe, au
   * caractère avec habillage) demandent un cadre flottant hors flux : ils ne
   * sont pas portés, cf. README.
   */

  /** Source de l'image : `data:` en local, adresse relative une fois déposée. */
  imageSrc?: string;
  /** Largeur du cadre, en points typographiques (`SwFmtFrmSize`). */
  imageWidthPt?: number;
  imageHeightPt?: number;
  /** Texte alternatif (`SdrObject::SetTitle`), lu par les technologies d'assistance. */
  imageAlt?: string;

  /* -- Rognage (`SvxGrfCrop`, svx/inc/svx/grfcrop.hxx) ----------------------
   *
   * Writer conserve quatre **retraits**, un par bord, retranchés de l'image
   * d'origine — et non un rectangle de découpe. La différence compte : rogner
   * deux fois se compose alors naturellement, et l'image reste intacte, seul
   * son cadrage change. On peut donc toujours revenir en arrière.
   *
   * Là où le C++ compte en 1/100 mm, on compte en **fraction de l'original**
   * (0 à 1). La couche 1 ne connaît pas la taille en pixels de l'image — elle
   * n'en connaît que l'adresse — et une fraction reste juste quelle que soit
   * cette taille. La conversion en longueurs absolues n'a lieu qu'à l'export
   * ODF, où `fo:clip` les exige.
   *
   * Les quatre valeurs sont des clés **distinctes** et non un objet : la
   * comparaison de formatage (`sameFormatting`) se fait par `!==`, et deux
   * objets de contenu identique n'y seraient jamais égaux — deux runs voisins
   * cesseraient alors de fusionner.
   */

  imageCropTopPct?: number;
  imageCropRightPct?: number;
  imageCropBottomPct?: number;
  imageCropLeftPct?: number;

  /* -- Cadre flottant (`SwFlyFrm` libre, layout/fly.cxx) --------------------
   *
   * `FLY_AS_CHAR` ci-dessus coule dans la ligne. Les trois autres ancrages de
   * Writer (`RndStdIds`, fmtanchr.hxx) sortent le cadre du flux : il se pose à
   * une coordonnée, et le texte s'écoule *autour*. C'est `SwFlyFreeFrm`, dont
   * la géométrie est calculée par `SwFlyFrm::MakeAll` puis retranchée de la
   * largeur utile de chaque ligne traversée.
   *
   * Le mode d'habillage est celui de `SwFmtSurround` (fmtsrndenum.hxx:27) :
   * `none` réserve toute la bande, `through` n'en réserve rien (le texte passe
   * dessous), `parallel` évite le cadre des deux côtés, `left`/`right` ne
   * gardent le texte que du côté nommé.
   *
   * Un run porteur d'`imageAnchor` autre que `as-char` reste un caractère
   * U+FFFC dans la chaîne : c'est son **point d'ancrage**. Il ne consomme
   * aucune largeur dans la ligne — sa géométrie est donnée par imageX/imageY.
   */

  /** `RndStdIds` : `as-char` coule dans la ligne, les autres flottent. */
  /* -- Légende de figure --------------------------------------------------
   *
   * Le **numéro n'est pas stocké**, seulement le texte et le mode.
   *
   * C'est le choix qu'a fait Writer pour ses champs de séquence
   * (`SwSetExpField` de type `SwGetSetExpType::Sequence`) : la valeur est
   * recalculée à l'affichage, jamais conservée. Un numéro écrit dans le
   * document serait faux dès la première insertion au-dessus, et il faudrait
   * renuméroter tout le reste à chaque édition — c'est précisément par là que
   * les doublons arrivent. Ici, `figureNumbering` le dérive de l'ordre du
   * document, et la question ne se pose plus.
   */
  /** Texte saisi par l'utilisateur, sans le préfixe « Figure n°X : ». */
  imageCaption?: string;
  /** Au-dessus ou au-dessous de l'image. Par défaut au-dessous. */
  imageCaptionPosition?: 'above' | 'below';
  imageCaptionAlign?: 'left' | 'center' | 'right';
  /**
   * Numérotation automatique. `undefined` vaut **activée** : c'est le mode par
   * défaut demandé, et il s'applique donc aussi aux images déjà présentes.
   */
  imageCaptionManual?: boolean;

  /**
   * Marge autour du cadre — image et légende comprises —, en points.
   *
   * Le moteur l'ajoute aux quatre côtés de la boîte mesurée : elle repousse
   * donc réellement le texte, au lieu d'être un simple retrait décoratif que
   * les lignes viendraient recouvrir.
   */
  imageMarginPt?: number;
  /** Blanc entre l'image et sa légende, en points. */
  imageCaptionGapPt?: number;

  imageAnchor?: FlyAnchor;
  /** `SwFmtSurround` : mode d'habillage du texte autour du cadre flottant. */
  imageSurround?: FlySurround;
  /** Abscisse du cadre, en points, relative à son ancre (`SwFmtHoriOrient`). */
  imageXPt?: number;
  /** Ordonnée du cadre, en points, relative à son ancre (`SwFmtVertOrient`). */
  imageYPt?: number;
  /** Marge d'habillage autour du cadre (`SvxLRSpaceItem` du cadre), en points. */
  imageWrapMarginPt?: number;

  /* -- Position du cadre (`SwFmtHoriOrient`, sw/inc/fmtornt.hxx) ------------
   *
   * `imageXPt` seul ne suffit pas à poser un cadre : une abscisse figée en
   * points cesse d'être juste dès que la marge de page change, et « collé au
   * bord droit » redevient alors « à 12,3 cm du bord gauche ».
   *
   * Writer sépare donc l'**orientation** de son **repère** — `SwFmtHoriOrient`
   * porte `text::HoriOrientation` (LEFT, CENTER, RIGHT, NONE) et
   * `text::RelOrientation` (PRINT_AREA, PAGE_FRAME, PAGE_PRINT_AREA). Seule
   * `NONE`, ici `from-left`, consulte l'abscisse ; les trois autres la
   * recalculent à chaque mise en page.
   */

  /** `text::HoriOrientation` : alignement horizontal, ou `from-left` pour un décalage libre. */
  imageHoriOrient?: FlyHoriOrient;
  /** `text::RelOrientation` : ce par rapport à quoi cet alignement se mesure. */
  imageHoriRelation?: FlyHoriRelation;

  /**
   * `RES_OPAQUE` (`SvxOpaqueItem`) : le cadre passe **devant** le texte.
   *
   * Dans Writer, c'est le calque qui décide — `hell` sous le texte, `heaven`
   * au-dessus (`SwDrawView`, `SdrLayerID`) —, et c'est ce que le format ODF
   * écrit en `style:run-through="foreground"`. La distinction n'a de sens
   * qu'avec l'habillage `through`, seul cas où cadre et texte se superposent.
   */
  imageInFront?: boolean;

  /* -- Ancres de commentaire, de signet et de révision ----------------------
   *
   * Ces trois-là suivent la même règle que le rognage plus haut : **une clé
   * scalaire, jamais un objet ni un tableau**. `sameFormatting` compare par
   * `!==`, et deux tableaux de contenu identique n'y seraient jamais égaux :
   * deux runs voisins cesseraient de fusionner, et l'invariant `MergePortions`
   * tomberait. Quand plusieurs commentaires couvrent le même run, leurs
   * identifiants sont donc joints en une chaîne **triée** (cf. `commentIdsOf`).
   */

  /** `SwPostItField` : identifiants de commentaires, triés et joints par `,`. */
  commentIds?: string;
  /** `SwBookmark` : nom du signet dont la plage couvre ce run. */
  bookmarkName?: string;
  /** `SwRangeRedline` : identifiant de la modification suivie couvrant ce run. */
  redlineId?: string;
  /** `RedlineType_t` (IDocumentRedlineAccess.hxx:73) : nature de la modification. */
  redlineType?: RedlineType;
}

/**
 * Ancrage d'un cadre. Transposition de `RndStdIds` (`sw/inc/fmtanchr.hxx`).
 *
 * `as-char` (`FLY_AS_CHAR`) est le seul qui coule dans la ligne ; les autres
 * font du cadre un `SwFlyFreeFrm` positionné hors flux.
 */
export type FlyAnchor = 'as-char' | 'to-para' | 'to-page';

/**
 * Mode d'habillage. Transposition de `SwSurround` (`sw/inc/fmtsrndenum.hxx:27`).
 *
 * `ideal` est `SURROUND_IDEAL`, l'habillage « optimal » : il ne décrit pas une
 * géométrie mais une **règle de choix**, résolue ligne à ligne par
 * `SwTxtFly::GetSurroundForTextWrap` d'après la place restant de chaque côté du
 * cadre (cf. `resolveIdealSurround`). Les cinq autres se lisent tels quels.
 */
export type FlySurround = 'none' | 'through' | 'parallel' | 'ideal' | 'left' | 'right';

/**
 * Alignement horizontal d'un cadre. Transposition de `text::HoriOrientation`
 * (`offapi/com/sun/star/text/HoriOrientation.idl`).
 *
 * `from-left` est `HoriOrientation::NONE` : pas d'alignement, la position vient
 * du décalage `imageXPt`. C'est le mode dans lequel tombe un cadre qu'on
 * déplace à la souris.
 */
export type FlyHoriOrient = 'left' | 'center' | 'right' | 'from-left';

/**
 * Repère d'un alignement horizontal. Transposition de `text::RelOrientation`
 * (`offapi/com/sun/star/text/RelOrientation.idl`).
 *
 * OpenOffice en distingue dix ; deux suffisent à une mise en page à colonne
 * unique, et les nommer d'après ce qu'elles mesurent vaut mieux que d'en
 * recopier dix dont huit coïncideraient :
 *
 *  - `text` recouvre `PRINT_AREA` et `PAGE_PRINT_AREA` — la colonne de texte,
 *    marges de page déduites. Les deux donnent ici la même bande ;
 *  - `page` est `PAGE_FRAME` : la feuille entière, marges comprises. C'est le
 *    seul repère qui permette à un cadre de déborder dans la marge.
 */
export type FlyHoriRelation = 'text' | 'page';

/** Nature d'une modification suivie (`IDocumentRedlineAccess.hxx:73-75`). */
export type RedlineType = 'insert' | 'delete' | 'format';

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
  'footnoteText',
  'footnoteId',
  'imageSrc',
  'imageWidthPt',
  'imageHeightPt',
  'imageAlt',
  'imageCropTopPct',
  'imageCropRightPct',
  'imageCropBottomPct',
  'imageCropLeftPct',
  'imageMarginPt',
  'imageCaptionGapPt',
  'imageCaption',
  'imageCaptionPosition',
  'imageCaptionAlign',
  'imageCaptionManual',
  'imageAnchor',
  'imageSurround',
  'imageXPt',
  'imageYPt',
  'imageWrapMarginPt',
  'imageHoriOrient',
  'imageHoriRelation',
  'imageInFront',
  'commentIds',
  'bookmarkName',
  'redlineId',
  'redlineType',
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
  /** Nombre de colonnes couvertes (`SwTableBox::getRowSpan` côté horizontal). */
  colSpan?: number;
  /** Nombre de lignes couvertes vers le bas. */
  rowSpan?: number;
  /**
   * Cellule **recouverte** par la fusion d'une voisine.
   *
   * Writer ne supprime pas les cellules absorbées par un `SwDoc::MergeTbl` : il
   * leur donne un `RowSpan` négatif (`swtable.hxx:475`, « covered cell ») et les
   * garde dans la ligne. La grille reste ainsi rectangulaire, ce dont dépendent
   * la navigation au curseur, l'insertion de colonne et la scission ultérieure.
   * On transpose ce choix : une cellule couverte reste présente, mais n'est ni
   * mesurée ni peinte.
   */
  covered?: boolean;
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

/**
 * Bloc « table des matières ». Transposition de `SwTOXBase` (`sw/inc/tox.hxx`).
 *
 * Writer ne stocke pas les entrées : il conserve la **définition** de la table
 * (quels niveaux de titre retenir, avec ou sans numéros de page) et régénère
 * son contenu à la demande (`SwDoc::UpdateTOX`). On transpose ce choix, pour la
 * même raison : des entrées figées se désynchroniseraient du corps du document
 * dès la première frappe. Les entrées sont donc dérivées à la pagination, seul
 * moment où le numéro de page d'un titre est connu.
 */
export interface TocNode {
  id: string;
  type: 'toc';
  /** Titre imprimé au-dessus de la table. */
  title: string;
  /** Niveaux de titre retenus, de 1 à `maxLevel` (`SwTOXBase::GetLevel`). */
  maxLevel: HeadingLevel;
  /** Afficher le numéro de page en fin de ligne (`SwForm` avec `TOKEN_PAGE_NUMS`). */
  showPageNumbers: boolean;
  /** Points de suite entre le titre et le numéro (`TOKEN_TAB_STOP` à points). */
  useDotLeader: boolean;
  pageBreakBefore?: boolean;
}

export type DocumentBlock = ParagraphNode | TableNode | TocNode;

/** Discriminant sûr : un bloc est un tableau ou un nœud de texte. */
export function isTable(block: DocumentBlock): block is TableNode {
  return block.type === 'table';
}

export function isToc(block: DocumentBlock): block is TocNode {
  return block.type === 'toc';
}

export function isParagraph(block: DocumentBlock): block is ParagraphNode {
  return block.type !== 'table' && block.type !== 'toc';
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
import type { DocumentComment } from './comments';
import type { Redline } from './redline';

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

  /* -- Tables annexes -------------------------------------------------------
   *
   * Trois sous-systèmes ancrent leur *repère* dans les runs et rangent leur
   * *contenu* ici. La règle qui décide de quel côté va quoi est constante :
   * ce qui doit suivre le texte quand on l'édite est un attribut de run ; ce
   * qui n'a pas de position — un auteur, une date, un fil de discussion — vit
   * dans une table indexée par identifiant.
   *
   * Les signets font exception et n'ont pas de table : un signet n'est *que*
   * sa position, il se lit donc entièrement depuis les runs (cf. bookmarks.ts).
   */

  /** `SwPostItField` : contenu des commentaires, ancrés par `TextRun.commentIds`. */
  comments?: DocumentComment[];
  /** `SwRedlineTbl` : métadonnées des révisions, ancrées par `TextRun.redlineId`. */
  redlines?: Redline[];
}
