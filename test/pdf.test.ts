// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph, createTable } from '../src/domain/document/document';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { exportToPdfBytes, exportToPdfBlob } from '../src/domain/pdf/export';
import { DEFAULT_FURNITURE } from '../src/domain/document/pageFurniture';
import { makeRun } from '../src/domain/document/runs';

describe('Génération et exportation PDF native (vcl::PDFWriter)', () => {
  const measurer = new MetricTextMeasurer();

  it('génère un fichier PDF binaire valide avec header %PDF-1.4 et trailer %%EOF', () => {
    const doc = createEmptyDocument('Test Document PDF');
    doc.blocks = [
      createParagraph('Titre du document', { headingLevel: 1 }),
      createParagraph('Ceci est un paragraphe de test en français avec des accents : é, è, à, ç, ô, €.'),
    ];

    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(100);

    const text = new TextDecoder('latin1').decode(bytes);

    // En-tête standard
    expect(text.startsWith('%PDF-1.4')).toBe(true);

    // Clôture standard
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    // Objets indispensables
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page');
    expect(text).toContain('/Type /Font');
    expect(text).toContain('xref');
    expect(text).toContain('trailer');
    expect(text).toContain('startxref');
  });

  it('inclut les métadonnées du document dans le dictionnaire Info', () => {
    const doc = createEmptyDocument('Rapport Annuel 2026');
    doc.meta.author = 'Alice';
    doc.blocks = [createParagraph('Corps du rapport')];

    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const text = new TextDecoder('latin1').decode(bytes);

    expect(text).toContain('/Title (Rapport Annuel 2026)');
    expect(text).toContain('/Author (Alice)');
    expect(text).toContain('/Creator (Apache OpenOffice Writer Web)');
    expect(text).toContain('/Producer (CloudAntille Writer Native PDF Engine)');
  });

  it('encode correctement les caractères accentués en WinAnsi / octal', () => {
    const doc = createEmptyDocument('Accents');
    doc.blocks = [createParagraph('Édition & Création')];

    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const text = new TextDecoder('latin1').decode(bytes);

    // 'É' est code 201 = \311, 'é' est code 233 = \351
    expect(text).toContain('\\311dition & Cr\\351ation');
  });

  it('génère plusieurs pages pour un document long', () => {
    const doc = createEmptyDocument('Multi-pages');
    const longText = 'Paragraphe de test remplissant la feuille pour déclencher la pagination. '.repeat(10);
    doc.blocks = [
      createParagraph('Page 1', { headingLevel: 1 }),
      createParagraph(longText),
      { ...createParagraph('Page 2 forcée', { headingLevel: 1 }), pageBreakBefore: true },
      createParagraph(longText),
    ];

    const layout = paginateDocument(doc, { measurer });
    expect(layout.pages.length).toBeGreaterThanOrEqual(2);

    const bytes = exportToPdfBytes(doc, layout);
    const text = new TextDecoder('latin1').decode(bytes);

    expect(text).toContain(`/Count ${layout.pages.length}`);
  });

  it('inclut le tracé des tableaux et leurs bordures', () => {
    const doc = createEmptyDocument('Document avec tableau');
    const table = createTable(2, 2);
    table.rows[0]!.cells[0]!.blocks = [createParagraph('Cellule 1')];
    table.rows[0]!.cells[1]!.blocks = [createParagraph('Cellule 2')];
    table.rows[1]!.cells[0]!.blocks = [createParagraph('Cellule 3')];
    table.rows[1]!.cells[1]!.blocks = [createParagraph('Cellule 4')];

    doc.blocks = [createParagraph('Avant tableau'), table, createParagraph('Après tableau')];

    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const text = new TextDecoder('latin1').decode(bytes);

    // Opérateur de tracé de rectangle pour les bordures de cellule
    expect(text).toContain(' re S');
    expect(text).toContain('Cellule 1');
    expect(text).toContain('Cellule 4');
  });

  it('rend l’en-tête et le pied de page avec jetons substitués', () => {
    const doc = createEmptyDocument('Rapport avec mobilier');
    doc.furniture = {
      ...DEFAULT_FURNITURE,
      header: 'Société - {titre}',
      footer: 'Page {page} / {pages}',
      onFirstPage: true,
    };

    doc.blocks = [createParagraph('Contenu')];

    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const text = new TextDecoder('latin1').decode(bytes);

    expect(text).toContain('Soci\\351t\\351 - Rapport avec mobilier');
    expect(text).toContain('Page 1 / 1');
  });

  it('rend les 3 zones, les fonds et les filets séparateurs dans le PDF', () => {
    const doc = createEmptyDocument('Rapport 3 zones');
    doc.furniture = {
      ...DEFAULT_FURNITURE,
      headerLeft: 'Gauche',
      headerCenter: 'Centre',
      headerRight: 'Droite',
      headerSeparator: true,
      headerSeparatorStyle: 'dashed',
      headerBackground: '#f0f4f8',
      footerLeft: 'Pied G',
      footerRight: 'Pied D',
      footerSeparator: true,
      onFirstPage: true,
    };

    doc.blocks = [createParagraph('Contenu du document')];

    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const text = new TextDecoder('latin1').decode(bytes);

    expect(text).toContain('(Gauche) Tj');
    expect(text).toContain('(Centre) Tj');
    expect(text).toContain('(Droite) Tj');
    expect(text).toContain('(Pied G) Tj');
    expect(text).toContain('(Pied D) Tj');
    // Vérification du filet séparateur dashed '[4 2] 0 d'
    expect(text).toContain('[4 2] 0 d');
  });

  /**
   * Cadres flottants au PDF.
   *
   * Le PDF les ignorait : une image habillée y disparaissait, et il ne restait
   * que le trou qu'elle avait creusé dans le texte. Faute d'un rastériseur dans
   * les tests, on vérifie le **cadre de remplacement** que trace `paintImage`
   * quand les octets manquent — sa présence prouve que le cadre a été visité.
   */
  function cadreFlottant(surround: 'parallel' | 'through', extra: Record<string, unknown> = {}) {
    return makeRun('￼', {
      imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
      imageWidthPt: 120,
      imageHeightPt: 90,
      imageAnchor: 'to-para',
      imageSurround: surround,
      imageXPt: 0,
      imageYPt: 0,
      ...extra,
    });
  }

  it('peint les cadres flottants, que le fil du texte ne porte pas', () => {
    const doc = createEmptyDocument('Cadre flottant');
    doc.blocks = [createParagraph('', { runs: [makeRun('Du texte '), cadreFlottant('parallel')] })];

    const layout = paginateDocument(doc, { measurer });
    expect(layout.pages[0]?.flies).toHaveLength(1);

    const text = new TextDecoder('latin1').decode(exportToPdfBytes(doc, layout));
    // `120 × 90 pt`, la taille du cadre, tracée en rectangle de remplacement.
    expect(text).toContain('120.00 90.00 re S');
  });

  it('peint le calque « devant le texte » après le corps de la page', () => {
    const doc = createEmptyDocument('Devant le texte');
    doc.blocks = [
      createParagraph('', {
        runs: [makeRun('Du texte '), cadreFlottant('through', { imageInFront: true })],
      }),
    ];

    const layout = paginateDocument(doc, { measurer });
    const text = new TextDecoder('latin1').decode(exportToPdfBytes(doc, layout));

    const cadre = text.indexOf('120.00 90.00 re S');
    const dernierTexte = text.lastIndexOf('ET');
    expect(cadre).toBeGreaterThan(-1);
    // L'ordre de `SwRootFrm::Paint` : le calque `heaven` passe après le texte.
    expect(cadre).toBeGreaterThan(dernierTexte);
  });

  it('exportToPdfBlob produit un objet Blob de type application/pdf', () => {
    const doc = createEmptyDocument('Blob Test');
    doc.blocks = [createParagraph('Texte')];
    const layout = paginateDocument(doc, { measurer });

    const blob = exportToPdfBlob(doc, layout);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(100);
  });
});
