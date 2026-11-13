// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Placement of floating images, compared to OpenOffice Writer:
 *
 *  - the band carved out of the text sits exactly under the painted frame, space above the paragraph included;
 *  - a frame anchored near the bottom of the page is pushed back onto the sheet (`SwFlyFreeFrm::CheckClip`),
 *    and the text goes around it where it is really painted;
 *  - page frames written by OpenOffice between paragraphs are imported, at the right height.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import { pageGeometry } from '../src/domain/document/pageSetup';
import { pxToPt } from '../src/domain/document/units';
import { paginateDocument } from '../src/domain/engine/paginate';
import { clampFlyTopPx } from '../src/domain/engine/flyLayout';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { importOdfContent } from '../src/domain/odf/import';
import type { DocumentBlock, ParagraphNode, TextRun } from '../src/domain/document/types';

const measurer = new MetricTextMeasurer();
const LONG = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(8);

function fly(extra: Partial<TextRun> = {}): TextRun {
  return makeRun('￼', {
    imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
    imageWidthPt: 100,
    imageHeightPt: 60,
    imageAnchor: 'to-para',
    imageSurround: 'parallel',
    imageHoriOrient: 'right',
    imageXPt: 0,
    imageYPt: 0,
    imageWrapMarginPt: 0,
    ...extra,
  });
}

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

/** Absolute lines (content-area frame of reference) of a placed paragraph. */
function absoluteLines(layout: ReturnType<typeof paginateDocument>, blockId: string) {
  const entry = layout.placements.get(blockId)![0]!;
  const placed = entry.placed;
  return {
    pageIndex: entry.pageIndex,
    lines: placed.layout.lines.slice(placed.fromLine, placed.toLine).map((line) => ({
      top: placed.topPx + (placed.isContinuation ? 0 : placed.layout.marginTopPx) + line.topPx,
      height: line.heightPx,
      right: line.leftPx + line.widthPx,
    })),
  };
}

describe('Bande de texte sous le cadre peint', () => {
  it("suit l'image même quand le paragraphe a un espace au-dessus", () => {
    const anchor: ParagraphNode = {
      ...createParagraph(''),
      marginTopPt: 20,
      runs: [fly(), makeRun(LONG, {})],
    };
    const layout = paginateDocument(docOf([createParagraph(LONG), anchor]), { measurer });
    const laid = layout.pages[0]!.flies![0]!;
    const { lines } = absoluteLines(layout, anchor.id);

    const frameBottom = laid.topPx + laid.heightPx;
    for (const line of lines) {
      const crosses = line.top < frameBottom && line.top + line.height > laid.topPx;
      if (crosses) expect(line.right).toBeLessThanOrEqual(laid.leftPx + 0.5);
    }
    // The first line entirely below the frame takes the whole width again: no band left empty under it.
    const below = lines.find((line) => line.top >= frameBottom)!;
    expect(below.right).toBeGreaterThan(laid.leftPx);
  });
});

describe('Cadre maintenu sur la feuille (CheckClip)', () => {
  it('clampFlyTopPx garde le cadre entre les bords de la feuille', () => {
    const geometry = { pageHeightPx: 1000, contentTopPx: 100 };
    expect(clampFlyTopPx(50, 100, geometry)).toBe(50);
    expect(clampFlyTopPx(900, 100, geometry)).toBe(800);
    expect(clampFlyTopPx(-500, 100, geometry)).toBe(-100);
    // Taller than the sheet: it sticks to the top edge.
    expect(clampFlyTopPx(0, 2000, geometry)).toBe(-100);
  });

  it("remonte un cadre ancré en bas de page, et le texte le contourne là où il est peint", () => {
    const geometry = pageGeometry(createEmptyDocument().pageSetup);
    const anchor: ParagraphNode = {
      ...createParagraph(''),
      runs: [fly({ imageYPt: pxToPt(geometry.contentHeightPx) }), makeRun('Ancre', {})],
    };
    const filler = createParagraph(LONG);
    const layout = paginateDocument(docOf([anchor, filler]), { measurer });
    const laid = layout.pages[0]!.flies![0]!;

    expect(laid.topPx + laid.heightPx).toBeLessThanOrEqual(
      geometry.pageHeightPx - geometry.contentTopPx + 0.01,
    );
    expect(laid.topPx - laid.anchorTopPx).toBeLessThan(geometry.contentHeightPx);

    // A frame high on the page, on the filler's lines: they must leave the frame's side free.
    const high: ParagraphNode = {
      ...createParagraph(''),
      runs: [fly({ imageYPt: 0 }), makeRun(LONG, {})],
    };
    const layout2 = paginateDocument(docOf([high]), { measurer });
    const laid2 = layout2.pages[0]!.flies![0]!;
    expect(laid2.anchorTopPx).toBe(0);
    expect(laid2.topPx).toBe(0);
  });
});

