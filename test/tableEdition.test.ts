// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Table editing from the interface: widths, cursor and navigation.
 *
 * These tests cover the gestures the user makes with the mouse and the keyboard, not the structure primitives (see `cellMerge.test.ts`). They protect against regressions, each of which had actually occurred:
 *
 *  - adding a column reset all the widths to equal, wiping those of the imported document;
 *  - deleting a row sent the cursor back to the very start of the document;
 *  - a merged cell kept the width of a single column.
 */

import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  deleteTable,
  deleteTableColumn,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  paragraphIndex,
  setTableColumnWidths,
  tableColumnWidths,
} from '../src/domain/document/document';
import { isTable, type DocumentBlock, type TableNode } from '../src/domain/document/types';
import {
  createEditorState,
  deleteCurrentTable,
  deleteCurrentTableColumn,
  deleteCurrentTableRow,
  distributeTableColumns,
  moveToAdjacentCell,
  resizeTableColumnBoundary,
  selectTableColumn,
  selectTableRow,
  selectedCellRect,
  selectWholeTable,
  tableContext,
} from '../src/domain/engine/edit';
import { collapsedSelection } from '../src/domain/engine/cursor';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

function tableOf(doc: { blocks: DocumentBlock[] }): TableNode {
  const block = doc.blocks.find(isTable);
  if (!block) throw new Error('aucun tableau dans le document');
  return block;
}

/** State with the cursor placed in a given cell. */
function stateInCell(blocks: DocumentBlock[], rowIndex: number, cellIndex: number) {
  const doc = docOf(blocks);
  const table = tableOf(doc);
  const target = table.rows[rowIndex]!.cells[cellIndex]!.blocks[0]!.id;
  const state = createEditorState(doc);
  return { ...state, selection: collapsedSelection({ blockId: target, offset: 0 }) };
}

/** Widths as the engine reads them, rounded for comparison. */
function widths(doc: { blocks: DocumentBlock[] }): number[] {
  return tableColumnWidths(tableOf(doc)).map((w) => Math.round(w * 100) / 100);
}

describe('Largeurs de colonne', () => {
  it('conserve les proportions quand on insère une colonne', () => {
    const table = createTable(2, 2);
    table.rows.forEach((row) => {
      row.cells[0]!.widthPercent = 75;
      row.cells[1]!.widthPercent = 25;
    });

    const after = insertTableColumn(docOf([table]), table.id, 1, 'right');

    // The new column takes a third; the other two keep their 3 to 1 ratio over the remaining two thirds.
    expect(widths(after)).toEqual([50, 16.67, 33.33]);
  });

  it('redistribue au prorata quand on supprime une colonne', () => {
    const table = createTable(1, 3);
    table.rows[0]!.cells[0]!.widthPercent = 50;
    table.rows[0]!.cells[1]!.widthPercent = 30;
    table.rows[0]!.cells[2]!.widthPercent = 20;

    const after = deleteTableColumn(docOf([table]), table.id, 1);

    // 50 and 20 share 100, keeping their 5 to 2 ratio.
    expect(widths(after)).toEqual([71.43, 28.57]);
  });

  it('aligne une ligne insérée sur la grille, non sur la ligne modèle', () => {
    const table = createTable(2, 3);
    const merged = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });

    // Row 0 now carries a master of two columns and a covered cell: copying its widths as they are would shift the grid.
    const after = insertTableRow(merged, table.id, 0, 'below');
    const inserted = tableOf(after).rows[1]!;

    expect(inserted.cells.map((c) => Math.round(c.widthPercent ?? 0))).toEqual([33, 33, 33]);
  });

  it('déplace une frontière sans toucher aux autres colonnes', () => {
    const table = createTable(1, 3);
    const state = stateInCell([table], 0, 0);

    const after = resizeTableColumnBoundary(state, table.id, 0, 10);

    expect(widths(after.doc)).toEqual([43.33, 23.33, 33.33]);
  });

  it('refuse de réduire une colonne sous sa largeur plancher', () => {
    const table = createTable(1, 2);
    const state = stateInCell([table], 0, 0);

    // A large gesture must not make the second column unreachable.
    const after = resizeTableColumnBoundary(state, table.id, 0, 500);

    const result = widths(after.doc);
    expect(result[1]).toBeGreaterThanOrEqual(3);
    expect(result[0]! + result[1]!).toBeCloseTo(100, 5);
  });

  it('rend des largeurs égales à la demande', () => {
    const table = createTable(1, 4);
    const uneven = setTableColumnWidths(docOf([table]), table.id, [70, 10, 10, 10]);
    const state = { ...createEditorState(uneven), selection: collapsedSelection({
      blockId: tableOf(uneven).rows[0]!.cells[0]!.blocks[0]!.id,
      offset: 0,
    }) };

    expect(widths(distributeTableColumns(state).doc)).toEqual([25, 25, 25, 25]);
  });

  it('donne à une cellule fusionnée la somme des colonnes couvertes', () => {
    const table = createTable(2, 3);
    const after = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 2,
    });

    const master = tableOf(after).rows[0]!.cells[0]!;
    // Without this the engine painted the master on a single column, and the two freed thirds stayed empty to its right.
    expect(master.widthPercent).toBeCloseTo(100, 5);
    expect(master.colSpan).toBe(3);
  });
});

