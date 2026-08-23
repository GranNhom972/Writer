/**
 * Commandes d'édition Write.
 *
 * Chaque commande est un `Command` ProseMirror : pure, testable, et réutilisée
 * telle quelle par le raccourci clavier, le bouton de ruban et le menu — une seule
 * implémentation, trois chemins d'accès (directive UX §5).
 */

import { setBlockType, toggleMark } from 'prosemirror-commands';
import type { Mark, MarkType, Node as PMNode } from 'prosemirror-model';
import { liftListItem, wrapInList } from 'prosemirror-schema-list';
import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import {
  MAX_FONT_SIZE,
  MAX_INDENT,
  MIN_FONT_SIZE,
  writeSchema,
  type Alignment,
} from '../document/schema';

const nodes = writeSchema.nodes;
const markTypes = writeSchema.marks;

export const toggleBold: Command = toggleMark(markTypes['strong']!);
export const toggleItalic: Command = toggleMark(markTypes['em']!);
export const toggleUnderline: Command = toggleMark(markTypes['underline']!);
export const toggleStrike: Command = toggleMark(markTypes['strike']!);

/* -------------------------------------------------------------------------- */
/* Blocs                                                                       */
/* -------------------------------------------------------------------------- */

/** Ctrl+1..6 — bascule titre ; sur le même niveau, revient au paragraphe. */
export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    // `level` peut arriver en chaîne : yrs n'écrit que des attributs textuels,
    // alors que le navigateur y met un nombre. Comparer les valeurs, pas les types.
    const isSameLevel =
      $from.parent.type === nodes['heading'] && Number($from.parent.attrs['level']) === level;
    const target = isSameLevel
      ? setBlockType(nodes['paragraph']!)
      : setBlockType(nodes['heading']!, { level });
    return target(state, dispatch);
  };
}

export const setParagraph: Command = setBlockType(nodes['paragraph']!);

/** Applique un attribut à tous les blocs de texte de la sélection. */
function updateBlockAttr(
  compute: (node: PMNode) => Record<string, unknown> | null,
): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    let tr = state.tr;
    let changed = false;

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type !== nodes['paragraph'] && node.type !== nodes['heading']) return true;
      const attrs = compute(node);
      if (!attrs) return true;
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      changed = true;
      return true;
    });

    if (!changed) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** Ctrl+L/E/R/J — alignement. `left` est stocké `null` (valeur par défaut). */
export function setAlignment(align: Alignment): Command {
  const value = align === 'left' ? null : align;
  return updateBlockAttr((node) => (node.attrs['align'] === value ? null : { align: value }));
}

export function setLineHeight(lineHeight: number): Command {
  const value = lineHeight === 1 ? null : lineHeight;
  return updateBlockAttr((node) => (node.attrs['lineHeight'] === value ? null : { lineHeight: value }));
}

/**
 * Retrait. Dans une liste, la touche agit sur la profondeur de l'élément ;
 * ailleurs, sur la marge du paragraphe — comportement attendu par l'usager.
 */
export function changeIndent(delta: 1 | -1): Command {
  return (state, dispatch, view) => {
    const listItem = nodes['list_item'];
    if (listItem && delta === -1 && isInside(state, 'list_item')) {
      if (liftListItem(listItem)(state, dispatch, view)) return true;
    }

    return updateBlockAttr((node) => {
      const current = Number(node.attrs['indent'] ?? 0);
      const next = Math.min(MAX_INDENT, Math.max(0, current + delta));
      return next === current ? null : { indent: next };
    })(state, dispatch, view);
  };
}

function isInside(state: EditorState, nodeName: string): boolean {
  const type = nodes[nodeName];
  if (!type) return false;
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === type) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Listes                                                                      */
/* -------------------------------------------------------------------------- */

export type ListKind = 'bullet_list' | 'ordered_list' | 'task_list';

export function toggleList(kind: ListKind): Command {
  return (state, dispatch, view) => {
    const listType = nodes[kind];
    const listItem = kind === 'task_list' ? nodes['task_item'] : nodes['list_item'];
    if (!listType || !listItem) return false;

    // Déjà dans ce type de liste : on en sort.
    if (isInside(state, kind)) {
      const plainItem = nodes['list_item'];
      if (kind === 'task_list') return liftTaskItems(state, dispatch);
      return plainItem ? liftListItem(plainItem)(state, dispatch, view) : false;
    }

    // Dans une autre liste : on sort d'abord pour éviter les listes imbriquées
    // involontaires, puis on applique le nouveau type.
    if (isInside(state, 'list_item') || isInside(state, 'task_list')) {
      const lifted = liftAll(state, dispatch, view);
      if (lifted) return true;
    }

    return wrapInList(listType, kind === 'task_list' ? { checked: false } : null)(state, dispatch, view);
  };
}

