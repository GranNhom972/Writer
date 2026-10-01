// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * What `Ctrl+A` must paint.
 *
 * The trap is a legitimate asymmetry between two neighboring notions: a table of contents is **write-protected** (the cursor cannot land in it, as in a `SwTOXBase`) but it is not **selection**-protected. The two were
 * confused: painting the rectangles followed the editing index, which leaves out tables of contents, so a select-all left them white.
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

    // The sample document carries a table of contents long enough to fill a whole page: it is that page that stayed blank, for lack of a single rectangle.
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
      // A rectangle starts after the paragraph's top margin: the test therefore checks for an overlap with its box, not its top.
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
    // The flip side: painting the table of contents must not make it editable.
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const { order } = paragraphIndex(doc);
    for (const engendre of layout.generatedBlockIds) {
      expect(order).not.toContain(engendre);
    }
  });

  it('ordonne les lignes engendrées à la place du sommaire dans le document', () => {
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    const { order } = paragraphIndex(doc);

    // The layout order contains the whole editing order, in the same order: the generated lines slot into it, never replace anything in it.
    const filtre = layout.readingOrder.filter((id) => !layout.generatedBlockIds.has(id));
    expect(filtre).toEqual(order);
  });
});

/**
 * The same table of contents, but at the **edge** of the document.
 *
 * The generated lines carry no placeable position. A table of contents that opens the document therefore has nothing editable before it: the first position of the document falls after its lines, and framing them with two
 * ranks of the layout order is no longer enough: it is the same symptom as above, back where the framing has no boundary to offer.
 */
describe('Sélection totale, sommaire au bord du document', () => {
  const titre = (texte: string, niveau: HeadingLevel) =>
    createParagraph(texte, { headingLevel: niveau });

  function docDe(blocks: DocumentBlock[]): WriterDocumentState {
    return { ...createEmptyDocument(), blocks };
  }

  /** The generated lines actually covered by a rectangle. */
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
    // The flip side of the extension: it only applies to a range that touches the edge of the document. Here the selection stops at the end of the paragraph that precedes the table of contents, which must stay white.
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
    // A range that starts from the second paragraph of the body: the table of contents that opens the document is before it, it must not be painted.
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
 * A **justified** line does not have the width that was measured for it.
 *
 * Justification spreads the remaining space over the blanks of the line (`wordSpacingPx`), and the rendering hands that to `word-spacing`: the painted line therefore goes right up to the edge of the column, well beyond the
 * width of the segments. Painting the selection from the latter left the **last word of every justified line** white: a checkerboard of unhighlighted tails in the middle of a `Ctrl+A`.
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

        // The painted width: that of the segments, plus the stretch carried by each blank of the line.
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
    // The flip side: the last line of a paragraph is not justified, so its rectangle must not extend to the edge of the column.
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
