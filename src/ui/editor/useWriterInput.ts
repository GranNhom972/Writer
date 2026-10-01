// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Hook central de contrôle. Transposition de `SwEditWin` — la fenêtre qui, dans
 * Writer, traduit les événements de saisie en commandes sur le modèle.
 *
 * Principe d'architecture : **rien n'est lu depuis le DOM**. Ni le
 * texte, ni la position du curseur, ni les limites de ligne. Le clavier et la
 * souris produisent des commandes, les commandes transforment l'état, et le
 * moteur recalcule la géométrie. Le DOM n'en est que la projection.
 *
 * La saisie passe par une zone de texte invisible plutôt que par
 * `contenteditable` : c'est ce qui permet de recevoir les méthodes de saisie
 * asiatiques, la dictée et le collage système sans jamais laisser le navigateur
 * modifier le document de son propre chef.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {
  createParagraph,
  createTable,
  insertBlockAfter,
  paragraphIndex,
  paragraphText,
  previousParagraphId,
  removeBlocks,
  replaceParagraph,
} from '../../domain/document/document';
import { normalizeUrl } from '../../domain/document/url';
import { isFloatingFly } from '../../domain/engine/flyLayout';
import {
  captionFormatting,
  clampSize,
  defaultFlyPlacement,
  spacingFormatting,
  cropFormatting,
  imageAttributes,
  imageWrapMode,
  isImageRun,
  makeImageRun,
  placementFormatting,
  wrapFormatting,
  WRAP_FORMAT_KEYS,
  type ImageAttributes,
  type ImageWrapMode,
} from '../../domain/document/images';
import type {
  DocumentPosition,
  DocumentSelection,
  ListKind,
  ParagraphNode,
  RunFormatting,
  TextRun,
  TocNode,
  WriterDocumentState,
} from '../../domain/document/types';
import {
  deleteCommentThread,
  editComment,
  replyToComment,
  resolveCommentThread,
} from '../../domain/document/comments';
import { removeBookmark } from '../../domain/document/bookmarks';
import {
  acceptAllRedlines,
  applyRedline,
  rejectAllRedlines,
} from '../../domain/document/redline';
import { updateToc, type TocOptions } from '../../domain/document/tox';
import {
  formattingAt,
  insertTextInRuns,
  makeRun,
  normalizeRuns,
  runFormatting,
  type RunFormatPatch,
} from '../../domain/document/runs';
import {
  caretGeometry,
  collapsedSelection,
  comparePositions,
  lineBounds,
  makeSelection,
  moveHorizontal,
  moveVertical,
  normalizeSelection,
  positionFromPoint,
  selectionRects,
  wordRangeAt,
  type CaretGeometry,
  type SelectionRect,
} from '../../domain/engine/cursor';
import {
  activeFormatting,
  applyParagraphFormat,
  applyRunFormat,
  changeListLevel,
  clearRunFormat,
  createEditorState,
  deleteBackward,
  deleteCurrentTable,
  deleteCurrentTableColumn,
  deleteCurrentTableRow,
  deleteForward,
  deleteSelection,
  distributeTableColumns,
  extractFragment,
  insertBlockPageBreak,
  insertFootnote,
  insertFragment,
  insertLineBreak,
  insertTableColumnLeft,
  insertTableColumnRight,
  insertTableOfContents,
  insertTableRowAbove,
  insertTableRowBelow,
  insertText,
  mergeSelectedCells,
  moveImageRun,
  moveToAdjacentCell,
  resizeTableColumnBoundary,
  selectAll,
  selectionText,
  selectTableColumn,
  selectTableRow,
  selectWholeTable,
  tableContext,
  bookmarkSelection,
  commentSelection,
  setHeading,
  setReviewMode,
  setSelection,
  splitCurrentCell,
  splitParagraph,
  toggleList,
  toggleListChecked,
  toggleRunFormat,
  type DocumentFragment,
  type EditorState,
  type ParagraphPatch,
} from '../../domain/engine/edit';
import {
  canRedo,
  canUndo,
  commit,
  createSession,
  deletionGroup,
  dragGroup,
  redo,
  settingsGroup,
  typingGroup,
  undo,
  type EditorSession,
  type GroupingKey,
} from '../../domain/engine/history';
import { createMeasurer, type TextMeasurer } from '../../domain/engine/measure';
import { paginateDocument, type DocumentLayout, type PlacedParagraph } from '../../domain/engine/paginate';

/**
 * Dernier fragment copié depuis cet éditeur.
 *
 * Le presse-papiers du système ne transporte que du texte et du HTML ; y écrire
 * notre modèle demanderait un type MIME propriétaire, que les navigateurs
 * filtrent. On garde donc le fragment de côté et on le reconnaît au collage par
 * son texte : un copier-coller interne conserve ainsi tout son formatage, et un
 * collage venu d'ailleurs retombe proprement sur le texte brut.
 */
let lastCopied: { text: string; fragment: DocumentFragment } | null = null;