function liftAll(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, view: unknown): boolean {
  const listItem = nodes['list_item'];
  if (listItem && isInside(state, 'list_item')) {
    return liftListItem(listItem)(state, dispatch, view as never);
  }
  return liftTaskItems(state, dispatch);
}

function liftTaskItems(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const taskItem = nodes['task_item'];
  if (!taskItem) return false;
  return liftListItem(taskItem)(state, dispatch);
}

/** Coche/décoche une case ; `pos` est la position du nœud `task_item`. */
export function toggleTask(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== nodes['task_item']) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs['checked'] }));
    return true;
  };
}

/* -------------------------------------------------------------------------- */
/* Marques paramétrées (police, taille, couleurs, lien)                        */
/* -------------------------------------------------------------------------- */

/** Remplace une marque paramétrée sur la sélection (ou l'arme pour la frappe). */
function applyMark(type: MarkType, attrs: Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const { empty, from, to } = state.selection;

    if (empty) {
      // Sélection vide : la marque s'applique à la frappe suivante.
      const stored = (state.storedMarks ?? state.selection.$from.marks()).filter(
        (mark) => mark.type !== type,
      );
      dispatch?.(state.tr.setStoredMarks(attrs ? [...stored, type.create(attrs)] : stored));
      return true;
    }

    let tr = state.tr.removeMark(from, to, type);
    if (attrs) tr = tr.addMark(from, to, type.create(attrs));
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

export function setFontFamily(family: string | null): Command {
  return applyMark(markTypes['fontFamily']!, family ? { family } : null);
}

export function setFontSize(size: number | null): Command {
  if (size === null) return applyMark(markTypes['fontSize']!, null);
  return applyMark(markTypes['fontSize']!, { size: clampFontSize(size) });
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return MIN_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

/** Boutons « − » / « + » du ruban : pas de 1 pt, bornes respectées. */
export function adjustFontSize(delta: number, fallback = 11): Command {
  return (state, dispatch, view) => {
    const current = activeMarkAttr(state, markTypes['fontSize']!, 'size');
    const base = typeof current === 'number' ? current : fallback;
    return setFontSize(clampFontSize(base + delta))(state, dispatch, view);
  };
}

export function setTextColor(color: string | null): Command {
  return applyMark(markTypes['textColor']!, color ? { color } : null);
}

export function setHighlight(color: string | null): Command {
  return applyMark(markTypes['highlight']!, color ? { color } : null);
}

/**
 * Normalise une URL saisie par l'usager.
 * Refuse tout schéma exécutable (`javascript:`, `data:`…) : un lien de document
 * collaboratif est réémis à tous les participants — c'est un vecteur XSS classique.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const allowed = ['http:', 'https:', 'mailto:'];
  if (!allowed.includes(url.protocol)) return null;
  return url.toString();
}

/**
 * Applique un lien. Sans sélection, l'adresse est **insérée comme texte** puis
 * marquée : armer une marque sur un curseur vide ne survit pas au passage du focus
 * par le dialogue, et l'usager attend de toute façon de voir le lien apparaître.
 */
export function setLink(rawHref: string, displayText?: string): Command {
  return (state, dispatch, view) => {
    const href = normalizeUrl(rawHref);
    if (!href) return false;

    const type = markTypes['link']!;
    if (!state.selection.empty) {
      return applyMark(type, { href })(state, dispatch, view);
    }

    const text = (displayText ?? rawHref).trim() || href;
    const node = writeSchema.text(text, [type.create({ href })]);
    dispatch?.(state.tr.replaceSelectionWith(node, false).scrollIntoView());
    return true;
  };
}

export const removeLink: Command = applyMark(markTypes['link']!, null);

/** Insertion d'image par URL. L'attribut `alt` est requis par l'appelant. */
export function insertImage(rawSrc: string, alt: string): Command {
  return (state, dispatch) => {
    const src = normalizeUrl(rawSrc);
    const type = nodes['image'];
    if (!src || !type || src.startsWith('mailto:')) return false;
    dispatch?.(state.tr.replaceSelectionWith(type.create({ src, alt })).scrollIntoView());
    return true;
  };
}

/* -------------------------------------------------------------------------- */
/* Formules mathématiques                                                      */
/* -------------------------------------------------------------------------- */

/** Insère une formule ; `display` = formule centrée sur sa propre ligne. */
export function insertMath(latex: string, display: boolean): Command {
  return (state, dispatch) => {
    const type = display ? nodes['math_block'] : nodes['math_inline'];
    if (!type || !latex.trim()) return false;
    dispatch?.(state.tr.replaceSelectionWith(type.create({ latex: latex.trim() })).scrollIntoView());
    return true;
  };
}

/** Modifie la formule située à `pos` (rouverte depuis le document). */
export function updateMath(pos: number, latex: string): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || !isMathNode(node)) return false;
    if (!latex.trim()) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: latex.trim() }));
    return true;
  };
}

