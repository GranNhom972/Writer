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
import { paragraphIndex } from '../src/domain/document/document';
import type { WriterDocumentState } from '../src/domain/document/types';

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
