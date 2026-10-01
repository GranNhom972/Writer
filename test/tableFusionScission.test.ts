// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Aller-retour fusion → scission, et survie des largeurs de colonne.
 *
 * Scinder une cellule fusionnée redessinait tout le tableau. La fusion donne à
 * la maîtresse la **somme** des colonnes absorbées ; la scission lui retirait
 * son `colSpan` sans lui reprendre cette largeur. Redevenue simple aux yeux de
 * `tableColumnWidths`, elle imposait ce total à sa seule colonne, et la
 * normalisation écrasait les autres : une grille régulière 33/33/33 ressortait
 * en 60/20/20 après un simple aller-retour.
 *
 * La largeur d'une colonne traverse une fusion par les cellules **recouvertes**,
 * qui conservent la leur. C'est cet invariant que ces tests protègent.
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

/** Empreinte de structure : recouvrement et étendues, ligne par ligne. */
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

    // Les colonnes absorbées ne disparaissent pas de la grille : leur largeur
    // survit sur les cellules recouvertes.
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
