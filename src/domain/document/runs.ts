/**
 * Opérations sur les plages de formatage d'un paragraphe.
 *
 * Équivalent fonctionnel de `SwpHints` (`sw/source/core/txtnode/thints.cxx`) :
 * insertion, suppression et pose d'attribut sur un intervalle, en préservant
 * l'invariant de `SwpHints::MergePortions` — **jamais deux runs adjacents de
 * formatage identique**, et jamais de run vide (hors paragraphe vide).
 *
 * Toutes les fonctions sont pures : elles renvoient de nouveaux tableaux et ne
 * modifient jamais leurs arguments.
 */

import { RUN_FORMAT_KEYS, type RunFormatKey, type RunFormatting, type TextRun } from './types';

/**
 * Modification d'attributs à appliquer sur une plage.
 *
 * `null` **retire** l'attribut : le run repasse au style par défaut du document.
 * C'est la distinction que fait Writer entre `SwTxtNode::SetAttr` et
 * `SwTxtNode::ResetAttr` — retirer n'est pas poser la valeur par défaut, car un
 * style nommé pourrait la redéfinir.
 */
export type RunFormatPatch = {
  [K in RunFormatKey]?: RunFormatting[K] | null;
};

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'mathDisplay',
]);

/** Longueur de la chaîne brute du paragraphe (`SwTxtNode::m_Text.Len()`). */
export function runsLength(runs: readonly TextRun[]): number {
  let total = 0;
  for (const run of runs) total += run.text.length;
  return total;
}

/** Chaîne brute du paragraphe : c'est elle qu'indexent les offsets de curseur. */
export function runsText(runs: readonly TextRun[]): string {
  let out = '';
  for (const run of runs) out += run.text;
  return out;
}

/** Extrait le jeu d'attributs d'un run, sans son texte. */
export function runFormatting(run: TextRun): RunFormatting {
  const out: RunFormatting = {};
  for (const key of RUN_FORMAT_KEYS) {
    const value = run[key];
    if (value !== undefined) assignFormat(out, key, value);
  }
  return out;
}

/**
 * Écrit une clé de formatage en conservant le typage.
 *
 * Le passage par une fonction est nécessaire sous `exactOptionalPropertyTypes` :
 * une affectation indexée directe ne prouve pas au compilateur que la valeur
 * correspond bien à *cette* clé-là.
 */
function assignFormat(target: RunFormatting, key: RunFormatKey, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

/** Deux plages portent-elles exactement le même formatage ? (`*p1 == *p2`) */
export function sameFormatting(a: RunFormatting, b: RunFormatting): boolean {
  for (const key of RUN_FORMAT_KEYS) {
    // `undefined` et clé absente sont le même état : « attribut non posé ».
    if ((a[key] ?? undefined) !== (b[key] ?? undefined)) return false;
  }
  return true;
}

/** Construit un run à partir d'un texte et d'un jeu d'attributs. */
export function makeRun(text: string, formatting: RunFormatting = {}): TextRun {
  const run: TextRun = { text };
  for (const key of RUN_FORMAT_KEYS) {
    const value = formatting[key];
    if (value !== undefined) assignFormat(run, key, value);
  }
  return run;
}

/**
 * Rétablit les invariants : retire les runs vides et fusionne les adjacents
 * de formatage identique. Transposition de `SwpHints::MergePortions`.
 *
 * Un paragraphe vide conserve **un** run vide, qui porte le formatage que
 * prendra la prochaine frappe — comme un `SwTxtNode` de texte vide conserve son
 * `SwAttrSet`.
 */
export function normalizeRuns(
  runs: readonly TextRun[],
  fallback?: RunFormatting,
): TextRun[] {
  const out: TextRun[] = [];

  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && sameFormatting(runFormatting(last), runFormatting(run))) {
      out[out.length - 1] = makeRun(last.text + run.text, runFormatting(last));
    } else {
      out.push(makeRun(run.text, runFormatting(run)));
    }
  }

  if (out.length === 0) {
    // Le formatage du paragraphe vidé lui survit : sans ce porteur, taper à
    // nouveau dans un paragraphe qu'on vient d'effacer repartirait du style par
    // défaut au lieu de reprendre celui qu'il avait.
    const carrier = fallback ?? (runs[0] ? runFormatting(runs[0]) : {});
    return [makeRun('', carrier)];
  }
  return out;
}

