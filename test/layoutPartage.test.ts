// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Structural sharing of layouts between two paginations.
 *
 * Pagination is pure: same inputs, same result. What is checked here is stronger: same inputs, **same object**. It is that identity, and not merely equality, that lets `React.memo(ParagraphView)` skip rendering an unchanged
 * paragraph, and that avoids recomposing its lines.
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  DEFAULT_DEFAULTS,
  replaceParagraph,
} from '../src/domain/document/document';
import type { ParagraphNode, WriterDocumentState } from '../src/domain/document/types';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { paginateDocument } from '../src/domain/engine/paginate';

function documentDe(blocs: ParagraphNode[]): WriterDocumentState {
  return {
    ...createEmptyDocument('Essai'),
    defaults: { ...DEFAULT_DEFAULTS, lineSpacing: 1 },
    blocks: blocs,
  };
}

function corpus(n: number): ParagraphNode[] {
  return Array.from({ length: n }, (_, i) =>
    createParagraph(`Paragraphe ${i + 1} — un texte assez long pour occuper plusieurs lignes une fois mis en page sur une feuille A4 ordinaire.`),
  );
}

describe('Partage structurel des mises en page', () => {
  it('rend le même objet de mise en page pour un paragraphe inchangé', () => {
    const measurer = new MetricTextMeasurer();
    const blocs = corpus(30);
    const doc = documentDe(blocs);

    const premier = paginateDocument(doc, { measurer });
    const second = paginateDocument(doc, { measurer });

    for (const bloc of blocs) {
      expect(second.paragraphLayouts.get(bloc.id)).toBe(premier.paragraphLayouts.get(bloc.id));
    }
  });

  it('ne recalcule que le paragraphe modifié', () => {
    const measurer = new MetricTextMeasurer();
    const blocs = corpus(30);
    const doc = documentDe(blocs);
    const premier = paginateDocument(doc, { measurer });

    /*
     * A keystroke as the editor produces it: `replaceParagraph` replaces the single touched node and carries everything else over by identity (the other paragraphs as well as the default settings). It is this conservation
     * that makes the sharing possible, and that is why the test goes through the real command rather than rebuilding a document by hand.
     */
    const cible = blocs[14]!;
    const second = paginateDocument(
      replaceParagraph(doc, cible.id, {
        ...createParagraph('Paragraphe 15 — texte remanié après une frappe.'),
        id: cible.id,
      }),
      { measurer },
    );

    let partages = 0;
    for (const bloc of blocs) {
      const avant = premier.paragraphLayouts.get(bloc.id);
      const maintenant = second.paragraphLayouts.get(bloc.id);
      if (avant !== undefined && avant === maintenant) partages += 1;
    }

    // The twenty-nine others are reused as they are.
    expect(partages).toBe(29);
    expect(second.paragraphLayouts.get(blocs[14]!.id)).not.toBe(
      premier.paragraphLayouts.get(blocs[14]!.id),
    );
  });

  it('recalcule quand la largeur de page change', () => {
    const measurer = new MetricTextMeasurer();
    const blocs = corpus(5);
    const doc = documentDe(blocs);
    const large = paginateDocument(doc, { measurer });

    const etroit = paginateDocument(
      { ...doc, pageSetup: { ...doc.pageSetup, marginLeftMm: 60, marginRightMm: 60 } },
      { measurer },
    );

    for (const bloc of blocs) {
      expect(etroit.paragraphLayouts.get(bloc.id)).not.toBe(large.paragraphLayouts.get(bloc.id));
    }
  });

  it('recalcule quand les réglages par défaut du document changent', () => {
    const measurer = new MetricTextMeasurer();
    const blocs = corpus(5);
    const doc = documentDe(blocs);
    const avant = paginateDocument(doc, { measurer });

    const apres = paginateDocument(
      { ...doc, defaults: { ...doc.defaults, fontSizePt: doc.defaults.fontSizePt * 2 } },
      { measurer },
    );

    for (const bloc of blocs) {
      const a = avant.paragraphLayouts.get(bloc.id)!;
      const b = apres.paragraphLayouts.get(bloc.id)!;
      expect(b).not.toBe(a);
      expect(b.heightPx).toBeGreaterThan(a.heightPx);
    }
  });

  it('conserve la table des numéros de figure tant que les numéros ne bougent pas', () => {
    const measurer = new MetricTextMeasurer();
    const blocs = corpus(6);
    const doc = documentDe(blocs);
    const avant = paginateDocument(doc, { measurer });

    const cible = blocs[2]!;
    const apres = paginateDocument(
      replaceParagraph(doc, cible.id, {
        ...createParagraph('Texte remanié, sans la moindre image.'),
        id: cible.id,
      }),
      { measurer },
    );

    /*
     * The document changed, the table did not: it must stay the **same** object. It is the one that carries the image context handed to every paragraph; a new table on every keystroke would be enough to make the whole
     * document render.
     */
    expect(apres.figureNumbers).toBe(avant.figureNumbers);
  });

  it('sépare les caches de deux mesureurs distincts', () => {
    const blocs = corpus(3);
    const doc = documentDe(blocs);
    const a = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const b = paginateDocument(doc, { measurer: new MetricTextMeasurer() });

    for (const bloc of blocs) {
      expect(b.paragraphLayouts.get(bloc.id)).not.toBe(a.paragraphLayouts.get(bloc.id));
    }
  });
});
