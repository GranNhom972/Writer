// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Modèles et exemples de formules mathématiques.
 */

export interface MathSnippet {
  /** Libellé accessible (le bouton n'affiche que le symbole). */
  label: string;
  /** Symbole affiché sur le bouton. */
  glyph: string;
  /** Code inséré. */
  latex: string;
  /** Décalage du curseur depuis la fin du code inséré (négatif = revenir en arrière). */
  caret?: number;
}

export interface MathSnippetGroup {
  name: string;
  snippets: MathSnippet[];
}

export const MATH_SNIPPETS: readonly MathSnippetGroup[] = [
  {
    name: 'Structures',
    snippets: [
      { label: 'Fraction', glyph: 'a⁄b', latex: '\\frac{}{}', caret: -3 },
      { label: 'Exposant', glyph: 'xⁿ', latex: '^{}', caret: -1 },
      { label: 'Indice', glyph: 'xₙ', latex: '_{}', caret: -1 },
      { label: 'Racine carrée', glyph: '√', latex: '\\sqrt{}', caret: -1 },
      { label: 'Racine n-ième', glyph: 'ⁿ√', latex: '\\sqrt[n]{}', caret: -1 },
      { label: 'Parenthèses ajustées', glyph: '( )', latex: '\\left( \\right)', caret: -7 },
      { label: 'Valeur absolue', glyph: '|x|', latex: '\\left| \\right|', caret: -7 },
      { label: 'Matrice 2 × 2', glyph: '▦', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
      { label: 'Système d’équations', glyph: '{≡', latex: '\\begin{cases} x = 1 \\\\ y = 2 \\end{cases}' },
    ],
  },
  {
    name: 'Opérateurs',
    snippets: [
      { label: 'Somme', glyph: '∑', latex: '\\sum_{i=1}^{n} ' },
      { label: 'Produit', glyph: '∏', latex: '\\prod_{i=1}^{n} ' },
      { label: 'Intégrale', glyph: '∫', latex: '\\int_{a}^{b} ' },
      { label: 'Intégrale double', glyph: '∬', latex: '\\iint_{D} ' },
      { label: 'Limite', glyph: 'lim', latex: '\\lim_{x \\to 0} ' },
      { label: 'Dérivée partielle', glyph: '∂', latex: '\\frac{\\partial }{\\partial x}', caret: -13 },
      { label: 'Racine de polynôme', glyph: '∛', latex: '\\sqrt[3]{}', caret: -1 },
    ],
  },
  {
    name: 'Relations',
    snippets: [
      { label: 'Différent de', glyph: '≠', latex: '\\neq ' },
      { label: 'Inférieur ou égal', glyph: '≤', latex: '\\leq ' },
      { label: 'Supérieur ou égal', glyph: '≥', latex: '\\geq ' },
      { label: 'Environ égal', glyph: '≈', latex: '\\approx ' },
      { label: 'Équivalent', glyph: '≡', latex: '\\equiv ' },
      { label: 'Appartient à', glyph: '∈', latex: '\\in ' },
      { label: 'Inclus dans', glyph: '⊂', latex: '\\subset ' },
      { label: 'Implique', glyph: '⇒', latex: '\\Rightarrow ' },
      { label: 'Équivaut à', glyph: '⇔', latex: '\\Leftrightarrow ' },
      { label: 'Tend vers', glyph: '→', latex: '\\to ' },
    ],
  },
  {
    name: 'Lettres grecques',
    snippets: [
      { label: 'alpha', glyph: 'α', latex: '\\alpha ' },
      { label: 'bêta', glyph: 'β', latex: '\\beta ' },
      { label: 'gamma', glyph: 'γ', latex: '\\gamma ' },
      { label: 'delta', glyph: 'δ', latex: '\\delta ' },
      { label: 'thêta', glyph: 'θ', latex: '\\theta ' },
      { label: 'lambda', glyph: 'λ', latex: '\\lambda ' },
      { label: 'mu', glyph: 'μ', latex: '\\mu ' },
      { label: 'pi', glyph: 'π', latex: '\\pi ' },
      { label: 'sigma', glyph: 'σ', latex: '\\sigma ' },
      { label: 'phi', glyph: 'φ', latex: '\\varphi ' },
      { label: 'oméga', glyph: 'ω', latex: '\\omega ' },
      { label: 'Delta majuscule', glyph: 'Δ', latex: '\\Delta ' },
      { label: 'Oméga majuscule', glyph: 'Ω', latex: '\\Omega ' },
    ],
  },
  {
    name: 'Ensembles',
    snippets: [
      { label: 'Entiers naturels', glyph: 'ℕ', latex: '\\mathbb{N} ' },
      { label: 'Entiers relatifs', glyph: 'ℤ', latex: '\\mathbb{Z} ' },
      { label: 'Rationnels', glyph: 'ℚ', latex: '\\mathbb{Q} ' },
      { label: 'Réels', glyph: 'ℝ', latex: '\\mathbb{R} ' },
      { label: 'Complexes', glyph: 'ℂ', latex: '\\mathbb{C} ' },
      { label: 'Infini', glyph: '∞', latex: '\\infty ' },
      { label: 'Union', glyph: '∪', latex: '\\cup ' },
      { label: 'Intersection', glyph: '∩', latex: '\\cap ' },
      { label: 'Ensemble vide', glyph: '∅', latex: '\\emptyset ' },
    ],
  },
];

/** Exemples proposés au premier usage : montrer vaut mieux qu'expliquer. */
export const MATH_EXAMPLES: readonly { label: string; latex: string }[] = [
  { label: 'Identité remarquable', latex: '(a+b)^2 = a^2 + 2ab + b^2' },
  { label: 'Équation du second degré', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
  { label: 'Somme géométrique', latex: '\\sum_{k=0}^{n} q^k = \\frac{1-q^{n+1}}{1-q}' },
  { label: 'Théorème fondamental', latex: '\\int_{a}^{b} f\'(x)\\,dx = f(b) - f(a)' },
];
