/**
 * Réservation de la zone de notes — `SwFtnContFrm` / `SwFtnBossFrm::GetVarSpace`
 * (`sw/source/core/layout/ftnfrm.cxx`).
 *
 * Le défaut que ces tests ferment : les notes étaient attachées aux pages
 * **après** la mise en page, sans que leur hauteur soit retranchée de la place
 * disponible. Sur une page pleine, le bandeau recouvrait donc les dernières
 * lignes du corps.
 *
 * L'invariant vérifié ici est celui de Writer : sur toute page portant des
 * notes, `corps + zone de notes <= hauteur utile`.
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

/** Paragraphe portant un appel de note à la fin de son texte. */
function avecNote(texte: string, id: string, note: string) {
  return createParagraph('', {
    runs: [makeRun(texte), makeRun('¹', { footnoteText: note, footnoteId: id })],
  });
}

const REMPLISSAGE =
  'Un paragraphe de remplissage suffisamment long pour occuper plusieurs lignes de la page. ';

describe('Réservation de la zone de notes (SwFtnBossFrm::GetVarSpace)', () => {
  it('le corps et les notes tiennent ensemble dans la hauteur utile', () => {
    // Assez de matière pour remplir la page, avec un appel de note à la fin.
    const blocs = [
      ...Array.from({ length: 40 }, (_, i) => createParagraph(`${REMPLISSAGE}${i}`)),
      avecNote('Dernière phrase', 'fn1', 'Une note explicative sur la dernière phrase.'),
    ];

    const layout = paginateDocument(docOf(blocs), { measurer });
    const utile = layout.geometry.contentHeightPx;

    for (const page of layout.pages) {
      if (!page.footnotes?.length) continue;
      expect(page.footnoteAreaHeightPx).toBeGreaterThan(0);
      // L'invariant : le bandeau ne peut plus recouvrir le corps.
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
    // Le paragraphe porteur est placé après un long remplissage : sa note doit
    // suivre sa ligne, pas rester sur la première page.
    const blocs = [
      ...Array.from({ length: 60 }, (_, i) => createParagraph(`${REMPLISSAGE}${i}`)),
      avecNote('Appel tardif', 'fnTard', 'Note appelée tard dans le document.'),
    ];

    const layout = paginateDocument(docOf(blocs), { measurer });
    expect(layout.pages.length).toBeGreaterThan(1);

    const pagesAvecNote = layout.pages.filter((p) => p.footnotes?.length);
    expect(pagesAvecNote).toHaveLength(1);
    expect(pagesAvecNote[0]?.index).toBe(layout.pages.length - 1);
    // Les pages précédentes n'ont rien réservé.
    expect(layout.pages[0]?.footnoteAreaHeightPx).toBeUndefined();
  });

  it('retient moins de lignes sur la page quand une note descend avec elles', () => {
    // Même corps, avec et sans note : la version annotée doit reporter au moins
    // autant de contenu, la zone de notes lui prenant de la place.
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

    // La numérotation ne dépend pas de la pagination : elle reste donc stable
    // d'une passe à l'autre, ce dont dépend la convergence en deux passes.
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
