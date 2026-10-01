// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Tests des mutations structurelles de tableaux (SwTable / SwTableLine / SwTableBox).
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createTable,
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
} from '../src/domain/document/document';
import type { DocumentBlock } from '../src/domain/document/types';
import {
  createEditorState,
  deleteCurrentTableColumn,
  deleteCurrentTableRow,
  insertTableColumnRight,
  insertTableRowBelow,
} from '../src/domain/engine/edit';
import { buildOdfPackage } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

describe('Mutations structurelles de tableaux', () => {
  it('insère une ligne au-dessus et au-dessous', () => {
    const table = createTable(2, 2);
    let doc = docOf([table]);
    expect(doc.blocks[0]?.type).toBe('table');
    if (doc.blocks[0]?.type !== 'table') return;

    // Insertion au-dessous de la première ligne (index 0)
    doc = insertTableRow(doc, table.id, 0, 'below');
    const table1 = doc.blocks[0] as typeof table;
    expect(table1.rows).toHaveLength(3);

    // Insertion au-dessus de la première ligne
    doc = insertTableRow(doc, table.id, 0, 'above');
    const table2 = doc.blocks[0] as typeof table;
    expect(table2.rows).toHaveLength(4);
  });

  it('supprime une ligne et supprime le tableau si dernière ligne', () => {
    const table = createTable(2, 2);
    let doc = docOf([table]);

    doc = deleteTableRow(doc, table.id, 0);
    const table1 = doc.blocks[0] as typeof table;
    expect(table1.rows).toHaveLength(1);

    // Supprimer la dernière ligne supprime le tableau
    doc = deleteTableRow(doc, table.id, 0);
    expect(doc.blocks.some((b) => b.type === 'table')).toBe(false);
  });

  it('insère une colonne et ajuste les pourcentages de largeur', () => {
    const table = createTable(2, 2); // 2 colonnes à 50%
    let doc = docOf([table]);

    doc = insertTableColumn(doc, table.id, 0, 'right');
    const table1 = doc.blocks[0] as typeof table;
    expect(table1.rows[0]?.cells).toHaveLength(3);
    expect(table1.rows[1]?.cells).toHaveLength(3);
    // 100 / 3 = 33.333...%
    expect(table1.rows[0]?.cells[0]?.widthPercent).toBeCloseTo(33.33, 1);
  });

  it('supprime une colonne et réajuste les largeurs', () => {
    const table = createTable(2, 3); // 3 colonnes
    let doc = docOf([table]);

    doc = deleteTableColumn(doc, table.id, 1);
    const table1 = doc.blocks[0] as typeof table;
    expect(table1.rows[0]?.cells).toHaveLength(2);
    expect(table1.rows[0]?.cells[0]?.widthPercent).toBeCloseTo(50, 1);
  });

  it('exécute les commandes d’édition depuis la position courante du curseur', () => {
    const table = createTable(2, 2);
    const doc = docOf([table]);
    const firstCellPId = table.rows[0]!.cells[0]!.blocks[0]!.id;

    let state = createEditorState(doc);
    state = {
      ...state,
      selection: {
        anchor: { blockId: firstCellPId, offset: 0 },
        focus: { blockId: firstCellPId, offset: 0 },
        isCollapsed: true,
      },
    };

    // Insérer ligne au-dessous
    state = insertTableRowBelow(state);
    let currentTable = state.doc.blocks[0] as typeof table;
    expect(currentTable.rows).toHaveLength(3);

    // Insérer colonne à droite
    state = insertTableColumnRight(state);
    currentTable = state.doc.blocks[0] as typeof table;
    expect(currentTable.rows[0]?.cells).toHaveLength(3);

    // Supprimer colonne
    state = deleteCurrentTableColumn(state);
    currentTable = state.doc.blocks[0] as typeof table;
    expect(currentTable.rows[0]?.cells).toHaveLength(2);

    // Supprimer ligne
    state = deleteCurrentTableRow(state);
    currentTable = state.doc.blocks[0] as typeof table;
    expect(currentTable.rows).toHaveLength(2);
  });

  it('préserve les largeurs relatives de colonnes à l’export / import ODF', () => {
    const table = createTable(2, 2);
    // Affecter des largeurs personnalisées (ex: 30% et 70%)
    table.rows[0]!.cells[0]!.widthPercent = 30;
    table.rows[0]!.cells[1]!.widthPercent = 70;
    table.rows[1]!.cells[0]!.widthPercent = 30;
    table.rows[1]!.cells[1]!.widthPercent = 70;

    const doc = docOf([table]);
    const pkg = buildOdfPackage(doc);
    const { document: importedDoc } = importOdfContent(pkg.files['content.xml'], {
      stylesXml: pkg.files['styles.xml'],
    });

    const importedTable = importedDoc.blocks.find((b) => b.type === 'table') as typeof table | undefined;
    expect(importedTable).toBeDefined();
    expect(importedTable?.rows[0]?.cells[0]?.widthPercent).toBeCloseTo(30, 0);
    expect(importedTable?.rows[0]?.cells[1]?.widthPercent).toBeCloseTo(70, 0);
  });
});