describe('Import des cadres ancrés à la page (ODF)', () => {
  const NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink"';

  function contentWith(vertical: string, frameAttrs: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}>` +
      `<office:automatic-styles><style:style style:name="fr1" style:family="graphic">` +
      `<style:graphic-properties style:wrap="parallel" ${vertical} ` +
      `style:horizontal-pos="from-left" style:horizontal-rel="page"/></style:style>` +
      `</office:automatic-styles><office:body><office:text>` +
      `<draw:frame draw:style-name="fr1" text:anchor-type="page" text:anchor-page-number="1" ${frameAttrs} ` +
      `svg:width="5cm" svg:height="3cm"><draw:image xlink:href="https://exemple.org/a.png"/></draw:frame>` +
      `<text:p>Premier paragraphe</text:p>` +
      `</office:text></office:body></office:document-content>`
    );
  }

  function firstFrame(xml: string): TextRun {
    const { document } = importOdfContent(xml);
    const paragraph = document.blocks[0] as ParagraphNode;
    const run = paragraph.runs.find((r) => r.imageSrc);
    expect(run).toBeDefined();
    expect(paragraph.runs.map((r) => r.text).join('')).toContain('Premier paragraphe');
    return run!;
  }

  it("garde l'image posée entre les paragraphes au lieu de la perdre", () => {
    const run = firstFrame(
      contentWith('style:vertical-pos="from-top" style:vertical-rel="page-content"', 'svg:x="2cm" svg:y="1cm"'),
    );
    expect(run.imageAnchor).toBe('to-page');
    expect(run.imageHoriRelation).toBe('page');
    expect(run.imageYPt).toBeCloseTo(28.35, 1);
  });

  it('ramène svg:y mesuré depuis le bord de la feuille dans la zone imprimable', () => {
    const geometry = pageGeometry(createEmptyDocument().pageSetup);
    const run = firstFrame(
      contentWith('style:vertical-pos="from-top" style:vertical-rel="page"', 'svg:x="2cm" svg:y="5cm"'),
    );
    expect(run.imageYPt).toBeCloseTo(5 * 28.3465 - pxToPt(geometry.contentTopPx), 1);
  });

  it('résout un cadre centré verticalement sur la page', () => {
    const geometry = pageGeometry(createEmptyDocument().pageSetup);
    const run = firstFrame(contentWith('style:vertical-pos="middle" style:vertical-rel="page"', 'svg:x="2cm"'));
    const attendu =
      -pxToPt(geometry.contentTopPx) + (pxToPt(geometry.pageHeightPx) - 3 * 28.3465) / 2;
    expect(run.imageYPt).toBeCloseTo(attendu, 1);
    // Painted at mid-height of the sheet.
    const layout = paginateDocument(importOdfContent(
      contentWith('style:vertical-pos="middle" style:vertical-rel="page"', 'svg:x="2cm"'),
    ).document, { measurer });
    const laid = layout.pages[0]!.flies![0]!;
    const milieu = geometry.contentTopPx + laid.topPx + laid.heightPx / 2;
    expect(milieu).toBeCloseTo(geometry.pageHeightPx / 2, 0);
  });
});
