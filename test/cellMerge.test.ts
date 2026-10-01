// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Merging and splitting cells: `SwDoc::MergeTbl` / `SwDoc::SplitTbl` (`sw/source/core/doc/tblrwcl.cxx`).
 *
 * The invariant these tests protect is Writer's: an absorbed cell is not **deleted** but marked as covered, which keeps the grid rectangular. Cursor navigation, a later column insertion and splitting all depend on
 * this property.
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  gridColumnsOf,
  insertTableColumn,
  mergeTableCells,
  splitTableCell,
  tableColumnCount,
} from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import { isTable, type DocumentBlock, type TableNode } from '../src/domain/document/types';
import { createEditorState, mergeSelectedCells, splitCurrentCell } from '../src/domain/engine/edit';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

function tableOf(doc: { blocks: DocumentBlock[] }): TableNode {
  const block = doc.blocks.find(isTable);
  if (!block) throw new Error('aucun tableau dans le document');
  return block;
}

describe('Fusion de cellules (SwDoc::MergeTbl)', () => {
  it('fusionne un rectangle et marque les cellules absorbées comme recouvertes', () => {
    const table = createTable(3, 3);
    const doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 1,
      fromCol: 0,
      toCol: 1,
    });

    const merged = tableOf(doc);
    const master = merged.rows[0]?.cells[0];

    expect(master?.colSpan).toBe(2);
    expect(master?.rowSpan).toBe(2);
    expect(master?.covered).toBeUndefined();

    // The three neighbors in the rectangle are covered, not removed.
    expect(merged.rows[0]?.cells[1]?.covered).toBe(true);
    expect(merged.rows[1]?.cells[0]?.covered).toBe(true);
    expect(merged.rows[1]?.cells[1]?.covered).toBe(true);

    // Outside the rectangle: nothing moved.
    expect(merged.rows[0]?.cells[2]?.covered).toBeUndefined();
    expect(merged.rows[2]?.cells[0]?.covered).toBeUndefined();
  });

  it('garde la grille rectangulaire : aucune cellule n\'est retirée', () => {
    const table = createTable(3, 3);
    const doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 2,
      fromCol: 0,
      toCol: 2,
    });

    const merged = tableOf(doc);
    for (const row of merged.rows) {
      expect(row.cells).toHaveLength(3);
    }
  });

  it('concatène le contenu des cellules absorbées plutôt que de le perdre', () => {
    const table = createTable(1, 3);
    table.rows[0]!.cells[0]!.blocks = [createParagraph('un')];
    table.rows[0]!.cells[1]!.blocks = [createParagraph('deux')];
    table.rows[0]!.cells[2]!.blocks = [createParagraph('trois')];

    const doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 2,
    });

    const textes = tableOf(doc)
      .rows[0]!.cells[0]!.blocks.map((p) => p.runs.map((r) => r.text).join(''))
      .filter((t) => t.length > 0);

    expect(textes).toEqual(['un', 'deux', 'trois']);
  });

  it('ignore un rectangle réduit à une seule cellule', () => {
    const table = createTable(2, 2);
    const doc = docOf([table]);
    const after = mergeTableCells(doc, table.id, { fromRow: 1, toRow: 1, fromCol: 1, toCol: 1 });
    expect(after).toBe(doc);
  });

  it('compte les colonnes de grille, pas les cellules restantes', () => {
    const table = createTable(2, 4);
    const doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 1,
      toCol: 2,
    });

    const merged = tableOf(doc);
    expect(tableColumnCount(merged)).toBe(4);

    // `row.cells[3]` no longer occupies column 3 on the grid side... except that the covered cells are kept, which restores the alignment.
    expect(gridColumnsOf(merged.rows[0]!)).toEqual([0, 1, 2, 3]);
  });
});

