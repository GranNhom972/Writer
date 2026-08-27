/**
 * Édition atomique. §4.2 du CLAUDE.md, transposé de `SwTxtNode` (`ndtxt.cxx`)
 * et `SwEditShell` (`sw/source/core/edit/`).
 *
 * Chaque opération suit la même séquence que Writer :
 *   1. localiser le nœud et l'offset visés ;
 *   2. scinder ou fusionner les plages de formatage en préservant le style local ;
 *   3. replacer le curseur ;
 *   4. produire l'action d'annulation correspondante.
 *
 * Les trois premiers points sont ici ; le quatrième est dans `history.ts`, qui
 * enveloppe ces opérations plutôt que de les instrumenter — une opération reste
 * ainsi une fonction pure de l'état vers l'état.
 */

import {
  containerKeyOf,
  createParagraph,
  deleteTableColumn,
  deleteTableRow,
  gridColumnsOf,
  insertBlockAfter,
  insertParagraphAfter,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  newId,
  paragraphIndex,
  paragraphText,
  removeBlocks,
  ROOT_CONTAINER,
  replaceParagraph,
  splitTableCell,
  touch,
  type CellRect,
} from '../document/document';
import {
  applyFormattingToRange,
  commonFormatting,
  deleteRangeInRuns,
  formattingAt,
  insertTextInRuns,
  makeRun,
  normalizeRuns,
  patchFormatting,
  runsLength,
  sliceRuns,
  splitRunsAt,
  type RunFormatPatch,
} from '../document/runs';
import {
  isTable,
  MAX_LIST_LEVEL,
  type DocumentBlock,
  type DocumentPosition,
  type DocumentSelection,
  type ListKind,
  type ParagraphNode,
  type RunFormatting,
  type TextRun,
  type WriterDocumentState,
} from '../document/types';
import {
  clampPosition,
  collapsedSelection,
  comparePositions,
  makeSelection,
  moveHorizontal,
  normalizeSelection,
  samePosition,
  type HorizontalGranularity,
} from './cursor';
import {
  markDeleted,
  markInserted,
  pruneOrphanRedlines,
  type RedlineAuthor,
} from '../document/redline';
import { addComment, pruneOrphanComments } from '../document/comments';
import { setBookmark } from '../document/bookmarks';
import { createToc, type TocOptions } from '../document/tox';

/**
 * État complet de l'éditeur.
 *
 * `pendingFormat` porte le formatage armé sur un curseur replié : appuyer sur
 * `Ctrl+B` puis taper doit produire du gras, alors qu'aucun texte n'existe
 * encore à formater. Writer garde cet état hors du document lui aussi
 * (`SwEditShell::SetAttrItem` sur un PaM vide n'écrit rien dans le nœud).
 */
export interface EditorState {
  doc: WriterDocumentState;
  selection: DocumentSelection;
  pendingFormat: RunFormatPatch | null;
  /**
   * Mode révision. Transposition de `REDLINE_ON` d'`IDocumentRedlineAccess`.
   *
   * Quand il est actif, aucune édition ne détruit : une frappe pose un
   * `REDLINE_INSERT`, une suppression un `REDLINE_DELETE` sans retirer le
   * texte. `null` — la valeur par défaut — rend à l'éditeur son comportement
   * habituel, ce qui garantit qu'aucun document existant ne change de
   * comportement du seul fait que ce champ existe.
   */
  review?: RedlineAuthor | null;
}

export function createEditorState(doc: WriterDocumentState): EditorState {
  const firstId = paragraphIndex(doc).order[0] ?? '';
  return {
    doc,
    selection: collapsedSelection({ blockId: firstId, offset: 0 }),
    pendingFormat: null,
  };
}

/** Formatage effectif à appliquer à la prochaine frappe. */
export function activeFormatting(state: EditorState): RunFormatting {
  const { selection, doc } = state;
  const { start, end } = normalizeSelection(doc, selection);
  const paragraph = paragraphIndex(doc).byId.get(start.blockId)?.paragraph;
  if (!paragraph) return {};

  const base = selection.isCollapsed
    ? formattingAt(paragraph.runs, start.offset)
    : start.blockId === end.blockId
      ? commonFormatting(paragraph.runs, start.offset, end.offset)
      : commonFormatting(paragraph.runs, start.offset, runsLength(paragraph.runs));

  const cleaned = { ...base };
  delete cleaned.footnoteText;
  delete cleaned.footnoteId;

  return state.pendingFormat ? patchFormatting(cleaned, state.pendingFormat) : cleaned;
}

/* -------------------------------------------------------------- suppression */