export function removeMath(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || !isMathNode(node)) return false;
    dispatch?.(state.tr.delete(pos, pos + node.nodeSize));
    return true;
  };
}

export function isMathNode(node: PMNode): boolean {
  return node.type === nodes['math_inline'] || node.type === nodes['math_block'];
}

/** Formule sous le curseur, s'il y en a une : sert à rouvrir l'éditeur. */
export function mathAtSelection(state: EditorState): { pos: number; latex: string; display: boolean } | null {
  const { from, to } = state.selection;
  let found: { pos: number; latex: string; display: boolean } | null = null;

  state.doc.nodesBetween(from, to === from ? from + 1 : to, (node, pos) => {
    if (found || !isMathNode(node)) return true;
    found = {
      pos,
      latex: String(node.attrs['latex'] ?? ''),
      display: node.type === nodes['math_block'],
    };
    return false;
  });

  return found;
}

/** Ctrl+Entrée — saut de page manuel (`SwPageDesc` côté OpenOffice). */
export const insertPageBreak: Command = (state, dispatch) => {
  const type = nodes['page_break'];
  const paragraphType = nodes['paragraph'];
  if (!type) return false;
  if (!dispatch) return true;

  let tr = state.tr.replaceSelectionWith(type.create());

  // Un saut en fin de document doit ouvrir une page où écrire : sans paragraphe
  // après lui, le curseur n'aurait nulle part où aller.
  const apres = tr.selection.from;
  if (paragraphType && apres >= tr.doc.content.size - 1) {
    tr = tr.insert(tr.doc.content.size, paragraphType.create());
    tr = tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
  }

  dispatch(tr.scrollIntoView());
  return true;
};

/** Efface la mise en forme : marques + attributs de bloc, retour au texte normal. */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) {
    dispatch?.(state.tr.setStoredMarks([]));
    return true;
  }

  let tr = state.tr;
  for (const type of Object.values(markTypes)) {
    tr = tr.removeMark(from, to, type);
  }

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === nodes['heading']) {
      tr = tr.setNodeMarkup(pos, nodes['paragraph'], { align: null, lineHeight: null, indent: 0 });
    } else if (node.type === nodes['paragraph']) {
      tr = tr.setNodeMarkup(pos, undefined, { align: null, lineHeight: null, indent: 0 });
    }
    return true;
  });

  dispatch?.(tr.scrollIntoView());
  return true;
};

/* -------------------------------------------------------------------------- */
/* Lecture de l'état pour le ruban                                             */
/* -------------------------------------------------------------------------- */

export interface FormattingState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  blockType: 'paragraph' | 'heading';
  headingLevel: number | null;
  alignment: Alignment;
  lineHeight: number;
  indent: number;
  fontFamily: string | null;
  fontSize: number | null;
  textColor: string | null;
  highlight: string | null;
  linkHref: string | null;
  listKind: ListKind | null;
}

function activeMarkAttr(state: EditorState, type: MarkType, attr: string): unknown {
  const { empty, from, to, $from } = state.selection;
  const marks: readonly Mark[] = empty
    ? (state.storedMarks ?? $from.marks())
    : collectMarksInRange(state, from, to, type);
  const found = marks.find((mark) => mark.type === type);
  return found?.attrs[attr] ?? null;
}

