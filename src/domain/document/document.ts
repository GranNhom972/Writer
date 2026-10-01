// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Building and walking the document (OpenOffice: `SwDoc` / `SwNodes`).
 *
 * `SwNodes` is an **ordered array**: it is that order, not the hierarchy, that
 * defines "the next paragraph". The cells of a table themselves contain text nodes
 * (`SwTableBox` → `SwStartNode` → `SwTxtNode`), so a cursor crosses a table with no
 * special case. We reproduce this property with a flat index of all the paragraphs,
 * cells included.
 */

import { A4_PORTRAIT } from './pageSetup';
import { hasCaption, imageKey, isImageRun } from './images';
import { makeRun, runsText } from './runs';
import {
  isParagraph,
  isTable,
  isToc,
  type DocumentBlock,
  type DocumentDefaults,
  type HeadingLevel,
  type ParagraphNode,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
  type WriterDocumentState,
} from './types';

let idCounter = 0;

/** Unique id of a node. Equivalent to Writer's stable `SwNodeIndex`. */
export function newId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Resets the counter to zero. Reserved for tests, to get stable ids. */
export function resetIdCounter(): void {
  idCounter = 0;
}

export const DEFAULT_DEFAULTS: DocumentDefaults = {
  fontFamily: 'Liberation Serif, Georgia, Times New Roman, serif',
  fontSizePt: 12,
  lineSpacing: 1.15,
  color: '#16191d',
};

export interface ParagraphOptions {
  id?: string;
  headingLevel?: HeadingLevel;
  alignment?: ParagraphNode['alignment'];
  lineSpacing?: number;
  runs?: ParagraphNode['runs'];
}

/** Creates a paragraph (or a heading if `headingLevel` is given). */
export function createParagraph(text = '', options: ParagraphOptions = {}): ParagraphNode {
  const node: ParagraphNode = {
    id: options.id ?? newId('p'),
    type: options.headingLevel ? 'heading' : 'paragraph',
    runs: options.runs ?? [makeRun(text)],
  };
  if (options.headingLevel !== undefined) node.headingLevel = options.headingLevel;
  if (options.alignment !== undefined) node.alignment = options.alignment;
  if (options.lineSpacing !== undefined) node.lineSpacing = options.lineSpacing;
  return node;
}

/** Creates an empty table of `rows` × `cols`, each cell holding one paragraph. */
export function createTable(rows: number, cols: number): TableNode {
  const widthPercent = 100 / Math.max(1, cols);
  return {
    id: newId('t'),
    type: 'table',
    rows: Array.from({ length: Math.max(1, rows) }, () => ({
      id: newId('tr'),
      cells: Array.from({ length: Math.max(1, cols) }, (): TableCellNode => ({
        id: newId('tc'),
        blocks: [createParagraph('')],
        widthPercent,
      })),
    })),
  };
}

export function createEmptyDocument(title = 'Document sans titre'): WriterDocumentState {
  const now = new Date().toISOString();
  return {
    id: newId('doc'),
    meta: { title, author: '', createdAt: now, updatedAt: now },
    pageSetup: { ...A4_PORTRAIT },
    defaults: { ...DEFAULT_DEFAULTS },
    blocks: [createParagraph('')],
  };
}

/** Where a paragraph lives: directly in the document flow, or inside a cell. */
export interface ParagraphLocation {
  paragraph: ParagraphNode;
  /** Index of the top-level block. */
  blockIndex: number;
  /** Path inside the table, if the paragraph is in a cell. */
  cell?: { rowIndex: number; cellIndex: number; innerIndex: number };
}

/** Result of `paragraphIndex`, memoized per document. */
export interface ParagraphIndex {
  order: string[];
  byId: Map<string, ParagraphLocation>;
}

/**
 * Memoized index, one entry per version of the document.
 *
 * A `WeakMap` and not a `Map`: the key is the document state itself, and every
 * keystroke produces a new one. A `Map` would hold on to every state seen since the
 * document was opened, which means the complete history of the document in memory.
 * The `WeakMap` lets the garbage collector reclaim each entry as soon as nobody
 * holds the matching state; in practice only the current state and those the undo
 * stack still holds remain.
 */
const indexParDocument = new WeakMap<WriterDocumentState, ParagraphIndex>();

