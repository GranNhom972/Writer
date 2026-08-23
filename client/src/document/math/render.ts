/**
 * Rendu des formules (couche 1).
 *
 * Le moteur (KaTeX) est chargé **à la demande** : la plupart des documents ne
 * contiennent pas de mathématiques, et l'embarquer dans le bundle initial ferait
 * sauter le budget de performance (00_DIRECTIVE_ARCHITECTURE.md §7).
 *
 * Sécurité : `trust: false` — les macros `\href`, `\url` et `\includegraphics`
 * sont refusées. Une formule est rediffusée à tous les collaborateurs ; elle ne
 * doit pas pouvoir injecter de lien ni de ressource externe.
 */

interface KatexRenderer {
  renderToString: (tex: string, options?: Record<string, unknown>) => string;
}

let loader: Promise<KatexRenderer> | null = null;

export function loadKatex(): Promise<KatexRenderer> {
  if (!loader) {
    loader = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
      ([module]) => (module.default ?? module) as unknown as KatexRenderer,
    );
  }
  return loader;
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
    const katex = await loadKatex();
    const html = katex.renderToString(source, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      // MathML inclus : c'est lui que lisent les technologies d'assistance.
      output: 'htmlAndMathml',
    });
    return { ok: true, html };
  } catch (error) {
    return { ok: false, message: describeMathError(error) };
  }
}

/**
 * Traduit l'erreur du moteur en français, sans jargon d'analyseur.
 * Un message brut comme « KaTeX parse error: Expected 'EOF', got '}' at position 7 »
 * n'aide personne à corriger sa formule.
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

/** Vérification rapide, sans charger le moteur : sert à l'état des boutons. */
export function hasBalancedBraces(latex: string): boolean {
  let depth = 0;
  for (let i = 0; i < latex.length; i += 1) {
    if (latex[i] === '\\') {
      i += 1; // caractère échappé : \{ et \} ne comptent pas
      continue;
    }
    if (latex[i] === '{') depth += 1;
    if (latex[i] === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
