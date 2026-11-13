// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * The five entries of the image's wrap menu, applied to an image that **starts** its paragraph:
 * the usual case right after an insertion, where the anchor character comes first in the line.
 *
 * That anchor takes no height. Probing the first line with it alone gave a zero-height line that no
 * frame overlapped, so the text stayed on top of the image whatever the mode.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import { pageGeometry } from '../src/domain/document/pageSetup';
import { pxToPt } from '../src/domain/document/units';
import { defaultFlyPlacement, wrapFormatting, type ImageWrapMode } from '../src/domain/document/images';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import type { DocumentBlock } from '../src/domain/document/types';

const measurer = new MetricTextMeasurer();
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);

function docWith(mode: ImageWrapMode, widthRatio: number) {
  const base = createEmptyDocument();
  const contentWidthPt = pxToPt(pageGeometry(base.pageSetup).contentWidthPx);
  const image = makeRun('￼', {
    imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
    imageWidthPt: contentWidthPt * widthRatio,
    imageHeightPt: 200,
    imageWrapMarginPt: 0,
    ...wrapFormatting(mode),
    ...(mode === 'inline' ? {} : defaultFlyPlacement(mode)),
  });
  const anchor = { ...createParagraph(''), runs: [image, makeRun('fzfefezfefzefezfe')] };
  const blocks: DocumentBlock[] = [anchor, createParagraph('gzgegrgre'), createParagraph(LOREM)];
  return { doc: { ...base, blocks }, blocks };
}

/** Lines in the content area's frame of reference, for every paragraph of page 1. */
function linesOf(layout: ReturnType<typeof paginateDocument>, blocks: DocumentBlock[]) {
  return blocks.flatMap((block) => {
    const entry = layout.placements.get(block.id)![0]!;
    const placed = entry.placed;
    const top = placed.topPx + placed.layout.marginTopPx;
    return placed.layout.lines.map((line) => ({
      top: top + line.topPx,
      bottom: top + line.topPx + line.heightPx,
      left: line.leftPx,
      right: line.leftPx + line.widthPx,
      text: line.segments.map((s) => s.text).join('').replace('￼', ''),
      blockId: block.id,
    }));
  });
}

describe('Menu d’habillage d’une image en tête de paragraphe', () => {
  for (const ratio of [1, 0.95, 0.6]) {
    for (const mode of ['wrap', 'break'] as const) {
      it(`${mode} à ${ratio * 100} % : aucune ligne ne passe sur l’image`, () => {
        const { doc, blocks } = docWith(mode, ratio);
        const layout = paginateDocument(doc, { measurer });
        const frame = layout.pages[0]!.flies![0]!;
        for (const line of linesOf(layout, blocks)) {
          if (!line.text) continue;
          const crossesY = line.top < frame.topPx + frame.heightPx && line.bottom > frame.topPx;
          const crossesX = line.left < frame.leftPx + frame.widthPx && line.right > frame.leftPx;
          expect(crossesY && crossesX, `« ${line.text} » passe sur l’image`).toBe(false);
        }
        // Nor on one another: the paragraph that follows starts below the lines moved under the frame.
        const lines = linesOf(layout, blocks).sort((a, b) => a.top - b.top);
        for (let i = 1; i < lines.length; i += 1) {
          const sameRow =
            lines[i]!.blockId === lines[i - 1]!.blockId && Math.abs(lines[i]!.top - lines[i - 1]!.top) < 0.5;
          if (!sameRow) expect(lines[i]!.top).toBeGreaterThanOrEqual(lines[i - 1]!.bottom - 0.5);
        }
      });
    }
  }

  it('« Intercaler le texte » met tout le texte sous l’image, même à côté d’une image étroite', () => {
    const { doc, blocks } = docWith('break', 0.4);
    const layout = paginateDocument(doc, { measurer });
    const frame = layout.pages[0]!.flies![0]!;
    for (const line of linesOf(layout, blocks)) {
      expect(line.top).toBeGreaterThanOrEqual(frame.topPx + frame.heightPx - 0.5);
    }
  });

  it('« Retour à la ligne » écrit à côté d’une image étroite', () => {
    const { doc, blocks } = docWith('wrap', 0.6);
    const layout = paginateDocument(doc, { measurer });
    const frame = layout.pages[0]!.flies![0]!;
    const first = linesOf(layout, blocks)[0]!;
    expect(first.top).toBeLessThan(frame.topPx + frame.heightPx);
  });

  for (const mode of ['behind', 'front'] as const) {
    it(`${mode} : le texte reste à sa place, sous ou sur l’image`, () => {
      const { doc, blocks } = docWith(mode, 1);
      const layout = paginateDocument(doc, { measurer });
      expect(layout.pages[0]!.flies).toHaveLength(1);
      expect(linesOf(layout, blocks)[0]!.top).toBeCloseTo(0, 3);
    });
  }

  it('« Aligner » garde l’image dans la ligne, comme un caractère', () => {
    const { doc, blocks } = docWith('inline', 0.5);
    const layout = paginateDocument(doc, { measurer });
    expect(layout.pages[0]!.flies ?? []).toHaveLength(0);
    expect(linesOf(layout, blocks)[0]!.bottom).toBeGreaterThan(ptToPxApprox(200));
  });
});

function ptToPxApprox(pt: number): number {
  return (pt * 96) / 72 - 1;
}
