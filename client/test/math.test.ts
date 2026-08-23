import { describe, expect, it } from 'vitest';
import {
  EMPTY_MATH_MESSAGE,
  describeMathError,
  renderMath,
} from '../src/document/math/render';
import { MATH_EXAMPLES, MATH_SNIPPETS } from '../src/document/math/snippets';

describe('rendu des formules', () => {
  it('rend une formule valide, MathML compris (lu par les lecteurs d’écran)', async () => {
    const result = await renderMath('x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('katex');
      expect(result.html).toContain('<math');
    }
  });

  it('distingue le mode « dans le texte » du mode centré', async () => {
    const inline = await renderMath('a^2', false);
    const block = await renderMath('a^2', true);
    expect(inline.ok && block.ok).toBe(true);
    if (inline.ok && block.ok) {
      expect(block.html).toContain('katex-display');
      expect(inline.html).not.toContain('katex-display');
    }
  });

  it('traite le champ vide comme une invitation, pas comme une erreur', async () => {
    const result = await renderMath('   ', false);
    expect(result).toEqual({ ok: false, message: EMPTY_MATH_MESSAGE });
  });

  it('refuse explicitement les commandes qui insèrent un lien ou une ressource', async () => {
    // Une formule est rediffusée à tous les collaborateurs. `trust: false` les
    // neutralise déjà, mais silencieusement : on préfère le dire à l'usager.
    for (const source of [
      '\\href{https://exemple.org}{clic}',
      '\\url{https://exemple.org}',
      '\\includegraphics{x.png}',
    ]) {
      const result = await renderMath(source, false);
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.message).toContain('désactivée');
    }
  });

  it('ne produit jamais de lien dans le HTML rendu', async () => {
    const result = await renderMath('a \\text{ et } b^2', false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).not.toContain('<a ');
      expect(result.html).not.toContain('href=');
    }
  });

  it('signale une formule invalide sans jeter d’exception', async () => {
    const result = await renderMath('\\frac{1}{', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('messages d’erreur', () => {
  it('traduit les erreurs de l’analyseur en français exploitable', () => {
    expect(describeMathError(new Error('Undefined control sequence: \\frakc'))).toContain('\\frakc');
    expect(describeMathError(new Error("Expected '}' at position 12"))).toContain('Accolades');
    expect(describeMathError(new Error("Expected group after '\\frac' at position 6"))).toContain(
      'Argument manquant',
    );
    expect(describeMathError(new Error('Double superscript at position 4'))).toContain('exposants');
  });

  it('reprend la position du caractère fautif quand elle est connue', () => {
    expect(describeMathError(new Error("Expected 'EOF' at position 7"))).toContain('caractère 7');
  });

  it('ne laisse jamais fuir le message brut du moteur', () => {
    const message = describeMathError(new Error('KaTeX parse error: something odd'));
    expect(message).not.toContain('KaTeX');
    expect(message).not.toContain('parse error');
  });
});


describe('palette de modèles', () => {
  const all = MATH_SNIPPETS.flatMap((group) => group.snippets);

  it('propose des modèles nommés et uniques', () => {
    const labels = all.map((snippet) => snippet.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const snippet of all) {
      expect(snippet.glyph.length).toBeGreaterThan(0);
      expect(snippet.latex.trim().length).toBeGreaterThan(0);
    }
  });

  it('place le curseur à l’intérieur du modèle, jamais hors du texte inséré', () => {
    for (const snippet of all) {
      const caret = snippet.caret ?? 0;
      expect(caret).toBeLessThanOrEqual(0);
      expect(Math.abs(caret)).toBeLessThanOrEqual(snippet.latex.length);
    }
  });

  it('ne contient que des modèles que le moteur sait rendre', async () => {
    // Un modèle qui casse l'aperçu dès son insertion serait un piège.
    for (const snippet of all) {
      const filled = snippet.latex.replace(/\{\}/g, '{x}');
      const result = await renderMath(filled, false);
      expect(result.ok, `${snippet.label} → ${filled}`).toBe(true);
    }
  });

  it('propose des exemples complets qui se rendent tels quels', async () => {
    for (const example of MATH_EXAMPLES) {
      const result = await renderMath(example.latex, true);
      expect(result.ok, example.label).toBe(true);
    }
  });
});
