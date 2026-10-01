// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Tests du moteur mathématique (KaTeX, modèles et intégration Writer).
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  DEFAULT_DEFAULTS,
} from '../src/domain/document/document';
import { makeRun, normalizeRuns, splitRunsAt } from '../src/domain/document/runs';
import {
  estimateLatexWidth,
  estimateMathMetrics,
  layoutParagraph,
  type LayoutContext,
} from '../src/domain/engine/lineBreak';
import {
  caretGeometry,
  caretXOnLine,
  collapsedSelection,
  moveHorizontal,
  offsetFromX,
} from '../src/domain/engine/cursor';
import {
  createEditorState,
  deleteBackward,
  deleteForward,
} from '../src/domain/engine/edit';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import {
  describeMathError,
  EMPTY_MATH_MESSAGE,
  renderMath,
  renderMathHtml,
} from '../src/domain/math/render';

const measurer = new MetricTextMeasurer();

function context(contentWidthPx: number): LayoutContext {
  return { measurer, defaults: { ...DEFAULT_DEFAULTS, lineSpacing: 1 }, contentWidthPx };
}

describe('Rendu KaTeX synchrone et asynchrone', () => {
  it('génère du HTML KaTeX valide pour une fraction en ligne', () => {
    const html = renderMathHtml('\\frac{a}{b}', false);
    expect(html).toContain('katex');
    expect(html).toContain('mfrac');
    expect(html).not.toContain('katex-display');
  });

  it('génère un conteneur d’affichage pour une formule centrée (displayMode)', () => {
    const html = renderMathHtml('\\int_{0}^{\\infty} e^{-x^2} dx', true);
    expect(html).toContain('katex-display');
    expect(html).toContain('katex');
  });

  it('rend correctement les matrices et systèmes', () => {
    const html = renderMathHtml('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', true);
    expect(html).toContain('matrix');
    expect(html).toContain('katex');
  });

  it('bloque les commandes non sécurisées (\\href, \\url, \\includegraphics)', async () => {
    const result = await renderMath('\\href{http://malicious.com}{clic}', false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('désactivée');
    }

    const html = renderMathHtml('\\url{http://malicious.com}', false);
    expect(html).toContain('katex-error');
  });

  it('gère les formules vides avec le message approprié', async () => {
    const result = await renderMath('   ', false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(EMPTY_MATH_MESSAGE);
    }
  });

  it('traduit les erreurs de syntaxe LaTeX en français clair', () => {
    const errorMsg = describeMathError(new Error('Undefined control sequence: \\nonexistent'));
    expect(errorMsg).toContain('Commande inconnue');
    expect(errorMsg).toContain('\\nonexistent');

    const unclosedMsg = describeMathError(new Error("Expected '}' at position 5"));
    expect(unclosedMsg).toContain('Accolades non refermées');
  });
});

describe('Plages de formatage avec attributs mathématiques (SwpHints)', () => {
  it('conserve les attributs mathLatex et mathDisplay lors de normalizeRuns', () => {
    const run = makeRun('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', {
      mathLatex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
      mathDisplay: true,
    });
    const normalized = normalizeRuns([run]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.mathLatex).toBe('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}');
    expect(normalized[0]?.mathDisplay).toBe(true);
  });

  it('ne fusionne pas un run mathématique avec un run de texte ordinaire', () => {
    const textRun = makeRun('Soit l’équation : ');
    const mathRun = makeRun('E = mc^2', { mathLatex: 'E = mc^2', mathDisplay: false });
    const normalized = normalizeRuns([textRun, mathRun]);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.mathLatex).toBeUndefined();
    expect(normalized[1]?.mathLatex).toBe('E = mc^2');
  });

  it('scinde correctement un run mathématique sans altérer ses attributs', () => {
    const mathRun = makeRun('\\alpha + \\beta', { mathLatex: '\\alpha + \\beta' });
    const [before, after] = splitRunsAt([mathRun], 6);
    expect(before[0]?.mathLatex).toBe('\\alpha + \\beta');
    expect(after[0]?.mathLatex).toBe('\\alpha + \\beta');
  });
});