/** Supprime la sélection et replie le curseur sur son début. */
export function deleteSelection(state: EditorState): EditorState {
  const { doc, selection } = state;
  if (selection.isCollapsed) return state;

  // Mode révision : rien ne disparaît, on signe la demande de suppression.
  if (state.review) return markSelectionDeleted(state, state.review);

  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startNode = index.byId.get(start.blockId);
  const endNode = index.byId.get(end.blockId);
  if (!startNode || !endNode) return state;

  if (start.blockId === end.blockId) {
    const runs = deleteRangeInRuns(startNode.paragraph.runs, start.offset, end.offset);
    return {
      doc: replaceParagraph(doc, start.blockId, { ...startNode.paragraph, runs }),
      selection: collapsedSelection(start),
      pendingFormat: null,
    };
  }

  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  const between = index.order.slice(startRank + 1, endRank);

  const sameContainer =
    containerKeyOf(doc, start.blockId) === containerKeyOf(doc, end.blockId);

  const [head] = splitRunsAt(startNode.paragraph.runs, start.offset);
  const [, tail] = splitRunsAt(endNode.paragraph.runs, end.offset);

  if (!sameContainer) {
    // Frontière de tableau : on vide ce qui est sélectionné dans chaque nœud,
    // sans jamais souder deux conteneurs — même refus que `SwNodes::_MoveNodes`.
    let next = replaceParagraph(doc, start.blockId, {
      ...startNode.paragraph,
      runs: normalizeRuns(head),
    });
    next = replaceParagraph(next, end.blockId, {
      ...endNode.paragraph,
      runs: normalizeRuns(tail),
    });
    for (const id of between) {
      const node = paragraphIndex(next).byId.get(id);
      if (node) {
        next = replaceParagraph(next, id, { ...node.paragraph, runs: normalizeRuns([]) });
      }
    }
    return { doc: next, selection: collapsedSelection(start), pendingFormat: null };
  }

  // Même conteneur : le premier nœud absorbe la fin du dernier, et tout ce qui
  // se trouve entre les deux disparaît (`SwTxtNode::JoinNext`).
  const merged: ParagraphNode = {
    ...startNode.paragraph,
    runs: normalizeRuns([...head, ...tail]),
  };
  let next = replaceParagraph(doc, start.blockId, merged);

  const removed = new Set<string>([...between, end.blockId]);
  if (containerKeyOf(doc, start.blockId) === ROOT_CONTAINER) {
    // Au fil du document, la sélection peut enjamber un tableau entier : il est
    // couvert, donc il part — sinon il resterait une grille vide au milieu du
    // texte recollé.
    for (let i = startNode.blockIndex + 1; i < endNode.blockIndex; i += 1) {
      const block = doc.blocks[i];
      if (block) removed.add(block.id);
    }
  }
  next = removeBlocks(next, removed);

  return { doc: next, selection: collapsedSelection(start), pendingFormat: null };
}

/**
 * Retour arrière. Sur un curseur replié en début de paragraphe, fusionne avec
 * le précédent — sauf si celui-ci est dans un autre conteneur.
 */
export function deleteBackward(
  state: EditorState,
  granularity: HorizontalGranularity = 'character',
): EditorState {
  if (!state.selection.isCollapsed) return deleteSelection(state);

  const from = state.selection.focus;
  const to = moveHorizontal(state.doc, from, -1, granularity);
  if (samePosition(from, to)) return state;
  if (
    to.blockId !== from.blockId &&
    containerKeyOf(state.doc, to.blockId) !== containerKeyOf(state.doc, from.blockId)
  ) {
    return state;
  }

  return deleteSelection({
    ...state,
    selection: makeSelection(to, from),
  });
}

/** Touche `Suppr`. Symétrique de `deleteBackward`. */
export function deleteForward(
  state: EditorState,
  granularity: HorizontalGranularity = 'character',
): EditorState {
  if (!state.selection.isCollapsed) return deleteSelection(state);

  const from = state.selection.focus;
  const to = moveHorizontal(state.doc, from, 1, granularity);
  if (samePosition(from, to)) return state;
  if (
    to.blockId !== from.blockId &&
    containerKeyOf(state.doc, to.blockId) !== containerKeyOf(state.doc, from.blockId)
  ) {
    return state;
  }

  return deleteSelection({
    ...state,
    selection: makeSelection(from, to),
  });
}

/* ---------------------------------------------------------------- insertion */