describe('Curseur après une modification de structure', () => {
  it('reste dans le tableau après la suppression d’une ligne', () => {
    const table = createTable(3, 2);
    const state = stateInCell([createParagraph('avant'), table, createParagraph('après')], 1, 1);

    const after = deleteCurrentTableRow(state);
    const location = paragraphIndex(after.doc).byId.get(after.selection.focus.blockId);

    // The cursor used to fall back on `order[0]`: deleting a row on page 12 sent the user back to page 1 with no explanation.
    expect(location?.cell).toBeDefined();
    expect(location?.cell?.rowIndex).toBe(1);
    expect(after.selection.focus.blockId).not.toBe(paragraphIndex(after.doc).order[0]);
  });

  it('reste dans le tableau après la suppression d’une colonne', () => {
    const table = createTable(3, 3);
    const state = stateInCell([createParagraph('avant'), table], 2, 2);

    const after = deleteCurrentTableColumn(state);
    const location = paragraphIndex(after.doc).byId.get(after.selection.focus.blockId);

    expect(location?.cell).toBeDefined();
    expect(location?.cell?.rowIndex).toBe(2);
  });

  it('se pose sur le paragraphe suivant quand le tableau disparaît', () => {
    const table = createTable(1, 1);
    const state = stateInCell([createParagraph('avant'), table, createParagraph('après')], 0, 0);

    const after = deleteCurrentTableRow(state);

    expect(after.doc.blocks.some(isTable)).toBe(false);
    const location = paragraphIndex(after.doc).byId.get(after.selection.focus.blockId);
    expect(location?.cell).toBeUndefined();
    expect(after.doc.blocks[location!.blockIndex]).toMatchObject({ id: after.selection.focus.blockId });
  });

  it('supprime le tableau courant en entier', () => {
    const table = createTable(3, 3);
    const state = stateInCell([createParagraph('avant'), table, createParagraph('après')], 1, 1);

    const after = deleteCurrentTable(state);

    expect(after.doc.blocks.some(isTable)).toBe(false);
    expect(after.doc.blocks).toHaveLength(2);
  });

  it('garde un paragraphe quand le tableau supprimé était seul', () => {
    const table = createTable(2, 2);
    const after = deleteTable(docOf([table]), table.id);

    // `SwDoc` always keeps at least one text node: without it, no cursor could land in the document.
    expect(after.blocks).toHaveLength(1);
    expect(isTable(after.blocks[0]!)).toBe(false);
  });
});

