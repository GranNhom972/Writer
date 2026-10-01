// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Rendu des formules mathématiques (couche 1).
 *
 * Le moteur (KaTeX) est chargé **à la demande** : la plupart des documents ne
 * contiennent pas de mathématiques, et l'embarquer dans le bundle initial ferait
 * sauter le budget de performance (00_DIRECTIVE_ARCHITECTURE.md §7).
 *
 * Sécurité : `trust: false` — les macros `\href`, `\url` et `\includegraphics`
 * sont refusées. Une formule ne doit pas pouvoir injecter de lien ni de ressource externe.
 */

import katex from 'katex';

export interface KatexRenderer {
  renderToString: (tex: string, options?: Record<string, unknown>) => string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface MathRenderSuccess {
  ok: true;
  html: string;
}

export interface MathRenderFailure {
  ok: false;
  /** Message en langage clair, affichable tel quel à l'usager. */
  message: string;
}

export type MathRenderResult = MathRenderSuccess | MathRenderFailure;

/** Formule vide : cas courant (champ en cours de saisie), pas une erreur. */
export const EMPTY_MATH_MESSAGE = 'Saisissez une formule pour en voir l’aperçu.';

/**
 * Commandes refusées avant même d'appeler le moteur.
 *
 * `trust: false` les neutralise déjà (KaTeX les rend sans produire de lien), mais
 * il le fait **silencieusement** : l'usager croirait avoir inséré un lien qui
 * n'existe pas. On le lui dit, et la défense reste double.
 */
const FORBIDDEN_COMMANDS = /\\(href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/;

/**
 * Rendu synchrone pour la projection DOM de la feuille.
 * Ne lève jamais d'exception et fournit un fallback sûr en cas d'erreur.
 */
export function renderMathHtml(latex: string, display: boolean): string {
  const source = latex.trim();
  if (!source) return '';

  const forbidden = FORBIDDEN_COMMANDS.exec(source);
  if (forbidden) {
    const tag = display ? 'div' : 'span';
    return `<${tag} class="katex-error" title="Commande non autorisée : \\${forbidden[1]}">[Formule non sécurisée]</${tag}>`;
  }

  try {
    return katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
    });
  } catch {
    const tag = display ? 'div' : 'span';
    return `<${tag} class="katex-fallback" style="font-family: 'Cambria Math', 'Latin Modern Math', serif; font-style: italic; ${
      display ? 'text-align: center; margin: 0.5em 0;' : ''
    }">${escapeHtml(source)}</${tag}>`;
  }
}

let mathMeasureContainer: HTMLDivElement | null = null;
const mathMeasurementCache = new Map<string, { widthPx: number; heightPx: number; ascentPx: number }>();

/**
 * Mesure au pixel exact le rendu KaTeX dans le navigateur pour garantir
 * que le moteur de mise en page et le curseur s'alignent parfaitement avec le DOM.
 */
export function measureMathExact(
  latex: string,
  display: boolean,
  font: { fontSizePx: number },
): { widthPx: number; heightPx: number; ascentPx: number } {
  if (typeof document === 'undefined') {
    return { widthPx: 0, heightPx: 0, ascentPx: 0 };
  }

  const key = `${display ? 'd' : 'i'}|${font.fontSizePx}|${latex}`;
  const cached = mathMeasurementCache.get(key);
  if (cached) return cached;

  if (!mathMeasureContainer) {
    mathMeasureContainer = document.createElement('div');
    mathMeasureContainer.style.position = 'absolute';
    mathMeasureContainer.style.visibility = 'hidden';
    mathMeasureContainer.style.top = '-9999px';
    mathMeasureContainer.style.left = '-9999px';
    mathMeasureContainer.style.pointerEvents = 'none';
    mathMeasureContainer.style.whiteSpace = 'nowrap';
    document.body.appendChild(mathMeasureContainer);
  }

  const html = renderMathHtml(latex, display);
  const span = document.createElement('span');
  span.className = `writer-math ${display ? 'writer-math--display' : 'writer-math--inline'}`;
  span.style.fontSize = `${font.fontSizePx}px`;
  span.innerHTML = html;

  mathMeasureContainer.appendChild(span);
  const target = span.querySelector<HTMLElement>('.katex-html') ?? span;
  const rect = target.getBoundingClientRect();
  mathMeasureContainer.removeChild(span);

  const widthPx = Math.max(font.fontSizePx, Math.ceil(rect.width));
  const heightPx = Math.max(font.fontSizePx * 1.2, Math.ceil(rect.height));
  const ascentPx = heightPx * 0.65;

  const result = { widthPx, heightPx, ascentPx };
  if (mathMeasurementCache.size > 500) mathMeasurementCache.clear();
  mathMeasurementCache.set(key, result);
  return result;
}

export async function renderMath(latex: string, display: boolean): Promise<MathRenderResult> {
  const source = latex.trim();
  if (!source) return { ok: false, message: EMPTY_MATH_MESSAGE };

  const forbidden = FORBIDDEN_COMMANDS.exec(source);
  if (forbidden) {
    return {
      ok: false,
      message: `La commande \\${forbidden[1]} est désactivée : une formule ne peut contenir ni lien ni ressource externe.`,
    };
  }

  try {
    const html = katex.renderToString(source, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      // MathML inclus pour l'accessibilité
      output: 'htmlAndMathml',
    });
    return { ok: true, html };
  } catch (error) {
    return { ok: false, message: describeMathError(error) };
  }
}

/**
 * Traduit l'erreur du moteur en français, sans jargon d'analyseur.
 */
export function describeMathError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const position = /at position (\d+)/.exec(raw)?.[1];
  const suffix = position ? ` (caractère ${position})` : '';

  if (/Undefined control sequence: (\\[a-zA-Z]+)/.test(raw)) {
    const command = /Undefined control sequence: (\\[a-zA-Z]+)/.exec(raw)?.[1] ?? '';
    return `Commande inconnue : ${command}. Vérifiez son orthographe${suffix}.`;
  }
  if (/Expected '}'|Expected 'EOF'|Unexpected end/.test(raw)) {
    return `Accolades non refermées${suffix}.`;
  }
  if (/Expected group after/.test(raw)) {
    const command = /Expected group after '(\\[a-zA-Z]*)'/.exec(raw)?.[1] ?? 'cette commande';
    return `Argument manquant après ${command} : ajoutez { } avec son contenu${suffix}.`;
  }
  if (/trust|\\href|\\url|\\includegraphics/i.test(raw)) {
    return 'Cette commande est désactivée : une formule ne peut pas contenir de lien ni de ressource externe.';
  }
  if (/Double superscript|Double subscript/.test(raw)) {
    return `Deux exposants (ou deux indices) se suivent : groupez-les avec { }${suffix}.`;
  }
  return `Formule invalide${suffix}.`;
}
