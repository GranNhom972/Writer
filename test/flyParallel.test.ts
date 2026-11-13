// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * `parallel` wrapping around a frame in the middle of the column, as OpenOffice Writer does it:
 * the line is filled on the left of the frame, a `SwFlyPortion` jumps over it, and the **same**
 * line goes on to its right (`SwTxtFormatter::CalcFlyWidth`, `sw/source/core/text/itrform2.cxx`).
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { caretXOnLine, offsetFromX } from '../src/domain/engine/cursor';
import { usableBand, usableBands, type FlyExclusion } from '../src/domain/engine/flyLayout';
import { layoutParagraph, segmentWordSpacing, type LayoutLine } from '../src/domain/engine/lineBreak';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import type { Alignment } from '../src/domain/document/types';

const measurer = new MetricTextMeasurer();
const TEXT = 'Le vif renard brun saute par-dessus le chien paresseux. '.repeat(8);
/** A frame in the middle of a 600 px column, over the first lines. */
const MIDDLE: FlyExclusion = { topPx: 0, bottomPx: 60, leftPx: 250, rightPx: 350 };

function layout(text: string, exclusions: FlyExclusion[], alignment?: Alignment) {
  return layoutParagraph(createParagraph(text, alignment ? { alignment } : {}), {
    measurer,
    defaults: createEmptyDocument().defaults,
    contentWidthPx: 600,
    exclusions,
  });
}

/** Painted extent of the text on each side of the gap. */
function sides(line: LayoutLine) {
  const gap = line.segments.findIndex((segment) => segment.flyGap);
  const left = line.segments.slice(0, gap);
  const right = line.segments.slice(gap + 1);
  const paintedRight = (segments: typeof left) => {
    const last = segments[segments.length - 1]!;
    const blanks = [...last.text].filter((c) => c === ' ').length;
    return last.leftPx + last.widthPx + blanks * segmentWordSpacing(line, last);
  };
  return {
    gap: line.segments[gap]!,
    leftEnd: paintedRight(left),
    rightStart: right[0]!.leftPx,
    rightEnd: paintedRight(right),
  };
}

describe('Bandes libres', () => {
  it('rend les deux côtés d’un cadre central, de gauche à droite', () => {
    expect(usableBands([MIDDLE], 0, 20, 600)).toEqual([
      { leftPx: 0, rightPx: 250 },
      { leftPx: 350, rightPx: 600 },
    ]);
    // The widest band is still available to whoever needs only one.
    const offCentre: FlyExclusion = { ...MIDDLE, leftPx: 200, rightPx: 300 };
    expect(usableBand([offCentre], 0, 20, 600)).toEqual({ leftPx: 300, rightPx: 600 });
  });

  it('écarte une bande trop étroite pour y écrire', () => {
    const nearLeft: FlyExclusion = { ...MIDDLE, leftPx: 10, rightPx: 300 };
    expect(usableBands([nearLeft], 0, 20, 600)).toEqual([{ leftPx: 300, rightPx: 600 }]);
  });
});

describe('Habillage parallèle d’un cadre central', () => {
  it('écrit des deux côtés du cadre sur la même ligne', () => {
    const { lines } = layout(TEXT, [MIDDLE]);
    const crossing = lines.filter((line) => line.topPx < MIDDLE.bottomPx);
    expect(crossing.length).toBeGreaterThan(0);

    for (const line of crossing) {
      const { gap, leftEnd, rightStart, rightEnd } = sides(line);
      // Text on the left stops before the frame, text on the right starts after it.
      expect(leftEnd).toBeLessThanOrEqual(MIDDLE.leftPx + 0.5);
      expect(rightStart).toBeGreaterThanOrEqual(MIDDLE.rightPx - 0.5);
      expect(rightEnd).toBeLessThanOrEqual(600 + 0.5);
      // The gap is exactly the jump between the two.
      expect(gap.leftPx + gap.widthPx).toBeCloseTo(rightStart, 3);
      expect(gap.startOffset).toBe(gap.endOffset);
    }
  });

  it('reprend toute la largeur sous le cadre', () => {
    const { lines } = layout(TEXT, [MIDDLE]);
    const below = lines.find((line) => line.topPx >= MIDDLE.bottomPx)!;
    expect(below.segments.some((segment) => segment.flyGap)).toBe(false);
    expect(below.widthPx).toBeGreaterThan(400);
  });

  it('ne perd ni ne double aucun caractère', () => {
    const { lines } = layout(TEXT, [MIDDLE]);
    let painted = '';
    let expected = '';
    for (const line of lines) {
      for (const segment of line.segments) painted += segment.text;
      expected += TEXT.slice(line.startOffset, line.endOffset).replace(/ +/g, ' ');
    }
    // Only the blanks swallowed at a cut (before the frame, or at the end of a line) disappear.
    expect(painted.replace(/ +/g, '')).toBe(TEXT.replace(/ +/g, ''));
    expect(expected.replace(/ +/g, '')).toBe(TEXT.replace(/ +/g, ''));
  });

  it('justifie chaque côté jusqu’à son bord : le cadre à gauche, la marge à droite', () => {
    const { lines } = layout(TEXT, [MIDDLE], 'justify');
    const line = lines.find((l) => l.topPx < MIDDLE.bottomPx && !l.isLast)!;
    const { leftEnd, rightStart, rightEnd } = sides(line);
    expect(leftEnd).toBeCloseTo(MIDDLE.leftPx, 0);
    expect(rightStart).toBeCloseTo(MIDDLE.rightPx, 0);
    expect(rightEnd).toBeCloseTo(600, 0);
  });

  it('fait sauter le cadre à un mot qui ne tient pas à sa gauche', () => {
    const narrow: FlyExclusion = { topPx: 0, bottomPx: 60, leftPx: 30, rightPx: 200 };
    const { lines } = layout('Anticonstitutionnellement suivi de mots courts. '.repeat(4), [narrow]);
    const first = lines[0]!;
    expect(first.segments.some((segment) => segment.flyGap)).toBe(false);
    expect(first.leftPx).toBeGreaterThanOrEqual(200);
  });

  it('arrête la ligne sur un saut de ligne, même avant le cadre', () => {
    const { lines } = layout('Court\nla suite du paragraphe après le saut de ligne', [MIDDLE]);
    expect(lines[0]!.segments.some((segment) => segment.flyGap)).toBe(false);
    expect(lines[0]!.endOffset).toBe(5);
  });

  it('place le curseur et le clic du côté droit du cadre', () => {
    const { lines } = layout(TEXT, [MIDDLE]);
    const line = lines[0]!;
    const { rightStart } = sides(line);
    const rightFirst = line.segments.find((s) => !s.flyGap && s.leftPx >= MIDDLE.rightPx - 0.5)!;

    expect(caretXOnLine(line, rightFirst.startOffset, measurer)).toBeCloseTo(rightStart, 3);
    expect(caretXOnLine(line, rightFirst.startOffset + 2, measurer)).toBeGreaterThan(rightStart);
    expect(offsetFromX(line, rightStart + 1, measurer)).toBe(rightFirst.startOffset);
  });
});