/** Localise l'offset : index du run le contenant et position dans ce run. */
export function locateOffset(
  runs: readonly TextRun[],
  offset: number,
): { runIndex: number; inner: number } {
  let remaining = offset;
  for (let i = 0; i < runs.length; i += 1) {
    const length = runs[i]!.text.length;
    // `<=` : un offset en fin de run appartient à ce run, ce qui fait hériter
    // la frappe du formatage de gauche (règle de Writer, cf. formattingAt).
    if (remaining <= length) return { runIndex: i, inner: remaining };
    remaining -= length;
  }
  const lastIndex = Math.max(0, runs.length - 1);
  return { runIndex: lastIndex, inner: runs[lastIndex]?.text.length ?? 0 };
}

/** Coupe la liste de runs en deux à l'offset donné (`SwTxtNode::SplitCntntNode`). */
export function splitRunsAt(
  runs: readonly TextRun[],
  offset: number,
): [TextRun[], TextRun[]] {
  const clamped = clamp(offset, 0, runsLength(runs));
  const before: TextRun[] = [];
  const after: TextRun[] = [];
  let consumed = 0;

  for (const run of runs) {
    const start = consumed;
    const end = consumed + run.text.length;
    const format = runFormatting(run);

    if (end <= clamped) {
      before.push(makeRun(run.text, format));
    } else if (start >= clamped) {
      after.push(makeRun(run.text, format));
    } else {
      const cut = clamped - start;
      before.push(makeRun(run.text.slice(0, cut), format));
      after.push(makeRun(run.text.slice(cut), format));
    }
    consumed = end;
  }

  // Une moitié vide doit tout de même porter le formatage du point de coupure,
  // que `normalizeRuns` ne pourrait pas deviner depuis un tableau vide.
  const atCut = formattingAt(runs, clamped);
  return [normalizeRuns(before, atCut), normalizeRuns(after, atCut)];
}

/** Extrait la plage `[start, end)` en conservant le formatage local. */
export function sliceRuns(
  runs: readonly TextRun[],
  start: number,
  end: number,
): TextRun[] {
  const total = runsLength(runs);
  const from = clamp(Math.min(start, end), 0, total);
  const to = clamp(Math.max(start, end), 0, total);
  const out: TextRun[] = [];
  let consumed = 0;

  for (const run of runs) {
    const runStart = consumed;
    const runEnd = consumed + run.text.length;
    consumed = runEnd;
    if (runEnd <= from) continue;
    if (runStart >= to) break;

    const sliceStart = Math.max(from, runStart) - runStart;
    const sliceEnd = Math.min(to, runEnd) - runStart;
    out.push(makeRun(run.text.slice(sliceStart, sliceEnd), runFormatting(run)));
  }

  return normalizeRuns(out);
}

/**
 * Insère du texte à l'offset donné.
 *
 * Sans formatage explicite, le texte hérite de celui de la position — c'est-à-dire
 * du caractère **à gauche** (cf. `formattingAt`) : taper à la suite d'un mot en
 * gras continue en gras, ce qu'attend l'usager.
 */
export function insertTextInRuns(
  runs: readonly TextRun[],
  offset: number,
  text: string,
  formatting?: RunFormatting,
): TextRun[] {
  if (text.length === 0) return normalizeRuns(runs);
  const format = formatting ?? formattingAt(runs, offset);
  const [before, after] = splitRunsAt(runs, offset);
  return normalizeRuns([...before, makeRun(text, format), ...after]);
}

/** Supprime la plage `[start, end)` (`SwTxtNode::EraseText`). */
export function deleteRangeInRuns(
  runs: readonly TextRun[],
  start: number,
  end: number,
): TextRun[] {
  const total = runsLength(runs);
  const from = clamp(Math.min(start, end), 0, total);
  const to = clamp(Math.max(start, end), 0, total);
  if (from === to) return normalizeRuns(runs);

  const [before] = splitRunsAt(runs, from);
  const [, after] = splitRunsAt(runs, to);
  // La liste peut devenir vide : `normalizeRuns` réinstalle alors un run vide
  // portant le formatage d'origine, pour que le paragraphe garde son style.
  return normalizeRuns([...before, ...after], formattingAt(runs, from));
}