/**
 * Flat index of all the paragraphs, in reading order.
 *
 * Built on demand rather than maintained: the document is immutable, so a kept index
 * would be out of date at the first keystroke.
 *
 * The result is, however, **memoized on the document state**, and it is immutability
 * that makes this cache exact: as long as the `doc` object is the same, so is its
 * index, with no invalidation to write. Correctness matters here: the index is
 * rebuilt from nearly eighty call sites, several of them on the typing path
 * (`currentParagraph`, the statistics, most editing commands), where the linear cost
 * used to be paid several times per typed character and not "once per transaction".
 */
export function paragraphIndex(doc: WriterDocumentState): ParagraphIndex {
  const memoise = indexParDocument.get(doc);
  if (memoise) return memoise;

  const order: string[] = [];
  const byId = new Map<string, ParagraphLocation>();

  doc.blocks.forEach((block, blockIndex) => {
    // A table of contents does not enter the index: its lines only exist at pagination
    // time, and a cursor must not be able to land in it, as in Writer where the content
    // of a `SwTOXBase` is write-protected.
    if (isToc(block)) return;

    if (isParagraph(block)) {
      order.push(block.id);
      byId.set(block.id, { paragraph: block, blockIndex });
      return;
    }
    if (!isTable(block)) return;
    block.rows.forEach((row, rowIndex) => {
      row.cells.forEach((cell, cellIndex) => {
        cell.blocks.forEach((inner, innerIndex) => {
          order.push(inner.id);
          byId.set(inner.id, {
            paragraph: inner,
            blockIndex,
            cell: { rowIndex, cellIndex, innerIndex },
          });
        });
      });
    });
  });

  const index: ParagraphIndex = { order, byId };
  indexParDocument.set(doc, index);
  return index;
}

/**
 * Figure number of each image that uses automatic numbering.
 *
 * Derived from the document's **reading order** (table cells included, since
 * `paragraphIndex` puts them there) and recomputed on every call. That is what makes
 * the numbering right by construction: adding, deleting or moving an image changes
 * the order, so the numbers, without any code having to renumber anything. No
 * duplicate is possible, since a single counter hands out the values.
 *
 * Images in **manual** mode do not use up a number: they are outside the sequence,
 * like a `SwSetExpField` that has been taken out of its series.
 *
 * The key is `blockId:offset`, the identity of an image in an immutable document,
 * valid for the duration of one render, which starts from the same state.
 */
const figuresParDocument = new WeakMap<WriterDocumentState, Map<string, number>>();

/**
 * Last numbering table produced, across all documents.
 *
 * Used to **canonicalize**: a keystroke produces a new document state and therefore
 * a new table, whose content is identical in the vast majority of cases, since
 * figure numbers only change when a captioned image is inserted or removed. Returning
 * the old table when the new one equals it keeps its identity stable, and with it the
 * identity of the image context handed to the paragraphs; otherwise every keystroke
 * would defeat their memoization.
 */
let dernieresFigures: Map<string, number> | null = null;

function memesFigures(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [cle, valeur] of a) {
    if (b.get(cle) !== valeur) return false;
  }
  return true;
}

export function figureNumbering(doc: WriterDocumentState): Map<string, number> {
  const memoise = figuresParDocument.get(doc);
  if (memoise) return memoise;

  const numbers = new Map<string, number>();
  let counter = 0;

  const { order, byId } = paragraphIndex(doc);
  for (const id of order) {
    const paragraph = byId.get(id)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    for (const run of paragraph.runs) {
      if (isImageRun(run) && hasCaption(run) && run.imageCaptionManual !== true) {
        counter += 1;
        numbers.set(imageKey(id, offset), counter);
      }
      offset += run.text.length;
    }
  }

  const canonique =
    dernieresFigures && memesFigures(dernieresFigures, numbers) ? dernieresFigures : numbers;
  dernieresFigures = canonique;
  figuresParDocument.set(doc, canonique);
  return canonique;
}

export function findParagraph(
  doc: WriterDocumentState,
  blockId: string,
): ParagraphNode | null {
  return paragraphIndex(doc).byId.get(blockId)?.paragraph ?? null;
}

/** Plain text of a paragraph: the string that the cursor offsets index into. */
export function paragraphText(paragraph: ParagraphNode): string {
  return runsText(paragraph.runs);
}

