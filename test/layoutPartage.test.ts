/**
 * Partage structurel des mises en page entre deux paginations.
 *
 * La pagination est pure : mêmes entrées, même résultat. Ce qui est vérifié ici
 * est plus fort — mêmes entrées, **même objet**. C'est cette identité, et non
 * seulement l'égalité, qui permet à `React.memo(ParagraphView)` de renoncer au
 * rendu d'un paragraphe inchangé, et qui évite de recomposer ses lignes.
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
     * Une frappe telle que l'éditeur la produit : `replaceParagraph` remplace
     * le seul nœud touché et reconduit tout le reste — les autres paragraphes
     * comme les réglages par défaut — par identité. C'est cette conservation
     * qui rend le partage possible, et c'est pourquoi le test passe par la
     * commande réelle plutôt que de reconstruire un document à la main.
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

    // Les vingt-neuf autres sont réutilisés tels quels.
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
     * Le document a changé, la table non : elle doit rester le **même** objet.
     * C'est elle qui porte le contexte d'images transmis à chaque paragraphe ;
     * une table neuve à chaque frappe suffirait à faire rendre tout le document.
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
