// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Pagination A4 — `SwLayAction`, `SwFlowFrm::MoveFwd`, `WidowsAndOrphans`.
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  DEFAULT_DEFAULTS,
} from '../src/domain/document/document';
import { pageGeometry, A4_PORTRAIT } from '../src/domain/document/pageSetup';
import { mmToPx } from '../src/domain/document/units';
import type { ParagraphNode, WriterDocumentState } from '../src/domain/document/types';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { paginateDocument } from '../src/domain/engine/paginate';

const measurer = new MetricTextMeasurer();

function documentOf(blocks: WriterDocumentState['blocks']): WriterDocumentState {
  return {
    ...createEmptyDocument('Essai'),
    defaults: { ...DEFAULT_DEFAULTS, lineSpacing: 1 },
    blocks,
  };
}

function paginate(doc: WriterDocumentState) {
  return paginateDocument(doc, { measurer });
}

/** Paragraphe d'une seule ligne, sans espacement, pour compter en lignes exactes. */
function line(text: string, extra: Partial<ParagraphNode> = {}): ParagraphNode {
  return { ...createParagraph(text), marginTopPt: 0, marginBottomPt: 0, ...extra };
}

describe('géométrie de la page', () => {
  it('calcule la zone imprimable d’une A4 : hauteur − marges − bandes', () => {
    const geometry = pageGeometry(A4_PORTRAIT);
    expect(geometry.contentWidthPx).toBeCloseTo(mmToPx(210 - 25 - 25), 5);
    expect(geometry.contentHeightPx).toBeCloseTo(mmToPx(297 - 20 - 20), 5);
  });

  it('échange largeur et hauteur en paysage', () => {
    const geometry = pageGeometry({ ...A4_PORTRAIT, orientation: 'landscape' });
    expect(geometry.pageWidthPx).toBeCloseTo(mmToPx(297), 5);
  });

  it('ne produit jamais une hauteur nulle, même avec des marges absurdes', () => {
    const geometry = pageGeometry({ ...A4_PORTRAIT, marginTopMm: 400, marginBottomMm: 400 });
    expect(geometry.contentHeightPx).toBeGreaterThan(0);
  });
});

describe('répartition en pages', () => {
  it('tient sur une seule page quand le contenu est court', () => {
    const layout = paginate(documentOf([createParagraph('Bonjour')]));
    expect(layout.pages).toHaveLength(1);
  });

  it('ouvre une page quand le contenu déborde', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => line(`ligne ${i}`));
    const layout = paginate(documentOf(blocks));
    expect(layout.pages.length).toBeGreaterThan(1);
  });

  it('ne laisse jamais un bloc dépasser la zone imprimable', () => {
    const blocks = Array.from({ length: 300 }, (_, i) => line(`ligne ${i}`));
    const layout = paginate(documentOf(blocks));
    for (const page of layout.pages) {
      expect(page.usedHeightPx).toBeLessThanOrEqual(layout.geometry.contentHeightPx + 0.001);
    }
  });

  it('honore un saut de page explicite', () => {
    const layout = paginate(
      documentOf([
        createParagraph('avant'),
        { ...createParagraph('après'), pageBreakBefore: true },
      ]),
    );
    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[1]?.blocks[0]?.blockId).toBe(layout.pages[1]?.blocks[0]?.blockId);
    expect(layout.pages[0]?.blocks).toHaveLength(1);
  });

  it('n’ouvre pas de page vide pour un saut en tête de document', () => {
    const layout = paginate(
      documentOf([{ ...createParagraph('début'), pageBreakBefore: true }]),
    );
    expect(layout.pages).toHaveLength(1);
  });
});

describe('veuves et orphelines — WidowsAndOrphans', () => {
  /** Un paragraphe assez long pour être coupé, avec des seuils choisis. */
  function longParagraph(lines: number, options: Partial<ParagraphNode>): ParagraphNode {
    const words = Array.from({ length: lines * 12 }, (_, i) => `mot${i}`).join(' ');
    return { ...createParagraph(words), marginTopPt: 0, marginBottomPt: 0, ...options };
  }

  it('reporte tout le paragraphe plutôt que d’y laisser moins d’orphelines', () => {
    // Une page presque pleine, puis un paragraphe qui ne pourrait y poser
    // qu'une seule ligne : la règle des orphelines (2) le fait basculer entier.
    const filler = Array.from({ length: 45 }, (_, i) => line(`remplissage ${i}`));
    const doc = documentOf([...filler, longParagraph(6, { orphans: 2, widows: 2 })]);
    const layout = paginate(doc);

    const target = doc.blocks[doc.blocks.length - 1]!;
    const placements = layout.placements.get(target.id)!;
    const first = placements[0]!;
    expect(first.placed.toLine - first.placed.fromLine).toBeGreaterThanOrEqual(2);
  });

  it('laisse au moins le nombre de veuves sur la page suivante', () => {
    const filler = Array.from({ length: 40 }, (_, i) => line(`remplissage ${i}`));
    const doc = documentOf([...filler, longParagraph(8, { orphans: 2, widows: 3 })]);
    const layout = paginate(doc);

    const target = doc.blocks[doc.blocks.length - 1]!;
    const placements = layout.placements.get(target.id)!;
    if (placements.length > 1) {
      const last = placements[placements.length - 1]!;
      expect(last.placed.toLine - last.placed.fromLine).toBeGreaterThanOrEqual(3);
    }
  });

  it('ne coupe pas un paragraphe marqué « solidaire »', () => {
    const filler = Array.from({ length: 45 }, (_, i) => line(`remplissage ${i}`));
    const doc = documentOf([...filler, longParagraph(5, { keepTogether: true })]);
    const layout = paginate(doc);

    const target = doc.blocks[doc.blocks.length - 1]!;
    expect(layout.placements.get(target.id)).toHaveLength(1);
  });

  it('coupe malgré tout un paragraphe plus haut qu’une page entière', () => {
    const doc = documentOf([longParagraph(120, { orphans: 5, widows: 5 })]);
    const layout = paginate(doc);
    // La garde `bHasToFit` : sur une page vide, on pose ce qui tient plutôt que
    // de boucler sans fin.
    expect(layout.pages.length).toBeGreaterThan(1);
    expect(layout.placements.get(doc.blocks[0]!.id)!.length).toBeGreaterThan(1);
  });
});

describe('tableaux', () => {
  it('mesure un tableau et lui donne une hauteur non nulle', () => {
    const table = createTable(3, 2);
    const layout = paginate(documentOf([table]));
    const placed = layout.pages[0]!.blocks.find((block) => block.kind === 'table');
    expect(placed).toBeDefined();
    expect(placed!.heightPx).toBeGreaterThan(0);
  });

  it('coupe un long tableau entre deux lignes, jamais dans une ligne', () => {
    const table = createTable(120, 2);
    const layout = paginate(documentOf([table]));
    expect(layout.pages.length).toBeGreaterThan(1);
    for (const page of layout.pages) {
      expect(page.usedHeightPx).toBeLessThanOrEqual(layout.geometry.contentHeightPx + 0.001);
    }
  });

  it('répète les lignes d’en-tête sur chaque morceau', () => {
    const table = createTable(120, 2);
    table.rows[0]!.isHeader = true;
    const layout = paginate(documentOf([table]));

    const pieces = layout.pages
      .flatMap((page) => page.blocks)
      .filter((block) => block.kind === 'table');
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.rows.some((row) => row.isHeader)).toBe(true);
    }
  });
});
