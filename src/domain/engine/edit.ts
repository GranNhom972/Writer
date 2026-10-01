// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Atomic editing, transposed from `SwTxtNode` (`ndtxt.cxx`) and `SwEditShell`
 * (`sw/source/core/edit/`).
 *
 * Each operation follows the same sequence as Writer:
 *   1. locate the targeted node and offset;
 *   2. split or merge the formatting ranges while keeping the local style;
 *   3. put the cursor back;
 *   4. produce the matching undo action.
 *
 * The first three are here; the fourth is in `history.ts`, which wraps these operations rather
 * than instrumenting them, so an operation stays a pure function from state to state.
 */

import {
  containerKeyOf,
  createParagraph,
  deleteTable,
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
  setTableColumnWidths,
  splitTableCell,
  tableColumnCount,
  tableColumnWidths,
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
  runFormatting,
  runsLength,
  sliceRuns,
  splitRunsAt,
  type RunFormatPatch,
} from '../document/runs';
import { isImageRun } from '../document/images';
import {
  isParagraph,
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
 * The complete state of the editor.
 *
 * `pendingFormat` holds the formatting armed on a collapsed cursor: pressing `Ctrl+B` and then
 * typing must produce bold, although there is no text yet to format. Writer also keeps this state
 * outside the document (`SwEditShell::SetAttrItem` on an empty PaM writes nothing into the node).
 */
export interface EditorState {
  doc: WriterDocumentState;
  selection: DocumentSelection;
  pendingFormat: RunFormatPatch | null;
  /**
   * Review mode. (OpenOffice: `REDLINE_ON` of `IDocumentRedlineAccess`.)
   *
   * When it is on, no edit destroys anything: typing puts a `REDLINE_INSERT`, a deletion puts a
   * `REDLINE_DELETE` without removing the text. `null`, the default, gives the editor its usual
   * behavior back, which guarantees that no existing document changes behavior just because this
   * field exists.
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

/** Effective formatting to apply to the next keystroke. */
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

/* -------------------------------------------------------------- deletion */

/** Deletes the selection and collapses the cursor to its start. */
export function deleteSelection(state: EditorState): EditorState {
  const { doc, selection } = state;
  if (selection.isCollapsed) return state;

  // Review mode: nothing disappears, we sign the deletion request.
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
    // Table boundary: we empty what is selected in each node, without ever welding two containers
    // together, the same refusal as `SwNodes::_MoveNodes`.
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

  // Same container: the first node absorbs the end of the last one, and everything between them
  // disappears (`SwTxtNode::JoinNext`).
  const merged: ParagraphNode = {
    ...startNode.paragraph,
    runs: normalizeRuns([...head, ...tail]),
  };
  let next = replaceParagraph(doc, start.blockId, merged);

  const removed = new Set<string>([...between, end.blockId]);
  if (containerKeyOf(doc, start.blockId) === ROOT_CONTAINER) {
    // In the document flow, the selection can span a whole table: it is covered, so it goes; otherwise
    // an empty grid would be left in the middle of the glued text.
    for (let i = startNode.blockIndex + 1; i < endNode.blockIndex; i += 1) {
      const block = doc.blocks[i];
      if (block) removed.add(block.id);
    }
  }
  next = removeBlocks(next, removed);

  return { doc: next, selection: collapsedSelection(start), pendingFormat: null };
}

/**
 * Backspace. On a collapsed cursor at the start of a paragraph, merges with the previous one, unless
 * that one is in another container.
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

/** `Delete` key. Symmetric to `deleteBackward`. */
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

/** Inserts text, replacing the selection if there is one. */
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

  // Review mode: the typing is signed afterwards. The insertion itself does not change, which is the
  // property we want: a single way to insert text whatever the mode.
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
    // The armed formatting is consumed by the keystroke: it does not outlive it.
    pendingFormat: null,
    ...(state.review !== undefined ? { review: state.review } : {}),
  };
}

/**
 * Marks the selection as deleted without removing the text.
 *
 * Over several paragraphs, each one is marked on its part and **none is merged**: as long as the
 * revision is not accepted, the paragraph break still exists. `SwDoc::DeleteAndJoin` under
 * `REDLINE_ON` makes the same choice, and it is the only one that lets a rejection restore
 * everything.
 *
 * The cursor collapses to the **end** of the selection and not the start: the text is still there,
 * going back to its start would give the impression that nothing happened.
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
      // The text the author had just inserted themselves has really disappeared: the cursor must take that
      // into account, otherwise it would land past the end.
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
 * Splits the paragraph in two (`SwTxtNode::SplitCntntNode`, `Enter` key).
 *
 * The second node inherits the paragraph attributes of the first, except the heading: the line that
 * follows a heading is ordinary text, never a second heading. This is the next-style rule
 * (`SwTxtFmtColl::GetNextTxtFmtColl`).
 */