/**
 * Replaces a paragraph wherever it is, including inside a cell.
 *
 * The replacement only copies the path that was touched: the neighboring blocks keep
 * their reference identity, which lets React re-render only what really changed.
 */
export function replaceParagraph(
  doc: WriterDocumentState,
  blockId: string,
  next: ParagraphNode,
): WriterDocumentState {
  let changed = false;

  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block)) {
      if (block.id !== blockId) return block;
      changed = true;
      return next;
    }
    let rowsChanged = false;
    const rows = block.rows.map((row) => {
      let cellsChanged = false;
      const cells = row.cells.map((cell) => {
        if (!cell.blocks.some((inner) => inner.id === blockId)) return cell;
        cellsChanged = true;
        return {
          ...cell,
          blocks: cell.blocks.map((inner) => (inner.id === blockId ? next : inner)),
        };
      });
      if (!cellsChanged) return row;
      rowsChanged = true;
      return { ...row, cells };
    });
    if (!rowsChanged) return block;
    changed = true;
    return { ...block, rows };
  });

  return changed ? touch({ ...doc, blocks }) : doc;
}

/** Stamps the time of the last modification (`SwDocShell::SetModified`). */
export function touch(doc: WriterDocumentState): WriterDocumentState {
  return { ...doc, meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

/** Id of the next paragraph in reading order, or `null`. */
export function nextParagraphId(
  doc: WriterDocumentState,
  blockId: string,
): string | null {
  const { order } = paragraphIndex(doc);
  const at = order.indexOf(blockId);
  return at >= 0 && at + 1 < order.length ? order[at + 1]! : null;
}

export function previousParagraphId(
  doc: WriterDocumentState,
  blockId: string,
): string | null {
  const { order } = paragraphIndex(doc);
  const at = order.indexOf(blockId);
  return at > 0 ? order[at - 1]! : null;
}

/* ------------------------------------------------- structural changes */

/**
 * Container of a paragraph: the document flow, or a cell.
 *
 * Writer forbids merging two text nodes separated by a table boundary
 * (`SwNodes::_MoveNodes` refuses to cross a `SwStartNode`). The container key is used
 * for exactly that: two paragraphs from different containers never join.
 */
export const ROOT_CONTAINER = 'root';

export function containerKeyOf(doc: WriterDocumentState, blockId: string): string | null {
  const location = paragraphIndex(doc).byId.get(blockId);
  if (!location) return null;
  if (!location.cell) return ROOT_CONTAINER;
  const block = doc.blocks[location.blockIndex];
  if (!block || !isTable(block)) return ROOT_CONTAINER;
  return block.rows[location.cell.rowIndex]?.cells[location.cell.cellIndex]?.id ?? ROOT_CONTAINER;
}

/**
 * Removes blocks from the document, by id.
 *
 * Accepts paragraphs as well as tables: a selection that spans a table takes it away
 * with it, as in Writer, since leaving behind a table emptied of its text would match
 * no intention.
 *
 * A container cannot stay empty: Writer always keeps a `SwTxtNode` in a cell and in
 * the body, otherwise the cursor would have nowhere to land. So an empty paragraph is
 * put back when needed.
 */
export function removeBlocks(
  doc: WriterDocumentState,
  ids: ReadonlySet<string>,
): WriterDocumentState {
  if (ids.size === 0) return doc;

  const blocks: DocumentBlock[] = [];
  for (const block of doc.blocks) {
    if (!isTable(block)) {
      if (!ids.has(block.id)) blocks.push(block);
      continue;
    }
    if (ids.has(block.id)) continue;
    blocks.push({
      ...block,
      rows: block.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => {
          const kept = cell.blocks.filter((inner) => !ids.has(inner.id));
          return { ...cell, blocks: kept.length > 0 ? kept : [createParagraph('')] };
        }),
      })),
    });
  }

  if (!blocks.some((block) => !isTable(block))) blocks.push(createParagraph(''));
  return touch({ ...doc, blocks });
}