function collectMarksInRange(state: EditorState, from: number, to: number, type: MarkType): Mark[] {
  const found: Mark[] = [];
  state.doc.nodesBetween(from, to, (node) => {
    const mark = node.marks.find((candidate) => candidate.type === type);
    if (mark) found.push(mark);
    return true;
  });
  return found;
}

function firstBlockInRange(state: EditorState): PMNode | null {
  const { from, to } = state.selection;
  let found: PMNode | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.type === nodes['paragraph'] || node.type === nodes['heading']) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

function currentListKind(state: EditorState): ListKind | null {
  for (const kind of ['task_list', 'bullet_list', 'ordered_list'] as const) {
    if (isInside(state, kind)) return kind;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tableaux, Notes de bas de page et Champs                                   */
/* -------------------------------------------------------------------------- */

export function isInTable(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === nodes['table']) return true;
  }
  return false;
}

export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    const tableType = nodes['table'];
    const rowType = nodes['table_row'];
    const cellType = nodes['table_cell'];
    const paragraphType = nodes['paragraph'];
    if (!tableType || !rowType || !cellType) return false;

    const safeRows = Math.max(1, Math.min(50, Math.round(rows)));
    const safeCols = Math.max(1, Math.min(20, Math.round(cols)));

    const rowNodes: PMNode[] = [];
    for (let r = 0; r < safeRows; r += 1) {
      const cellNodes: PMNode[] = [];
      for (let c = 0; c < safeCols; c += 1) {
        const type = r === 0 && nodes['table_header'] ? nodes['table_header'] : cellType;
        cellNodes.push(type.createAndFill()!);
      }
      rowNodes.push(rowType.create(null, cellNodes));
    }

    const tableNode = tableType.create(null, rowNodes);
    if (!dispatch) return true;

    let tr = state.tr.replaceSelectionWith(tableNode);

    // Un tableau en dernière position piège le curseur : sans bloc après lui, on
    // ne peut plus rien écrire à la suite. On garantit donc un paragraphe final.
    const insertedEnd = tr.selection.from;
    const $end = tr.doc.resolve(Math.min(insertedEnd, tr.doc.content.size));
    const isLastBlock = $end.after(1) >= tr.doc.content.size;
    if (isLastBlock && paragraphType) {
      tr = tr.insert(tr.doc.content.size, paragraphType.create());
    }

    // Le curseur va dans la première cellule : on insère un tableau pour le
    // remplir, pas pour le contempler.
    const firstCell = findFirstCellPos(tr.doc, insertedEnd);
    if (firstCell !== null) {
      tr = tr.setSelection(TextSelection.create(tr.doc, firstCell));
    }

    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Position de saisie dans la première cellule du tableau le plus proche avant `from`. */
function findFirstCellPos(doc: PMNode, from: number): number | null {
  let result: number | null = null;

  doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.type !== nodes['table'] || pos + node.nodeSize < from - 1) return true;

    node.descendants((child, childPos) => {
      if (result !== null) return false;
      if (child.type === nodes['table_header'] || child.type === nodes['table_cell']) {
        // +1 pour entrer dans la cellule, +1 pour entrer dans son paragraphe.
        result = pos + 1 + childPos + 2;
        return false;
      }
      return true;
    });

    return false;
  });

  return result;
}

/** Description du tableau contenant le curseur : ce dont le panneau a besoin. */
export interface TableInfo {
  pos: number;
  rows: number;
  /** Nombre de colonnes de la ligne la plus large. */
  cols: number;
  borderWidth: number;
  borderColor: string | null;
  headerRow: boolean;
}

export function tableInfo(state: EditorState): TableInfo | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    const node = $from.node(d);
    if (node.type !== nodes['table']) continue;

    let cols = 0;
    node.forEach((row) => {
      cols = Math.max(cols, row.childCount);
    });

    return {
      pos: $from.before(d),
      rows: node.childCount,
      cols,
      borderWidth: Number(node.attrs['borderWidth'] ?? 1),
      borderColor: (node.attrs['borderColor'] as string | null) ?? null,
      headerRow: node.attrs['headerRow'] !== false,
    };
  }
  return null;
}