describe('Mise en page et géométrie des formules', () => {
  it('estime une hauteur verticale accrue pour les fractions et intégrales', () => {
    const font = { fontFamily: 'Liberation Serif', fontSizePx: 16, bold: false, italic: false };
    const simple = estimateMathMetrics('x + y = z', false, font);
    const fraction = estimateMathMetrics('\\frac{a}{b}', false, font);
    const displayIntegral = estimateMathMetrics('\\int_{a}^{b} f(x) dx', true, font);

    expect(fraction.heightPx).toBeGreaterThan(simple.heightPx);
    expect(displayIntegral.heightPx).toBeGreaterThanOrEqual(48);
    expect(displayIntegral.ascentPx).toBeGreaterThan(displayIntegral.heightPx * 0.5);
  });

  it('calcule la hauteur de ligne d’un paragraphe contenant une formule', () => {
    const formula = '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
    const paragraph = createParagraph(formula, {
      alignment: 'center',
      runs: [makeRun(formula, { mathLatex: formula, mathDisplay: true })],
    });

    const layout = layoutParagraph(paragraph, context(500));
    expect(layout.lines).toHaveLength(1);
    const line = layout.lines[0];
    expect(line).toBeDefined();
    // La hauteur de ligne doit être augmentée pour accueillir la fraction
    expect(line!.heightPx).toBeGreaterThanOrEqual(44);
    expect(line!.segments[0]?.formatting.mathLatex).toBe(formula);
  });

  it('positionne le curseur aux extrémités du segment mathématique de façon atomique', () => {
    const formula = 'E = mc^2';
    const paragraph = createParagraph('', {
      runs: [
        makeRun('Texte avant '),
        makeRun(formula, { mathLatex: formula, mathDisplay: false }),
        makeRun(' texte après'),
      ],
    });

    const layout = layoutParagraph(paragraph, context(500));
    const line = layout.lines[0]!;
    const mathSegment = line.segments[1]!;

    // Début de formule
    const startX = caretXOnLine(line, mathSegment.startOffset, measurer);
    expect(startX).toBe(mathSegment.leftPx);

    // Milieu ou fin de formule -> snap à l'extrémité
    const endX = caretXOnLine(line, mathSegment.endOffset, measurer);
    expect(endX).toBe(mathSegment.leftPx + mathSegment.widthPx);

    // Clic / hit-test au milieu de la formule -> renvoie startOffset ou endOffset sans scinder la formule
    const offsetNearStart = offsetFromX(line, mathSegment.leftPx + 2, measurer);
    expect(offsetNearStart).toBe(mathSegment.startOffset);

    const offsetNearEnd = offsetFromX(line, mathSegment.leftPx + mathSegment.widthPx - 2, measurer);
    expect(offsetNearEnd).toBe(mathSegment.endOffset);
  });

  it('supprime une formule entière d’un seul coup avec Retour arrière (Backspace)', () => {
    const doc = createEmptyDocument();
    const formula = 'E = mc^2';
    const p = createParagraph('', {
      runs: [
        makeRun('Avant '),
        makeRun(formula, { mathLatex: formula, mathDisplay: false }),
        makeRun(' après'),
      ],
    });
    doc.blocks = [p];

    // Curseur positionné juste après la formule : "Avant " (6) + "E = mc^2" (8) = offset 14
    const state = createEditorState(doc);
    const atFormulaEnd = {
      ...state,
      selection: collapsedSelection({ blockId: p.id, offset: 14 }),
    };

    // moveHorizontal vers la gauche doit sauter directement au début de la formule (offset 6)
    const target = moveHorizontal(doc, atFormulaEnd.selection.focus, -1);
    expect(target.offset).toBe(6);

    // deleteBackward supprime la formule entière
    const afterDelete = deleteBackward(atFormulaEnd);
    const updatedParagraph = afterDelete.doc.blocks[0] as typeof p;
    expect(updatedParagraph.runs.some((r) => r.mathLatex)).toBe(false);
    expect(updatedParagraph.runs.map((r) => r.text).join('')).toBe('Avant  après');
    expect(afterDelete.selection.focus.offset).toBe(6);
  });

  it('supprime une formule entière d’un seul coup avec Suppr (Delete)', () => {
    const doc = createEmptyDocument();
    const formula = 'E = mc^2';
    const p = createParagraph('', {
      runs: [
        makeRun('Avant '),
        makeRun(formula, { mathLatex: formula, mathDisplay: false }),
        makeRun(' après'),
      ],
    });
    doc.blocks = [p];

    // Curseur positionné juste avant la formule : offset 6
    const state = createEditorState(doc);
    const atFormulaStart = {
      ...state,
      selection: collapsedSelection({ blockId: p.id, offset: 6 }),
    };

    // moveHorizontal vers la droite doit sauter directement à la fin de la formule (offset 14)
    const target = moveHorizontal(doc, atFormulaStart.selection.focus, 1);
    expect(target.offset).toBe(14);

    // deleteForward supprime la formule entière
    const afterDelete = deleteForward(atFormulaStart);
    const updatedParagraph = afterDelete.doc.blocks[0] as typeof p;
    expect(updatedParagraph.runs.some((r) => r.mathLatex)).toBe(false);
    expect(updatedParagraph.runs.map((r) => r.text).join('')).toBe('Avant  après');
    expect(afterDelete.selection.focus.offset).toBe(6);
  });

  it('adapte la hauteur du curseur dans le texte ordinaire sur une ligne contenant une formule', () => {
    const formula = '\\frac{a}{b}';
    const p = createParagraph('', {
      runs: [
        makeRun('Texte ordinaire ', { fontSizePt: 12 }),
        makeRun(formula, { mathLatex: formula, mathDisplay: false }),
      ],
    });
    const layout = layoutParagraph(p, context(500));
    expect(layout.lines).toHaveLength(1);
    const line = layout.lines[0]!;
    expect(line.heightPx).toBeGreaterThanOrEqual(28);

    const docLayout = {
      pages: [],
      paragraphLayouts: new Map([[p.id, layout]]),
      placements: new Map([
        [
          p.id,
          [
            {
              pageIndex: 0,
              placed: {
                leftPx: 0,
                topPx: 0,
                heightPx: line.heightPx,
                fromLine: 0,
                toLine: 1,
                isContinuation: false,
                layout,
              },
            },
          ],
        ],
      ]),
    };

    // Curseur dans le texte ordinaire au début (offset 0)
    const textCaret = caretGeometry(docLayout as any, { blockId: p.id, offset: 0 }, measurer);
    expect(textCaret).not.toBeNull();
    // La hauteur du curseur dans le texte ordinaire doit être proportionnelle au texte et inférieure à la hauteur totale de la fraction
    expect(textCaret!.heightPx).toBeLessThan(line.heightPx);
  });

  it('estime la largeur d’une fraction en empilement vertical sans sur-estimer horizontalement', () => {
    const em = 19.5;
    const fraction = '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
    const width = estimateLatexWidth(fraction, em);

    // La largeur réelle d'une telle fraction est d'environ 100 à 150px (et non pas 250px)
    expect(width).toBeGreaterThanOrEqual(80);
    expect(width).toBeLessThan(160);
  });

  it('ne coupe jamais une formule mathématique au milieu lors d’un retour à la ligne', () => {
    const formula = 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}';
    const p = createParagraph('', {
      runs: [
        makeRun('Texte d’introduction un peu long '),
        makeRun(formula, { mathLatex: formula, mathDisplay: false }),
        makeRun(' suite du texte explicatif.'),
      ],
    });

    // Largeur étroite forçant le retour à la ligne
    const layout = layoutParagraph(p, context(220));
    expect(layout.lines.length).toBeGreaterThanOrEqual(2);

    // Vérifier qu'aucune ligne ne coupe la formule en son milieu
    for (const line of layout.lines) {
      for (const segment of line.segments) {
        if (segment.formatting.mathLatex) {
          expect(segment.text).toBe(formula);
        }
      }
    }
  });
});