/** Insère du texte, en remplaçant la sélection s'il y en a une. */
export function insertText(state: EditorState, text: string): EditorState {
  if (text.length === 0) return state;

  const base = state.selection.isCollapsed ? state : deleteSelection(state);
  const position = base.selection.focus;
  const node = paragraphIndex(base.doc).byId.get(position.blockId);
  if (!node) return state;

  const rawInherited = formattingAt(node.paragraph.runs, position.offset);
  const inherited: RunFormatting = { ...rawInherited };
  delete inherited.footnoteText;
  delete inherited.footnoteId;

  const formatting = state.pendingFormat
    ? patchFormatting(inherited, state.pendingFormat)
    : inherited;

  const runs = insertTextInRuns(node.paragraph.runs, position.offset, text, formatting);
  let doc = replaceParagraph(base.doc, position.blockId, { ...node.paragraph, runs });

  // Mode révision : la frappe est signée après coup. L'insertion elle-même ne
  // change pas — c'est bien la propriété qu'on veut, une seule façon d'insérer
  // du texte quel que soit le mode.
  if (state.review) {
    doc = markInserted(
      doc,
      position.blockId,
      position.offset,
      position.offset + text.length,
      state.review,
    );
  }

  return {
    doc,
    selection: collapsedSelection({
      blockId: position.blockId,
      offset: position.offset + text.length,
    }),
    // Le formatage armé est consommé par la frappe : il ne survit pas au-delà.
    pendingFormat: null,
    ...(state.review !== undefined ? { review: state.review } : {}),
  };
}

/**
 * Marque la sélection comme supprimée sans retirer le texte.
 *
 * Sur plusieurs paragraphes, chacun est marqué sur sa part et **aucun n'est
 * fusionné** : tant que la révision n'est pas acceptée, la coupure de
 * paragraphe existe encore. `SwDoc::DeleteAndJoin` sous `REDLINE_ON` fait le
 * même choix, et c'est le seul qui permette au rejet de tout restaurer.
 *
 * Le curseur se replie en **fin** de sélection et non au début : le texte est
 * toujours là, revenir à son début donnerait l'impression que rien ne s'est
 * passé.
 */
function markSelectionDeleted(state: EditorState, who: RedlineAuthor): EditorState {
  const { doc, selection } = state;
  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);

  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank < 0 || endRank < 0) return state;

  let next = doc;
  let removedInStart = 0;

  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = index.order[rank];
    if (!blockId) continue;
    const paragraph = paragraphIndex(next).byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    const length = runsLength(paragraph.runs);
    const from = rank === startRank ? start.offset : 0;
    const to = rank === endRank ? end.offset : length;
    if (to <= from) continue;

    const result = markDeleted(next, blockId, from, to, who);
    next = result.doc;
    if (rank === startRank) {
      // Le texte que l'auteur venait lui-même d'insérer a bel et bien disparu :
      // le curseur doit en tenir compte, sinon il se poserait au-delà de la fin.
      for (const range of result.removedRanges) removedInStart += range.end - range.start;
    }
  }

  const focusBlockId = endRank === startRank ? start.blockId : end.blockId;
  const focusOffset =
    endRank === startRank ? Math.max(start.offset, end.offset - removedInStart) : end.offset;

  return {
    ...state,
    doc: pruneOrphanComments(pruneOrphanRedlines(next)),
    selection: collapsedSelection({ blockId: focusBlockId, offset: focusOffset }),
    pendingFormat: null,
  };
}

/**
 * Coupe le paragraphe en deux (`SwTxtNode::SplitCntntNode`, touche `Entrée`).
 *
 * Le second nœud hérite des attributs de paragraphe du premier, sauf le titre :
 * la ligne qui suit un titre est du texte courant, jamais un second titre —
 * c'est la règle de style suivant (`SwTxtFmtColl::GetNextTxtFmtColl`).
 */
export function splitParagraph(state: EditorState): EditorState {
  const base = state.selection.isCollapsed ? state : deleteSelection(state);
  const position = base.selection.focus;
  const node = paragraphIndex(base.doc).byId.get(position.blockId);
  if (!node) return state;

  // `Entrée` sur un élément de liste **vide** ne crée pas un second élément
  // vide : il sort de la liste, en remontant d'abord d'un niveau s'il y en a
  // un. C'est le geste par lequel on termine une liste, et le seul qui ne
  // demande pas d'aller chercher un bouton.
  if (node.paragraph.listKind !== undefined && runsLength(node.paragraph.runs) === 0) {
    const level = node.paragraph.listLevel ?? 0;
    return level > 0
      ? {
          ...base,
          doc: replaceParagraph(base.doc, position.blockId, {
            ...node.paragraph,
            listLevel: level - 1,
          }),
        }
      : toggleList(base, node.paragraph.listKind);
  }

  const [head, tail] = splitRunsAt(node.paragraph.runs, position.offset);
  const current: ParagraphNode = { ...node.paragraph, runs: head };

  const follower: ParagraphNode = {
    ...node.paragraph,
    id: newId('p'),
    runs: tail,
  };
  if (node.paragraph.type === 'heading') {
    follower.type = 'paragraph';
    delete follower.headingLevel;
  }
  // Un saut de page explicite reste attaché au nœud qui l'a reçu.
  delete follower.pageBreakBefore;
  // Le nouvel élément de liste hérite du type et du niveau, jamais de l'état de
  // la case ni d'une reprise de numérotation : ce sont des propriétés de
  // l'élément qu'on quitte, pas de celui qu'on crée.
  delete follower.listChecked;
  delete follower.listRestart;
  delete follower.listStartValue;

  let doc = replaceParagraph(base.doc, position.blockId, current);
  doc = insertParagraphAfter(doc, position.blockId, follower);

  return {
    doc,
    selection: collapsedSelection({ blockId: follower.id, offset: 0 }),
    pendingFormat: null,
  };
}