export interface WriterCommands {
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrike: () => void;
  setFontFamily: (family: string | null) => void;
  setFontSize: (sizePt: number | null) => void;
  setColor: (color: string | null) => void;
  setHighlight: (color: string | null) => void;
  clearFormatting: () => void;
  setHeadingLevel: (level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => void;
  setAlignment: (alignment: ParagraphNode['alignment']) => void;
  setLineSpacing: (spacing: number) => void;
  setFirstLineIndentPt: (pt: number | null) => void;
  toggleSpaceBefore: () => void;
  toggleSpaceAfter: () => void;
  indent: (direction: 1 | -1) => void;
  insertPageBreak: () => void;
  adjustFontSize: (delta: number) => void;
  toggleList: (kind: ListKind) => void;
  changeListLevel: (direction: 1 | -1) => void;
  toggleTask: (blockId: string) => void;
  /** Renvoie `false` si l'adresse est refusée : le dialogue le signale alors. */
  setLink: (url: string) => boolean;
  removeLink: () => void;
  insertTable: (rows: number, cols: number) => void;
  insertTableRowAbove: () => void;
  insertTableRowBelow: () => void;
  deleteTableRow: () => void;
  insertTableColumnLeft: () => void;
  insertTableColumnRight: () => void;
  deleteTableColumn: () => void;
  deleteTable: () => void;
  /** Répartit également les colonnes du tableau courant. */
  distributeColumns: () => void;
  /** Déplace la frontière entre deux colonnes, à la souris. */
  resizeColumnBoundary: (tableId: string, boundaryIndex: number, deltaPercent: number) => void;
  selectRow: (tableId: string, rowIndex: number) => void;
  selectColumn: (tableId: string, columnIndex: number) => void;
  selectTable: (tableId: string) => void;
  /** Passe à la cellule suivante ou précédente (`Tab` / `Maj+Tab`). */
  goToAdjacentCell: (forward: boolean) => void;
  insertFootnote: (text: string) => void;
  /** Fusionne les cellules sélectionnées (`SwDoc::MergeTbl`). */
  mergeCells: () => void;
  /** Scinde la cellule courante (`SwDoc::SplitTbl`). */
  splitCell: (direction: 'horizontal' | 'vertical', count?: number) => void;
  /** Insère une table des matières après le bloc courant (`SwTOXBase`). */
  insertTableOfContents: (options?: TocOptions) => void;
  /** Modifie la définition d'un sommaire déjà posé. */
  updateToc: (tocId: string, patch: Partial<Omit<TocNode, 'id' | 'type'>>) => void;

  /* -- Commentaires (`SwPostItMgr`) -------------------------------------- */
  addComment: (author: string, text: string) => void;
  replyToComment: (threadId: string, author: string, text: string) => void;
  resolveComment: (threadId: string, resolved: boolean) => void;
  deleteComment: (threadId: string) => void;
  editComment: (commentId: string, text: string) => void;

  /* -- Signets (`SwBookmark`) -------------------------------------------- */
  setBookmark: (name: string) => void;
  removeBookmark: (name: string) => void;

  /* -- Suivi des modifications (`SwRedline`) ----------------------------- */
  /** Active le mode révision au nom d'un auteur, ou le coupe avec `null`. */
  setReviewMode: (author: string | null) => void;
  acceptRedline: (redlineId: string) => void;
  rejectRedline: (redlineId: string) => void;
  acceptAllRedlines: () => void;
  rejectAllRedlines: () => void;

  /**
   * Intégration au texte du cadre image situé à cet offset.
   *
   * Un seul point d'entrée pour les trois attributs d'OpenOffice — ancrage,
   * habillage et calque : les régler séparément laisserait passer des états
   * que Writer n'a pas, comme un cadre « devant le texte » resté dans le fil.
   */
  setImageWrap: (blockId: string, offset: number, mode: ImageWrapMode) => void;
  /**
   * Déplace un cadre flottant. Les coordonnées sont en points, dans le repère
   * de son ancre (`SwFmtHoriOrient` / `SwFmtVertOrient`).
   *
   * Bascule l'alignement horizontal en `from-left` : un cadre qu'on déplace à
   * la main a par définition quitté son alignement, et le laisser aligné
   * ramènerait l'image à sa place au prochain calcul.
   */
  setImagePosition: (blockId: string, offset: number, xPt: number, yPt: number) => void;
  /**
   * Ré-ancre une image au paragraphe où on vient de la lâcher.
   *
   * C'est ce que fait `SwFEShell::SetAnchor` à la fin d'un glissement : un
   * cadre reste tributaire de son ancre — c'est elle qui décide de sa page —,
   * donc le déposer trois pages plus bas doit changer l'ancre, pas seulement
   * l'ordonnée. Sans cela, une image traînée loin de son paragraphe restait
   * dessinée sur la page de celui-ci, et sortait de la feuille.
   *
   * Une image « comme caractère » n'a pas de coordonnées : pour elle,
   * `target` est simplement sa nouvelle place dans le texte, et `xPt`/`yPt`
   * sont ignorés.
   */
  moveImageTo: (
    blockId: string,
    offset: number,
    target: DocumentPosition,
    xPt: number,
    yPt: number,
  ) => void;

  insertMath: (latex: string, display: boolean) => void;
  updateMath: (blockId: string, latex: string, display: boolean) => void;
  deleteMath: (blockId: string) => void;
  /** Insère une image au curseur, ancrée « comme caractère » (`SwFlyCntFrm`). */
  insertImage: (attributes: ImageAttributes) => void;
  /** Réécrit source, dimensions et texte alternatif du cadre situé à cet offset. */
  updateImage: (blockId: string, offset: number, attributes: ImageAttributes) => void;
  /** Retaille une image depuis l'éditeur, sans passer par la fenêtre. */
  resizeImage: (blockId: string, offset: number, widthPt: number, heightPt: number) => void;
  deleteImage: (blockId: string, offset: number) => void;
  goToBlock: (blockId: string) => void;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  /**
   * Modifie les **réglages** du document — mobilier de page, marges, titre —
   * sans toucher au curseur ni au focus.
   *
   * Ces réglages n'appartiennent pas au fil du texte : on les change depuis un
   * dialogue ou la règle, pendant que le curseur reste où il était. D'où les
   * deux différences avec une commande d'édition ordinaire : rien n'est rendu
   * à la zone de saisie invisible — le champ du dialogue garderait sinon le
   * focus une frappe sur deux —, et la session n'est pas refondée, sous peine
   * d'effacer l'historique du document à chaque caractère tapé dans un en-tête.
   *
   * La transformation est appliquée **dans** le réducteur, jamais sur le
   * document du rendu : deux frappes groupées par React partiraient sinon du
   * même état, et la seconde écraserait la première.
   *
   * `settingId` regroupe les transactions d'un même geste continu en une seule
   * entrée d'annulation (cf. `settingsGroup`).
   */
  updateDocument: (
    label: string,
    transform: (doc: WriterDocumentState) => WriterDocumentState,
    settingId?: string,
  ) => void;
  /**
   * Applique une modification venue du réseau.
   *
   * Distincte d'`updateDocument`, qui inscrit son changement à l'historique :
   * une modification venue du réseau n'y entre **pas**. Défaire son propre
   * travail après qu'un collègue a écrit ailleurs doit rester possible, et
   * `Ctrl+Z` ne doit jamais annuler la frappe de quelqu'un d'autre.
   *
   * `remapSelection` reporte le curseur : quelqu'un qui écrit **avant** le
   * point décale le texte sous celui-ci, et le laisser où il était ferait taper
   * à côté. Le simple recadrage aux bornes du document ne suffit pas — l'offset
   * y reste valide, seulement il ne désigne plus le même caractère.
   */
  applyRemote: (
    transform: (doc: WriterDocumentState) => WriterDocumentState,
    remapSelection?: (selection: DocumentSelection) => DocumentSelection,
  ) => void;
}

export interface WriterController {
  session: EditorSession;
  layout: DocumentLayout;
  measurer: TextMeasurer;
  activeFormat: RunFormatting;
  currentParagraph: ParagraphNode | null;
  /** Tableau sous le curseur, ou `null` — sert à griser les commandes inertes. */
  table: ReturnType<typeof tableContext>;
  caret: CaretGeometry | null;
  rects: SelectionRect[];
  /**
   * Rectangles de sélection **regroupés par page**, et seulement pour les pages
   * qui en portent.
   *
   * Le regroupement est fait ici, une fois, et non par un `filter` dans la
   * boucle de rendu des feuilles : un filtre y rendrait un tableau neuf à
   * chaque rendu pour chaque page, ce qui suffit à faire échouer la
   * comparaison superficielle de `React.memo(A4Page)` — le document entier
   * serait alors reconcilié à chaque frappe.
   *
   * Une table creuse et non un tableau indexé par page : une sélection ne
   * touche qu'une page ou deux, et un tableau dense recréerait un `[]` neuf
   * pour toutes les autres à chaque frappe — le même défaut, déplacé. Les
   * pages absentes retombent sur la constante gelée `AUCUN_RECT`.
   */
  rectsByPage: ReadonlyMap<number, readonly SelectionRect[]>;
  /** Paragraphes posés, regroupés par page — ce que chaque feuille doit peindre. */
  placementsByPage: { blockId: string; placed: PlacedParagraph }[][];
  isFocused: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  focus: () => void;
  run: (label: string, transform: (state: EditorState) => EditorState) => void;
  commands: WriterCommands;
  handlers: {
    onKeyDown: (event: React.KeyboardEvent) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
    onCopy: (event: React.ClipboardEvent) => void;
    onCut: (event: React.ClipboardEvent) => void;
    onPaste: (event: React.ClipboardEvent) => void;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>, pageIndex: number) => void;
  };
}

/**
 * Cadre image couvrant cet offset.
 *
 * On accepte l'offset du **début** du cadre comme celui de sa fin : le rendu
 * annonce le premier, alors qu'un curseur posé juste après l'image donne le
 * second. Exiger l'un des deux ferait échouer la retouche une fois sur deux.
 */
function imageRunAt(
  runs: readonly TextRun[],
  offset: number,
): { index: number; offset: number } | null {
  let consumed = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    const start = consumed;
    const end = consumed + run.text.length;
    if (isImageRun(run) && offset >= start && offset <= end) return { index, offset: start };
    consumed = end;
  }
  return null;
}

/** Attributs du premier cadre image du paragraphe, pour ouvrir l'atelier. */
export function imageDraftAt(
  runs: readonly TextRun[],
  offset: number,
): (ImageAttributes & { offset: number }) | null {
  const cible = imageRunAt(runs, offset);
  if (!cible) return null;
  const attributs = imageAttributes(runs[cible.index]!);
  return attributs ? { ...attributs, offset: cible.offset } : null;
}

/**
 * Ramène une sélection dans les limites d'un document qui a changé sous elle.
 *
 * Un participant distant peut supprimer le paragraphe où l'on a le curseur, ou
 * en raccourcir un. Sans ce recadrage, le moteur chercherait un bloc qui
 * n'existe plus et le curseur disparaîtrait de l'écran.
 */
function clampSelection(
  doc: WriterDocumentState,
  selection: DocumentSelection,
): DocumentSelection {
  const index = paragraphIndex(doc);

  const recadrer = (position: DocumentPosition): DocumentPosition => {
    const node = index.byId.get(position.blockId);
    if (!node) {
      // Bloc disparu : on se replie sur le premier paragraphe, seul point
      // toujours valide d'un document non vide.
      const premier = index.order[0];
      return premier ? { blockId: premier, offset: 0 } : position;
    }
    const longueur = paragraphText(node.paragraph).length;
    if (position.offset <= longueur) return position;
    return { ...position, offset: longueur };
  };

  const anchor = recadrer(selection.anchor);
  const focus = recadrer(selection.focus);
  return {
    ...selection,
    anchor,
    focus,
    isCollapsed: anchor.blockId === focus.blockId && anchor.offset === focus.offset,
  };
}

const INDENT_STEP_PT = 36; // 1,27 cm — le pas de tabulation par défaut de Writer.
/** Bornes de corps de police, reprises de l'application Write. */
export const MIN_FONT_SIZE_PT = 6;
export const MAX_FONT_SIZE_PT = 96;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