/** Inserts a paragraph right after another one, in the same container. */
export function insertParagraphAfter(
  doc: WriterDocumentState,
  afterId: string,
  node: ParagraphNode,
): WriterDocumentState {
  const location = paragraphIndex(doc).byId.get(afterId);
  if (!location) return doc;

  if (!location.cell) {
    const blocks = [...doc.blocks];
    blocks.splice(location.blockIndex + 1, 0, node);
    return touch({ ...doc, blocks });
  }

  const { rowIndex, cellIndex, innerIndex } = location.cell;
  const blocks = doc.blocks.map((block, index) => {
    if (index !== location.blockIndex || !isTable(block)) return block;
    return {
      ...block,
      rows: block.rows.map((row, r) => {
        if (r !== rowIndex) return row;
        return {
          ...row,
          cells: row.cells.map((cell, c) => {
            if (c !== cellIndex) return cell;
            const inner = [...cell.blocks];
            inner.splice(innerIndex + 1, 0, node);
            return { ...cell, blocks: inner };
          }),
        };
      }),
    };
  });

  return touch({ ...doc, blocks });
}

/** Inserts a top-level block (table, paragraph) after a paragraph. */
export function insertBlockAfter(
  doc: WriterDocumentState,
  afterId: string,
  block: DocumentBlock,
): WriterDocumentState {
  const location = paragraphIndex(doc).byId.get(afterId);
  // A table is not nested inside a cell here: Writer allows it, but nested layout is not
  // handled (see the README).
  const at = location && !location.cell ? location.blockIndex + 1 : doc.blocks.length;
  const blocks = [...doc.blocks];
  blocks.splice(at, 0, block);
  return touch({ ...doc, blocks });
}

/**
 * Inserts a row in a table, above or below `rowIndex`. (OpenOffice:
 * `SwDoc::InsertRow`.)
 */
export function insertTableRow(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
  position: 'above' | 'below',
): WriterDocumentState {
  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;
    const targetRow = block.rows[rowIndex] ?? block.rows[0];
    if (!targetRow) return block;

    // The widths come from the **grid**, not from the model row: that row may carry a
    // merge, in which case its `widthPercent` values count for two columns on one cell
    // and for nothing on the other. The new row, on the other hand, is plain, and its
    // edges must fall on those of the neighboring rows.
    const columns = tableColumnWidths(block);
    const newCells: TableCellNode[] = targetRow.cells.map((cell, index) => ({
      id: newId('tc'),
      blocks: [createParagraph('')],
      widthPercent: columns[index] ?? 100 / Math.max(1, targetRow.cells.length),
      ...(cell.paddingPt !== undefined ? { paddingPt: cell.paddingPt } : {}),
      ...(cell.borderColor !== undefined ? { borderColor: cell.borderColor } : {}),
    }));

    const newRow: TableRowNode = {
      id: newId('tr'),
      cells: newCells,
    };

    const insertIndex = position === 'above' ? Math.max(0, rowIndex) : rowIndex + 1;
    const rows = [...block.rows];
    rows.splice(insertIndex, 0, newRow);
    return { ...block, rows };
  });

  return touch({ ...doc, blocks });
}

/**
 * Deletes a row of a table. (OpenOffice: `SwDoc::DeleteRow`.)
 */
export function deleteTableRow(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
): WriterDocumentState {
  let tableRemoved = false;
  const blocks: DocumentBlock[] = [];

  for (const block of doc.blocks) {
    if (!isTable(block) || block.id !== tableId) {
      blocks.push(block);
      continue;
    }
    if (block.rows.length <= 1) {
      tableRemoved = true;
      continue;
    }
    const rows = block.rows.filter((_, idx) => idx !== rowIndex);
    blocks.push({ ...block, rows });
  }

  if (tableRemoved && !blocks.some((b) => !isTable(b))) {
    blocks.push(createParagraph(''));
  }

  return touch({ ...doc, blocks });
}

/**
 * Inserts a column in a table, to the left or right of `colIndex`. (OpenOffice:
 * `SwDoc::InsertCol`.)
 */