describe('Scission de cellules (SwDoc::SplitTbl)', () => {
  it('rend leur autonomie aux cellules recouvertes', () => {
    const table = createTable(2, 2);
    let doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 1,
      fromCol: 0,
      toCol: 1,
    });
    expect(tableOf(doc).rows[1]?.cells[1]?.covered).toBe(true);

    doc = splitTableCell(doc, table.id, 0, 0, 'horizontal');
    const split = tableOf(doc);

    expect(split.rows[0]?.cells[0]?.colSpan).toBeUndefined();
    expect(split.rows[0]?.cells[0]?.rowSpan).toBeUndefined();
    for (const row of split.rows) {
      for (const cell of row.cells) expect(cell.covered).toBeUndefined();
    }
  });

  it('scinde une cellule simple en colonnes et partage sa largeur', () => {
    const table = createTable(1, 2);
    const largeurAvant = table.rows[0]!.cells[0]!.widthPercent!;

    const doc = splitTableCell(docOf([table]), table.id, 0, 0, 'horizontal', 2);
    const split = tableOf(doc);

    expect(split.rows[0]?.cells).toHaveLength(3);
    expect(split.rows[0]?.cells[0]?.widthPercent).toBeCloseTo(largeurAvant / 2, 5);
    expect(split.rows[0]?.cells[1]?.widthPercent).toBeCloseTo(largeurAvant / 2, 5);
  });

  it('scinde une cellule simple en lignes en intercalant des lignes neuves', () => {
    const table = createTable(2, 2);
    const doc = splitTableCell(docOf([table]), table.id, 0, 0, 'vertical', 3);
    const split = tableOf(doc);

    // Two rows added under row 0.
    expect(split.rows).toHaveLength(4);
    // The neighbors of the original row stretch downwards.
    expect(split.rows[0]?.cells[1]?.rowSpan).toBe(3);
    expect(split.rows[1]?.cells[1]?.covered).toBe(true);
  });
});

describe('Fusion depuis la sélection du curseur', () => {
  it('fusionne le rectangle couvert par le PaM', () => {
    const table = createTable(2, 2);
    const doc = docOf([table]);

    const debut = table.rows[0]!.cells[0]!.blocks[0]!.id;
    const fin = table.rows[1]!.cells[1]!.blocks[0]!.id;

    const state = {
      ...createEditorState(doc),
      selection: {
        anchor: { blockId: debut, offset: 0 },
        focus: { blockId: fin, offset: 0 },
        isCollapsed: false,
      },
    };

    const merged = tableOf(mergeSelectedCells(state).doc);
    expect(merged.rows[0]?.cells[0]?.colSpan).toBe(2);
    expect(merged.rows[0]?.cells[0]?.rowSpan).toBe(2);
  });

  it('ne fait rien quand la sélection sort du tableau', () => {
    const table = createTable(2, 2);
    const paragraphe = createParagraph('dehors');
    const doc = docOf([paragraphe, table]);

    const state = {
      ...createEditorState(doc),
      selection: {
        anchor: { blockId: paragraphe.id, offset: 0 },
        focus: { blockId: table.rows[0]!.cells[0]!.blocks[0]!.id, offset: 0 },
        isCollapsed: false,
      },
    };

    expect(mergeSelectedCells(state)).toBe(state);
  });

  it('scinde la cellule où se trouve le curseur', () => {
    const table = createTable(1, 2);
    const doc = docOf([table]);
    const state = {
      ...createEditorState(doc),
      selection: {
        anchor: { blockId: table.rows[0]!.cells[0]!.blocks[0]!.id, offset: 0 },
        focus: { blockId: table.rows[0]!.cells[0]!.blocks[0]!.id, offset: 0 },
        isCollapsed: true,
      },
    };

    expect(tableOf(splitCurrentCell(state, 'horizontal', 2).doc).rows[0]?.cells).toHaveLength(3);
  });
});

