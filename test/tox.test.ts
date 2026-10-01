// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Table of contents: `SwTOXBase` / `SwDoc::UpdateTOX` (`sw/source/core/tox/tox.cxx`).
 *
 * The point that matters: the table of contents does not **store** its entries, it derives them. These tests check that it therefore cannot get out of sync with the body, and that the page numbers are those of the real layout.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import {
  createToc,
  hasToc,
  isGeneratedTocParagraph,
  tocEntries,
  tocLineId,
  tocNodes,
  tocTitleId,
  updateToc,
  DEFAULT_TOC_MAX_LEVEL,
  DEFAULT_TOC_TITLE,
} from '../src/domain/document/tox';
import { headingAnchorName } from '../src/domain/document/bookmarks';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { buildContentXml } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';
import type { DocumentBlock, HeadingLevel } from '../src/domain/document/types';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

function titre(texte: string, niveau: HeadingLevel) {
  return createParagraph(texte, { headingLevel: niveau });
}

const measurer = new MetricTextMeasurer();

describe('Définition du sommaire (SwTOXBase)', () => {
  it('crée un bloc avec les réglages par défaut de Writer', () => {
    const toc = createToc();
    expect(toc.type).toBe('toc');
    expect(toc.title).toBe(DEFAULT_TOC_TITLE);
    expect(toc.maxLevel).toBe(DEFAULT_TOC_MAX_LEVEL);
    expect(toc.showPageNumbers).toBe(true);
    expect(toc.useDotLeader).toBe(true);
  });

  it('retient les titres jusqu\'au niveau demandé, et pas au-delà', () => {
    const toc = createToc({ maxLevel: 2 });
    const doc = docOf([toc, titre('Un', 1), titre('Un.Un', 2), titre('Trop profond', 3)]);

    const entries = tocEntries(doc, toc);
    expect(entries.map((e) => e.text)).toEqual(['Un', 'Un.Un']);
    expect(entries[0]?.level).toBe(1);
    expect(entries[1]?.level).toBe(2);
  });

  it('ignore un titre vide : sa ligne ne renverrait à rien de lisible', () => {
    const toc = createToc();
    const doc = docOf([toc, titre('  ', 1), titre('Réel', 1)]);
    expect(tocEntries(doc, toc).map((e) => e.text)).toEqual(['Réel']);
  });

  it('ignore les titres placés dans une cellule de tableau', () => {
    const toc = createToc();
    const doc = docOf([toc, titre('Au fil du texte', 1)]);
    // `tocEntries` only walks `doc.blocks`: a heading nested in a cell has no position in the document's hierarchy.
    expect(tocEntries(doc, toc)).toHaveLength(1);
  });

  it('écarte le caractère de substitution des objets du texte d\'entrée', () => {
    const toc = createToc();
    const avecImage = createParagraph('', {
      headingLevel: 1,
      runs: [makeRun('Titre '), makeRun('￼', { imageSrc: 'data:,x', imageWidthPt: 10, imageHeightPt: 10 })],
    });
    const doc = docOf([toc, avecImage]);
    expect(tocEntries(doc, toc)[0]?.text).toBe('Titre');
  });

  it('donne à chaque entrée l\'ancre du titre qu\'elle vise', () => {
    const toc = createToc();
    const h = titre('Chapitre', 1);
    const doc = docOf([toc, h]);
    expect(tocEntries(doc, toc)[0]?.anchorName).toBe(headingAnchorName(h.id));
  });

  it('modifie la définition sans toucher au corps', () => {
    const toc = createToc();
    const doc = docOf([toc, titre('A', 1)]);
    const after = updateToc(doc, toc.id, { maxLevel: 1, showPageNumbers: false });

    const [modifie] = tocNodes(after);
    expect(modifie?.maxLevel).toBe(1);
    expect(modifie?.showPageNumbers).toBe(false);
    expect(after.blocks[1]).toBe(doc.blocks[1]);
  });

  it('repère les blocs de sommaire du document', () => {
    expect(hasToc(docOf([createParagraph('rien')]))).toBe(false);
    expect(hasToc(docOf([createToc()]))).toBe(true);
  });

  it('dérive des identifiants de ligne stables', () => {
    expect(tocLineId('toc1', 0)).toBe('toc1__line0');
    expect(tocLineId('toc1', 0)).toBe(tocLineId('toc1', 0));
    expect(isGeneratedTocParagraph(tocLineId('toc1', 2))).toBe(true);
    expect(isGeneratedTocParagraph(tocTitleId('toc1'))).toBe(true);
    expect(isGeneratedTocParagraph('p42')).toBe(false);
  });
});

