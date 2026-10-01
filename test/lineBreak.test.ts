// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Line wrapping: a transposition of `SwTxtGuess::Guess`.
 *
 * The analytical measurer gives exact, reproducible widths: a lowercase letter is worth 0.5 em, a space 0.25. At 12 pt (16 px), a lowercase letter is therefore 8 px and a space 4 px, which makes it possible to compute the
 * expected width of each line by hand.
 */
import { describe, expect, it } from 'vitest';
import { createParagraph, DEFAULT_DEFAULTS } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { layoutParagraph, type LayoutContext } from '../src/domain/engine/lineBreak';

const measurer = new MetricTextMeasurer();

function context(contentWidthPx: number): LayoutContext {
  return { measurer, defaults: { ...DEFAULT_DEFAULTS, lineSpacing: 1 }, contentWidthPx };
}

/** Text actually painted on each line. */
function linesOf(text: string, width: number, options = {}): string[] {
  const paragraph = createParagraph(text, options);
  const layout = layoutParagraph(paragraph, context(width));
  return layout.lines.map((line) => text.slice(line.startOffset, line.endOffset));
}

describe('découpage en lignes', () => {
  it('garde une seule ligne quand tout tient', () => {
    expect(linesOf('abc', 1000)).toEqual(['abc']);
  });

  it('coupe à la dernière occasion de coupure avant le débordement', () => {
    // "aaaa bbbb cccc": each word is 32 px, each space 4 px.
    expect(linesOf('aaaa bbbb cccc', 70)).toEqual(['aaaa bbbb', 'cccc']);
  });

  it('avale les espaces entre les deux lignes', () => {
    // The next line never starts with a space (`nBreakStart`).
    const lines = linesOf('aaaa      bbbb', 40);
    expect(lines[0]).toBe('aaaa');
    expect(lines[1]).toBe('bbbb');
  });

  it('ne compte pas les espaces finales dans la largeur de la ligne', () => {
    const paragraph = createParagraph('aaaa bbbb');
    const layout = layoutParagraph(paragraph, context(40));
    // 4 lowercase letters × 8 px: the space that follows overflows without widening the line.
    expect(layout.lines[0]?.widthPx).toBe(32);
  });

  it('coupe dans le mot quand aucun mot ne tient — « break cut »', () => {
    const lines = linesOf('abcdefghij', 40);
    expect(lines).toEqual(['abcde', 'fghij']);
  });

  it('progresse même quand la colonne est plus étroite qu’un caractère', () => {
    const lines = linesOf('abcd', 1);
    expect(lines).toEqual(['a', 'b', 'c', 'd']);
  });

  it('coupe après un tiret', () => {
    expect(linesOf('bien-aimé', 45)).toEqual(['bien-', 'aimé']);
  });

  it('ne coupe pas sur une espace insécable', () => {
    // Written with an escape sequence: a literal non-breaking space cannot be told apart from an ordinary space in the source, and the test would lose its meaning the first time it was reread. "bb cc" is 36 px wide
    // and fits in 40; the whole thing does not fit. The non-breaking space not being a break opportunity, the line is cut on the ordinary space and the group stays together.
    const lines = linesOf('aa bb\u00A0cc', 40);
    expect(lines[0]).toBe('aa');
    expect(lines[1]).toBe('bb\u00A0cc');
  });

  it('honore un saut de ligne explicite', () => {
    expect(linesOf('ab\ncd', 1000)).toEqual(['ab', 'cd']);
  });

  it('produit une ligne vide pour un paragraphe vide', () => {
    const layout = layoutParagraph(createParagraph(''), context(500));
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]?.heightPx).toBeGreaterThan(0);
  });
});

describe('tabulations', () => {
  it('avance jusqu’au taquet suivant', () => {
    const layout = layoutParagraph(createParagraph('a\tb'), context(1000));
    const segments = layout.lines[0]!.segments;
    const tab = segments.find((segment) => segment.isTab);
    expect(tab).toBeDefined();
    // Default tab stop: 1.25 cm ≈ 47.24 px. The "a" is 8 px, so the tab fills up to the first stop.
    expect(tab!.leftPx + tab!.widthPx).toBeCloseTo(47.244, 2);
  });
});

describe('hauteur de ligne', () => {
  it('prend la plus grande fonte de la ligne', () => {
    const paragraph = createParagraph('', {
      runs: [makeRun('petit', { fontSizePt: 8 }), makeRun('GRAND', { fontSizePt: 24 })],
    });
    const layout = layoutParagraph(paragraph, context(1000));
    const height = layout.lines[0]!.heightPx;
    // The line follows the 24 pt font, not the 8 pt one.
    expect(height).toBeGreaterThan(24 * (96 / 72) * 0.9);
  });

  it('applique le facteur d’interligne', () => {
    const simple = layoutParagraph(createParagraph('abc'), context(1000));
    const double = layoutParagraph(
      createParagraph('abc', { lineSpacing: 2 }),
      context(1000),
    );
    expect(double.lines[0]!.heightPx).toBeCloseTo(simple.lines[0]!.heightPx * 2, 5);
  });
});

describe('alignement', () => {
  it('centre la ligne dans la largeur disponible', () => {
    const layout = layoutParagraph(
      createParagraph('abcd', { alignment: 'center' }),
      context(100),
    );
    // 4 lowercase letters = 32 px, 68 px remain, spread on both sides.
    expect(layout.lines[0]!.leftPx).toBeCloseTo(34, 5);
  });

  it('justifie toutes les lignes sauf la dernière', () => {
    const paragraph = createParagraph('aa bb cc dd ee ff', { alignment: 'justify' });
    const layout = layoutParagraph(paragraph, context(70));
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines[0]!.wordSpacingPx).toBeGreaterThan(0);
    expect(layout.lines[layout.lines.length - 1]!.wordSpacingPx).toBe(0);
  });
});