/**
 * Actions que le contrôleur déclenche mais n'implémente pas : elles ouvrent une
 * fenêtre du navigateur ou un dialogue, ce qui n'est pas de son ressort.
 */
/**
 * Une transaction a-t-elle le droit d'aboutir ?
 *
 * Règle unique de la lecture seule, isolée ici pour être vérifiable sans monter
 * un éditeur : ce qui laisse le document identique — déplacer le curseur,
 * sélectionner pour copier — passe toujours ; ce qui le change ne passe que si
 * l'on a le droit d'écrire.
 *
 * La décision se prend sur le document lui-même, jamais sur le nom de la
 * commande : une commande oubliée dans une liste serait une modification qui
 * passe, et personne ne s'en apercevrait avant que le serveur ne la rejette en
 * silence.
 */
export function transactionAutorisee(
  lectureSeule: boolean,
  avant: EditorState,
  apres: EditorState,
): boolean {
  return !lectureSeule || apres.doc === avant.doc;
}

export interface WriterHooks {
  /**
   * Interdit toute modification du document, sans rien figer d'autre.
   *
   * Le badge « Lecture seule » et le refus de publication ne suffisaient pas :
   * la frappe restait acceptée localement, s'affichait, puis disparaissait à la
   * fermeture — on croyait avoir écrit. Refuser à la source est la seule façon
   * de ne pas mentir à celui qui tape.
   */
  readOnly?: boolean;
  onPrint?: () => void;
  onOpenFindReplace?: () => void;
  onOpenLink?: () => void;
  onOpenMath?: () => void;
  onEditMath?: (blockId: string, latex: string, display: boolean) => void;
  onOpenImage?: () => void;
  onEditImage?: (blockId: string, offset: number) => void;
  /** Clic droit dans le document, en coordonnées de fenêtre. */
  onOpenContextMenu?: (x: number, y: number) => void;
}

