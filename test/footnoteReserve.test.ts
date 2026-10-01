// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Reservation of the footnote area: `SwFtnContFrm` / `SwFtnBossFrm::GetVarSpace` (`sw/source/core/layout/ftnfrm.cxx`).
 *
 * The defect these tests close: notes were attached to the pages **after** layout, without their height being subtracted from the available room. On a full page, the banner therefore covered the last lines of the body.
 *
 * The invariant checked here is Writer's: on every page that carries notes, `body + footnote area <= usable height`.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph, createTable } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import {
  collectDocumentFootnotes,
  paginateDocument,
  FOOTNOTE_SEPARATOR_PX,
} from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import type { DocumentBlock } from '../src/domain/document/types';

const measurer = new MetricTextMeasurer();

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

/** Paragraph carrying a footnote call at the end of its text. */
function avecNote(texte: string, id: string, note: string) {
  return createParagraph('', {
    runs: [makeRun(texte), makeRun('¹', { footnoteText: note, footnoteId: id })],
  });
}

const REMPLISSAGE =
  'Un paragraphe de remplissage suffisamment long pour occuper plusieurs lignes de la page. ';

describe('Réservation de la zone de notes (SwFtnBossFrm::GetVarSpace)', () => {
  it('le corps et les notes tiennent ensemble dans la hauteur utile', () => {
    // Enough material to fill the page, with a footnote call at the end.
    const blocs = [
      ...Array.from({ length: 40 }, (_, i) => createParagraph(`${REMPLISSAGE}${i}`)),
      avecNote('Dernière phrase', 'fn1', 'Une note explicative sur la dernière phrase.'),
    ];

    const layout = paginateDocument(docOf(blocs), { measurer });
    const utile = layout.geometry.contentHeightPx;

    for (const page of layout.pages) {
      if (!page.footnotes?.length) continue;
      expect(page.footnoteAreaHeightPx).toBeGreaterThan(0);
      // The invariant: the banner can no longer cover the body.
      expect(page.usedHeightPx + (page.footnoteAreaHeightPx ?? 0)).toBeLessThanOrEqual(utile + 0.5);
    }
  });

  it('une note réserve au moins le filet de séparation et sa propre hauteur', () => {
    const doc = docOf([avecNote('Texte court', 'fn1', 'Note brève.')]);
    const layout = paginateDocument(doc, { measurer });
    const page = layout.pages[0]!;

    expect(page.footnotes).toHaveLength(1);
    expect(page.footnoteAreaHeightPx).toBeGreaterThan(FOOTNOTE_SEPARATOR_PX);
    expect(page.footnotes?.[0]?.heightPx).toBeGreaterThan(0);
  });

  it('une note longue réserve plus qu\'une note brève', () => {
    const breve = paginateDocument(docOf([avecNote('T', 'fn1', 'Court.')]), { measurer });
    const longue = paginateDocument(
      docOf([
        avecNote(
          'T',
          'fn1',
          'Une note de bas de page particulièrement longue, qui occupe plusieurs lignes une fois disposée dans la largeur de la page, et dont la hauteur doit donc être mesurée pour de vrai plutôt qu\'estimée à une seule ligne.',
        ),
      ]),
      { measurer },
    );

    expect(longue.pages[0]?.footnoteAreaHeightPx).toBeGreaterThan(
      breve.pages[0]?.footnoteAreaHeightPx ?? 0,
    );
  });

  it('la réserve croît avec le nombre de notes de la page', () => {
    const une = paginateDocument(docOf([avecNote('A', 'fn1', 'Note un.')]), { measurer });

    const deux = paginateDocument(
      docOf([
        createParagraph('', {
          runs: [
            makeRun('A'),
            makeRun('¹', { footnoteText: 'Note un.', footnoteId: 'fn1' }),
            makeRun('B'),
            makeRun('²', { footnoteText: 'Note deux.', footnoteId: 'fn2' }),
          ],
        }),
      ]),
      { measurer },
    );

    expect(deux.pages[0]?.footnotes).toHaveLength(2);
    expect(deux.pages[0]?.footnoteAreaHeightPx).toBeGreaterThan(
      une.pages[0]?.footnoteAreaHeightPx ?? 0,
    );
  });

  it('n\'impute la note qu\'à la page portant la ligne de son appel', () => {
    // The carrier paragraph is placed after a long filler: its note must follow its line, not stay on the first page.
    const blocs = [
      ...Array.from({ length: 60 }, (_, i) => createParagraph(`${REMPLISSAGE}${i}`)),
      avecNote('Appel tardif', 'fnTard', 'Note appelée tard dans le document.'),
    ];

    const layout = paginateDocument(docOf(blocs), { measurer });
    expect(layout.pages.length).toBeGreaterThan(1);

    const pagesAvecNote = layout.pages.filter((p) => p.footnotes?.length);
    expect(pagesAvecNote).toHaveLength(1);
    expect(pagesAvecNote[0]?.index).toBe(layout.pages.length - 1);
    // The previous pages reserved nothing.
    expect(layout.pages[0]?.footnoteAreaHeightPx).toBeUndefined();
  });

  it('retient moins de lignes sur la page quand une note descend avec elles', () => {
    // Same body, with and without a note: the annotated version must carry over at least as much content, the footnote area taking room from it.
    const corps = Array.from({ length: 44 }, (_, i) => createParagraph(`${REMPLISSAGE}${i}`));

    const sansNote = paginateDocument(docOf([...corps]), { measurer });
    const avecNotes = paginateDocument(
      docOf([
        ...corps.slice(0, -1),
        avecNote(`${REMPLISSAGE}43`, 'fn1', 'Une note qui prend de la place en bas de page.'),
      ]),
      { measurer },
    );

    const premiereSans = sansNote.pages[0]!;
    const premiereAvec = avecNotes.pages[0]!;
    expect(premiereAvec.usedHeightPx).toBeLessThanOrEqual(premiereSans.usedHeightPx + 0.5);
  });

  it('numérote les notes globalement, dans l\'ordre de lecture', () => {
    const doc = docOf([
      avecNote('Premier', 'fnA', 'Note A.'),
      avecNote('Deuxième', 'fnB', 'Note B.'),
      avecNote('Troisième', 'fnC', 'Note C.'),
    ]);

    const refs = collectDocumentFootnotes(doc);
    expect(refs.get('fnA')?.index).toBe(1);
    expect(refs.get('fnB')?.index).toBe(2);
    expect(refs.get('fnC')?.index).toBe(3);

    // Numbering does not depend on pagination: it therefore stays stable from one pass to the next, which the two-pass convergence depends on.
    const layout = paginateDocument(doc, { measurer });
    expect(layout.pages[0]?.footnotes?.map((f) => f.index)).toEqual([1, 2, 3]);
  });

  it('réserve aussi pour une note appelée depuis une cellule de tableau', () => {
    const table = createTable(1, 1);
    table.rows[0]!.cells[0]!.blocks = [avecNote('Dans la cellule', 'fnT', 'Note de cellule.')];

    const layout = paginateDocument(docOf([table]), { measurer });
    expect(layout.pages[0]?.footnotes).toHaveLength(1);
    expect(layout.pages[0]?.footnoteAreaHeightPx).toBeGreaterThan(0);
  });

  it('un document sans note ne réserve rien', () => {
    const layout = paginateDocument(docOf([createParagraph('Aucune note ici.')]), { measurer });
    expect(layout.pages[0]?.footnotes).toBeUndefined();
    expect(layout.pages[0]?.footnoteAreaHeightPx).toBeUndefined();
  });
});
