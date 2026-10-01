// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Cursor in a table: designation by click and vertical movement.
 *
 * Two distinct regressions, both "invisible" at the model level and yet the most visible in use:
 *
 *  - the click looked for the closest **line of text**, ignoring cell edges. The text of a cell being short and left-aligned, clicking in the right half of a box put the cursor in the next box;
 *  - vertical movement followed the **document order**. Since `paragraphIndex` flattens the cells in reading order, `Down` led to the cell on the right: the arrows moved the cursor sideways.
 *
 * Both are fixed through geometry, and that is what these tests measure.
 */

import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  paragraphIndex,
} from '../src/domain/document/document';
import type { DocumentBlock } from '../src/domain/document/types';
import { moveVertical, positionFromPoint } from '../src/domain/engine/cursor';
import { paginateDocument, type PlacedTable } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';

const measurer = new MetricTextMeasurer();

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

/** A 3×3 table whose every cell carries a short text, and its document. */
function grille(before = 'avant', after = 'après') {
  const table = createTable(3, 3);
  table.rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      cell.blocks = [createParagraph(`c${r}${c}`)];
    }),
  );
  const doc = docOf([createParagraph(before), table, createParagraph(after)]);
  const layout = paginateDocument(doc, { measurer });
  return { doc, table, layout };
}

function placedTable(layout: ReturnType<typeof paginateDocument>): PlacedTable {
  const found = layout.pages[0]?.blocks.find((block) => block.kind === 'table');
  if (found?.kind !== 'table') throw new Error('tableau non posé');
  return found;
}

/** `row/column` path of a paragraph, for readable assertions. */
function cellOf(doc: ReturnType<typeof docOf>, blockId: string): string {
  const location = paragraphIndex(doc).byId.get(blockId);
  if (!location?.cell) return 'hors tableau';
  return `${location.cell.rowIndex}/${location.cell.cellIndex}`;
}

describe('Clic dans une cellule', () => {
  it('désigne la cellule cliquée, où que l’on clique dedans', () => {
    const { doc, layout } = grille();
    const placed = placedTable(layout);

    for (const row of placed.rows) {
      const top = placed.topPx + row.topPx;
      for (const cell of row.cells) {
        // Five x coordinates per cell, from the left edge to the right edge: it was the right part that tipped over to the neighbor.
        for (const part of [0.05, 0.3, 0.5, 0.75, 0.95]) {
          const x = cell.leftPx + cell.widthPx * part;
          const y = top + row.heightPx / 2;
          const position = positionFromPoint(layout, 0, x, y, measurer);

          expect(position, `clic à ${Math.round(part * 100)} % de la cellule`).not.toBeNull();
          expect(cellOf(doc, position!.blockId), `clic à ${Math.round(part * 100)} %`).toBe(
            `${row.rowIndex}/${cell.cellIndex}`,
          );
        }
      }
    }
  });

  it('ne piège pas le curseur : un clic hors du tableau reste hors du tableau', () => {
    const { doc, layout } = grille();
    const placed = placedTable(layout);

    // Well above the grid: the paragraph that precedes it.
    const above = positionFromPoint(layout, 0, 10, Math.max(0, placed.topPx - 6), measurer);
    expect(cellOf(doc, above!.blockId)).toBe('hors tableau');
  });
});

describe('Flèches Haut et Bas dans un tableau', () => {
  it('descend dans la même colonne, et non vers la cellule de droite', () => {
    const { doc, table, layout } = grille();
    const start = table.rows[0]!.cells[1]!.blocks[0]!;

    let position = { blockId: start.id, offset: 0 };
    let desiredX: number | null = null;
    const visited: string[] = [cellOf(doc, position.blockId)];

    for (let i = 0; i < 2; i += 1) {
      const next = moveVertical(layout, position, 1, desiredX, measurer);
      expect(next, `descente ${i + 1}`).not.toBeNull();
      position = next!.position;
      desiredX = next!.desiredX;
      visited.push(cellOf(doc, position.blockId));
    }

    expect(visited).toEqual(['0/1', '1/1', '2/1']);
  });

  it('remonte dans la même colonne', () => {
    const { doc, table, layout } = grille();
    const start = table.rows[2]!.cells[2]!.blocks[0]!;

    const first = moveVertical(layout, { blockId: start.id, offset: 0 }, -1, null, measurer);
    expect(cellOf(doc, first!.position.blockId)).toBe('1/2');

    const second = moveVertical(layout, first!.position, -1, first!.desiredX, measurer);
    expect(cellOf(doc, second!.position.blockId)).toBe('0/2');
  });

  it('entre dans le tableau par le haut et en ressort par le bas', () => {
    const { doc, layout } = grille();
    const first = paragraphIndex(doc).order[0]!;

    // Entering: from the paragraph that precedes, we land in the first row.
    const entering = moveVertical(layout, { blockId: first, offset: 0 }, 1, null, measurer);
    expect(cellOf(doc, entering!.position.blockId)).toBe('0/0');

    // Leaving: three steps down, we leave the grid through the bottom.
    let position = entering!.position;
    let desiredX: number | null = entering!.desiredX;
    for (let i = 0; i < 3; i += 1) {
      const next = moveVertical(layout, position, 1, desiredX, measurer);
      if (!next) break;
      position = next.position;
      desiredX = next.desiredX;
    }
    expect(cellOf(doc, position.blockId)).toBe('hors tableau');
  });

  it('garde l’abscisse mémorisée d’une ligne à l’autre', () => {
    const { table, layout } = grille();
    const start = table.rows[0]!.cells[2]!.blocks[0]!;

    const first = moveVertical(layout, { blockId: start.id, offset: 2 }, 1, null, measurer);
    const second = moveVertical(layout, first!.position, 1, first!.desiredX, measurer);

    // `desiredX` is the contract of successive vertical moves: without it the cursor would drift to the left on every shorter line.
    expect(second!.desiredX).toBeCloseTo(first!.desiredX, 5);
  });

  it('franchit encore les pages hors tableau', () => {
    // Enough paragraphs to overflow a page: vertical navigation must not stop at the bottom of the sheet.
    const many = Array.from({ length: 90 }, (_, i) => createParagraph(`paragraphe ${i}`));
    const doc = docOf(many);
    const layout = paginateDocument(doc, { measurer });
    expect(layout.pages.length).toBeGreaterThan(1);

    const lastOfFirstPage = layout.pages[0]!.blocks
      .filter((block) => block.kind !== 'table')
      .at(-1);
    expect(lastOfFirstPage).toBeDefined();

    const id = (lastOfFirstPage as { blockId: string }).blockId;
    const next = moveVertical(layout, { blockId: id, offset: 0 }, 1, null, measurer);

    expect(next).not.toBeNull();
    expect(next!.position.blockId).not.toBe(id);
  });
});