describe('Développement à la pagination (SwDoc::UpdateTOX)', () => {
  it('développe le sommaire en paragraphes concrets, hors AST', () => {
    const toc = createToc();
    const doc = docOf([toc, titre('Alpha', 1), titre('Beta', 2)]);
    const layout = paginateDocument(doc, { measurer });

    // The document itself has not changed: the table of contents stays compact.
    expect(doc.blocks[0]?.type).toBe('toc');

    // But the layout does see a heading and two lines.
    expect(layout.generatedBlockIds.has(tocTitleId(toc.id))).toBe(true);
    expect(layout.generatedBlockIds.has(tocLineId(toc.id, 0))).toBe(true);
    expect(layout.generatedBlockIds.has(tocLineId(toc.id, 1))).toBe(true);
  });

  it('rend chaque ligne cliquable vers son titre', () => {
    const toc = createToc();
    const alpha = titre('Alpha', 1);
    const doc = docOf([toc, alpha]);
    const layout = paginateDocument(doc, { measurer });

    expect(layout.tocTargets.get(tocLineId(toc.id, 0))).toBe(alpha.id);
  });

  it('affiche le numéro de page réel du titre visé', () => {
    const toc = createToc();
    const premier = titre('Premier', 1);
    // Enough material to push the second heading onto a following page.
    const remplissage = Array.from({ length: 90 }, (_, i) =>
      createParagraph(`Paragraphe de remplissage numéro ${i} pour occuper la page.`),
    );
    const second = titre('Second', 1);

    const doc = docOf([toc, premier, ...remplissage, second]);
    const layout = paginateDocument(doc, { measurer });

    const pagePremier = layout.placements.get(premier.id)?.[0]?.pageIndex ?? -1;
    const pageSecond = layout.placements.get(second.id)?.[0]?.pageIndex ?? -1;
    expect(pageSecond).toBeGreaterThan(pagePremier);

    const ligneSecond = layout.paragraphLayouts.get(tocLineId(toc.id, 1));
    const texte = ligneSecond?.lines.flatMap((l) => l.segments.map((s) => s.text)).join('') ?? '';

    // The line ends with the heading's 1-indexed page number.
    expect(texte.startsWith('Second')).toBe(true);
    expect(texte.trimEnd().endsWith(String(pageSecond + 1))).toBe(true);
  });

  it('converge en deux passes : la géométrie ne dépend pas des numéros', () => {
    const toc = createToc();
    const doc = docOf([
      toc,
      ...Array.from({ length: 12 }, (_, i) => titre(`Titre ${i}`, 1)),
    ]);

    const first = paginateDocument(doc, { measurer });
    const second = paginateDocument(doc, { measurer });

    // Two calls give the same result: the function stays pure despite the two internal passes.
    expect(second.pages).toHaveLength(first.pages.length);
    for (const [id, layout] of first.paragraphLayouts) {
      expect(second.paragraphLayouts.get(id)?.lines.length).toBe(layout.lines.length);
    }
  });

  it('affiche une ligne d\'explication quand aucun titre n\'existe', () => {
    const toc = createToc();
    const layout = paginateDocument(docOf([toc, createParagraph('du texte')]), { measurer });
    const ligne = layout.paragraphLayouts.get(tocLineId(toc.id, 0));
    const texte = ligne?.lines.flatMap((l) => l.segments.map((s) => s.text)).join('') ?? '';
    expect(texte).toContain('Aucun titre');
  });

  it('pose des points de suite, et les retire quand on les refuse', () => {
    const avecPoints = createToc({ useDotLeader: true });
    const sansPoints = createToc({ id: 'toc2', useDotLeader: false });

    const lireTexte = (toc: ReturnType<typeof createToc>): string => {
      const layout = paginateDocument(docOf([toc, titre('Court', 1)]), { measurer });
      const ligne = layout.paragraphLayouts.get(tocLineId(toc.id, 0));
      return ligne?.lines.flatMap((l) => l.segments.map((s) => s.text)).join('') ?? '';
    };

    expect(lireTexte(avecPoints)).toContain('....');
    expect(lireTexte(sansPoints)).not.toContain('..');
  });

  it('omet le numéro de page quand la définition le demande', () => {
    const toc = createToc({ showPageNumbers: false });
    const layout = paginateDocument(docOf([toc, titre('Sans numéro', 1)]), { measurer });
    const ligne = layout.paragraphLayouts.get(tocLineId(toc.id, 0));
    const texte = ligne?.lines.flatMap((l) => l.segments.map((s) => s.text)).join('') ?? '';
    expect(texte).toBe('Sans numéro');
  });

  it('un document sans sommaire garde une pagination inchangée', () => {
    const doc = docOf([titre('A', 1), createParagraph('texte')]);
    const layout = paginateDocument(doc, { measurer });
    expect(layout.tocTargets.size).toBe(0);
    expect(layout.generatedBlockIds.size).toBe(0);
  });
});

