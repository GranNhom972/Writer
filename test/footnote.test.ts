// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Tests du sous-système de notes de bas de page (SwFtnFrm / SwFtnContFrm).
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph, paragraphText } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import {
  countFootnotes,
  createEditorState,
  insertFootnote,
  insertText,
} from '../src/domain/engine/edit';
import { paginateDocument } from '../src/domain/engine/paginate';
import { createMeasurer } from '../src/domain/engine/measure';
import { buildOdfPackage } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';

function docOf(blocks: ReturnType<typeof createParagraph>[]) {
  return { ...createEmptyDocument(), blocks };
}

describe('Sous-système de notes de bas de page (SwFtnFrm)', () => {
  it('insère un appel de note avec indice en exposant et texte de note', () => {
    const doc = docOf([createParagraph('Texte principal ')]);
    const state = createEditorState(doc);
    const stateWithCaret = {
      ...state,
      selection: {
        anchor: { blockId: doc.blocks[0]!.id, offset: 16 },
        focus: { blockId: doc.blocks[0]!.id, offset: 16 },
        isCollapsed: true,
      },
    };

    const nextState = insertFootnote(stateWithCaret, 'Ceci est la première note.');
    expect(countFootnotes(nextState.doc)).toBe(1);

    const paragraph = nextState.doc.blocks[0]!;
    if (paragraph.type === 'paragraph') {
      const footnoteRun = paragraph.runs.find((r) => r.footnoteText !== undefined);
      expect(footnoteRun).toBeDefined();
      expect(footnoteRun?.footnoteText).toBe('Ceci est la première note.');
      expect(footnoteRun?.footnoteId).toBeDefined();
      expect(footnoteRun?.text).toBe('¹');
    }
  });

  it('génère des numéros séquentiels pour des notes multiples sans propager aux frappes suivantes', () => {
    let state = createEditorState(docOf([createParagraph('')]));
    state = insertText(state, 'Premier');
    state = insertFootnote(state, 'Note 1');
    state = insertText(state, ' Deuxième');
    state = insertFootnote(state, 'Note 2');

    expect(countFootnotes(state.doc)).toBe(2);

    const paragraph = state.doc.blocks[0]!;
    if (paragraph.type === 'paragraph') {
      const footnoteRuns = paragraph.runs.filter((r) => r.footnoteText !== undefined);
      expect(footnoteRuns).toHaveLength(2);
      expect(footnoteRuns[0]?.text).toBe('¹');
      expect(footnoteRuns[0]?.footnoteText).toBe('Note 1');
      expect(footnoteRuns[1]?.text).toBe('²');
      expect(footnoteRuns[1]?.footnoteText).toBe('Note 2');
      expect(paragraphText(paragraph)).toBe('Premier¹ Deuxième²');
    }
  });

  it('associe les notes de bas de page à leur page respective lors de la pagination', () => {
    const p1 = createParagraph('Page 1 ', {
      runs: [
        makeRun('Texte page 1 '),
        makeRun('¹', { footnoteText: 'Note de la page 1', footnoteId: 'fn1' }),
      ],
    });
    const doc = docOf([p1]);
    const measurer = createMeasurer();
    const layout = paginateDocument(doc, { measurer });

    expect(layout.pages.length).toBeGreaterThanOrEqual(1);
    const firstPage = layout.pages[0]!;
    expect(firstPage.footnotes).toBeDefined();
    expect(firstPage.footnotes?.length).toBe(1);
    expect(firstPage.footnotes?.[0]?.text).toBe('Note de la page 1');
    expect(firstPage.footnotes?.[0]?.index).toBe(1);
  });

  it('effectue un aller-retour ODF complet avec des notes de bas de page', () => {
    const p = createParagraph('Introduction ', {
      runs: [
        makeRun('Texte documenté '),
        makeRun('¹', { footnoteText: 'Note explicative', footnoteId: 'fn_test' }),
      ],
    });
    const doc = docOf([p]);

    const pkg = buildOdfPackage(doc);
    const { document: importedDoc } = importOdfContent(pkg.files['content.xml'], {
      stylesXml: pkg.files['styles.xml'],
    });

    expect(importedDoc.blocks.length).toBeGreaterThanOrEqual(1);
    const importedP = importedDoc.blocks[0]!;
    if (importedP.type === 'paragraph') {
      const fnRun = importedP.runs.find((r) => r.footnoteText !== undefined);
      expect(fnRun).toBeDefined();
      expect(fnRun?.footnoteText).toBe('Note explicative');
    }
  });
});