/**
 * Saut de ligne dans le paragraphe (`Maj+Entrée`, `SwBreakPortion`).
 *
 * Différent du saut de paragraphe : le nœud reste unique, donc son alignement,
 * ses retraits et sa puce de liste restent partagés par les deux lignes.
 */
export function insertLineBreak(state: EditorState): EditorState {
  return insertText(state, '\n');
}

/** Saut de page explicite (`Ctrl+Entrée`) : le texte reprend en haut de la page suivante. */
export function insertBlockPageBreak(state: EditorState): EditorState {
  const position = state.selection.focus;
  const node = paragraphIndex(state.doc).byId.get(position.blockId);
  if (!node) return state;

  // Un saut de page se pose **sur** un nœud : c'est un attribut de paragraphe
  // (`SvxFmtBreakItem`), pas un caractère inséré dans le texte.
  const split = splitParagraph(state);
  const target = split.selection.focus;
  const created = paragraphIndex(split.doc).byId.get(target.blockId);
  if (!created) return split;

  return {
    ...split,
    doc: replaceParagraph(split.doc, target.blockId, {
      ...created.paragraph,
      pageBreakBefore: true,
    }),
  };
}

/* ---------------------------------------------------------------- formatage */

/**
 * Applique un correctif de formatage de caractère.
 *
 * Sur un curseur replié, rien n'est écrit dans le document : le correctif est
 * mémorisé et s'appliquera à la frappe suivante.
 */
export function applyRunFormat(state: EditorState, patch: RunFormatPatch): EditorState {
  const { doc, selection } = state;

  if (selection.isCollapsed) {
    return {
      ...state,
      pendingFormat: { ...(state.pendingFormat ?? {}), ...patch },
    };
  }

  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return state;

  let next = doc;
  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = index.order[rank]!;
    const paragraph = paragraphIndex(next).byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    const length = runsLength(paragraph.runs);
    const from = rank === startRank ? start.offset : 0;
    const to = rank === endRank ? end.offset : length;
    next = replaceParagraph(next, blockId, {
      ...paragraph,
      runs: applyFormattingToRange(paragraph.runs, from, to, patch),
    });
  }

  return { doc: next, selection, pendingFormat: null };
}

/** Bascule un attribut booléen sur la sélection (`Ctrl+B`, `Ctrl+I`, …). */
export function toggleRunFormat(
  state: EditorState,
  key: 'bold' | 'italic' | 'underline' | 'strikeThrough',
): EditorState {
  const active = activeFormatting(state)[key] === true;
  return applyRunFormat(state, { [key]: active ? null : true } as RunFormatPatch);
}

/** Retire tout formatage de caractère de la sélection (`Ctrl+M` de Writer). */
export function clearRunFormat(state: EditorState): EditorState {
  return applyRunFormat(state, {
    bold: null,
    italic: null,
    underline: null,
    strikeThrough: null,
    fontFamily: null,
    fontSizePt: null,
    color: null,
    backgroundColor: null,
  });
}

/** Clés de paragraphe qu'un correctif peut toucher. */
type ParagraphPatchKey =
  | 'type'
  | 'headingLevel'
  | 'alignment'
  | 'lineSpacing'
  | 'marginTopPt'
  | 'marginBottomPt'
  | 'indentLeftPt'
  | 'indentRightPt'
  | 'firstLineIndentPt'
  | 'pageBreakBefore'
  | 'keepTogether'
  | 'styleName';

/**
 * Correctif d'attributs de paragraphe.
 *
 * `null` **retire** l'attribut, comme dans `RunFormatPatch` : « aligner à
 * gauche » n'est pas la même chose que « ne plus imposer d'alignement », et
 * seule la seconde laisse un style nommé reprendre la main.
 */
export type ParagraphPatch = {
  [K in ParagraphPatchKey]?: ParagraphNode[K] | null;
};

/**
 * Applique un correctif de paragraphe à tous les nœuds touchés par la sélection
 * (`SwEditShell::SetAttrSet` sur un PaM couvrant plusieurs nœuds).
 */
export function applyParagraphFormat(
  state: EditorState,
  patch: ParagraphPatch,
): EditorState {
  const { doc, selection } = state;
  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return state;

  let next = doc;
  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = index.order[rank]!;
    const paragraph = paragraphIndex(next).byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    next = replaceParagraph(next, blockId, applyParagraphPatch(paragraph, patch));
  }

  return { doc: next, selection, pendingFormat: state.pendingFormat };
}

