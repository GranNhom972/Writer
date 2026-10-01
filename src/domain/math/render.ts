// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Rendering of math formulas (layer 1).
 *
 * The engine (KaTeX) is loaded **on demand**: most documents contain no math, and bundling it in the initial bundle
 * would blow the performance budget (00_DIRECTIVE_ARCHITECTURE.md §7).
 *
 * Security: `trust: false`: the `\href`, `\url` and `\includegraphics` macros are refused. A formula must not be able to
 * inject a link or an external resource.
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
  /** Plain-language message, which can be shown to the user as it is. */
  message: string;
}

export type MathRenderResult = MathRenderSuccess | MathRenderFailure;

/** Empty formula: a common case (a field being typed into), not an error. */
export const EMPTY_MATH_MESSAGE = 'Saisissez une formule pour en voir l’aperçu.';

/**
 * Commands refused before the engine is even called.
 *
 * `trust: false` already neutralizes them (KaTeX renders them without producing a link), but it does so **silently**:
 * the user would believe they had inserted a link that does not exist. We tell them, and the defense stays double.
 */
const FORBIDDEN_COMMANDS = /\\(href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/;

/**
 * Synchronous rendering for the DOM projection of the sheet. Never throws and provides a safe fallback on error.
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
 * Measures the KaTeX rendering to the exact pixel in the browser, to guarantee that the layout engine and the cursor
 * line up perfectly with the DOM.
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
      // MathML included for accessibility
      output: 'htmlAndMathml',
    });
    return { ok: true, html };
  } catch (error) {
    return { ok: false, message: describeMathError(error) };
  }
}

/**
 * Translates the engine's error into plain language for the user (in French, like the rest of the interface), without
 * parser jargon.
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