describe('Navigation de cellule en cellule (Tab)', () => {
  it('avance dans l’ordre de lecture et passe à la ligne suivante', () => {
    const table = createTable(2, 2);
    let state = stateInCell([table], 0, 0);

    state = moveToAdjacentCell(state, true);
    expect(tableContext(state)).toMatchObject({ rowIndex: 0, cellIndex: 1 });

    state = moveToAdjacentCell(state, true);
    expect(tableContext(state)).toMatchObject({ rowIndex: 1, cellIndex: 0 });
  });

  it('revient en arrière avec Maj+Tab', () => {
    const table = createTable(2, 2);
    const state = moveToAdjacentCell(stateInCell([table], 1, 0), false);

    expect(tableContext(state)).toMatchObject({ rowIndex: 0, cellIndex: 1 });
  });

  it('ajoute une ligne quand Tab quitte la dernière cellule', () => {
    const table = createTable(2, 2);
    const state = moveToAdjacentCell(stateInCell([table], 1, 1), true);

    expect(tableOf(state.doc).rows).toHaveLength(3);
    expect(tableContext(state)).toMatchObject({ rowIndex: 2, cellIndex: 0 });
  });

  it('ne sort pas du tableau par le haut', () => {
    const table = createTable(2, 2);
    const state = stateInCell([table], 0, 0);

    expect(moveToAdjacentCell(state, false)).toBe(state);
  });

  it('saute les cellules recouvertes par une fusion', () => {
    const table = createTable(2, 3);
    const merged = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });
    const first = tableOf(merged).rows[0]!.cells[0]!.blocks[0]!.id;
    const state = {
      ...createEditorState(merged),
      selection: collapsedSelection({ blockId: first, offset: 0 }),
    };

    // Column 1 is covered: `Tab` must reach column 2.
    expect(tableContext(moveToAdjacentCell(state, true))).toMatchObject({
      rowIndex: 0,
      cellIndex: 2,
    });
  });
});

describe('Sélection de bandes', () => {
  it('sélectionne une ligne entière', () => {
    const table = createTable(3, 3);
    const state = selectTableRow(stateInCell([table], 0, 0), table.id, 1);

    expect(selectedCellRect(state)?.rect).toEqual({
      fromRow: 1,
      toRow: 1,
      fromCol: 0,
      toCol: 2,
    });
  });

  it('sélectionne une colonne entière', () => {
    const table = createTable(3, 3);
    const state = selectTableColumn(stateInCell([table], 0, 0), table.id, 2);

    expect(selectedCellRect(state)?.rect).toEqual({
      fromRow: 0,
      toRow: 2,
      fromCol: 2,
      toCol: 2,
    });
  });

  it('sélectionne le tableau entier', () => {
    const table = createTable(3, 4);
    const state = selectWholeTable(stateInCell([table], 1, 1), table.id);

    expect(selectedCellRect(state)?.rect).toEqual({
      fromRow: 0,
      toRow: 2,
      fromCol: 0,
      toCol: 3,
    });
  });
});

describe('Contexte de tableau (grisage des commandes)', () => {
  it('vaut null hors d’un tableau', () => {
    const state = createEditorState(docOf([createParagraph('texte')]));
    expect(tableContext(state)).toBeNull();
  });

  it('rapporte les dimensions et la cellule courante', () => {
    const table = createTable(4, 3);
    expect(tableContext(stateInCell([table], 2, 1))).toMatchObject({
      tableId: table.id,
      rowIndex: 2,
      cellIndex: 1,
      rowCount: 4,
      columnCount: 3,
      rect: null,
    });
  });

  it('ne signale un rectangle que si la sélection couvre plusieurs cellules', () => {
    const table = createTable(3, 3);
    const single = stateInCell([table], 1, 1);
    expect(tableContext(single)?.rect).toBeNull();

    const row = selectTableRow(single, table.id, 1);
    expect(tableContext(row)?.rect).toEqual({ fromRow: 1, toRow: 1, fromCol: 0, toCol: 2 });
  });
});
