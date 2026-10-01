// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Ce que `Ctrl+A` doit peindre.
 *
 * Le piège est une asymétrie légitime entre deux notions voisines : un sommaire
 * est **protégé en écriture** — le curseur ne peut pas s'y poser, comme dans un
 * `SwTOXBase` — mais il n'est pas protégé en **sélection**. Les deux repères
 * étaient confondus : la peinture des rectangles suivait l'index d'édition, qui
 * écarte les sommaires, et une sélection totale les laissait donc en blanc.
 *
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { openOdt } from '../src/domain/odf/package';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { selectAll, type EditorState } from '../src/domain/engine/edit';
import { selectionRects } from '../src/domain/engine/cursor';
import {
  createEmptyDocument,
  createParagraph,
  paragraphIndex,
  paragraphText,
} from '../src/domain/document/document';
import { createToc } from '../src/domain/document/tox';
import type { DocumentBlock, HeadingLevel, WriterDocumentState } from '../src/domain/document/types';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let doc: WriterDocumentState;

beforeAll(async () => {
  const octets = await readFile(resolve(RACINE, 'exemple', 'doc_test.odt'));
  doc = (await openOdt(new Uint8Array(octets))).document;
});

function toutSelectionner(document_: WriterDocumentState): EditorState {
  const depart: EditorState = {
    doc: document_,
    selection: {
      anchor: { blockId: '', offset: 0 },
      focus: { blockId: '', offset: 0 },
      isCollapsed: true,
    },
    pendingFormat: null,
  };
  return selectAll(depart);
}

describe('Sélection totale', () => {
  it('couvre toutes les pages, sommaire compris', () => {
    const measurer = new MetricTextMeasurer();
    const layout = paginateDocument(doc, { measurer });
    const rects = selectionRects(doc, layout, toutSelectionner(doc).selection, measurer);

    // Le document d'exemple porte un sommaire assez long pour occuper une page
    // entière : c'est elle qui restait vierge, faute d'un seul rectangle.
    expect(layout.generatedBlockIds.size).toBeGreaterThan(0);

    const pagesAvecTexte = layout.pages
      .filter((page) => page.blocks.some((bloc) => bloc.kind === 'paragraph'))
      .map((page) => page.index);
    const pagesSurlignees = new Set(rects.map((rect) => rect.pageIndex));

    for (const index of pagesAvecTexte) {
      expect(pagesSurlignees.has(index)).toBe(true);
    }
  });

  it('peint chaque bloc réellement posé, y compris les lignes engendrées', () => {
    const measurer = new MetricTextMeasurer();
    const layout = paginateDocument(doc, { measurer });
    const rects = selectionRects(doc, layout, toutSelectionner(doc).selection, measurer);

    const nonPeints: string[] = [];
    for (const blockId of layout.readingOrder) {
      const poses = layout.placements.get(blockId);
      if (!poses) continue;
      // Un rectangle commence après la marge haute du paragraphe : le test
      // porte donc sur un chevauchement avec sa boîte, pas sur son sommet.
      const peint = poses.some(({ pageIndex, placed }) =>
        rects.some(
          (rect) =>
            rect.pageIndex === pageIndex &&
            rect.topPx >= placed.topPx - 1 &&
            rect.topPx < placed.topPx + placed.heightPx + 1,
        ),
      );
      if (!peint) nonPeints.push(blockId);
    }

    expect(nonPeints).toEqual([]);
  });

  it('laisse le sommaire hors de portée du curseur', () => {
    // La contrepartie : peindre le sommaire ne doit pas le rendre éditable.
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const { order } = paragraphIndex(doc);
    for (const engendre of layout.generatedBlockIds) {
      expect(order).not.toContain(engendre);
    }
  });

  it('ordonne les lignes engendrées à la place du sommaire dans le document', () => {
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const { order } = paragraphIndex(doc);

    // L'ordre de pose contient tout l'ordre d'édition, dans le même ordre —
    // les lignes engendrées viennent s'y intercaler, jamais s'y substituer.
    const filtre = layout.readingOrder.filter((id) => !layout.generatedBlockIds.has(id));
    expect(filtre).toEqual(order);
  });
});

/**
 * Le même sommaire, mais au **bord** du document.
 *
 * Les lignes engendrées ne portent aucune position posable. Un sommaire qui
 * ouvre le document n'a donc rien d'éditable avant lui : la première position
 * du document tombe après ses lignes, et les encadrer par deux rangs de
 * l'ordre de pose ne suffit plus — c'est le même symptôme que plus haut, revenu
 * là où l'encadrement n'a pas de borne à offrir.
 */