/**
 * Applique un correctif à un nœud. Une valeur `null` **retire** l'attribut, qui
 * repasse alors au défaut du document — la distinction `SetAttr` / `ResetAttr`.
 */
function applyParagraphPatch(node: ParagraphNode, patch: ParagraphPatch): ParagraphNode {
  const updated: ParagraphNode = { ...node };
  const fields = updated as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete fields[key];
    else fields[key] = value;
  }
  // Un paragraphe redevenu courant ne garde pas son niveau de titre.
  if (updated.type !== 'heading') delete updated.headingLevel;
  return updated;
}

/** Transforme la sélection en titre de niveau donné, ou en paragraphe courant. */
export function setHeading(state: EditorState, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): EditorState {
  return level === 0
    ? applyParagraphFormat(state, { type: 'paragraph' })
    : applyParagraphFormat(state, { type: 'heading', headingLevel: level });
}

/* ------------------------------------------------------------------ listes */

/**
 * Bascule la sélection en liste du type donné, ou l'en sort.
 *
 * Une liste n'étant qu'un attribut de paragraphe (`RES_PARATR_LIST_*`), la
 * bascule ne déplace aucun nœud : elle pose ou retire des attributs. Tous les
 * paragraphes touchés reçoivent le **même** identifiant de liste, ce qui en
 * fait une seule liste continue plutôt qu'une suite d'éléments isolés.
 */
export function toggleList(state: EditorState, kind: ListKind): EditorState {
  const { doc, selection } = state;
  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return state;

  // Déjà entièrement dans une liste de ce type → on en sort.
  let toutDedans = true;
  for (let rank = startRank; rank <= endRank; rank += 1) {
    const node = index.byId.get(index.order[rank]!)?.paragraph;
    if (!node || node.listKind !== kind) {
      toutDedans = false;
      break;
    }
  }

  // Rejoindre la liste voisine plutôt que d'en ouvrir une nouvelle : passer en
  // liste le paragraphe qui suit une liste doit continuer sa numérotation.
  const voisin = index.byId.get(index.order[startRank - 1] ?? '')?.paragraph;
  const listId = toutDedans
    ? undefined
    : voisin?.listKind === kind && voisin.listId
      ? voisin.listId
      : newId('l');

  let next = doc;
  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = index.order[rank]!;
    const paragraph = paragraphIndex(next).byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    const updated: ParagraphNode = { ...paragraph };
    if (toutDedans) {
      delete updated.listKind;
      delete updated.listId;
      delete updated.listLevel;
      delete updated.listChecked;
      delete updated.listRestart;
      delete updated.listStartValue;
    } else {
      updated.listKind = kind;
      updated.listId = listId!;
      updated.listLevel = paragraph.listLevel ?? 0;
      // Un titre ne devient pas un élément de liste : Writer non plus ne
      // numérote pas un titre au même titre qu'un paragraphe de corps.
      if (updated.type === 'heading') {
        updated.type = 'paragraph';
        delete updated.headingLevel;
      }
      if (kind !== 'task') delete updated.listChecked;
      else updated.listChecked = paragraph.listChecked ?? false;
    }
    next = replaceParagraph(next, blockId, updated);
  }

  return { doc: next, selection, pendingFormat: state.pendingFormat };
}

/**
 * Change le niveau d'imbrication des éléments sélectionnés.
 *
 * Hors liste, la commande retombe sur le retrait ordinaire : c'est ce que fait
 * `Tab` dans Writer, et l'usager n'a pas à savoir dans lequel des deux cas il
 * se trouve.
 */
export function changeListLevel(state: EditorState, direction: 1 | -1): EditorState {
  const { doc, selection } = state;
  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return state;

  let next = doc;
  let touche = false;

  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = index.order[rank]!;
    const paragraph = paragraphIndex(next).byId.get(blockId)?.paragraph;
    if (!paragraph || paragraph.listKind === undefined) continue;
    touche = true;
    const level = Math.max(
      0,
      Math.min(MAX_LIST_LEVEL - 1, (paragraph.listLevel ?? 0) + direction),
    );
    next = replaceParagraph(next, blockId, { ...paragraph, listLevel: level });
  }

  return touche
    ? { doc: next, selection, pendingFormat: state.pendingFormat }
    : state;
}

/** Coche ou décoche un élément de liste à cocher. */
export function toggleListChecked(state: EditorState, blockId: string): EditorState {
  const paragraph = paragraphIndex(state.doc).byId.get(blockId)?.paragraph;
  if (!paragraph || paragraph.listKind !== 'task') return state;
  return {
    ...state,
    doc: replaceParagraph(state.doc, blockId, {
      ...paragraph,
      listChecked: !(paragraph.listChecked ?? false),
    }),
  };
}

/* --------------------------------------------------------- presse-papiers */

/** Contenu extrait d'une sélection, prêt à recoller sans perdre le formatage. */
export interface DocumentFragment {
  paragraphs: { runs: TextRun[]; attributes: ParagraphPatch }[];
}