export function insertTableColumn(
  doc: WriterDocumentState,
  tableId: string,
  colIndex: number,
  position: 'left' | 'right',
): WriterDocumentState {
  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;
    if (block.rows.length === 0) return block;

    const oldCols = Math.max(1, block.rows[0]?.cells.length ?? 1);
    const newCols = oldCols + 1;

    // The new column takes the share of an average column, and the existing ones shrink
    // **proportionally** to make room for it. Resetting them all to `100 / newCols` would
    // wipe out the widths of an imported document as well as those set with the mouse:
    // adding a column must not flatten the grid.
    const share = 100 / newCols;
    const shrink = (100 - share) / 100;

    const rows = block.rows.map((row) => {
      const insertAt = position === 'left' ? Math.max(0, colIndex) : colIndex + 1;
      const fallback = 100 / Math.max(1, row.cells.length);
      const newCell: TableCellNode = {
        id: newId('tc'),
        blocks: [createParagraph('')],
        widthPercent: share,
      };
      const cells: TableCellNode[] = row.cells.map((c) => ({
        ...c,
        widthPercent: (c.widthPercent ?? fallback) * shrink,
      }));
      cells.splice(insertAt, 0, newCell);
      return { ...row, cells };
    });

    return { ...block, rows };
  });

  return touch({ ...doc, blocks });
}

/**
 * Deletes a column of a table. (OpenOffice: `SwDoc::DeleteCol`.)
 */
export function deleteTableColumn(
  doc: WriterDocumentState,
  tableId: string,
  colIndex: number,
): WriterDocumentState {
  let tableRemoved = false;
  const blocks: DocumentBlock[] = [];

  for (const block of doc.blocks) {
    if (!isTable(block) || block.id !== tableId) {
      blocks.push(block);
      continue;
    }
    const firstRow = block.rows[0];
    if (!firstRow || firstRow.cells.length <= 1) {
      tableRemoved = true;
      continue;
    }

    const rows = block.rows.map((row) => {
      const fallback = 100 / Math.max(1, row.cells.length);
      const cells = row.cells.filter((_, idx) => idx !== colIndex);
      // The width that is freed is redistributed **proportionally** over the columns that
      // remain, rather than equalizing them: deleting a narrow column must not undo the
      // layout of the others.
      const total = cells.reduce((sum, c) => sum + (c.widthPercent ?? fallback), 0);
      const scale = total > 0 ? 100 / total : 1;
      return {
        ...row,
        cells: cells.map((c) => ({ ...c, widthPercent: (c.widthPercent ?? fallback) * scale })),
      };
    });

    blocks.push({ ...block, rows });
  }

  if (tableRemoved && !blocks.some((b) => !isTable(b))) {
    blocks.push(createParagraph(''));
  }

  return touch({ ...doc, blocks });
}

/* ------------------------------------------------- merging and splitting cells */

/**
 * A rectangle of cells, expressed as row and column indices.
 *
 * Columns are counted as **grid columns** and not as positions in `row.cells`: the two
 * differ as soon as a merge has happened, and mixing them up is the classic source of
 * errors in any table code.
 */
export interface CellRect {
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
}

/**
 * Grid column where each cell of a row begins.
 *
 * ## The grid invariant, and why it holds
 *
 * A merge **keeps** the absorbed cells, as carriers of the `covered` flag (see
 * `mergeTableCells`, a transposition of `SwDoc::MergeTbl`). Every cell of the table,
 * covered or not, therefore occupies exactly one grid column, and `row.cells[i]` is
 * column `i`.
 *
 * `colSpan` is then only used for the painted **width**, never for grid arithmetic.
 * Counting `colSpan` here would double every merged column: once for the master and
 * once for its carrier.
 *
 * The function exists in spite of its simplicity because it is the only place where
 * this invariant is stated: any table code that needs a column goes through it, and
 * reads the invariant at the same time.
 */
export function gridColumnsOf(row: TableRowNode): number[] {
  return row.cells.map((_, index) => index);
}

/** Number of grid columns of the table: that of its widest row. */
export function tableColumnCount(table: TableNode): number {
  let max = 0;
  for (const row of table.rows) max = Math.max(max, row.cells.length);
  return max;
}

/**
 * Width of each **grid column**, as a percentage, normalized to 100.
 *
 * A width is carried by the cells but belongs to the column: in Writer,
 * `SwTable::GetTabCols` is the authority, not the individual box. Merged cells say
 * nothing useful about it (a master with `colSpan` 2 measures two columns, a covered
 * one measures none), so only plain cells report their column, and the rest falls back
 * on an equal share. The final normalization guarantees the invariant the rendering
 * depends on: the columns add up to the table's width, never 97 % or 103 %.
 */