describe('Sélection totale, sommaire au bord du document', () => {
  const titre = (texte: string, niveau: HeadingLevel) =>
    createParagraph(texte, { headingLevel: niveau });

  function docDe(blocks: DocumentBlock[]): WriterDocumentState {
    return { ...createEmptyDocument(), blocks };
  }

  /** Les lignes engendrées effectivement recouvertes par un rectangle. */
  function sommairePeint(document_: WriterDocumentState, selection = toutSelectionner(document_).selection) {
    const measurer = new MetricTextMeasurer();
    const layout = paginateDocument(document_, { measurer });
    const rects = selectionRects(document_, layout, selection, measurer);

    const peintes = [...layout.generatedBlockIds].filter((id) => {
      const poses = layout.placements.get(id);
      if (!poses) return false;
      return poses.some(({ pageIndex, placed }) =>
        rects.some(
          (rect) =>
            rect.pageIndex === pageIndex &&
            rect.topPx >= placed.topPx - 1 &&
            rect.topPx < placed.topPx + placed.heightPx + 1,
        ),
      );
    });
    return { engendrees: layout.generatedBlockIds.size, peintes: peintes.length };
  }

  const dernier = createParagraph('Un autre paragraphe.');
  const corps: DocumentBlock[] = [
    titre('Premier titre', 1),
    createParagraph('Un paragraphe de corps.'),
    titre('Second titre', 1),
    dernier,
  ];

  it('peint un sommaire qui ouvre le document', () => {
    const compte = sommairePeint(docDe([createToc(), ...corps]));
    expect(compte.engendrees).toBeGreaterThan(0);
    expect(compte.peintes).toBe(compte.engendrees);
  });

  it('peint un sommaire qui clôt le document', () => {
    const compte = sommairePeint(docDe([...corps, createToc()]));
    expect(compte.engendrees).toBeGreaterThan(0);
    expect(compte.peintes).toBe(compte.engendrees);
  });

  it('laisse hors sélection un sommaire que la plage n\'atteint pas', () => {
    // La contrepartie de l'extension : elle ne vaut que pour une plage qui
    // touche le bord du document. Ici la sélection s'arrête à la fin du
    // paragraphe qui précède le sommaire, lequel doit rester blanc.
    const avant = createParagraph('Avant le sommaire.');
    const document_ = docDe([avant, createToc(), ...corps]);
    const selection = {
      anchor: { blockId: avant.id, offset: 0 },
      focus: { blockId: avant.id, offset: paragraphText(avant).length },
      isCollapsed: false,
    };

    const compte = sommairePeint(document_, selection);
    expect(compte.engendrees).toBeGreaterThan(0);
    expect(compte.peintes).toBe(0);
  });

  it('ne peint rien hors de la plage quand le sommaire ouvre et que la plage commence plus loin', () => {
    // Une plage qui part du deuxième paragraphe du corps : le sommaire qui
    // ouvre le document est avant elle, il n'a pas à être peint.
    const document_ = docDe([createToc(), ...corps]);
    const selection = {
      anchor: { blockId: dernier.id, offset: 0 },
      focus: { blockId: dernier.id, offset: paragraphText(dernier).length },
      isCollapsed: false,
    };

    const compte = sommairePeint(document_, selection);
    expect(compte.peintes).toBe(0);
  });
});

/**
 * Une ligne **justifiée** n'a pas la largeur qu'on lui a mesurée.
 *
 * La justification répartit l'espace restant sur les blancs de la ligne
 * (`wordSpacingPx`), et le rendu le confie à `word-spacing` : la ligne peinte
 * va donc jusqu'au bord de la colonne, bien au-delà de la largeur des segments.
 * Peindre la sélection d'après cette dernière laissait le **dernier mot de
 * chaque ligne justifiée** en blanc — un damier de queues non surlignées au
 * milieu d'un `Ctrl+A`.
 */
describe('Sélection d\'un paragraphe justifié', () => {
  const texte =
    'Ce document exerce chaque sous-système porté depuis le code C++ de ' +
    'StarWriter. Il est engendré par un script qui vérifie sa longueur et son ' +
    'aller-retour ODF avant de l\'écrire, puis relu ligne à ligne pour que la ' +
    'justification ait de quoi étirer plusieurs lignes pleines.';

  function lignesJustifiees() {
    const measurer = new MetricTextMeasurer();
    const paragraphe = createParagraph(texte, { alignment: 'justify' });
    const document_ = { ...createEmptyDocument(), blocks: [paragraphe] };
    const layout = paginateDocument(document_, { measurer });
    const rects = selectionRects(document_, layout, toutSelectionner(document_).selection, measurer);
    const paragraphLayout = layout.paragraphLayouts.get(paragraphe.id)!;
    const placed = layout.placements.get(paragraphe.id)![0]!;

    return { paragraphLayout, placed, rects };
  }

  it('étire le rectangle jusqu\'à la fin peinte de la ligne', () => {
    const { paragraphLayout, placed, rects } = lignesJustifiees();

    const etirees = paragraphLayout.lines.filter((line) => line.wordSpacingPx > 0);
    expect(etirees.length).toBeGreaterThan(0);

    let top = placed.placed.topPx + paragraphLayout.marginTopPx;
    for (const line of paragraphLayout.lines) {
      if (line.wordSpacingPx > 0) {
        const rect = rects.find((r) => Math.abs(r.topPx - top) < 1);
        expect(rect).toBeDefined();

        // La largeur peinte : celle des segments, plus l'étirement porté par
        // chaque blanc de la ligne.
        const blancs = line.segments.reduce(
          (total, segment) => total + [...segment.text].filter((c) => c === ' ').length,
          0,
        );
        const peinte = line.widthPx + blancs * line.wordSpacingPx;

        expect(peinte).toBeGreaterThan(line.widthPx);
        expect(rect!.widthPx).toBeCloseTo(peinte, 1);
      }
      top += line.heightPx;
    }
  });

  it('laisse la dernière ligne à sa largeur mesurée', () => {
    // Contrepartie : la dernière ligne d'un paragraphe n'est pas justifiée, son
    // rectangle ne doit donc pas s'étendre jusqu'au bord de la colonne.
    const { paragraphLayout, placed, rects } = lignesJustifiees();
    const derniere = paragraphLayout.lines[paragraphLayout.lines.length - 1]!;
    expect(derniere.wordSpacingPx).toBe(0);

    let top = placed.placed.topPx + paragraphLayout.marginTopPx;
    for (const line of paragraphLayout.lines) {
      if (line === derniere) break;
      top += line.heightPx;
    }

    const rect = rects.find((r) => Math.abs(r.topPx - top) < 1);
    expect(rect).toBeDefined();
    expect(rect!.widthPx).toBeCloseTo(derniere.widthPx, 1);
  });
});