export function extractFragment(state: EditorState): DocumentFragment {
  const { doc, selection } = state;
  if (selection.isCollapsed) return { paragraphs: [] };

  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return { paragraphs: [] };

  const paragraphs: DocumentFragment['paragraphs'] = [];
  for (let rank = startRank; rank <= endRank; rank += 1) {
    const location = index.byId.get(index.order[rank]!);
    if (!location) continue;
    const node = location.paragraph;
    const length = runsLength(node.runs);
    const from = rank === startRank ? start.offset : 0;
    const to = rank === endRank ? end.offset : length;

    const attributes: ParagraphPatch = { type: node.type };
    if (node.headingLevel !== undefined) attributes.headingLevel = node.headingLevel;
    if (node.alignment !== undefined) attributes.alignment = node.alignment;
    if (node.lineSpacing !== undefined) attributes.lineSpacing = node.lineSpacing;

    paragraphs.push({ runs: sliceRuns(node.runs, from, to), attributes });
  }
  return { paragraphs };
}

/** Texte brut d'une sélection — pour le presse-papiers `text/plain`. */
export function selectionText(state: EditorState): string {
  return extractFragment(state)
    .paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
    .join('\n');
}

/**
 * Colle un fragment à la position courante.
 *
 * Le premier paragraphe du fragment se **fond** dans le paragraphe d'accueil
 * plutôt que de créer un nœud : coller trois mots au milieu d'une phrase ne
 * doit pas la couper en deux.
 */
export function insertFragment(state: EditorState, fragment: DocumentFragment): EditorState {
  if (fragment.paragraphs.length === 0) return state;

  const base = state.selection.isCollapsed ? state : deleteSelection(state);
  const position = base.selection.focus;
  const node = paragraphIndex(base.doc).byId.get(position.blockId);
  if (!node) return state;

  const [head, tail] = splitRunsAt(node.paragraph.runs, position.offset);
  const first = fragment.paragraphs[0]!;

  if (fragment.paragraphs.length === 1) {
    const runs = normalizeRuns([...head, ...first.runs, ...tail]);
    const offset = runsLength(head) + runsLength(first.runs);
    return {
      doc: replaceParagraph(base.doc, position.blockId, { ...node.paragraph, runs }),
      selection: collapsedSelection({ blockId: position.blockId, offset }),
      pendingFormat: null,
    };
  }

  let doc = replaceParagraph(base.doc, position.blockId, {
    ...node.paragraph,
    runs: normalizeRuns([...head, ...first.runs]),
  });

  let previousId = position.blockId;
  let lastId = position.blockId;
  let lastOffset = 0;

  for (let i = 1; i < fragment.paragraphs.length; i += 1) {
    const entry = fragment.paragraphs[i]!;
    const isLast = i === fragment.paragraphs.length - 1;
    const runs = isLast ? normalizeRuns([...entry.runs, ...tail]) : normalizeRuns(entry.runs);

    const created = createParagraph('', { runs });
    Object.assign(created, entry.attributes);
    if (created.type !== 'heading') delete created.headingLevel;

    doc = insertParagraphAfter(doc, previousId, created);
    previousId = created.id;
    if (isLast) {
      lastId = created.id;
      lastOffset = runsLength(entry.runs);
    }
  }

  return {
    doc: touch(doc),
    selection: collapsedSelection({ blockId: lastId, offset: lastOffset }),
    pendingFormat: null,
  };
}

/* ---------------------------------------------------------------- sélection */

/** Sélectionne tout le document (`Ctrl+A`). */
export function selectAll(state: EditorState): EditorState {
  const { order, byId } = paragraphIndex(state.doc);
  const firstId = order[0];
  const lastId = order[order.length - 1];
  if (!firstId || !lastId) return state;
  const last = byId.get(lastId)!;

  return {
    ...state,
    selection: makeSelection(
      { blockId: firstId, offset: 0 },
      { blockId: lastId, offset: paragraphText(last.paragraph).length },
    ),
  };
}

/** Replace le curseur, en bornant la position aux limites réelles du document. */
export function setSelection(
  state: EditorState,
  selection: DocumentSelection,
): EditorState {
  const anchor = clampPosition(state.doc, selection.anchor);
  const focus = clampPosition(state.doc, selection.focus);
  return {
    ...state,
    selection: {
      anchor,
      focus,
      isCollapsed: samePosition(anchor, focus),
      desiredX: selection.desiredX ?? null,
    },
  };
}

/** Étend la sélection jusqu'à `focus` en conservant l'ancre (`Maj` + geste). */
export function extendSelectionTo(
  state: EditorState,
  focus: DocumentPosition,
  desiredX: number | null = null,
): EditorState {
  return setSelection(state, makeSelection(state.selection.anchor, focus, desiredX));
}

