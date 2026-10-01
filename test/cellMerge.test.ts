// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Fusion et scission de cellules — `SwDoc::MergeTbl` / `SwDoc::SplitTbl`
 * (`sw/source/core/doc/tblrwcl.cxx`).
 *
 * L'invariant que ces tests protègent est celui de Writer : une cellule
 * absorbée n'est pas **supprimée** mais marquée recouverte, ce qui garde la
 * grille rectangulaire. C'est de cette propriété que dépendent la navigation au
 * curseur, l'insertion ultérieure d'une colonne et la scission.
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

    // Les trois voisines du rectangle sont recouvertes, pas retirées.
    expect(merged.rows[0]?.cells[1]?.covered).toBe(true);
    expect(merged.rows[1]?.cells[0]?.covered).toBe(true);
    expect(merged.rows[1]?.cells[1]?.covered).toBe(true);

    // Hors rectangle : rien n'a bougé.
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

    // `row.cells[3]` n'occupe plus la colonne 3 côté grille… si ce n'est que
    // les cellules recouvertes sont conservées, ce qui rétablit l'alignement.
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

    // Deux lignes ajoutées sous la ligne 0.
    expect(split.rows).toHaveLength(4);
    // Les voisines de la ligne d'origine s'étendent vers le bas.
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
    // Largeurs implicites : la fusion doit cumuler celles des colonnes couvertes.
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
     * La fusion cumule bien deux colonnes, mais l'égalité n'est pas flottante :
     * les frontières de colonnes sont des cumuls **arrondis** au pixel
     * (`columnBoundariesPx`), si bien que deux colonnes nominalement égales
     * peuvent différer d'un pixel. Exiger `2 × largeurSimple` au millième
     * reviendrait à exiger le contraire de ce que l'arrondi garantit.
     *
     * Ce qui doit tenir exactement, c'est la **fermeture de la grille** : le
     * bord droit de la fusion tombe sur le bord gauche de la cellule suivante,
     * sans trou ni recouvrement.
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
     * La grille ferme sur le cumul **arrondi** de la largeur de contenu, et non
     * sur sa valeur flottante : `columnBoundariesPx` arrondit chaque borne
     * cumulée, la dernière comprise. L'écart avec le bord du texte est donc
     * borné par un demi-pixel — et surtout il ne s'accumule pas d'une colonne
     * à l'autre, ce qui était le défaut visé.
     */
    const totalWidth = Math.round(layout.geometry.contentWidthPx);
    for (const row of placed.rows) {
      for (const cell of row.cells) {
        if (cell.covered) continue;
        expect(cell.leftPx + cell.widthPx).toBeLessThanOrEqual(totalWidth);
        // Bornes entières : c'est ce qui rend les traits nets à tout zoom.
        expect(Number.isInteger(cell.leftPx)).toBe(true);
        expect(Number.isInteger(cell.widthPx)).toBe(true);
      }

      // Aucune couture : chaque cellule visible touche exactement la suivante,
      // et la dernière ferme sur le bord de la zone de texte.
      const visibles = row.cells.filter((cell) => !cell.covered);
      visibles.forEach((cell, i) => {
        const suivante = visibles[i + 1];
        expect(cell.leftPx + cell.widthPx).toBe(suivante ? suivante.leftPx : totalWidth);
      });
    }

    /*
     * Ligne 0 : la fusion L1C1+L1C2 et la cellule L1C3 se joignent.
     *
     * Chaque borne est à moins d'un demi-pixel de sa position idéale — c'est
     * exactement la garantie d'un cumul arrondi, et c'est tout ce qu'un arrondi
     * au pixel peut promettre. Le contrôle porte donc sur cette borne d'erreur,
     * et non sur une égalité décimale que l'arrondi rend inatteignable ; la
     * jointure exacte, elle, est déjà vérifiée plus haut.
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

    // Chaque ligne a bien gagné une cellule : la grille reste rectangulaire.
    expect(after.rows[0]?.cells).toHaveLength(3);
    expect(after.rows[1]?.cells).toHaveLength(3);
  });
});