export function tableColumnWidths(table: TableNode): number[] {
  const count = Math.max(1, tableColumnCount(table));
  const even = 100 / count;
  const widths = new Array<number>(count).fill(NaN);

  for (const row of table.rows) {
    row.cells.forEach((cell, index) => {
      if (index >= count) return;
      // A merge master measures several columns: its width says nothing about its own
      // column. A **covered** cell, however, kept the width of its column at the time of the
      // merge. That is how widths survive a `MergeTbl`, and so how a split can give them
      // back.
      if ((cell.colSpan ?? 1) > 1) return;
      if (cell.widthPercent === undefined) return;
      if (!Number.isNaN(widths[index]!)) return;
      widths[index] = cell.widthPercent;
    });
  }

  const resolved = widths.map((w) => (Number.isNaN(w) || w <= 0 ? even : w));
  const total = resolved.reduce((sum, w) => sum + w, 0);
  return total > 0 ? resolved.map((w) => (w * 100) / total) : resolved;
}

/**
 * Rewrites the column widths of a table (`SwTable::SetTabCols`).
 *
 * A merged cell receives the **sum** of the columns it covers: this keeps its edges
 * aligned with those of the neighboring rows when the user drags a handle.
 */
export function setTableColumnWidths(
  doc: WriterDocumentState,
  tableId: string,
  widths: number[],
): WriterDocumentState {
  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;

    const total = widths.reduce((sum, w) => sum + w, 0);
    if (total <= 0) return block;
    const normalized = widths.map((w) => (Math.max(0, w) * 100) / total);

    const rows = block.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell, index) => {
        const span = Math.max(1, cell.colSpan ?? 1);
        let width = 0;
        for (let i = index; i < index + span; i += 1) width += normalized[i] ?? 0;
        return { ...cell, widthPercent: width };
      }),
    }));

    return { ...block, rows };
  });

  return touch({ ...doc, blocks });
}

/** Deletes a whole table, replacing it with a paragraph if it was the only block. */
export function deleteTable(doc: WriterDocumentState, tableId: string): WriterDocumentState {
  const blocks = doc.blocks.filter((block) => !(isTable(block) && block.id === tableId));
  if (blocks.length === doc.blocks.length) return doc;
  // A document with no text node at all has nowhere to put a cursor: `SwDoc` always
  // keeps at least one `SwTxtNode`, and so do we.
  if (!blocks.some((block) => !isTable(block))) blocks.push(createParagraph(''));
  return touch({ ...doc, blocks });
}

/**
 * Index in `row.cells` of the cell that occupies a given grid column.
 *
 * It is the identity, because of the invariant in `gridColumnsOf`. The function names
 * the intent instead of leaving a bare `row.cells[column]` with nothing to say why it
 * is correct.
 */
function cellIndexAtColumn(row: TableRowNode, column: number): number {
  return column >= 0 && column < row.cells.length ? column : -1;
}

/**
 * Merges a rectangle of cells. (OpenOffice: `SwDoc::MergeTbl`,
 * `sw/source/core/doc/tblrwcl.cxx`.)
 *
 * Writer does not **delete** the absorbed cells: it marks them "covered" (a
 * `SwTableBox` with a negative `RowSpan`, swtable.hxx:475) and keeps them in their
 * row. The grid therefore stays rectangular, which cursor navigation, a later column
 * insertion and splitting all depend on. We transpose that choice with the `covered`
 * flag.
 *
 * The content of the absorbed cells is **concatenated** into the master cell, as
 * `SwDoc::MergeTbl` does: merging must never lose text.
 */