/** La sélection est-elle vide de tout contenu ? */
export function isEmptySelection(state: EditorState): boolean {
  return (
    state.selection.isCollapsed ||
    comparePositions(state.doc, state.selection.anchor, state.selection.focus) === 0
  );
}

/** Run unique portant un texte et un formatage — utilitaire des tests et de l'import. */
export function runOf(text: string, formatting: RunFormatting = {}): TextRun {
  return makeRun(text, formatting);
}

/* --------------------------------------------------- notes de bas de page */

function toSuperscript(n: number): string {
  const digits = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
  return String(n)
    .split('')
    .map((d) => digits[Number(d)] ?? d)
    .join('');
}

/** Compte le nombre total de notes de bas de page dans le document. */
export function countFootnotes(doc: WriterDocumentState): number {
  let count = 0;
  const { order, byId } = paragraphIndex(doc);
  for (const id of order) {
    const node = byId.get(id)?.paragraph;
    if (!node) continue;
    for (const run of node.runs) {
      if (run.footnoteText !== undefined) count += 1;
    }
  }
  return count;
}

/**
 * Insère un appel de note de bas de page au curseur.
 * Transposition de `SwFtnFrm` / `SwDoc::Insert(SwFmtFtn)`.
 */
export function insertFootnote(state: EditorState, text: string): EditorState {
  const footnoteContent = text.trim();
  if (!footnoteContent) return state;

  const base = state.selection.isCollapsed ? state : deleteSelection(state);
  const position = base.selection.focus;
  const node = paragraphIndex(base.doc).byId.get(position.blockId);
  if (!node) return state;

  const totalFn = countFootnotes(base.doc);
  const marker = toSuperscript(totalFn + 1);
  const fnId = newId('fn');

  const inherited = formattingAt(node.paragraph.runs, position.offset);
  const formatting: RunFormatting = {
    ...inherited,
    footnoteText: footnoteContent,
    footnoteId: fnId,
  };

  const runs = insertTextInRuns(node.paragraph.runs, position.offset, marker, formatting);
  const doc = replaceParagraph(base.doc, position.blockId, { ...node.paragraph, runs });

  return {
    doc,
    selection: collapsedSelection({
      blockId: position.blockId,
      offset: position.offset + marker.length,
    }),
    pendingFormat: null,
  };
}

/* ---------------------------------------------------- opérations de tableau */

export function currentTableLocation(state: EditorState): {
  tableId: string;
  rowIndex: number;
  cellIndex: number;
} | null {
  const position = state.selection.focus;
  const location = paragraphIndex(state.doc).byId.get(position.blockId);
  if (!location || !location.cell) return null;
  const block = state.doc.blocks[location.blockIndex];
  if (!block || !isTable(block)) return null;
  return {
    tableId: block.id,
    rowIndex: location.cell.rowIndex,
    cellIndex: location.cell.cellIndex,
  };
}

export function insertTableRowAbove(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = insertTableRow(state.doc, loc.tableId, loc.rowIndex, 'above');
  return { ...state, doc };
}

export function insertTableRowBelow(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = insertTableRow(state.doc, loc.tableId, loc.rowIndex, 'below');
  return { ...state, doc };
}

export function deleteCurrentTableRow(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = deleteTableRow(state.doc, loc.tableId, loc.rowIndex);
  const nextFirst = paragraphIndex(doc).order[0] ?? '';
  return { ...state, doc, selection: collapsedSelection({ blockId: nextFirst, offset: 0 }) };
}

export function insertTableColumnLeft(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = insertTableColumn(state.doc, loc.tableId, loc.cellIndex, 'left');
  return { ...state, doc };
}

export function insertTableColumnRight(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = insertTableColumn(state.doc, loc.tableId, loc.cellIndex, 'right');
  return { ...state, doc };
}

export function deleteCurrentTableColumn(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = deleteTableColumn(state.doc, loc.tableId, loc.cellIndex);
  const nextFirst = paragraphIndex(doc).order[0] ?? '';
  return { ...state, doc, selection: collapsedSelection({ blockId: nextFirst, offset: 0 }) };
}

/* --------------------------------------- fusion et scission de cellules */

/**
 * Rectangle de cellules couvert par la sélection courante.
 *
 * Une sélection de tableau, dans Writer comme ici, n'est pas une sélection de
 * texte : `SwCursorShell::IsTableMode` bascule sur un `SwCellFrm` de départ et
 * un d'arrivée, et le rectangle en est le **plus petit englobant**. C'est ce
 * que reconstruit cette fonction à partir des deux extrémités du `SwPaM`.
 *
 * Le calcul se fait en **colonnes de grille** et non en indices de cellule :
 * après une fusion, `row.cells[2]` n'occupe plus la colonne 2, et confondre
 * les deux fusionnerait le mauvais rectangle.
 */