/** Modifie les propriétés du tableau courant (trait, en-tête) en une transaction. */
export function setTableAttrs(attrs: Partial<Omit<TableInfo, 'pos' | 'rows' | 'cols'>>): Command {
  return (state, dispatch) => {
    const info = tableInfo(state);
    if (!info) return false;

    const node = state.doc.nodeAt(info.pos);
    if (!node || node.type !== nodes['table']) return false;

    dispatch?.(state.tr.setNodeMarkup(info.pos, undefined, { ...node.attrs, ...attrs }));
    return true;
  };
}

/**
 * Redimensionne le tableau à exactement `rows` × `cols`.
 *
 * Les lignes et colonnes sont ajoutées ou retirées **par la fin** : les cellules
 * déjà remplies gardent leur place, ce qui rend l'opération prévisible. Le
 * contenu supprimé l'est en une seule transaction, donc annulable d'un coup.
 */
export function resizeTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const info = tableInfo(state);
    const rowType = nodes['table_row'];
    const cellType = nodes['table_cell'];
    const headerType = nodes['table_header'];
    if (!info || !rowType || !cellType) return false;

    const table = state.doc.nodeAt(info.pos);
    if (!table) return false;

    const targetRows = Math.max(1, Math.min(50, Math.round(rows)));
    const targetCols = Math.max(1, Math.min(20, Math.round(cols)));
    if (targetRows === info.rows && targetCols === info.cols) return false;

    const useHeader = info.headerRow && headerType;
    const rowNodes: PMNode[] = [];

    for (let r = 0; r < targetRows; r += 1) {
      const existing = r < table.childCount ? table.child(r) : null;
      const cells: PMNode[] = [];

      for (let c = 0; c < targetCols; c += 1) {
        const type = r === 0 && useHeader ? headerType : cellType;
        const kept = existing && c < existing.childCount ? existing.child(c) : null;

        // Une cellule conservée garde son contenu ; seul son type peut changer
        // (première ligne devenant en-tête, ou l'inverse).
        if (kept && kept.type === type) {
          cells.push(kept);
        } else if (kept) {
          cells.push(type.create(kept.attrs, kept.content));
        } else {
          cells.push(type.createAndFill()!);
        }
      }

      rowNodes.push(rowType.create(existing?.attrs ?? null, cells));
    }

    const next = nodes['table']!.create(table.attrs, rowNodes);
    if (!dispatch) return true;

    // Position du curseur AVANT le remplacement, en coordonnées de cellule.
    const before = cellCoordinates(state);

    let tr = state.tr.replaceWith(info.pos, info.pos + table.nodeSize, next);

    // Sans cela, remplacer le tableau éjecte le curseur : le panneau de
    // propriétés se refermerait à chaque changement de dimension.
    const targetRow = Math.min(before?.row ?? 0, targetRows - 1);
    const targetCol = Math.min(before?.col ?? 0, targetCols - 1);
    const cellPos = cellPositionAt(tr.doc, info.pos, targetRow, targetCol);
    if (cellPos !== null) {
      tr = tr.setSelection(TextSelection.create(tr.doc, cellPos));
    }

    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Coordonnées (ligne, colonne) de la cellule contenant le curseur. */
function cellCoordinates(state: EditorState): { row: number; col: number } | null {
  const { $from } = state.selection;

  for (let d = $from.depth; d > 0; d -= 1) {
    if ($from.node(d).type !== nodes['table']) continue;
    // d = table, d+1 = ligne, d+2 = cellule
    const row = $from.index(d);
    const col = $from.depth > d + 1 ? $from.index(d + 1) : 0;
    return { row, col };
  }
  return null;
}

/** Position de saisie dans la cellule (row, col) du tableau situé à `tablePos`. */
function cellPositionAt(doc: PMNode, tablePos: number, row: number, col: number): number | null {
  const table = doc.nodeAt(tablePos);
  if (!table || row >= table.childCount) return null;

  const rowNode = table.child(row);
  if (col >= rowNode.childCount) return null;

  let offset = tablePos + 1; // entrée dans le tableau
  for (let r = 0; r < row; r += 1) offset += table.child(r).nodeSize;
  offset += 1; // entrée dans la ligne
  for (let c = 0; c < col; c += 1) offset += rowNode.child(c).nodeSize;

  // +1 cellule, +1 paragraphe
  return offset + 2;
}

/* --- Opérations ciblées : agir à un endroit précis, pas seulement à la fin --- */