describe('Mise en page des cellules fusionnées', () => {
  it('ne mesure ni ne pose les cellules recouvertes', () => {
    const table = createTable(2, 2);
    table.rows[0]!.cells[0]!.blocks = [createParagraph('maître')];
    table.rows[0]!.cells[1]!.blocks = [
      createParagraph('', { runs: [makeRun('absorbée par la fusion')] }),
    ];

    const doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });

    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const placed = layout.pages[0]?.blocks.find((b) => b.kind === 'table');
    expect(placed?.kind).toBe('table');
    if (placed?.kind !== 'table') return;

    const cells = placed.rows[0]!.cells;
    expect(cells[0]?.covered).toBeUndefined();
    expect(cells[0]?.colSpan).toBe(2);
    expect(cells[1]?.covered).toBe(true);
    expect(cells[1]?.widthPx).toBe(0);
    expect(cells[1]?.layouts).toHaveLength(0);
  });

  it('donne à la cellule fusionnée la largeur de toutes ses colonnes', () => {
    const table = createTable(1, 4);
    // Implicit widths: the merge must add up those of the columns it covers.
    for (const cell of table.rows[0]!.cells) delete cell.widthPercent;

    const doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });

    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const placed = layout.pages[0]?.blocks.find((b) => b.kind === 'table');
    if (placed?.kind !== 'table') throw new Error('tableau non posé');

    const cells = placed.rows[0]!.cells;
    const largeurSimple = cells[2]!.widthPx;

    /*
     * The merge does add up two columns, but the equality is not a floating-point one: the column boundaries are **rounded** running totals to the pixel (`columnBoundariesPx`), so two columns that are nominally equal can
     * differ by a pixel. Requiring `2 × simpleWidth` to a thousandth would amount to requiring the opposite of what rounding guarantees.
     *
     * What must hold exactly is the **closing of the grid**: the right edge of the merge falls on the left edge of the next cell, with no gap or overlap.
     */
    expect(cells[0]!.leftPx + cells[0]!.widthPx).toBe(cells[2]!.leftPx);
    expect(cells[0]!.widthPx).toBeGreaterThanOrEqual(largeurSimple * 2 - 2);
    expect(cells[0]!.widthPx).toBeLessThanOrEqual(largeurSimple * 2 + 2);
  });

  it('aligne correctement les cellules après fusion puis scission sans trou ni débordement', () => {
    let table = createTable(3, 3);
    table.rows.forEach((ligne, r) =>
      ligne.cells.forEach((cellule, c) => {
        cellule.blocks = [createParagraph(`L${r + 1}C${c + 1}`)];
      }),
    );

    let doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });
    doc = splitTableCell(doc, table.id, 2, 2, 'horizontal', 2);

    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const placed = layout.pages[0]?.blocks.find((b) => b.kind === 'table');
    if (placed?.kind !== 'table') throw new Error('tableau non posé');

    /*
     * The grid closes on the **rounded** running total of the content width, not on its floating-point value: `columnBoundariesPx` rounds every accumulated boundary, the last one included. The gap with the text edge is
     * therefore bounded by half a pixel, and above all it does not accumulate from one column to the next, which was the defect aimed at.
     */
    const totalWidth = Math.round(layout.geometry.contentWidthPx);
    for (const row of placed.rows) {
      for (const cell of row.cells) {
        if (cell.covered) continue;
        expect(cell.leftPx + cell.widthPx).toBeLessThanOrEqual(totalWidth);
        // Integer boundaries: that is what makes the lines crisp at any zoom.
        expect(Number.isInteger(cell.leftPx)).toBe(true);
        expect(Number.isInteger(cell.widthPx)).toBe(true);
      }

      // No seam: each visible cell touches the next exactly, and the last one closes on the edge of the text area.
      const visibles = row.cells.filter((cell) => !cell.covered);
      visibles.forEach((cell, i) => {
        const suivante = visibles[i + 1];
        expect(cell.leftPx + cell.widthPx).toBe(suivante ? suivante.leftPx : totalWidth);
      });
    }

    /*
     * Row 0: the merge L1C1+L1C2 and the cell L1C3 join up.
     *
     * Each boundary is within half a pixel of its ideal position: that is exactly the guarantee of a rounded running total, and all that rounding to the pixel can promise. The check therefore targets that error bound,
     * and not a decimal equality that rounding makes unreachable; the exact join, for its part, was already verified above.
     */
    const DEMI_PIXEL = 0.5;
    const row0 = placed.rows[0]!;
    expect(row0.cells[0]?.leftPx).toBe(0);
    expect(Math.abs(row0.cells[0]!.widthPx - totalWidth * (2 / 3))).toBeLessThanOrEqual(DEMI_PIXEL);
    expect(Math.abs(row0.cells[2]!.leftPx - totalWidth * (2 / 3))).toBeLessThanOrEqual(DEMI_PIXEL);
    expect(Math.abs(row0.cells[2]!.widthPx - totalWidth * (1 / 3))).toBeLessThanOrEqual(DEMI_PIXEL);
  });

  it('survit à l\'insertion d\'une colonne après fusion', () => {
    const table = createTable(2, 2);
    let doc = mergeTableCells(docOf([table]), table.id, {
      fromRow: 0,
      toRow: 0,
      fromCol: 0,
      toCol: 1,
    });

    doc = insertTableColumn(doc, table.id, 1, 'right');
    const after = tableOf(doc);

    // Every row did gain a cell: the grid stays rectangular.
    expect(after.rows[0]?.cells).toHaveLength(3);
    expect(after.rows[1]?.cells).toHaveLength(3);
  });
});