describe('Aller-retour ODF du sommaire', () => {
  it('exporte la définition et le rendu, réimporte la définition seule', () => {
    const toc = createToc({ title: 'Sommaire', maxLevel: 2, useDotLeader: true });
    const doc = docOf([toc, titre('Alpha', 1), titre('Beta', 2), titre('Trop bas', 3)]);

    const xml = buildContentXml(doc);
    expect(xml).toContain('<text:table-of-content');
    expect(xml).toContain('text:outline-level="2"');
    expect(xml).toContain('<text:index-title-template>Sommaire</text:index-title-template>');
    expect(xml).toContain('style:leader-char="."');
    // The rendering does contain the entries that were kept, not the level-3 one.
    expect(xml).toContain('Alpha');
    expect(xml).toContain('Beta');

    const { document: relu } = importOdfContent(xml);
    const [relue] = tocNodes(relu);
    expect(relue?.title).toBe('Sommaire');
    expect(relue?.maxLevel).toBe(2);
    expect(relue?.useDotLeader).toBe(true);
    expect(relue?.showPageNumbers).toBe(true);

    // The entries are not re-imported as frozen paragraphs: only the definition block remains, the headings staying the source.
    const paragraphes = relu.blocks.filter((b) => b.type !== 'toc');
    expect(paragraphes.some((b) => b.type === 'paragraph' && 'runs' in b && b.runs.some((r) => r.text.includes('....')))).toBe(false);
  });

  it('conserve le réglage « sans numéros de page »', () => {
    const toc = createToc({ showPageNumbers: false });
    const xml = buildContentXml(docOf([toc, titre('X', 1)]));
    const { document: relu } = importOdfContent(xml);
    expect(tocNodes(relu)[0]?.showPageNumbers).toBe(false);
  });

  it('exporte une ancre de renvoi sur chaque titre', () => {
    const h = titre('Cible', 1);
    const xml = buildContentXml(docOf([h]));
    expect(xml).toContain(`<text:bookmark text:name="${headingAnchorName(h.id)}"/>`);
  });
});
