// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Merge → split round trip, and survival of the column widths.
 *
 * Splitting a merged cell used to redraw the whole table. The merge gives the master the **sum** of the absorbed columns; the split took away its `colSpan` without taking that width back. Having become plain again in the
 * eyes of `tableColumnWidths`, it imposed this total on its single column, and the normalization crushed the others: a regular 33/33/33 grid came out as 60/20/20 after a simple round trip.
 *
 * The width of a column crosses a merge through the **covered** cells, which keep theirs. It is this invariant that these tests protect.
 */

import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createTable,
  mergeTableCells,
  setTableColumnWidths,
  splitTableCell,
  tableColumnWidths,
  type CellRect,
} from '../src/domain/document/document';
import { isTable, type DocumentBlock, type TableNode } from '../src/domain/document/types';
import { createEditorState, tableContext } from '../src/domain/engine/edit';
import { collapsedSelection } from '../src/domain/engine/cursor';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

function tableOf(doc: { blocks: DocumentBlock[] }): TableNode {
  const block = doc.blocks.find(isTable);
  if (!block) throw new Error('aucun tableau');
  return block;
}

const widths = (doc: { blocks: DocumentBlock[] }) =>
  tableColumnWidths(tableOf(doc)).map((w) => Math.round(w * 10) / 10);

/** Structure fingerprint: coverage and spans, row by row. */
const shape = (doc: { blocks: DocumentBlock[] }) =>
  tableOf(doc)
    .rows.map((row) =>
      row.cells
        .map((c) => `${c.covered ? 'X' : '.'}${c.colSpan ?? ''}${c.rowSpan ? 'r' + c.rowSpan : ''}`)
        .join(','),
    )
    .join(' // ');

describe('Fusion puis scission', () => {
  const cases: { nom: string; rows: number; cols: number; largeurs?: number[]; rect: CellRect }[] = [
    { nom: 'trois colonnes égales', rows: 3, cols: 3, rect: { fromRow: 0, toRow: 0, fromCol: 0, toCol: 2 } },
    {
      nom: 'colonnes inégales, fusion au milieu',
      rows: 3,
      cols: 4,
      largeurs: [10, 20, 30, 40],
      rect: { fromRow: 1, toRow: 1, fromCol: 1, toCol: 2 },
    },
    { nom: 'fusion verticale', rows: 3, cols: 3, rect: { fromRow: 0, toRow: 1, fromCol: 1, toCol: 1 } },
    { nom: 'rectangle 2×2', rows: 3, cols: 3, rect: { fromRow: 0, toRow: 1, fromCol: 0, toCol: 1 } },
    {
      nom: 'tableau entier, colonnes inégales',
      rows: 2,
      cols: 2,
      largeurs: [70, 30],
      rect: { fromRow: 0, toRow: 1, fromCol: 0, toCol: 1 },
    },
  ];

  for (const { nom, rows, cols, largeurs, rect } of cases) {
    it(`rend la grille intacte — ${nom}`, () => {
      const table = createTable(rows, cols);
      const before = largeurs
        ? setTableColumnWidths(docOf([table]), table.id, largeurs)
        : docOf([table]);

      const merged = mergeTableCells(before, table.id, rect);
      const after = splitTableCell(merged, table.id, rect.fromRow, rect.fromCol, 'horizontal', 2);

      expect(widths(after), 'largeurs de colonne').toEqual(widths(before));
      expect(shape(after), 'structure de grille').toEqual(shape(before));
    });
  }

  it('conserve les largeurs pendant que la fusion tient', () => {
    const table = createTable(3, 4);
    const before = setTableColumnWidths(docOf([table]), table.id, [10, 20, 30, 40]);
    const merged = mergeTableCells(before, table.id, { fromRow: 1, toRow: 1, fromCol: 1, toCol: 2 });

    // The absorbed columns do not disappear from the grid: their width survives on the covered cells.
    expect(widths(merged)).toEqual([10, 20, 30, 40]);
  });

  it('donne à la maîtresse la somme de ses colonnes, et la lui reprend', () => {
    const table = createTable(2, 4);
    const before = setTableColumnWidths(docOf([table]), table.id, [10, 20, 30, 40]);
    const rect: CellRect = { fromRow: 0, toRow: 0, fromCol: 1, toCol: 2 };

    const merged = mergeTableCells(before, table.id, rect);
    expect(tableOf(merged).rows[0]!.cells[1]!.widthPercent).toBeCloseTo(50, 5);

    const after = splitTableCell(merged, table.id, 0, 1, 'horizontal', 2);
    expect(tableOf(after).rows[0]!.cells[1]!.widthPercent).toBeCloseTo(20, 5);
    expect(tableOf(after).rows[0]!.cells[2]!.widthPercent).toBeCloseTo(30, 5);
  });
});

describe('Contexte : cellule fusionnée', () => {
  const stateIn = (doc: { blocks: DocumentBlock[] }, row: number, cell: number) => {
    const target = tableOf(doc).rows[row]!.cells[cell]!.blocks[0]!.id;
    const state = createEditorState(doc as never);
    return { ...state, selection: collapsedSelection({ blockId: target, offset: 0 }) };
  };

  it('signale une cellule fusionnée, pour que le menu dise « séparer »', () => {
    const table = createTable(2, 3);
    const plain = docOf([table]);
    expect(tableContext(stateIn(plain, 0, 0))?.merged).toBe(false);

    const merged = mergeTableCells(plain, table.id, { fromRow: 0, toRow: 0, fromCol: 0, toCol: 1 });
    expect(tableContext(stateIn(merged, 0, 0))?.merged).toBe(true);
  });

  it('ne signale rien de fusionné après la scission', () => {
    const table = createTable(2, 3);
    const merged = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });
    const after = splitTableCell(merged, table.id, 0, 0, 'horizontal', 2);
    expect(tableContext(stateIn(after, 0, 0))?.merged).toBe(false);
  });
});