export function mergeTableCells(
  doc: WriterDocumentState,
  tableId: string,
  rect: CellRect,
): WriterDocumentState {
  const fromRow = Math.max(0, Math.min(rect.fromRow, rect.toRow));
  const toRow = Math.max(rect.fromRow, rect.toRow);
  const fromCol = Math.max(0, Math.min(rect.fromCol, rect.toCol));
  const toCol = Math.max(rect.fromCol, rect.toCol);

  // A rectangle of a single cell has nothing to merge.
  if (fromRow === toRow && fromCol === toCol) return doc;

  let changed = false;

  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;
    if (fromRow >= block.rows.length) return block;

    const lastRow = Math.min(toRow, block.rows.length - 1);
    const masterRow = block.rows[fromRow];
    if (!masterRow) return block;

    const masterIndex = cellIndexAtColumn(masterRow, fromCol);
    if (masterIndex < 0) return block;

    /*
     * Width of the master cell: the **sum** of the absorbed columns.
     *
     * `colSpan` is not enough. The engine reads `widthPercent` first (`measureRow`), and
     * the master kept its own: merging three columns produced a frame one column wide,
     * and the freed area stayed gaping to its right. This is also the convention that
     * `setTableColumnWidths` applies when a handle is dragged, so both paths must write the
     * same thing.
     */
    const columns = tableColumnWidths(block);
    let mergedWidth = 0;
    for (let c = fromCol; c <= toCol; c += 1) mergedWidth += columns[c] ?? 0;

    // Absorbed content, in reading order: row by row, column by column. Empty paragraphs
    // are dropped: merging six empty cells must not produce six blank lines.
    const absorbed: ParagraphNode[] = [];
    for (let r = fromRow; r <= lastRow; r += 1) {
      const row = block.rows[r];
      if (!row) continue;
      const starts = gridColumnsOf(row);
      row.cells.forEach((cell, index) => {
        const start = starts[index] ?? 0;
        if (start < fromCol || start > toCol) return;
        if (r === fromRow && index === masterIndex) return;
        if (cell.covered) return;
        for (const paragraph of cell.blocks) {
          if (runsText(paragraph.runs).trim().length > 0) absorbed.push(paragraph);
        }
      });
    }

    const rows = block.rows.map((row, r) => {
      if (r < fromRow || r > lastRow) return row;
      const starts = gridColumnsOf(row);

      const cells = row.cells.map((cell, index) => {
        const start = starts[index] ?? 0;
        if (start < fromCol || start > toCol) return cell;

        if (r === fromRow && index === masterIndex) {
          changed = true;
          const merged: TableCellNode = {
            ...cell,
            colSpan: toCol - fromCol + 1,
            rowSpan: lastRow - fromRow + 1,
            widthPercent: mergedWidth,
            blocks: [...cell.blocks, ...absorbed],
          };
          delete merged.covered;
          return merged;
        }

        changed = true;
        // The covered cell keeps its identity and an empty paragraph: the cursor will no longer
        // go there, but a later split finds it again.
        const covered: TableCellNode = {
          ...cell,
          covered: true,
          blocks: [createParagraph('')],
        };
        delete covered.colSpan;
        delete covered.rowSpan;
        return covered;
      });

      return { ...row, cells };
    });

    return { ...block, rows };
  });

  return changed ? touch({ ...doc, blocks }) : doc;
}

/**
 * Splits a merged cell, or a plain cell, into `count` parts. (OpenOffice:
 * `SwDoc::SplitTbl`, `tblrwcl.cxx`.)
 *
 * Splitting a **merged** cell amounts to giving the covered cells their independence
 * back: no cell is created, the flag is simply removed. Splitting a **plain** cell
 * needs new ones.
 *
 * The content stays in the first part, as in Writer: spreading it would mean guessing
 * where the user wanted to cut.
 */
