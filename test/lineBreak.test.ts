/**
 * Retour à la ligne — transposition de `SwTxtGuess::Guess`.
 *
 * Le mesureur analytique donne des largeurs exactes et reproductibles : une
 * lettre minuscule vaut 0,5 cadratin, une espace 0,25. À 12 pt (16 px), une
 * minuscule fait donc 8 px et une espace 4 px, ce qui permet de calculer à la
 * main la largeur attendue de chaque ligne.
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

/** Texte réellement peint sur chaque ligne. */
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
    // « aaaa bbbb cccc » : chaque mot fait 32 px, chaque espace 4 px.
    expect(linesOf('aaaa bbbb cccc', 70)).toEqual(['aaaa bbbb', 'cccc']);
  });

  it('avale les espaces entre les deux lignes', () => {
    // La ligne suivante ne commence jamais par une espace (`nBreakStart`).
    const lines = linesOf('aaaa      bbbb', 40);
    expect(lines[0]).toBe('aaaa');
    expect(lines[1]).toBe('bbbb');
  });

  it('ne compte pas les espaces finales dans la largeur de la ligne', () => {
    const paragraph = createParagraph('aaaa bbbb');
    const layout = layoutParagraph(paragraph, context(40));
    // 4 minuscules × 8 px : l'espace qui suit déborde sans élargir la ligne.
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
    // Écrite en échappement : une insécable littérale est indiscernable d'une
    // espace ordinaire dans la source, et le test perdrait son sens à la
    // première relecture. « bb\u00A0cc » fait 36 px et tient sur 40 ; l'ensemble
    // ne tient pas. L'insécable n'étant pas une occasion de coupure, la ligne
    // se coupe sur l'espace ordinaire et le groupe reste solidaire.
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
    // Taquet par défaut : 1,25 cm ≈ 47,24 px. Le « a » fait 8 px, la
    // tabulation comble donc jusqu'au premier taquet.
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
    // La ligne suit la fonte de 24 pt, pas celle de 8 pt.
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
    // 4 minuscules = 32 px, reste 68 px répartis de part et d'autre.
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