export function useWriterInput(
  initialDocument: WriterDocumentState,
  hooks: WriterHooks = {},
): WriterController {
  const measurer = useMemo(() => createMeasurer(), []);
  const [session, setSession] = useState<EditorSession>(() =>
    createSession(createEditorState(initialDocument)),
  );
  const [isFocused, setFocused] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [fontsTick, setFontsTick] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Lu au moment de l'appel, pas à la création de `run` : la permission peut
  // changer en cours de séance (révocation d'un partage).
  const lectureSeuleRef = useRef(false);
  lectureSeuleRef.current = hooks.readOnly === true;
  const composing = useRef(false);
  const dragging = useRef(false);

  // Les actions de l'application vivent dans une réf : le gestionnaire clavier
  // peut ainsi les appeler sans les compter parmi ses dépendances, et rester
  // stable d'un rendu à l'autre.
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  /**
   * Le tableau où se trouve le curseur, ou `null`.
   *
   * Passe par une référence parce que `onKeyDown` ne dépend volontairement pas
   * de l'état : y ajouter `session` le reconstruirait à chaque frappe. La
   * référence est réassignée au rendu, donc toujours à jour quand la touche
   * arrive.
   */
  const tableRef = useRef<ReturnType<typeof tableContext>>(null);

  /** Session courante, pour les gestionnaires qui doivent la lire hors réducteur. */
  const sessionRef = useRef<EditorSession | null>(null);

  /**
   * Les métriques d'une fonte changent au moment où elle finit de charger. Un
   * document mis en page avant ce moment serait mesuré avec la fonte de repli,
   * puis peint avec la vraie : les lignes ne tomberaient pas au bon endroit.
   */
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFontsTick((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const layout = useMemo(
    () => paginateDocument(session.state.doc, { measurer }),
    // `fontsTick` force un recalcul quand les fontes deviennent disponibles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.state.doc, measurer, fontsTick],
  );

  const focus = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Applique une commande et l'inscrit à l'historique.
   *
   * La transformation **et** la clé de regroupement sont calculées à
   * l'intérieur du réducteur, à partir de l'état courant. Les calculer dehors
   * les figerait à l'état du rendu : deux frappes arrivées dans le même lot —
   * ce que React 18 regroupe systématiquement — partiraient alors du même
   * point de départ, et la seconde écraserait la première.
   */
  const run = useCallback(
    (
      label: string,
      transform: (state: EditorState) => EditorState,
      groupingOf?: (before: EditorState, after: EditorState) => GroupingKey | null,
    ) => {
      setSession((current) => {
        const next = transform(current.state);
        if (!transactionAutorisee(lectureSeuleRef.current, current.state, next)) {
          return current;
        }
        return commit(current, label, next, groupingOf?.(current.state, next) ?? null);
      });
    },
    [],
  );

  /** Déplace le curseur sans rien inscrire à l'historique. */
  const move = useCallback((transform: (state: EditorState) => EditorState) => {
    setSession((current) => ({ ...current, state: transform(current.state) }));
  }, []);

  const caret = useMemo(
    () => caretGeometry(layout, session.state.selection.focus, measurer),
    [layout, session.state.selection.focus, measurer],
  );

  const rects = useMemo(
    () => selectionRects(session.state.doc, layout, session.state.selection, measurer),
    [session.state.doc, layout, session.state.selection, measurer],
  );

  const rectsByPage = useMemo(() => {
    const pages = new Map<number, SelectionRect[]>();
    for (const rect of rects) {
      const liste = pages.get(rect.pageIndex);
      if (liste) liste.push(rect);
      else pages.set(rect.pageIndex, [rect]);
    }
    return pages;
  }, [rects]);

  const placementsByPage = useMemo(() => {
    const pages: { blockId: string; placed: PlacedParagraph }[][] = layout.pages.map(() => []);
    for (const [blockId, entries] of layout.placements) {
      for (const entry of entries) {
        pages[entry.pageIndex]?.push({ blockId, placed: entry.placed });
      }
    }
    return pages;
  }, [layout]);

  const activeFormat = useMemo(() => activeFormatting(session.state), [session.state]);

  const currentParagraph = useMemo(
    () => paragraphIndex(session.state.doc).byId.get(session.state.selection.focus.blockId)
      ?.paragraph ?? null,
    [session.state.doc, session.state.selection.focus.blockId],
  );

  /**
   * Tableau sous le curseur — `null` en dehors de toute grille.
   *
   * Exposé pour que les menus grisent ce qui ne s'applique pas : une commande
   * de tableau proposée hors tableau est un clic sans effet, donc un bug d'UX.
   */
  const table = useMemo(() => tableContext(session.state), [session.state]);
  tableRef.current = table;
  sessionRef.current = session;

  /* ------------------------------------------------------------- commandes */

  const patchRun = useCallback(
    (label: string, patch: RunFormatPatch) => {
      run(label, (state) => applyRunFormat(state, patch));
      focus();
    },
    [run, focus],
  );

  const patchParagraph = useCallback(
    (label: string, patch: ParagraphPatch) => {
      run(label, (state) => applyParagraphFormat(state, patch));
      focus();
    },
    [run, focus],
  );

  const commands = useMemo<WriterCommands>(
    () => ({
      toggleBold: () => {
        run('Gras', (state) => toggleRunFormat(state, 'bold'));
        focus();
      },
      toggleItalic: () => {
        run('Italique', (state) => toggleRunFormat(state, 'italic'));
        focus();
      },
      toggleUnderline: () => {
        run('Souligné', (state) => toggleRunFormat(state, 'underline'));
        focus();
      },
      toggleStrike: () => {
        run('Barré', (state) => toggleRunFormat(state, 'strikeThrough'));
        focus();
      },
      setFontFamily: (family) => patchRun('Police', { fontFamily: family }),
      setFontSize: (sizePt) => patchRun('Taille', { fontSizePt: sizePt }),
      setColor: (color) => patchRun('Couleur', { color }),
      setHighlight: (color) => patchRun('Surlignage', { backgroundColor: color }),
      clearFormatting: () => {
        run('Effacer la mise en forme', (state) => clearRunFormat(state));
        focus();
      },
      setHeadingLevel: (level) => {
        run('Style de paragraphe', (state) => setHeading(state, level));
        focus();
      },
      setAlignment: (alignment) => patchParagraph('Alignement', { alignment: alignment ?? null }),
      setLineSpacing: (spacing) => patchParagraph('Interligne', { lineSpacing: spacing }),
      setFirstLineIndentPt: (pt) => patchParagraph('Retrait première ligne', { firstLineIndentPt: pt }),

      toggleSpaceBefore: () => {
        setSession((current) => {
          const node = currentNode(current.state);
          const pose = (node?.marginTopPt ?? 0) > 0;
          return commit(
            current,
            'Espacement avant',
            applyParagraphFormat(current.state, {
              marginTopPt: pose ? 0 : current.state.doc.defaults.fontSizePt,
            }),
          );
        });
        focus();
      },

      toggleSpaceAfter: () => {
        setSession((current) => {
          const node = currentNode(current.state);
          const pose = (node?.marginBottomPt ?? 0) > 0;
          return commit(
            current,
            'Espacement après',
            applyParagraphFormat(current.state, {
              marginBottomPt: pose ? 0 : current.state.doc.defaults.fontSizePt,
            }),
          );
        });
        focus();
      },

      indent: (direction) => {
        setSession((current) => {
          const node = currentNode(current.state);
          // Dans une liste, `Tab` change le **niveau** : c'est ce que fait
          // Writer, et l'usager n'a pas à savoir dans lequel des deux cas il
          // se trouve pour obtenir le décalage qu'il attend.
          if (node?.listKind !== undefined) {
            return commit(current, 'Niveau de liste', changeListLevel(current.state, direction));
          }
          const now = node?.indentLeftPt ?? 0;
          // Le retrait ne descend pas sous zéro : un retrait négatif ferait
          // sortir le texte de la zone imprimable.
          const next = Math.max(0, now + direction * INDENT_STEP_PT);
          return commit(
            current,
            'Retrait',
            applyParagraphFormat(current.state, { indentLeftPt: next === 0 ? null : next }),
          );
        });
        focus();
      },

      adjustFontSize: (delta) => {
        setSession((current) => {
          const actuel = activeFormatting(current.state).fontSizePt
            ?? current.state.doc.defaults.fontSizePt;
          const taille = Math.max(MIN_FONT_SIZE_PT, Math.min(MAX_FONT_SIZE_PT, actuel + delta));
          return commit(current, 'Taille', applyRunFormat(current.state, { fontSizePt: taille }));
        });
        focus();
      },

      toggleList: (kind) => {
        run('Liste', (state) => toggleList(state, kind));
        focus();
      },

      changeListLevel: (direction) => {
        run('Niveau de liste', (state) => changeListLevel(state, direction));
        focus();
      },

      toggleTask: (blockId) => {
        run('Case à cocher', (state) => toggleListChecked(state, blockId));
        focus();
      },

      setLink: (url) => {
        const normalisee = normalizeUrl(url);
        // Adresse refusée : on le dit au dialogue plutôt que de ne rien faire.
        // Un bouton qui ferme sa fenêtre sans rien poser laisse croire au succès.
        if (!normalisee) return false;
        setSession((current) => {
          // Sans sélection, il n'y a rien à marquer : on insère l'adresse comme
          // texte, puis on la marque. Armer un lien sur un curseur replié ne
          // laisserait rien de visible, et l'usager attend de voir son lien.
          if (current.state.selection.isCollapsed) {
            const avant = current.state.selection.focus;
            const avecTexte = insertText(current.state, url.trim() || normalisee);
            const apres = avecTexte.selection.focus;
            const marque = applyRunFormat(
              {
                ...avecTexte,
                selection: makeSelection(avant, apres),
              },
              { linkHref: normalisee },
            );
            return commit(current, 'Lien', {
              ...marque,
              selection: collapsedSelection(apres),
            });
          }
          return commit(current, 'Lien', applyRunFormat(current.state, { linkHref: normalisee }));
        });
        focus();
        return true;
      },

      removeLink: () => patchRun('Retirer le lien', { linkHref: null }),

      insertTable: (rows, cols) => {
        setSession((current) => {
          const position = current.state.selection.focus;
          const table = createTable(rows, cols);
          let doc = insertBlockAfter(current.state.doc, position.blockId, table);

          // Un paragraphe suit toujours le tableau : sans lui, un tableau en
          // fin de document piège le curseur, qui n'a plus aucune position où
          // aller ensuite.
          const at = doc.blocks.findIndex((block) => block.id === table.id);
          if (at >= 0 && at === doc.blocks.length - 1) {
            doc = { ...doc, blocks: [...doc.blocks, createParagraph('')] };
          }

          // Le curseur va dans la première cellule : c'est là qu'on écrit après
          // avoir posé un tableau.
          const premiere = table.rows[0]?.cells[0]?.blocks[0];
          const next: EditorState = {
            doc,
            selection: premiere
              ? collapsedSelection({ blockId: premiere.id, offset: 0 })
              : current.state.selection,
            pendingFormat: null,
          };
          return commit(current, 'Insérer un tableau', next);
        });
        focus();
      },

      insertTableRowAbove: () => {
        run('Insérer une ligne au-dessus', (state) => insertTableRowAbove(state));
        focus();
      },

      insertTableRowBelow: () => {
        run('Insérer une ligne au-dessous', (state) => insertTableRowBelow(state));
        focus();
      },

      deleteTableRow: () => {
        run('Supprimer la ligne', (state) => deleteCurrentTableRow(state));
        focus();
      },

      insertTableColumnLeft: () => {
        run('Insérer une colonne à gauche', (state) => insertTableColumnLeft(state));
        focus();
      },

      insertTableColumnRight: () => {
        run('Insérer une colonne à droite', (state) => insertTableColumnRight(state));
        focus();
      },

      deleteTableColumn: () => {
        run('Supprimer la colonne', (state) => deleteCurrentTableColumn(state));
        focus();
      },

      deleteTable: () => {
        run('Supprimer le tableau', (state) => deleteCurrentTable(state));
        focus();
      },

      distributeColumns: () => {
        run('Répartir les colonnes', (state) => distributeTableColumns(state));
        focus();
      },

      resizeColumnBoundary: (tableId, boundaryIndex, deltaPercent) => {
        // Le glissement d'une poignée produit des dizaines d'événements : ils
        // se regroupent en **une** entrée d'historique, sinon dix `Ctrl+Z`
        // seraient nécessaires pour défaire un seul geste.
        run(
          'Largeur de colonne',
          (state) => resizeTableColumnBoundary(state, tableId, boundaryIndex, deltaPercent),
          () => dragGroup(`${tableId}:${boundaryIndex}`),
        );
      },

      selectRow: (tableId, rowIndex) => {
        move((state) => selectTableRow(state, tableId, rowIndex));
        focus();
      },

      selectColumn: (tableId, columnIndex) => {
        move((state) => selectTableColumn(state, tableId, columnIndex));
        focus();
      },

      selectTable: (tableId) => {
        move((state) => selectWholeTable(state, tableId));
        focus();
      },

      goToAdjacentCell: (forward) => {
        // `Tab` en fin de tableau ajoute une ligne : la transaction doit donc
        // passer par `run`, pas par `move`, pour être annulable.
        run('Cellule suivante', (state) => moveToAdjacentCell(state, forward));
        focus();
      },

      insertFootnote: (text) => {
        run('Insérer une note de bas de page', (state) => insertFootnote(state, text));
        focus();
      },

      mergeCells: () => {
        run('Fusionner les cellules', (state) => mergeSelectedCells(state));
        focus();
      },

      splitCell: (direction, count = 2) => {
        run('Scinder la cellule', (state) => splitCurrentCell(state, direction, count));
        focus();
      },

      insertTableOfContents: (options) => {
        run('Insérer une table des matières', (state) => insertTableOfContents(state, options));
        focus();
      },

      updateToc: (tocId, patch) => {
        run('Modifier la table des matières', (state) => ({
          ...state,
          doc: updateToc(state.doc, tocId, patch),
        }));
        focus();
      },

      addComment: (author, text) => {
        run('Ajouter un commentaire', (state) => commentSelection(state, author, text).state);
        focus();
      },

      replyToComment: (threadId, author, text) => {
        run('Répondre au commentaire', (state) => ({
          ...state,
          doc: replyToComment(state.doc, threadId, author, text),
        }));
      },

      resolveComment: (threadId, resolved) => {
        run(resolved ? 'Résoudre le commentaire' : 'Rouvrir le commentaire', (state) => ({
          ...state,
          doc: resolveCommentThread(state.doc, threadId, resolved),
        }));
      },

      deleteComment: (threadId) => {
        run('Supprimer le commentaire', (state) => ({
          ...state,
          doc: deleteCommentThread(state.doc, threadId),
        }));
      },

      editComment: (commentId, text) => {
        run('Modifier le commentaire', (state) => ({
          ...state,
          doc: editComment(state.doc, commentId, text),
        }));
      },

      setBookmark: (name) => {
        run('Poser un signet', (state) => bookmarkSelection(state, name));
        focus();
      },

      removeBookmark: (name) => {
        run('Retirer le signet', (state) => ({ ...state, doc: removeBookmark(state.doc, name) }));
        focus();
      },

      setReviewMode: (author) => {
        // Le basculement ne touche pas au document : il ne passe donc pas par
        // `run`, qui empilerait une transaction annulable sans rien à annuler.
        setSession((current) => ({
          ...current,
          state: setReviewMode(current.state, author ? { author } : null),
        }));
        focus();
      },

      acceptRedline: (redlineId) => {
        run('Accepter la modification', (state) => ({
          ...state,
          doc: applyRedline(state.doc, redlineId, 'accept'),
        }));
      },

      rejectRedline: (redlineId) => {
        run('Rejeter la modification', (state) => ({
          ...state,
          doc: applyRedline(state.doc, redlineId, 'reject'),
        }));
      },

      acceptAllRedlines: () => {
        run('Accepter toutes les modifications', (state) => ({
          ...state,
          doc: acceptAllRedlines(state.doc),
        }));
      },

      rejectAllRedlines: () => {
        run('Rejeter toutes les modifications', (state) => ({
          ...state,
          doc: rejectAllRedlines(state.doc),
        }));
      },

      setImageWrap: (blockId, offset, mode) => {
        run("Intégration de l'image", (state) => {
          const node = paragraphIndex(state.doc).byId.get(blockId)?.paragraph;
          if (!node) return state;
          const cible = imageRunAt(node.runs, offset);
          if (!cible) return state;

          const precedent = runFormatting(node.runs[cible.index]!);
          const formatting = { ...precedent };

          /*
           * Les clés d'habillage sont **effacées** avant d'être réécrites.
           *
           * `wrapFormatting` ne rend que ce que le nouveau mode demande, jamais
           * les absences : sans cet effacement, revenir dans le fil laisserait
           * derrière lui un `imageInFront` ou un décalage, qui ressortirait au
           * basculement suivant comme si on ne l'avait jamais quitté.
           */
          for (const key of WRAP_FORMAT_KEYS) delete formatting[key];

          if (mode !== 'inline') {
            Object.assign(
              formatting,
              wrapFormatting(mode, precedent.imageAnchor ?? 'to-para'),
              // Un cadre déjà flottant garde sa position ; un cadre qui quitte
              // le fil du texte s'en voit donner une, faute de quoi il tomberait
              // au coin haut-gauche du paragraphe, en travers de sa première ligne.
              imageWrapMode(precedent) === 'inline'
                ? defaultFlyPlacement(mode)
                : {
                    ...(precedent.imageHoriOrient !== undefined
                      ? { imageHoriOrient: precedent.imageHoriOrient }
                      : {}),
                    ...(precedent.imageHoriRelation !== undefined
                      ? { imageHoriRelation: precedent.imageHoriRelation }
                      : {}),
                    imageXPt: precedent.imageXPt ?? 0,
                    imageYPt: precedent.imageYPt ?? 0,
                    ...(precedent.imageWrapMarginPt !== undefined
                      ? { imageWrapMarginPt: precedent.imageWrapMarginPt }
                      : {}),
                  },
            );
          }

          const runs = [...node.runs];
          runs[cible.index] = makeRun(node.runs[cible.index]!.text, formatting);
          return { ...state, doc: replaceParagraph(state.doc, blockId, { ...node, runs }) };
        });
        focus();
      },

      setImagePosition: (blockId, offset, xPt, yPt) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId)?.paragraph;
          if (!node) return current;
          const cible = imageRunAt(node.runs, offset);
          if (!cible) return current;

          const cadre = node.runs[cible.index]!;
          if (!isFloatingFly(cadre)) return current;
          if (cadre.imageXPt === xPt && cadre.imageYPt === yPt) return current;

          const runs = [...node.runs];
          runs[cible.index] = {
            ...cadre,
            // Un cadre qu'on déplace à la main a quitté son alignement : le
            // laisser aligné le ramènerait à sa place au prochain calcul, et le
            // geste n'aurait servi à rien.
            imageHoriOrient: 'from-left',
            imageXPt: xPt,
            imageYPt: yPt,
          };

          const doc = replaceParagraph(current.state.doc, blockId, { ...node, runs });
          const next = { ...current.state, doc };
          if (!transactionAutorisee(lectureSeuleRef.current, current.state, next)) return current;
          // Tout le glissement forme une seule entrée d'historique.
          return commit(current, 'Déplacer l’image', next, dragGroup(`fly:${blockId}:${offset}`));
        });
      },

      moveImageTo: (blockId, offset, target, xPt, yPt) => {
        run('Déplacer l’image', (state) => ({
          ...state,
          doc: moveImageRun(state.doc, blockId, offset, target, { xPt, yPt }),
        }));
      },

      insertMath: (latex, display) => {
        setSession((current) => {
          const position = current.state.selection.focus;
          const formulaText = latex.trim();
          if (!formulaText) return current;

          if (display) {
            const mathParagraph = createParagraph(formulaText, {
              alignment: 'center',
              runs: [
                makeRun(formulaText, {
                  mathLatex: formulaText,
                  mathDisplay: true,
                }),
              ],
            });
            const doc = insertBlockAfter(current.state.doc, position.blockId, mathParagraph);
            return commit(current, 'Insérer formule', {
              ...current.state,
              doc,
              selection: collapsedSelection({ blockId: mathParagraph.id, offset: formulaText.length }),
            });
          } else {
            const base = current.state.selection.isCollapsed ? current.state : deleteSelection(current.state);
            const pos = base.selection.focus;
            const node = paragraphIndex(base.doc).byId.get(pos.blockId);
            if (!node) return current;

            const inherited = formattingAt(node.paragraph.runs, pos.offset);
            const formatting = {
              ...inherited,
              mathLatex: formulaText,
              mathDisplay: false,
            };
            const runs = insertTextInRuns(node.paragraph.runs, pos.offset, formulaText, formatting);
            const doc = replaceParagraph(base.doc, pos.blockId, { ...node.paragraph, runs });

            return commit(current, 'Insérer formule', {
              ...base,
              doc,
              selection: collapsedSelection({
                blockId: pos.blockId,
                offset: pos.offset + formulaText.length,
              }),
              pendingFormat: null,
            });
          }
        });
        focus();
      },

      updateMath: (blockId, latex, display) => {
        setSession((current) => {
          const formulaText = latex.trim();
          if (!formulaText) return current;

          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          let targetOffset = 0;
          let foundMath = false;
          let offsetAccum = 0;

          const newRuns: TextRun[] = [];
          for (const run of node.paragraph.runs) {
            if (!foundMath && run.mathLatex) {
              foundMath = true;
              targetOffset = offsetAccum + formulaText.length;
              newRuns.push(
                makeRun(formulaText, {
                  ...runFormatting(run),
                  mathLatex: formulaText,
                  mathDisplay: display,
                }),
              );
            } else {
              newRuns.push(run);
            }
            offsetAccum += run.text.length;
          }

          if (!foundMath) {
            targetOffset = formulaText.length;
            newRuns.push(
              makeRun(formulaText, {
                mathLatex: formulaText,
                mathDisplay: display,
              }),
            );
          }

          const updatedParagraph: ParagraphNode = {
            ...node.paragraph,
            runs: normalizeRuns(newRuns),
          };
          if (display) {
            updatedParagraph.alignment = 'center';
          } else if (updatedParagraph.alignment === 'center') {
            delete updatedParagraph.alignment;
          }

          const doc = replaceParagraph(current.state.doc, blockId, updatedParagraph);
          return commit(current, 'Modifier formule', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: targetOffset }),
          });
        });
        focus();
      },

      deleteMath: (blockId) => {
        setSession((current) => {
          const index = paragraphIndex(current.state.doc);
          const node = index.byId.get(blockId);
          if (!node) return current;

          // Si le paragraphe ne contient QUE la formule (bloc display ou paragraphe dédié) :
          if (node.paragraph.runs.length <= 1 || node.paragraph.runs.every((r) => r.mathLatex || !r.text)) {
            const prevId = previousParagraphId(current.state.doc, blockId);
            const doc = removeBlocks(current.state.doc, new Set([blockId]));
            const nextIndex = paragraphIndex(doc);
            const fallbackId = prevId ?? nextIndex.order[0] ?? '';
            return commit(current, 'Supprimer formule', {
              ...current.state,
              doc,
              selection: collapsedSelection({ blockId: fallbackId, offset: 0 }),
            });
          }

          // Si la formule est en ligne au milieu d'autre texte : retirer seulement le run mathématique
          let targetOffset = 0;
          let offsetAccum = 0;
          const remainingRuns: TextRun[] = [];
          for (const run of node.paragraph.runs) {
            if (run.mathLatex) {
              targetOffset = offsetAccum;
            } else {
              remainingRuns.push(run);
              offsetAccum += run.text.length;
            }
          }

          const updatedParagraph: ParagraphNode = {
            ...node.paragraph,
            runs: normalizeRuns(remainingRuns.length > 0 ? remainingRuns : [makeRun('')]),
          };

          const doc = replaceParagraph(current.state.doc, blockId, updatedParagraph);
          return commit(current, 'Supprimer formule', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: targetOffset }),
          });
        });
        focus();
      },

      /* ------------------------------------------------------------ images */

      insertImage: (attributes) => {
        setSession((current) => {
          if (!attributes.src) return current;

          // Une image remplace la sélection, comme le ferait une frappe : c'est
          // ce que fait `SwFEShell::Insert` quand un `SwPaM` n'est pas replié.
          const base = current.state.selection.isCollapsed
            ? current.state
            : deleteSelection(current.state);
          const position = base.selection.focus;
          const node = paragraphIndex(base.doc).byId.get(position.blockId);
          if (!node) return current;

          const cadre = makeImageRun(attributes);
          const runs = insertTextInRuns(
            node.paragraph.runs,
            position.offset,
            cadre.text,
            runFormatting(cadre),
          );
          const doc = replaceParagraph(base.doc, position.blockId, { ...node.paragraph, runs });

          return commit(current, 'Insérer une image', {
            ...base,
            doc,
            selection: collapsedSelection({
              blockId: position.blockId,
              offset: position.offset + cadre.text.length,
            }),
            // Sans cette remise à zéro, la frappe suivante hériterait du cadre et
            // produirait une seconde image.
            pendingFormat: null,
          });
        });
        focus();
      },

      updateImage: (blockId, offset, attributes) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          const cible = imageRunAt(node.paragraph.runs, offset);
          if (!cible) return current;

          // Le cadre est **reconstruit** plutôt que corrigé clé par clé : un
          // rognage retiré doit voir ses quatre valeurs disparaître, et une
          // fusion de l'ancien formatage les laisserait en place.
          const runs = [...node.paragraph.runs];
          const conserve = runFormatting(runs[cible.index]!);
          for (const cle of [
            'imageAlt',
            'imageCropTopPct',
            'imageCropRightPct',
            'imageCropBottomPct',
            'imageCropLeftPct',
            'imageCaption',
            'imageCaptionPosition',
            'imageCaptionAlign',
            'imageCaptionManual',
            'imageMarginPt',
            'imageCaptionGapPt',
            // L'habillage suit la même règle : revenir dans le fil du texte
            // doit faire disparaître la géométrie flottante, et une fusion de
            // l'ancien formatage la laisserait en place.
            ...WRAP_FORMAT_KEYS,
          ] as const) {
            delete conserve[cle];
          }
          runs[cible.index] = makeRun(runs[cible.index]!.text, {
            ...conserve,
            imageSrc: attributes.src,
            imageWidthPt: clampSize(attributes.widthPt),
            imageHeightPt: clampSize(attributes.heightPt),
            ...(attributes.alt ? { imageAlt: attributes.alt } : {}),
            ...cropFormatting(attributes.crop),
            ...captionFormatting(attributes.caption),
            ...spacingFormatting(attributes.marginPt, attributes.captionGapPt),
            ...placementFormatting(attributes.wrap),
          });

          const doc = replaceParagraph(current.state.doc, blockId, {
            ...node.paragraph,
            runs: normalizeRuns(runs),
          });
          return commit(current, 'Modifier l’image', {
            ...current.state,
            doc,
            selection: collapsedSelection({
              blockId,
              offset: cible.offset + runs[cible.index]!.text.length,
            }),
          });
        });
        focus();
      },

      /**
       * Retaille une image en place.
       *
       * Ne touche **que** les deux dimensions : tout le reste du formatage est
       * conservé tel quel. Reconstruire le run comme le fait `updateImage`
       * effacerait la légende et le rognage à chaque mouvement de souris.
       */
      resizeImage: (blockId, offset, widthPt, heightPt) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;
          const cible = imageRunAt(node.paragraph.runs, offset);
          if (!cible) return current;

          const run = node.paragraph.runs[cible.index]!;
          const largeur = clampSize(widthPt);
          const hauteur = clampSize(heightPt);
          if (run.imageWidthPt === largeur && run.imageHeightPt === hauteur) return current;

          const runs = [...node.paragraph.runs];
          runs[cible.index] = { ...run, imageWidthPt: largeur, imageHeightPt: hauteur };

          const doc = replaceParagraph(current.state.doc, blockId, {
            ...node.paragraph,
            runs,
          });
          const next = { ...current.state, doc };
          if (!transactionAutorisee(lectureSeuleRef.current, current.state, next)) return current;
          // Tout le glissement forme une seule entrée d'historique.
          return commit(current, 'Redimensionner l’image', next, dragGroup(`img:${blockId}:${offset}`));
        });
      },

      deleteImage: (blockId, offset) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          const cible = imageRunAt(node.paragraph.runs, offset);
          if (!cible) return current;

          const runs = node.paragraph.runs.filter((_, index) => index !== cible.index);
          const doc = replaceParagraph(current.state.doc, blockId, {
            ...node.paragraph,
            runs: normalizeRuns(runs, formattingAt(node.paragraph.runs, cible.offset)),
          });
          return commit(current, 'Supprimer l’image', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: cible.offset }),
          });
        });
        focus();
      },

      goToBlock: (blockId) => {
        move((state) => setSelection(state, collapsedSelection({ blockId, offset: 0 })));
        focus();
      },
      insertPageBreak: () => {
        run('Saut de page', (state) => insertBlockPageBreak(state));
        focus();
      },
      undo: () => {
        setSession((current) => undo(current));
        focus();
      },
      redo: () => {
        setSession((current) => redo(current));
        focus();
      },
      selectAll: () => {
        move((state) => selectAll(state));
        focus();
      },
      updateDocument: (label, transform, settingId) => {
        run(
          label,
          (state) => {
            const doc = transform(state.doc);
            if (doc === state.doc) return state;
            // Le curseur reste où il est ; le recadrage ne sert qu'au cas où le
            // réglage aurait raccourci le document sous lui.
            return { ...state, doc, selection: clampSelection(doc, state.selection) };
          },
          settingId ? () => settingsGroup(settingId) : undefined,
        );
      },
      applyRemote: (transform, remapSelection) => {
        setSession((current) => {
          const doc = transform(current.state.doc);
          if (doc === current.state.doc) return current;

          const selection = remapSelection
            ? remapSelection(current.state.selection)
            : current.state.selection;

          // La modification distante n'entre **pas** dans l'historique local :
          // `Ctrl+Z` défait ce que l'on a fait soi-même, jamais ce qu'un autre
          // a écrit. C'est aussi pourquoi on écrit `state` directement plutôt
          // que de passer par `commit`.
          return {
            ...current,
            state: {
              ...current.state,
              doc,
              selection: clampSelection(doc, selection),
            },
          };
        });
      },
    }),
    [run, move, patchRun, patchParagraph, focus],
  );

  /* --------------------------------------------------------------- clavier */

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const { key, shiftKey, altKey } = event;
      const meta = event.ctrlKey || event.metaKey;
      const granularity = meta || altKey ? 'word' : 'character';

      /**
       * Pose le curseur, en étendant la sélection si `Maj` est enfoncée.
       *
       * La cible est une **fonction** de l'état courant, pas une valeur : c'est
       * ce qui rend correct un appui maintenu sur une flèche, dont les
       * répétitions peuvent arriver dans le même lot de rendu.
       */
      const goTo = (
        target: (current: EditorState) => { position: DocumentPosition; desiredX: number | null } | null,
      ): void => {
        event.preventDefault();
        move((current) => {
          const next = target(current);
          if (!next) return current;
          return setSelection(
            current,
            shiftKey
              ? makeSelection(current.selection.anchor, next.position, next.desiredX)
              : collapsedSelection(next.position),
          );
        });
      };

      if (meta && !shiftKey) {
        switch (key.toLowerCase()) {
          case 'b': event.preventDefault(); commands.toggleBold(); return;
          case 'i': event.preventDefault(); commands.toggleItalic(); return;
          case 'u': event.preventDefault(); commands.toggleUnderline(); return;
          case 'a': event.preventDefault(); commands.selectAll(); return;
          case 'z': event.preventDefault(); commands.undo(); return;
          case 'y': event.preventDefault(); commands.redo(); return;
          case 'm': event.preventDefault(); commands.clearFormatting(); return;
          case 'l': event.preventDefault(); commands.setAlignment('left'); return;
          case 'e': event.preventDefault(); commands.setAlignment('center'); return;
          case 'r': event.preventDefault(); commands.setAlignment('right'); return;
          case 'j': event.preventDefault(); commands.setAlignment('justify'); return;
          case 'k': event.preventDefault(); hooksRef.current.onOpenLink?.(); return;
          case 'f': event.preventDefault(); hooksRef.current.onOpenFindReplace?.(); return;
          case 'p': event.preventDefault(); hooksRef.current.onPrint?.(); return;
          case ']': event.preventDefault(); commands.indent(1); return;
          case '[': event.preventDefault(); commands.indent(-1); return;
          case '\\': event.preventDefault(); commands.clearFormatting(); return;
          default: break;
        }
      }

      if (meta && shiftKey) {
        switch (key.toLowerCase()) {
          // `Ctrl+Maj+Z` refait, comme `Ctrl+Y` : les deux conventions
          // coexistent selon les plateformes, refuser l'une surprendrait la
          // moitié des usagers.
          case 'z': event.preventDefault(); commands.redo(); return;
          case 'x': event.preventDefault(); commands.toggleStrike(); return;
          case 'e': event.preventDefault(); hooksRef.current.onOpenMath?.(); return;
          case '&': case '7': event.preventDefault(); commands.toggleList('ordered'); return;
          case 'é': case '8': event.preventDefault(); commands.toggleList('bullet'); return;
          case '"': case '9': event.preventDefault(); commands.toggleList('task'); return;
          case '<': event.preventDefault(); commands.adjustFontSize(-1); return;
          case '>': event.preventDefault(); commands.adjustFontSize(1); return;
          default: break;
        }
      }

      if (meta && key >= '1' && key <= '6' && !shiftKey) {
        event.preventDefault();
        commands.setHeadingLevel(Number(key) as 1 | 2 | 3 | 4 | 5 | 6);
        return;
      }

      switch (key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          event.preventDefault();
          const direction = key === 'ArrowLeft' ? -1 : 1;
          goTo((current) => {
            // Une sélection non vide se replie sur le bord vers lequel on va,
            // plutôt que de faire un pas depuis la tête : c'est le comportement
            // attendu partout, et il évite de perdre un caractère au passage.
            if (!current.selection.isCollapsed && !shiftKey) {
              const { start, end } = normalizeSelection(current.doc, current.selection);
              return { position: direction < 0 ? start : end, desiredX: null };
            }
            return {
              position: moveHorizontal(
                current.doc,
                current.selection.focus,
                direction,
                granularity,
              ),
              desiredX: null,
            };
          });
          return;
        }

        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const direction = key === 'ArrowUp' ? -1 : 1;
          goTo((current) =>
            moveVertical(
              layout,
              current.selection.focus,
              direction,
              current.selection.desiredX ?? null,
              measurer,
            ),
          );
          return;
        }

        case 'Home':
        case 'End': {
          event.preventDefault();
          goTo((current) => {
            // `Ctrl+Origine` / `Ctrl+Fin` visent le document ; sans `Ctrl`, la
            // ligne **visuelle**, pas le paragraphe : sur un paragraphe replié
            // en cinq lignes, `Fin` s'arrête au bout de la ligne où l'on est.
            if (meta) {
              const edge = documentEdgeOffset(current.doc, key === 'Home' ? 'start' : 'end');
              return edge ? { position: edge, desiredX: null } : null;
            }
            const bounds = lineBounds(layout, current.selection.focus);
            if (!bounds) return null;
            return {
              position: {
                blockId: current.selection.focus.blockId,
                offset: key === 'Home' ? bounds.start : bounds.end,
              },
              desiredX: null,
            };
          });
          return;
        }

        case 'Backspace':
        case 'Delete': {
          event.preventDefault();
          const direction = key === 'Backspace' ? -1 : 1;
          run(
            'Suppression',
            (current) =>
              direction < 0
                ? deleteBackward(current, granularity)
                : deleteForward(current, granularity),
            (before, after) => {
              const removed = removedCharacter(before, direction);
              if (!removed) return null;
              return deletionGroup(
                before.selection.focus.blockId,
                before.selection.focus.offset,
                after.selection.focus.offset,
                removed,
              );
            },
          );
          return;
        }

        case 'Enter': {
          event.preventDefault();
          if (meta) commands.insertPageBreak();
          else if (shiftKey) run('Saut de ligne', (current) => insertLineBreak(current));
          else run('Nouveau paragraphe', (current) => splitParagraph(current));
          return;
        }

        // `Maj+F10` et la touche Menu ouvrent le menu contextuel. Sans elles, les
        // commandes de tableau ne seraient atteignables qu'à la souris. La zone
        // de saisie invisible suit le curseur : son rectangle **est** la
        // position du curseur à l'écran.
        case 'ContextMenu': {
          event.preventDefault();
          const box = inputRef.current?.getBoundingClientRect();
          hooksRef.current.onOpenContextMenu?.(box?.left ?? 0, box?.bottom ?? 0);
          return;
        }

        case 'F10': {
          if (!shiftKey) break;
          event.preventDefault();
          const box = inputRef.current?.getBoundingClientRect();
          hooksRef.current.onOpenContextMenu?.(box?.left ?? 0, box?.bottom ?? 0);
          return;
        }

        case 'Tab': {
          // La tabulation reste dans le document : sortir de l'éditeur au
          // clavier se fait par `Échap` puis `Tab`, sinon on ne pourrait jamais
          // en insérer une.
          event.preventDefault();

          // Dans un tableau, `Tab` passe de cellule en cellule — convention
          // partagée par Word, Google Docs et Writer. Elle prime sur les deux
          // autres usages : c'est le seul moyen de remplir une grille au
          // clavier, et une tabulation dans une cellule étroite n'a guère de
          // sens.
          if (tableRef.current) {
            commands.goToAdjacentCell(!shiftKey);
            return;
          }

          if (shiftKey) {
            commands.indent(-1);
            return;
          }
          // En tête d'un élément de liste, `Tab` imbrique — ailleurs, il insère
          // une vraie tabulation. C'est la règle de Writer : le décalage prime
          // là où il a un sens structurel.
          setSession((current) => {
            const node = currentNode(current.state);
            if (node?.listKind !== undefined && current.state.selection.focus.offset === 0) {
              return commit(current, 'Niveau de liste', changeListLevel(current.state, 1));
            }
            return commit(current, 'Tabulation', insertText(current.state, '\t'));
          });
          return;
        }

        case 'Escape':
          event.preventDefault();
          inputRef.current?.blur();
          return;

        default:
          break;
      }
    },
    // Plus aucune dépendance à l'état : le gestionnaire ne lit que `current`,
    // fourni par le réducteur. Il reste donc stable d'un rendu à l'autre.
    [layout, measurer, move, run, commands],
  );

  /* ------------------------------------------------------- saisie de texte */

  /**
   * Saisie de texte, branchée sur l'événement **natif** `beforeinput`.
   *
   * React expose bien un `onBeforeInput`, mais c'est un émulateur bâti sur
   * `keypress` et `textInput` : il ne porte pas `inputType`. Or c'est
   * précisément par `inputType` que les claviers virtuels annoncent leurs
   * effacements (`deleteContentBackward`), la dictée son insertion et le
   * navigateur son autocomplétion — autant de cas qui, sans cela, modifieraient
   * la zone tampon sans jamais atteindre le modèle.
   */
  const handleBeforeInput = useCallback(
    (event: InputEvent) => {
      // Pendant une composition (méthode de saisie asiatique, dictée), on laisse
      // le navigateur travailler : le texte n'arrive qu'à la fin.
      if (composing.current) return;

      // Rien de ce que fait le navigateur dans la zone tampon ne doit
      // subsister : le document est la seule source de vérité.
      event.preventDefault();

      const data = event.data ?? '';

      switch (event.inputType) {
        case 'insertText':
        case 'insertFromPaste':
        case 'insertFromDrop':
        case 'insertReplacementText':
        case 'insertFromYank':
          if (!data) return;
          run(
            'Saisie',
            (state) => insertText(state, data),
            (before, after) =>
              typingGroup(
                before.selection.focus.blockId,
                before.selection.focus.offset,
                after.selection.focus.offset,
                data,
              ),
          );
          return;

        case 'insertLineBreak':
          run('Saut de ligne', (state) => insertLineBreak(state));
          return;

        case 'insertParagraph':
          run('Nouveau paragraphe', (state) => splitParagraph(state));
          return;

        case 'deleteContentBackward':
        case 'deleteByCut':
          run('Suppression', (state) => deleteBackward(state));
          return;

        case 'deleteContentForward':
          run('Suppression', (state) => deleteForward(state));
          return;

        case 'deleteWordBackward':
          run('Suppression', (state) => deleteBackward(state, 'word'));
          return;

        case 'deleteWordForward':
          run('Suppression', (state) => deleteForward(state, 'word'));
          return;

        case 'historyUndo':
          setSession((current) => undo(current));
          return;

        case 'historyRedo':
          setSession((current) => redo(current));
          return;

        default:
          // Type inconnu : on a déjà empêché l'effet par défaut, donc rien ne
          // se produit — ce qui vaut mieux qu'une modification silencieuse de
          // la zone tampon que le modèle ignorerait.
          return;
      }
    },
    [run],
  );

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.addEventListener('beforeinput', handleBeforeInput);
    return () => node.removeEventListener('beforeinput', handleBeforeInput);
  }, [handleBeforeInput]);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      composing.current = false;
      const data = event.data;
      // La zone tampon est vidée : elle ne sert qu'à recueillir la composition,
      // le texte vit désormais dans le modèle.
      if (inputRef.current) inputRef.current.value = '';
      if (!data) return;
      run('Saisie', (state) => insertText(state, data));
    },
    [run],
  );

  /* --------------------------------------------------------- presse-papiers */

  const onCopy = useCallback(
    (event: React.ClipboardEvent) => {
      const text = selectionText(session.state);
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      lastCopied = { text, fragment: extractFragment(session.state) };
    },
    [session.state],
  );

  const onCut = useCallback(
    (event: React.ClipboardEvent) => {
      const text = selectionText(session.state);
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      lastCopied = { text, fragment: extractFragment(session.state) };
      run('Couper', (state) => deleteBackward(state));
    },
    [session.state, run],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;

      if (lastCopied && lastCopied.text === text) {
        const fragment = lastCopied.fragment;
        run('Coller', (state) => insertFragment(state, fragment));
        return;
      }
      // Collage venu d'ailleurs : on respecte au moins les fins de ligne, en
      // les transformant en vrais paragraphes.
      const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
      run('Coller', (state) =>
        insertFragment(state, {
          paragraphs: paragraphs.map((line) => ({
            runs: [{ text: line }],
            attributes: { type: 'paragraph' as const },
          })),
        }),
      );
    },
    [run],
  );

  /* ---------------------------------------------------------------- souris */

  /** Coordonnées du pointeur dans la zone de contenu d'une page. */
  const pointToContent = useCallback(
    // Un `MouseEvent` suffit : la fonction ne lit que `currentTarget` et les
    // coordonnées de fenêtre, communes à tous les événements de pointage.
    (event: React.MouseEvent<HTMLDivElement>): { x: number; y: number } => {
      const rect = event.currentTarget.getBoundingClientRect();
      // Le rectangle est déjà mis à l'échelle par le zoom : on divise pour
      // revenir aux coordonnées du modèle, qui ignore le zoom.
      const x = (event.clientX - rect.left) / zoom - layout.geometry.contentLeftPx;
      const y = (event.clientY - rect.top) / zoom - layout.geometry.contentTopPx;
      return { x, y };
    },
    [zoom, layout.geometry],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      if (event.button !== 0) return;
      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      if (!position) return;

      event.preventDefault();
      focus();

      const paragraph = paragraphIndex(session.state.doc).byId.get(position.blockId)?.paragraph;

      if (event.detail >= 3 && paragraph) {
        // Triple clic : le paragraphe entier.
        const length = paragraphText(paragraph).length;
        move((state) =>
          setSelection(
            state,
            makeSelection(
              { blockId: position.blockId, offset: 0 },
              { blockId: position.blockId, offset: length },
            ),
          ),
        );
        return;
      }

      if (event.detail === 2 && paragraph) {
        const mathRun = paragraph.runs.find((r) => r.mathLatex);
        if (mathRun?.mathLatex) {
          hooksRef.current.onEditMath?.(
            position.blockId,
            mathRun.mathLatex,
            Boolean(mathRun.mathDisplay),
          );
          return;
        }

        const { start, end } = wordRangeAt(paragraphText(paragraph), position.offset);
        move((state) =>
          setSelection(
            state,
            makeSelection(
              { blockId: position.blockId, offset: start },
              { blockId: position.blockId, offset: end },
            ),
          ),
        );
        return;
      }

      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      move((state) =>
        setSelection(
          state,
          event.shiftKey
            ? makeSelection(state.selection.anchor, position)
            : collapsedSelection(position),
        ),
      );
    },
    [layout, measurer, pointToContent, focus, move, session.state.doc],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      if (!dragging.current) return;
      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      if (!position) return;
      move((state) => setSelection(state, makeSelection(state.selection.anchor, position)));
    },
    [layout, measurer, pointToContent, move],
  );

  /**
   * Clic droit : pose le curseur, puis laisse l'appelant ouvrir le menu.
   *
   * Le curseur ne bouge **pas** si le clic tombe dans la sélection courante.
   * C'est la règle de tous les éditeurs, et elle est indispensable ici : sans
   * elle, un clic droit sur une ligne sélectionnée pour la supprimer replierait
   * d'abord la sélection, et la commande ne porterait plus sur rien.
   */
  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, pageIndex: number) => {
      event.preventDefault();
      focus();

      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      // La référence est assignée au rendu : elle est donc déjà posée quand un
      // événement de pointage peut arriver.
      const state = sessionRef.current?.state;

      if (position && state) {
        const { start, end } = normalizeSelection(state.doc, state.selection);
        const inside =
          !state.selection.isCollapsed &&
          comparePositions(state.doc, position, start) >= 0 &&
          comparePositions(state.doc, position, end) <= 0;
        if (!inside) move((current) => setSelection(current, collapsedSelection(position)));
      }

      hooksRef.current.onOpenContextMenu?.(event.clientX, event.clientY);
    },
    [layout, measurer, pointToContent, focus, move],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, _pageIndex: number) => {
      if (!dragging.current) return;
      dragging.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const setZoom = useCallback((next: number) => {
    setZoomState(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  const onFocusInput = useCallback(() => setFocused(true), []);
  const onBlurInput = useCallback(() => setFocused(false), []);

  /**
   * Faisceau de gestionnaires, d'identité stable.
   *
   * Chaque gestionnaire est déjà tenu par un `useCallback` ; ce qui manquait,
   * c'était l'identité de **l'objet** qui les porte. Reconstruit à chaque
   * rendu, il propageait son instabilité à tout ce qui en dépend — au premier
   * rang `onPagePointerDown`, transmis aux feuilles.
   */
  const handlers = useMemo(
    () => ({
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onFocus: onFocusInput,
      onBlur: onBlurInput,
      onCopy,
      onCut,
      onPaste,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onContextMenu,
    }),
    [
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onFocusInput,
      onBlurInput,
      onCopy,
      onCut,
      onPaste,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onContextMenu,
    ],
  );

  return {
    session,
    layout,
    measurer,
    activeFormat,
    currentParagraph,
    table,
    caret,
    rects,
    rectsByPage,
    placementsByPage,
    isFocused,
    canUndo: canUndo(session),
    canRedo: canRedo(session),
    zoom,
    setZoom,
    inputRef,
    focus,
    run,
    commands,
    handlers,
  };
}

/* ------------------------------------------------------------------ outils */

/** Paragraphe où se trouve la tête du curseur. */
function currentNode(state: EditorState): ParagraphNode | null {
  return paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)?.paragraph ?? null;
}

/** Caractère qu'un effacement va retirer, pour le regroupement d'annulation. */
function removedCharacter(state: EditorState, direction: -1 | 1): string | null {
  if (!state.selection.isCollapsed) return null;
  const position = state.selection.focus;
  const paragraph = paragraphIndex(state.doc).byId.get(position.blockId)?.paragraph;
  if (!paragraph) return null;

  const text = paragraphText(paragraph);
  const other = moveHorizontal(state.doc, position, direction, 'character');
  if (other.blockId !== position.blockId) return null;

  const from = Math.min(position.offset, other.offset);
  const to = Math.max(position.offset, other.offset);
  return to > from ? text.slice(from, to) : null;
}

/** Première ou dernière position du document (`Ctrl+Origine` / `Ctrl+Fin`). */
function documentEdgeOffset(
  doc: WriterDocumentState,
  edge: 'start' | 'end',
): { blockId: string; offset: number } | null {
  const { order, byId } = paragraphIndex(doc);
  const id = edge === 'start' ? order[0] : order[order.length - 1];
  if (!id) return null;
  const paragraph = byId.get(id)?.paragraph;
  if (!paragraph) return null;
  return { blockId: id, offset: edge === 'start' ? 0 : paragraphText(paragraph).length };
}