/**
 * Applique un correctif d'attributs sur `[start, end)`.
 *
 * Sur une plage vide, il n'y a rien à écrire dans le modèle : le formatage
 * « en attente » d'un curseur replié est porté par l'état d'édition, pas par le
 * document (`SwCrsrShell::GetCurAttr` vs les hints du nœud).
 */
export function applyFormattingToRange(
  runs: readonly TextRun[],
  start: number,
  end: number,
  patch: RunFormatPatch,
): TextRun[] {
  const total = runsLength(runs);
  const from = clamp(Math.min(start, end), 0, total);
  const to = clamp(Math.max(start, end), 0, total);
  if (from === to) return normalizeRuns(runs);

  const out: TextRun[] = [];
  let consumed = 0;

  for (const run of runs) {
    const runStart = consumed;
    const runEnd = consumed + run.text.length;
    consumed = runEnd;
    const format = runFormatting(run);

    if (runEnd <= from || runStart >= to) {
      out.push(makeRun(run.text, format));
      continue;
    }

    const head = run.text.slice(0, Math.max(0, from - runStart));
    const bodyStart = Math.max(from, runStart) - runStart;
    const bodyEnd = Math.min(to, runEnd) - runStart;
    const body = run.text.slice(bodyStart, bodyEnd);
    const tail = run.text.slice(bodyEnd);

    if (head) out.push(makeRun(head, format));
    out.push(makeRun(body, patchFormatting(format, patch)));
    if (tail) out.push(makeRun(tail, format));
  }

  return normalizeRuns(out);
}

/**
 * Applique un correctif à un jeu d'attributs.
 *
 * Forme canonique imposée : un booléen est `true` ou **absent**, jamais `false`.
 * Sans cette règle, « gras » et « pas gras » seraient deux formatages distincts
 * et deux runs voisins ne fusionneraient plus — la liste enflerait à chaque
 * bascule.
 */
export function patchFormatting(
  format: RunFormatting,
  patch: RunFormatPatch,
): RunFormatting {
  const out: RunFormatting = { ...format };

  for (const key of RUN_FORMAT_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    const removes = value === null || value === undefined ||
      (BOOLEAN_KEYS.has(key) && value === false);
    if (removes) delete out[key];
    else assignFormat(out, key, value);
  }

  return out;
}

/**
 * Formatage qui s'applique à une frappe faite à cet offset.
 *
 * Writer prend celui du caractère de **gauche** (`SwTxtNode::GetAttr` avec
 * `nStt == nEnd`), sauf en début de paragraphe où il n'y a que la droite.
 */
export function formattingAt(runs: readonly TextRun[], offset: number): RunFormatting {
  if (runs.length === 0) return {};
  const clamped = clamp(offset, 0, runsLength(runs));
  if (clamped === 0) {
    const fmt = { ...runFormatting(runs[0]!) };
    delete fmt.mathLatex;
    delete fmt.mathDisplay;
    return fmt;
  }

  const { runIndex, inner } = locateOffset(runs, clamped);
  const run = runs[runIndex]!;
  const base = inner > 0 ? runFormatting(run) : runFormatting(runs[runIndex - 1] ?? run);
  const fmt = { ...base };
  delete fmt.mathLatex;
  delete fmt.mathDisplay;
  return fmt;
}

/**
 * Attributs communs à toute la plage — pour l'état des boutons de la barre
 * d'outils. Une clé absente du résultat signifie « valeurs mêlées ».
 */
export function commonFormatting(
  runs: readonly TextRun[],
  start: number,
  end: number,
): RunFormatting {
  if (start === end) return formattingAt(runs, start);

  const slice = sliceRuns(runs, start, end).filter((run) => run.text.length > 0);
  if (slice.length === 0) return formattingAt(runs, start);

  let common = runFormatting(slice[0]!);
  for (let i = 1; i < slice.length; i += 1) {
    const next = runFormatting(slice[i]!);
    for (const key of RUN_FORMAT_KEYS) {
      if ((common[key] ?? undefined) !== (next[key] ?? undefined)) delete common[key];
    }
  }
  return common;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