/** Insère une ligne à l'index donné (0 = avant la première). */
export function insertRowAt(index: number): Command {
  return (state, dispatch) => {
    const info = tableInfo(state);
    const rowType = nodes['table_row'];
    const cellType = nodes['table_cell'];
    if (!info || !rowType || !cellType) return false;

    const table = state.doc.nodeAt(info.pos);
    if (!table) return false;

    const at = Math.max(0, Math.min(info.rows, index));
    const cells: PMNode[] = [];
    for (let c = 0; c < info.cols; c += 1) cells.push(cellType.createAndFill()!);

    let offset = info.pos + 1;
    for (let r = 0; r < at; r += 1) offset += table.child(r).nodeSize;

    if (!dispatch) return true;
    let tr = state.tr.insert(offset, rowType.create(null, cells));

    // Le curseur suit la ligne créée : on l'a demandée pour la remplir.
    const cellPos = cellPositionAt(tr.doc, info.pos, at, 0);
    if (cellPos !== null) tr = tr.setSelection(TextSelection.create(tr.doc, cellPos));

    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function deleteRowAt(index: number): Command {
  return (state, dispatch) => {
    const info = tableInfo(state);
    if (!info) return false;
    // Supprimer la dernière ligne reviendrait à supprimer le tableau : on exige
    // que ce geste soit explicite.
    if (info.rows <= 1) return false;

    const table = state.doc.nodeAt(info.pos);
    if (!table || index < 0 || index >= info.rows) return false;

    let offset = info.pos + 1;
    for (let r = 0; r < index; r += 1) offset += table.child(r).nodeSize;

    if (!dispatch) return true;
    let tr = state.tr.delete(offset, offset + table.child(index).nodeSize);

    const fallbackRow = Math.min(index, info.rows - 2);
    const cellPos = cellPositionAt(tr.doc, info.pos, fallbackRow, 0);
    if (cellPos !== null) tr = tr.setSelection(TextSelection.create(tr.doc, cellPos));

    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Insère une colonne à l'index donné, dans toutes les lignes. */
export function insertColumnAt(index: number): Command {
  return (state, dispatch) => {
    const info = tableInfo(state);
    const cellType = nodes['table_cell'];
    const headerType = nodes['table_header'];
    if (!info || !cellType) return false;

    const table = state.doc.nodeAt(info.pos);
    if (!table) return false;

    const at = Math.max(0, Math.min(info.cols, index));
    if (!dispatch) return true;

    let tr = state.tr;

    // De la dernière ligne vers la première : insérer par le début décalerait
    // les positions calculées pour les lignes suivantes.
    for (let r = info.rows - 1; r >= 0; r -= 1) {
      const row = table.child(r);
      const type = r === 0 && info.headerRow && headerType ? headerType : cellType;

      let offset = info.pos + 1;
      for (let i = 0; i < r; i += 1) offset += table.child(i).nodeSize;
      offset += 1;
      for (let c = 0; c < Math.min(at, row.childCount); c += 1) offset += row.child(c).nodeSize;

      tr = tr.insert(offset, type.createAndFill()!);
    }

    const cellPos = cellPositionAt(tr.doc, info.pos, 0, at);
    if (cellPos !== null) tr = tr.setSelection(TextSelection.create(tr.doc, cellPos));

    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function deleteColumnAt(index: number): Command {
  return (state, dispatch) => {
    const info = tableInfo(state);
    if (!info || info.cols <= 1) return false;

    const table = state.doc.nodeAt(info.pos);
    if (!table || index < 0 || index >= info.cols) return false;

    if (!dispatch) return true;
    let tr = state.tr;

    for (let r = info.rows - 1; r >= 0; r -= 1) {
      const row = table.child(r);
      if (index >= row.childCount) continue;

      let offset = info.pos + 1;
      for (let i = 0; i < r; i += 1) offset += table.child(i).nodeSize;
      offset += 1;
      for (let c = 0; c < index; c += 1) offset += row.child(c).nodeSize;

      tr = tr.delete(offset, offset + row.child(index).nodeSize);
    }

    const fallbackCol = Math.min(index, info.cols - 2);
    const cellPos = cellPositionAt(tr.doc, info.pos, 0, fallbackCol);
    if (cellPos !== null) tr = tr.setSelection(TextSelection.create(tr.doc, cellPos));

    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function deleteTable(): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodes['table']) {
        const pos = $from.before(d);
        const node = $from.node(d);
        if (dispatch) {
          dispatch(state.tr.delete(pos, pos + node.nodeSize).scrollIntoView());
        }
        return true;
      }
    }
    return false;
  };
}

export function addTableRow(after = true): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    let rowDepth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodes['table_row']) {
        rowDepth = d;
        break;
      }
    }
    if (rowDepth === -1) return false;
    const rowNode = $from.node(rowDepth);
    const cellCount = rowNode.childCount;
    const newCells: PMNode[] = [];
    for (let i = 0; i < cellCount; i++) {
      newCells.push(nodes['table_cell']!.createAndFill()!);
    }
    const newRow = nodes['table_row']!.create(null, newCells);
    const insertPos = after ? $from.after(rowDepth) : $from.before(rowDepth);
    if (dispatch) {
      dispatch(state.tr.insert(insertPos, newRow).scrollIntoView());
    }
    return true;
  };
}