export function splitTableCell(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
  cellIndex: number,
  direction: 'horizontal' | 'vertical',
  count = 2,
): WriterDocumentState {
  const parts = Math.max(2, Math.floor(count));
  let changed = false;

  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;

    const row = block.rows[rowIndex];
    const cell = row?.cells[cellIndex];
    if (!row || !cell) return block;

    const colSpan = Math.max(1, cell.colSpan ?? 1);
    const rowSpan = Math.max(1, cell.rowSpan ?? 1);
    const isMerged = colSpan > 1 || rowSpan > 1;

    if (isMerged) {
      changed = true;
      const startColumn = gridColumnsOf(row)[cellIndex] ?? 0;
      const endColumn = startColumn + colSpan - 1;
      const lastRow = Math.min(rowIndex + rowSpan - 1, block.rows.length - 1);

      /*
       * Give the master the width of **its own** column back, not that of all the columns it
       * used to cover.
       *
       * The merge gave it the sum of the absorbed columns; without this restoration it kept
       * that total after the split. Having become plain again in the eyes of
       * `tableColumnWidths`, it then imposed its width on its single column, and the
       * normalization crushed all the others: splitting a cell merged over three columns
       * turned a regular grid into 60 / 20 / 20. A local operation must not redraw the whole
       * table.
       */
      const columns = tableColumnWidths(block);

      const rows = block.rows.map((current, r) => {
        if (r < rowIndex || r > lastRow) return current;
        const starts = gridColumnsOf(current);
        const cells = current.cells.map((candidate, index) => {
          const start = starts[index] ?? 0;

          if (r === rowIndex && index === cellIndex) {
            const restored: TableCellNode = { ...candidate };
            delete restored.colSpan;
            delete restored.rowSpan;
            const own = columns[start];
            if (own !== undefined) restored.widthPercent = own;
            return restored;
          }

          if (start < startColumn || start > endColumn) return candidate;
          if (!candidate.covered) return candidate;
          const freed: TableCellNode = { ...candidate };
          delete freed.covered;
          const own = columns[start];
          if (own !== undefined) freed.widthPercent = own;
          return freed;
        });
        return { ...current, cells };
      });

      return { ...block, rows };
    }

    changed = true;

    if (direction === 'horizontal') {
      // Vertical split of the cell: its width is shared among the parts, and the other
      // columns do not move.
      const shareWidth = (cell.widthPercent ?? 100 / Math.max(1, row.cells.length)) / parts;
      const rows = block.rows.map((current, r) => {
        if (r !== rowIndex) {
          // The other rows gain as many columns as the split creates. They get **covered
          // carriers** and not an extended `colSpan`: without them `row.cells[i]` would stop being
          // column `i`, and the whole grid calculation would collapse (see `gridColumnsOf`).
          const target = current.cells[cellIndex];
          if (!target) return current;

          const porteuses: TableCellNode[] = Array.from({ length: parts - 1 }, () => ({
            id: newId('tc'),
            blocks: [createParagraph('')],
            covered: true,
          }));

          const cells = current.cells.map((candidate, index) =>
            index === cellIndex
              ? { ...candidate, colSpan: Math.max(1, candidate.colSpan ?? 1) + parts - 1 }
              : candidate,
          );
          cells.splice(cellIndex + 1, 0, ...porteuses);
          return { ...current, cells };
        }

        const replacements: TableCellNode[] = [{ ...cell, widthPercent: shareWidth }];
        for (let i = 1; i < parts; i += 1) {
          replacements.push({
            id: newId('tc'),
            blocks: [createParagraph('')],
            widthPercent: shareWidth,
            ...(cell.paddingPt !== undefined ? { paddingPt: cell.paddingPt } : {}),
            ...(cell.borderColor !== undefined ? { borderColor: cell.borderColor } : {}),
          });
        }

        const cells = [...current.cells];
        cells.splice(cellIndex, 1, ...replacements);
        return { ...current, cells };
      });

      return { ...block, rows };
    }

    // Horizontal split of the cell: new rows are slipped in, and all the other cells of the
    // original row stretch downwards so as not to leave holes.
    const newRows: TableRowNode[] = [];
    for (let i = 1; i < parts; i += 1) {
      newRows.push({
        id: newId('tr'),
        cells: row.cells.map((candidate, index) => {
          if (index === cellIndex) {
            return {
              id: newId('tc'),
              blocks: [createParagraph('')],
              ...(candidate.widthPercent !== undefined
                ? { widthPercent: candidate.widthPercent }
                : {}),
              ...(candidate.paddingPt !== undefined ? { paddingPt: candidate.paddingPt } : {}),
            };
          }
          return {
            id: newId('tc'),
            blocks: [createParagraph('')],
            covered: true,
            ...(candidate.widthPercent !== undefined
              ? { widthPercent: candidate.widthPercent }
              : {}),
          };
        }),
      });
    }

    const rows = block.rows.map((current, r) => {
      if (r !== rowIndex) return current;
      const cells = current.cells.map((candidate, index) =>
        index === cellIndex ? candidate : { ...candidate, rowSpan: parts },
      );
      return { ...current, cells };
    });
    rows.splice(rowIndex + 1, 0, ...newRows);

    return { ...block, rows };
  });

  return changed ? touch({ ...doc, blocks }) : doc;
}