export function splitParagraph(state: EditorState): EditorState {
  const base = state.selection.isCollapsed ? state : deleteSelection(state);
  const position = base.selection.focus;
  const node = paragraphIndex(base.doc).byId.get(position.blockId);
  if (!node) return state;

  // `Enter` on an **empty** list item does not create a second empty item: it leaves the list, first
  // going up one level if there is one. It is the gesture that ends a list, and the only one that does
  // not require reaching for a button.
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
  // An explicit page break stays attached to the node that received it.
  delete follower.pageBreakBefore;
  // The new list item inherits the type and level, never the state of the checkbox nor a numbering
  // restart: those are properties of the item being left, not of the one being created.
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
 * Line break inside the paragraph (`Shift+Enter`, `SwBreakPortion`).
 *
 * Different from a paragraph break: the node stays single, so its alignment, its indents and its list
 * bullet stay shared by the two lines.
 */
export function insertLineBreak(state: EditorState): EditorState {
  return insertText(state, '\n');
}

/** Explicit page break (`Ctrl+Enter`): the text resumes at the top of the next page. */
export function insertBlockPageBreak(state: EditorState): EditorState {
  const position = state.selection.focus;
  const node = paragraphIndex(state.doc).byId.get(position.blockId);
  if (!node) return state;

  // A page break is set **on** a node: it is a paragraph attribute (`SvxFmtBreakItem`), not a character
  // inserted in the text.
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

/* ---------------------------------------------------------------- formatting */

/**
 * Applies a character-formatting patch.
 *
 * On a collapsed cursor nothing is written into the document: the patch is remembered and will apply
 * to the next keystroke.
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

/** Toggles a boolean attribute on the selection (`Ctrl+B`, `Ctrl+I`, ...). */
export function toggleRunFormat(
  state: EditorState,
  key: 'bold' | 'italic' | 'underline' | 'strikeThrough',
): EditorState {
  const active = activeFormatting(state)[key] === true;
  return applyRunFormat(state, { [key]: active ? null : true } as RunFormatPatch);
}

/** Removes all character formatting from the selection (Writer's `Ctrl+M`). */
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

/** Paragraph keys that a patch can touch. */
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
 * Paragraph attribute patch.
 *
 * `null` **removes** the attribute, as in `RunFormatPatch`: "align left" is not the same as "stop
 * forcing an alignment", and only the second lets a named style take over again.
 */
export type ParagraphPatch = {
  [K in ParagraphPatchKey]?: ParagraphNode[K] | null;
};

/**
 * Applies a paragraph patch to every node touched by the selection (`SwEditShell::SetAttrSet` on a
 * PaM covering several nodes).
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
 * Applies a patch to a node. A `null` value **removes** the attribute, which then goes back to the
 * document default: the `SetAttr` / `ResetAttr` distinction.
 */
function applyParagraphPatch(node: ParagraphNode, patch: ParagraphPatch): ParagraphNode {
  const updated: ParagraphNode = { ...node };
  const fields = updated as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete fields[key];
    else fields[key] = value;
  }
  // A paragraph that becomes ordinary again does not keep its heading level.
  if (updated.type !== 'heading') delete updated.headingLevel;
  return updated;
}

/** Turns the selection into a heading of the given level, or into an ordinary paragraph. */
export function setHeading(state: EditorState, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): EditorState {
  return level === 0
    ? applyParagraphFormat(state, { type: 'paragraph' })
    : applyParagraphFormat(state, { type: 'heading', headingLevel: level });
}

/* ------------------------------------------------------------------ lists */

/**
 * Turns the selection into a list of the given type, or takes it out of one.
 *
 * A list being only a paragraph attribute (`RES_PARATR_LIST_*`), the toggle moves no node: it sets or
 * removes attributes. All the touched paragraphs get the **same** list id, which makes them one
 * continuous list rather than a series of isolated items.
 */
export function toggleList(state: EditorState, kind: ListKind): EditorState {
  const { doc, selection } = state;
  const { start, end } = normalizeSelection(doc, selection);
  const index = paragraphIndex(doc);
  const startRank = index.order.indexOf(start.blockId);
  const endRank = index.order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return state;

  // Already entirely in a list of this type → we take it out.
  let toutDedans = true;
  for (let rank = startRank; rank <= endRank; rank += 1) {
    const node = index.byId.get(index.order[rank]!)?.paragraph;
    if (!node || node.listKind !== kind) {
      toutDedans = false;
      break;
    }
  }

  // Join the neighboring list rather than open a new one: turning the paragraph that follows a list
  // into a list item must continue its numbering.
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
      // A heading does not become a list item: Writer does not number a heading the way it numbers a body
      // paragraph either.
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
 * Changes the nesting level of the selected items.
 *
 * Outside a list, the command falls back on the ordinary indent: this is what `Tab` does in Writer,
 * and the user does not have to know which of the two cases they are in.
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

/** Ticks or unticks an item of a checklist. */
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

/* --------------------------------------------------------- clipboard */

/** Content extracted from a selection, ready to be pasted back without losing the formatting. */
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

/** Plain text of a selection, for the `text/plain` clipboard. */
export function selectionText(state: EditorState): string {
  return extractFragment(state)
    .paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
    .join('\n');
}

/**
 * Pastes a fragment at the current position.
 *
 * The first paragraph of the fragment **blends** into the receiving paragraph rather than creating a
 * node: pasting three words in the middle of a sentence must not cut it in two.
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

/* ---------------------------------------------------------------- selection */

/** Selects the whole document (`Ctrl+A`). */
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

/** Puts the cursor back, clamping the position to the real limits of the document. */
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

/** Extends the selection up to `focus` while keeping the anchor (`Shift` + gesture). */
export function extendSelectionTo(
  state: EditorState,
  focus: DocumentPosition,
  desiredX: number | null = null,
): EditorState {
  return setSelection(state, makeSelection(state.selection.anchor, focus, desiredX));
}

/** Is the selection empty of any content? */
export function isEmptySelection(state: EditorState): boolean {
  return (
    state.selection.isCollapsed ||
    comparePositions(state.doc, state.selection.anchor, state.selection.focus) === 0
  );
}

/** A single run carrying a text and a formatting: a utility for tests and for import. */
export function runOf(text: string, formatting: RunFormatting = {}): TextRun {
  return makeRun(text, formatting);
}

/* --------------------------------------------------- footnotes */

function toSuperscript(n: number): string {
  const digits = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
  return String(n)
    .split('')
    .map((d) => digits[Number(d)] ?? d)
    .join('');
}

/** Counts the total number of footnotes in the document. */
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
 * Inserts a footnote call at the cursor. (OpenOffice: `SwFtnFrm` /
 * `SwDoc::Insert(SwFmtFtn)`.)
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

/* ---------------------------------------------------- table operations */

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

/**
 * Everything the interface needs to know about the current table, in a single call.
 *
 * Table commands are **inert** outside a table: `insertTableRow` and the like return the state
 * unchanged. Without this selector, a menu cannot tell "nothing to do" from "nothing happened", and the
 * user clicks an active item that has no effect, the worst kind of feedback. It is what makes it
 * possible to grey out what does not apply.
 */
export function tableContext(state: EditorState): {
  tableId: string;
  rowIndex: number;
  cellIndex: number;
  rowCount: number;
  columnCount: number;
  /** Rectangle of cells when the selection covers several. */
  rect: CellRect | null;
  /**
   * Is the current cell the result of a merge?
   *
   * On a merged cell, "split" does not cut: it **gives the grid back**, by freeing the absorbed cells.
   * The two gestures have different names in the interface, and this flag is what tells them apart,
   * rather than promising a split that will not happen.
   */
  merged: boolean;
} | null {
  const loc = currentTableLocation(state);
  if (!loc) return null;
  const block = state.doc.blocks.find((candidate) => candidate.id === loc.tableId);
  if (!block || !isTable(block)) return null;
  const selected = selectedCellRect(state);
  const rect = selected && selected.tableId === loc.tableId ? selected.rect : null;
  const multiple = rect ? rect.fromRow !== rect.toRow || rect.fromCol !== rect.toCol : false;
  const cell = block.rows[loc.rowIndex]?.cells[loc.cellIndex];

  return {
    tableId: loc.tableId,
    rowIndex: loc.rowIndex,
    cellIndex: loc.cellIndex,
    rowCount: block.rows.length,
    columnCount: tableColumnCount(block),
    rect: multiple ? rect : null,
    merged: (cell?.colSpan ?? 1) > 1 || (cell?.rowSpan ?? 1) > 1,
  };
}

/**
 * First paragraph of a cell, going backwards if the targeted cell has disappeared or is covered. Used
 * to put the cursor back after a structural operation.
 */
function cellAnchorId(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
  cellIndex: number,
): string | null {
  const block = doc.blocks.find((candidate) => candidate.id === tableId);
  if (!block || !isTable(block)) return null;
  const row = block.rows[Math.min(rowIndex, block.rows.length - 1)] ?? block.rows[0];
  if (!row) return null;

  // A covered cell does not take a cursor: we go up to its master, on the left, exactly as `SwCrsrShell`
  // does when leaving a `SwTableBox` with a negative RowSpan.
  for (let i = Math.min(cellIndex, row.cells.length - 1); i >= 0; i -= 1) {
    const cell = row.cells[i];
    if (cell && !cell.covered && cell.blocks[0]) return cell.blocks[0].id;
  }
  for (const cell of row.cells) {
    if (!cell.covered && cell.blocks[0]) return cell.blocks[0].id;
  }
  return null;
}

/**
 * Puts the cursor back after a row or column deletion.
 *
 * Letting it fall on `order[0]`, the very first paragraph of the document, was the previous behavior:
 * deleting a row of a table on page 12 sent the user back to page 1 with nothing to explain it. We stay
 * in the table as long as it exists, and otherwise on the paragraph that followed it.
 */
function selectionAfterStructuralEdit(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
  cellIndex: number,
  fallbackBlockIndex: number,
): DocumentSelection {
  const inCell = cellAnchorId(doc, tableId, rowIndex, cellIndex);
  if (inCell) return collapsedSelection({ blockId: inCell, offset: 0 });

  // The table disappeared with its last row: we land on the paragraph that now takes its place, or on the
  // previous one if it was at the end.
  const index = paragraphIndex(doc);
  for (let i = fallbackBlockIndex; i < doc.blocks.length; i += 1) {
    const block = doc.blocks[i];
    if (block && isParagraph(block) && index.byId.has(block.id)) {
      return collapsedSelection({ blockId: block.id, offset: 0 });
    }
  }
  for (let i = Math.min(fallbackBlockIndex, doc.blocks.length) - 1; i >= 0; i -= 1) {
    const block = doc.blocks[i];
    if (block && isParagraph(block) && index.byId.has(block.id)) {
      return collapsedSelection({ blockId: block.id, offset: paragraphText(block).length });
    }
  }
  return collapsedSelection({ blockId: index.order[0] ?? '', offset: 0 });
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
  const blockIndex = state.doc.blocks.findIndex((block) => block.id === loc.tableId);
  const doc = deleteTableRow(state.doc, loc.tableId, loc.rowIndex);
  if (doc === state.doc) return state;
  // We aim at the row that took the place of the deleted one, so the same index; `cellAnchorId` brings it
  // back within bounds if it was the last one.
  const selection = selectionAfterStructuralEdit(
    doc,
    loc.tableId,
    loc.rowIndex,
    loc.cellIndex,
    blockIndex,
  );
  return { ...state, doc, selection };
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
  const blockIndex = state.doc.blocks.findIndex((block) => block.id === loc.tableId);
  const doc = deleteTableColumn(state.doc, loc.tableId, loc.cellIndex);
  if (doc === state.doc) return state;
  const selection = selectionAfterStructuralEdit(
    doc,
    loc.tableId,
    loc.rowIndex,
    loc.cellIndex,
    blockIndex,
  );
  return { ...state, doc, selection };
}

/** Deletes the whole current table, with the cursor put back where it was. */
export function deleteCurrentTable(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const blockIndex = state.doc.blocks.findIndex((block) => block.id === loc.tableId);
  const doc = deleteTable(state.doc, loc.tableId);
  if (doc === state.doc) return state;
  return {
    ...state,
    doc,
    selection: selectionAfterStructuralEdit(doc, loc.tableId, 0, 0, blockIndex),
  };
}

/* ------------------------------------------------- column widths */

/** Column widths of the current table, as percentages, for the interface. */
export function currentTableColumnWidths(state: EditorState): number[] | null {
  const loc = currentTableLocation(state);
  if (!loc) return null;
  const block = state.doc.blocks.find((candidate) => candidate.id === loc.tableId);
  return block && isTable(block) ? tableColumnWidths(block) : null;
}

/**
 * Moves the **boundary** between two neighboring columns, with the mouse.
 *
 * Only the two adjacent columns move, and their sum is kept: this is the behavior of
 * `SwTable::SetTabCols` in "move edge" mode, and the one the user expects, since dragging one line must
 * not make the whole grid shiver. A minimum width keeps a column from becoming unreachable with the
 * mouse.
 */
export function resizeTableColumnBoundary(
  state: EditorState,
  tableId: string,
  boundaryIndex: number,
  deltaPercent: number,
): EditorState {
  const block = state.doc.blocks.find((candidate) => candidate.id === tableId);
  if (!block || !isTable(block)) return state;

  const widths = tableColumnWidths(block);
  const left = widths[boundaryIndex];
  const right = widths[boundaryIndex + 1];
  if (left === undefined || right === undefined) return state;

  const MIN = 3;
  const pair = left + right;
  const nextLeft = Math.min(pair - MIN, Math.max(MIN, left + deltaPercent));
  if (Math.abs(nextLeft - left) < 0.001) return state;

  const next = [...widths];
  next[boundaryIndex] = nextLeft;
  next[boundaryIndex + 1] = pair - nextLeft;

  return { ...state, doc: setTableColumnWidths(state.doc, tableId, next) };
}

/** Gives the columns of the current table equal widths again. */
export function distributeTableColumns(state: EditorState): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const block = state.doc.blocks.find((candidate) => candidate.id === loc.tableId);
  if (!block || !isTable(block)) return state;
  const count = Math.max(1, tableColumnCount(block));
  const even = new Array<number>(count).fill(100 / count);
  return { ...state, doc: setTableColumnWidths(state.doc, loc.tableId, even) };
}

/* ------------------------------------------------- navigation and selection */

/**
 * Moves the cursor by one cell, in reading order (`Tab`).
 *
 * At the end of a table, `Tab` **adds a row** rather than leaving it: this is the convention of Word,
 * Google Docs and Writer, and it is how a grid is filled with the keyboard without ever touching the
 * mouse.
 */
export function moveToAdjacentCell(state: EditorState, forward: boolean): EditorState {
  const loc = currentTableLocation(state);
  if (!loc) return state;
  const block = state.doc.blocks.find((candidate) => candidate.id === loc.tableId);
  if (!block || !isTable(block)) return state;

  const flat: { rowIndex: number; cellIndex: number }[] = [];
  block.rows.forEach((row, rowIndex) =>
    row.cells.forEach((cell, cellIndex) => {
      if (!cell.covered) flat.push({ rowIndex, cellIndex });
    }),
  );

  const here = flat.findIndex((c) => c.rowIndex === loc.rowIndex && c.cellIndex === loc.cellIndex);
  if (here === -1) return state;
  const target = flat[here + (forward ? 1 : -1)];

  if (!target) {
    if (!forward) return state;
    const doc = insertTableRow(state.doc, loc.tableId, block.rows.length - 1, 'below');
    const anchor = cellAnchorId(doc, loc.tableId, block.rows.length, 0);
    return anchor ? { ...state, doc, selection: collapsedSelection({ blockId: anchor, offset: 0 }) } : state;
  }

  const cell = block.rows[target.rowIndex]?.cells[target.cellIndex];
  const paragraph = cell?.blocks[0];
  if (!paragraph) return state;

  // The content of the cell that is reached is fully selected: this is what lets you fill it by typing,
  // without having to erase it first.
  const length = paragraphText(cell.blocks[cell.blocks.length - 1]!).length;
  return {
    ...state,
    selection: makeSelection(
      { blockId: paragraph.id, offset: 0 },
      { blockId: cell.blocks[cell.blocks.length - 1]!.id, offset: length },
    ),
  };
}

/** Selects a whole row of the table (click on its handle). */
export function selectTableRow(state: EditorState, tableId: string, rowIndex: number): EditorState {
  const block = state.doc.blocks.find((candidate) => candidate.id === tableId);
  if (!block || !isTable(block)) return state;
  const row = block.rows[rowIndex];
  if (!row) return state;

  const first = row.cells.find((cell) => !cell.covered)?.blocks[0];
  const lastCell = [...row.cells].reverse().find((cell) => !cell.covered);
  const last = lastCell?.blocks[lastCell.blocks.length - 1];
  if (!first || !last) return state;

  return {
    ...state,
    selection: makeSelection(
      { blockId: first.id, offset: 0 },
      { blockId: last.id, offset: paragraphText(last).length },
    ),
  };
}

/** Selects a whole column of the table (click on its handle). */
export function selectTableColumn(
  state: EditorState,
  tableId: string,
  columnIndex: number,
): EditorState {
  const block = state.doc.blocks.find((candidate) => candidate.id === tableId);
  if (!block || !isTable(block)) return state;

  const firstCell = block.rows[0]?.cells[columnIndex];
  const lastRow = block.rows[block.rows.length - 1];
  const lastCell = lastRow?.cells[columnIndex];
  const first = firstCell?.blocks[0];
  const last = lastCell?.blocks[lastCell.blocks.length - 1];
  if (!first || !last) return state;

  return {
    ...state,
    selection: makeSelection(
      { blockId: first.id, offset: 0 },
      { blockId: last.id, offset: paragraphText(last).length },
    ),
  };
}

/** Selects all the cells of the current table. */
export function selectWholeTable(state: EditorState, tableId: string): EditorState {
  const block = state.doc.blocks.find((candidate) => candidate.id === tableId);
  if (!block || !isTable(block) || block.rows.length === 0) return state;
  const withFirst = selectTableRow(state, tableId, 0);
  const withLast = selectTableRow(state, tableId, block.rows.length - 1);
  return { ...state, selection: makeSelection(withFirst.selection.anchor, withLast.selection.focus) };
}

/* --------------------------------------- merging and splitting cells */

/**
 * Rectangle of cells covered by the current selection.
 *
 * A table selection, in Writer as here, is not a text selection: `SwCursorShell::IsTableMode` switches
 * to a start `SwCellFrm` and an end one, and the rectangle is their **smallest bounding box**. That is
 * what this function rebuilds from the two ends of the `SwPaM`.
 *
 * The computation is done in **grid columns** and not in cell indices: after a merge, `row.cells[2]` no
 * longer occupies column 2, and mixing them up would merge the wrong rectangle.
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

/** Merges the selected cells (`SwDoc::MergeTbl`). */
export function mergeSelectedCells(state: EditorState): EditorState {
  const selected = selectedCellRect(state);
  if (!selected) return state;

  const doc = mergeTableCells(state.doc, selected.tableId, selected.rect);
  if (doc === state.doc) return state;

  // The cursor lands in the master cell: the others no longer exist for navigation, and leaving it there
  // would make it unreachable.
  const master = paragraphIndex(doc);
  const block = doc.blocks.find((candidate) => candidate.id === selected.tableId);
  const cell =
    block && isTable(block)
      ? block.rows[selected.rect.fromRow]?.cells.find((candidate) => !candidate.covered)
      : undefined;
  const target = cell?.blocks[0]?.id ?? master.order[0] ?? '';

  return { ...state, doc, selection: collapsedSelection({ blockId: target, offset: 0 }) };
}

/** Splits the current cell (`SwDoc::SplitTbl`). */
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

/* -------------------------------------------------- table of contents */

/**
 * Inserts a table of contents after the current block.
 *
 * The inserted block holds **no entries**: they are derived at every pagination (see `engine/tox.ts`).
 * This is what guarantees that a table of contents cannot lie about the content of the document: it has
 * nothing to lie *with*.
 */
export function insertTableOfContents(state: EditorState, options: TocOptions = {}): EditorState {
  const toc = createToc(options);
  const doc = insertBlockAfter(state.doc, state.selection.focus.blockId, toc as DocumentBlock);
  return { ...state, doc };
}

/* --------------------------------------------- comments and bookmarks */

/** Puts a comment on the selection (`SwEditShell::InsertPostIt`). */
export function commentSelection(
  state: EditorState,
  author: string,
  text: string,
  options: { initials?: string; now?: string } = {},
): { state: EditorState; threadId: string } {
  const { start, end } = normalizeSelection(state.doc, state.selection);
  // A comment with no range has nothing to anchor: Writer refuses it too.
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

/** Puts a bookmark on the selection (`IDocumentMarkAccess::makeMark`). */
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

/* -------------------------------------------------------- review mode */

/** Turns change tracking on or off (`REDLINE_ON` / `REDLINE_NONE`). */
export function setReviewMode(state: EditorState, who: RedlineAuthor | null): EditorState {
  return { ...state, review: who };
}

/** Is change tracking on? */
export function isReviewing(state: EditorState): boolean {
  return state.review != null;
}

/* ------------------------------------------- moving an image frame */

/** Where to place a floating frame after it has been moved, in points. */
export interface FlyDropPlacement {
  xPt: number;
  yPt: number;
}

/**
 * Moves the image frame located at `offset` to `target`.
 *
 * Counterpart of `SwFEShell::SetAnchor` / `SwFEShell::EndDrag` (`sw/source/core/frmedt/fefly1.cxx`): at
 * the end of a drag, Writer does not just correct the frame's coordinates, it **changes its anchor** to
 * the paragraph where it was dropped.
 *
 * The reason is structural: it is the anchor that decides a frame's page (`SwFlyFrm::AnchorFrm`). A frame
 * dragged three pages down but still anchored to its original paragraph keeps being drawn on that
 * paragraph's page, and leaves the sheet: it follows the pointer during the gesture and then disappears
 * when released.
 *
 * `placement` is only read for a floating frame. An image "as a character" has no coordinates of its own:
 * moving it is only changing its place in the text, and the line formatter does the rest.
 */
export function moveImageRun(
  doc: WriterDocumentState,
  blockId: string,
  offset: number,
  target: DocumentPosition,
  placement: FlyDropPlacement,
): WriterDocumentState {
  const index = paragraphIndex(doc);
  const source = index.byId.get(blockId)?.paragraph;
  const destination = index.byId.get(target.blockId)?.paragraph;
  if (!source || !destination) return doc;

  const cible = imageRunIndexAt(source.runs, offset);
  if (!cible) return doc;

  const cadre = source.runs[cible.index]!;
  const formatage = runFormatting(cadre);
  const flottant = Boolean(cadre.imageAnchor && cadre.imageAnchor !== 'as-char');

  // A frame moved by hand has left its alignment: leaving it aligned would bring it back to its place at the
  // next computation, and the gesture would have done nothing.
  const place = flottant
    ? {
        imageHoriOrient: 'from-left' as const,
        imageXPt: placement.xPt,
        imageYPt: placement.yPt,
      }
    : {};

  const restantes = source.runs.filter((_, i) => i !== cible.index);
  const heritage = formattingAt(source.runs, cible.offset);

  if (target.blockId === blockId) {
    /*
     * The removal shifts what follows it.
     *
     * An offset aimed **after** the frame designates, once the frame is removed, a character further left:
     * without this correction, the image moved back one notch every time it was moved to the right within its
     * paragraph.
     */
    const vise =
      target.offset > cible.offset ? target.offset - cadre.text.length : target.offset;
    const runs = insertTextInRuns(
      normalizeRuns(restantes, heritage),
      Math.max(0, vise),
      cadre.text,
      { ...formatage, ...place },
    );
    return replaceParagraph(doc, blockId, { ...source, runs });
  }

  // Two paragraphs: we remove first, then insert. The receiving paragraph is **read again** after the
  // removal, because the one we were holding dates from before.
  const sansCadre = replaceParagraph(doc, blockId, {
    ...source,
    runs: normalizeRuns(restantes, heritage),
  });
  const arrivee = paragraphIndex(sansCadre).byId.get(target.blockId)?.paragraph;
  if (!arrivee) return doc;

  const longueur = paragraphText(arrivee).length;
  const runs = insertTextInRuns(
    arrivee.runs,
    Math.min(Math.max(0, target.offset), longueur),
    cadre.text,
    { ...formatage, ...place },
  );
  return replaceParagraph(sansCadre, target.blockId, { ...arrivee, runs });
}

/**
 * Index and start offset of the image frame that covers this offset.
 *
 * We accept the offset of the **start** of the frame as well as that of its end: the rendering announces
 * the first, and a cursor placed right after the image gives the second.
 */
function imageRunIndexAt(
  runs: readonly TextRun[],
  offset: number,
): { index: number; offset: number } | null {
  let consomme = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    const debut = consomme;
    const fin = consomme + run.text.length;
    if (isImageRun(run) && offset >= debut && offset <= fin) return { index, offset: debut };
    consomme = fin;
  }
  return null;
}