export function selectedCellRect(state: EditorState): {
  tableId: string;
  rect: CellRect;
} | null {
  const index = paragraphIndex(state.doc);
  const anchor = index.byId.get(state.selection.anchor.blockId);
  const focus = index.byId.get(state.selection.focus.blockId);
  if (!anchor?.cell || !focus?.cell) return null;
  if (anchor.blockIndex !== focus.blockIndex) return null;

  const block = state.doc.blocks[anchor.blockIndex];
  if (!block || !isTable(block)) return null;

  const anchorRow = block.rows[anchor.cell.rowIndex];
  const focusRow = block.rows[focus.cell.rowIndex];
  if (!anchorRow || !focusRow) return null;

  const anchorCol = gridColumnsOf(anchorRow)[anchor.cell.cellIndex] ?? 0;
  const focusCol = gridColumnsOf(focusRow)[focus.cell.cellIndex] ?? 0;

  return {
    tableId: block.id,
    rect: {
      fromRow: Math.min(anchor.cell.rowIndex, focus.cell.rowIndex),
      toRow: Math.max(anchor.cell.rowIndex, focus.cell.rowIndex),
      fromCol: Math.min(anchorCol, focusCol),
      toCol: Math.max(anchorCol, focusCol),
    },
  };
}

/** Fusionne les cellules sélectionnées (`SwDoc::MergeTbl`). */
export function mergeSelectedCells(state: EditorState): EditorState {
  const selected = selectedCellRect(state);
  if (!selected) return state;

  const doc = mergeTableCells(state.doc, selected.tableId, selected.rect);
  if (doc === state.doc) return state;

  // Le curseur se pose dans la cellule maîtresse : les autres n'existent plus
  // pour la navigation, l'y laisser le rendrait inatteignable.
  const master = paragraphIndex(doc);
  const block = doc.blocks.find((candidate) => candidate.id === selected.tableId);
  const cell =
    block && isTable(block)
      ? block.rows[selected.rect.fromRow]?.cells.find((candidate) => !candidate.covered)
      : undefined;
  const target = cell?.blocks[0]?.id ?? master.order[0] ?? '';

  return { ...state, doc, selection: collapsedSelection({ blockId: target, offset: 0 }) };
}

/** Scinde la cellule courante (`SwDoc::SplitTbl`). */
export function splitCurrentCell(
  state: EditorState,
  direction: 'horizontal' | 'vertical',
  count = 2,
): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const doc = splitTableCell(state.doc, loc.tableId, loc.rowIndex, loc.cellIndex, direction, count);
  return doc === state.doc ? state : { ...state, doc };
}

/* -------------------------------------------------- table des matières */

/**
 * Insère une table des matières après le bloc courant.
 *
 * Le bloc inséré ne contient **aucune entrée** : elles sont dérivées à chaque
 * pagination (cf. `engine/tox.ts`). C'est ce qui garantit qu'un sommaire ne
 * peut pas mentir sur le contenu du document — il n'a rien à mentir *avec*.
 */
export function insertTableOfContents(state: EditorState, options: TocOptions = {}): EditorState {
  const toc = createToc(options);
  const doc = insertBlockAfter(state.doc, state.selection.focus.blockId, toc as DocumentBlock);
  return { ...state, doc };
}

/* --------------------------------------------- commentaires et signets */

/** Pose un commentaire sur la sélection (`SwEditShell::InsertPostIt`). */
export function commentSelection(
  state: EditorState,
  author: string,
  text: string,
  options: { initials?: string; now?: string } = {},
): { state: EditorState; threadId: string } {
  const { start, end } = normalizeSelection(state.doc, state.selection);
  // Un commentaire sans plage n'a rien à ancrer : Writer refuse aussi.
  if (state.selection.isCollapsed || start.blockId !== end.blockId) {
    return { state, threadId: '' };
  }

  const { doc, threadId } = addComment(
    state.doc,
    { blockId: start.blockId, startOffset: start.offset, endOffset: end.offset },
    author,
    text,
    options,
  );

  return { state: doc === state.doc ? state : { ...state, doc }, threadId };
}

/** Pose un signet sur la sélection (`IDocumentMarkAccess::makeMark`). */
export function bookmarkSelection(state: EditorState, name: string): EditorState {
  const { start, end } = normalizeSelection(state.doc, state.selection);
  if (start.blockId !== end.blockId) return state;

  const doc = setBookmark(
    state.doc,
    { blockId: start.blockId, startOffset: start.offset, endOffset: end.offset },
    name,
  );
  return doc === state.doc ? state : { ...state, doc };
}

/* -------------------------------------------------------- mode révision */

/** Active ou désactive le suivi des modifications (`REDLINE_ON` / `REDLINE_NONE`). */
export function setReviewMode(state: EditorState, who: RedlineAuthor | null): EditorState {
  return { ...state, review: who };
}

/** Le suivi des modifications est-il actif ? */
export function isReviewing(state: EditorState): boolean {
  return state.review != null;
}