export function deleteTableRow(): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    let rowDepth = -1;
    let tableDepth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === nodes['table_row']) rowDepth = d;
      if ($from.node(d).type === nodes['table']) tableDepth = d;
    }
    if (rowDepth === -1 || tableDepth === -1) return false;
    const table = $from.node(tableDepth);
    if (table.childCount <= 1) {
      return deleteTable()(state, dispatch);
    }
    const start = $from.before(rowDepth);
    const end = $from.after(rowDepth);
    if (dispatch) {
      dispatch(state.tr.delete(start, end).scrollIntoView());
    }
    return true;
  };
}

export function insertFootnote(text: string): Command {
  return (state, dispatch) => {
    if (!nodes['footnote']) return false;
    let maxIdx = 0;
    state.doc.descendants((node) => {
      if (node.type === nodes['footnote']) {
        maxIdx = Math.max(maxIdx, Number(node.attrs['index'] ?? 0));
      }
    });
    const id = `fn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const footnoteNode = nodes['footnote'].create({
      id,
      index: maxIdx + 1,
      text,
    });
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(footnoteNode).scrollIntoView());
    }
    return true;
  };
}

export const insertPageNumber: Command = (state, dispatch) => {
  if (!nodes['page_number']) return false;
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(nodes['page_number'].create()).scrollIntoView());
  }
  return true;
};

export interface FormattingState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  blockType: 'paragraph' | 'heading';
  headingLevel: number | null;
  alignment: Alignment;
  lineHeight: number;
  indent: number;
  fontFamily: string | null;
  fontSize: number | null;
  textColor: string | null;
  highlight: string | null;
  linkHref: string | null;
  listKind: ListKind | null;
  inTable: boolean;
}

export function readFormattingState(state: EditorState): FormattingState {
  const { $from, empty, from, to } = state.selection;
  const marks = empty ? (state.storedMarks ?? $from.marks()) : null;

  const hasMark = (name: string): boolean => {
    const type = markTypes[name];
    if (!type) return false;
    return marks ? Boolean(type.isInSet(marks)) : state.doc.rangeHasMark(from, to, type);
  };

  const parent = firstBlockInRange(state) ?? $from.parent;
  const isHeading = parent.type === nodes['heading'];

  return {
    bold: hasMark('strong'),
    italic: hasMark('em'),
    underline: hasMark('underline'),
    strike: hasMark('strike'),
    blockType: isHeading ? 'heading' : 'paragraph',
    headingLevel: isHeading ? Number(parent.attrs['level']) : null,
    alignment: (parent.attrs['align'] as Alignment | null) ?? 'left',
    lineHeight: Number(parent.attrs['lineHeight'] ?? 1),
    indent: Number(parent.attrs['indent'] ?? 0),
    fontFamily: (activeMarkAttr(state, markTypes['fontFamily']!, 'family') as string | null) ?? null,
    fontSize: (activeMarkAttr(state, markTypes['fontSize']!, 'size') as number | null) ?? null,
    textColor: (activeMarkAttr(state, markTypes['textColor']!, 'color') as string | null) ?? null,
    highlight: (activeMarkAttr(state, markTypes['highlight']!, 'color') as string | null) ?? null,
    linkHref: (activeMarkAttr(state, markTypes['link']!, 'href') as string | null) ?? null,
    listKind: currentListKind(state),
    inTable: isInTable(state),
  };
}
