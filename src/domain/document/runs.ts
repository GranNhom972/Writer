// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Operations on the formatting ranges of a paragraph.
 *
 * Functional equivalent of `SwpHints` (`sw/source/core/txtnode/thints.cxx`): insert, delete
 * and set an attribute on an interval, while preserving the `SwpHints::MergePortions`
 * invariant: **never two adjacent runs with identical formatting**, and never an empty run
 * (except in an empty paragraph).
 *
 * All the functions are pure: they return new arrays and never modify their arguments.
 */

import { RUN_FORMAT_KEYS, type RunFormatKey, type RunFormatting, type TextRun } from './types';

/**
 * Attribute change to apply on a range.
 *
 * `null` **removes** the attribute: the run goes back to the document's default style.
 * This is the distinction Writer makes between `SwTxtNode::SetAttr` and
 * `SwTxtNode::ResetAttr`: removing is not the same as setting the default value, because a
 * named style could redefine it.
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

/** Length of the paragraph's raw string (`SwTxtNode::m_Text.Len()`). */
export function runsLength(runs: readonly TextRun[]): number {
  let total = 0;
  for (const run of runs) total += run.text.length;
  return total;
}

/** Raw string of the paragraph: it is the one the cursor offsets index into. */
export function runsText(runs: readonly TextRun[]): string {
  let out = '';
  for (const run of runs) out += run.text;
  return out;
}

/** Extracts the attribute set of a run, without its text. */
export function runFormatting(run: TextRun): RunFormatting {
  const out: RunFormatting = {};
  for (const key of RUN_FORMAT_KEYS) {
    const value = run[key];
    if (value !== undefined) assignFormat(out, key, value);
  }
  return out;
}

/**
 * Writes a formatting key while keeping its typing.
 *
 * Going through a function is necessary under `exactOptionalPropertyTypes`: a direct
 * indexed assignment does not prove to the compiler that the value matches *that* key.
 */
function assignFormat(target: RunFormatting, key: RunFormatKey, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

/** Do two ranges carry exactly the same formatting? (`*p1 == *p2`) */
export function sameFormatting(a: RunFormatting, b: RunFormatting): boolean {
  for (const key of RUN_FORMAT_KEYS) {
    // `undefined` and an absent key are the same state: "attribute not set".
    if ((a[key] ?? undefined) !== (b[key] ?? undefined)) return false;
  }
  return true;
}

/** Builds a run from a text and an attribute set. */
export function makeRun(text: string, formatting: RunFormatting = {}): TextRun {
  const run: TextRun = { text };
  for (const key of RUN_FORMAT_KEYS) {
    const value = formatting[key];
    if (value !== undefined) assignFormat(run, key, value);
  }
  return run;
}

/**
 * Restores the invariants: removes empty runs and merges adjacent ones that have identical
 * formatting. (OpenOffice: `SwpHints::MergePortions`.)
 *
 * An empty paragraph keeps **one** empty run, which carries the formatting the next
 * keystroke will take, just as a `SwTxtNode` with empty text keeps its `SwAttrSet`.
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
    // The formatting of the emptied paragraph outlives it: without this carrier, typing again
    // in a paragraph that has just been erased would start from the default style instead of
    // resuming the one it had.
    const carrier = fallback ?? (runs[0] ? runFormatting(runs[0]) : {});
    return [makeRun('', carrier)];
  }
  return out;
}

/** Locates the offset: index of the run that contains it, and position inside that run. */
export function locateOffset(
  runs: readonly TextRun[],
  offset: number,
): { runIndex: number; inner: number } {
  let remaining = offset;
  for (let i = 0; i < runs.length; i += 1) {
    const length = runs[i]!.text.length;
    // `<=`: an offset at the end of a run belongs to that run, so that typing inherits the
    // formatting on the left (Writer's rule, see formattingAt).
    if (remaining <= length) return { runIndex: i, inner: remaining };
    remaining -= length;
  }
  const lastIndex = Math.max(0, runs.length - 1);
  return { runIndex: lastIndex, inner: runs[lastIndex]?.text.length ?? 0 };
}

/** Splits the list of runs in two at the given offset (`SwTxtNode::SplitCntntNode`). */
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

  // An empty half must still carry the formatting of the cut point, which `normalizeRuns`
  // could not guess from an empty array.
  const atCut = formattingAt(runs, clamped);
  return [normalizeRuns(before, atCut), normalizeRuns(after, atCut)];
}

/** Extracts the range `[start, end)` while keeping the local formatting. */
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
 * Inserts text at the given offset.
 *
 * With no explicit formatting, the text inherits that of the position, meaning the
 * character **on the left** (see `formattingAt`): typing right after a bold word keeps
 * going in bold, which is what the user expects.
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

/** Deletes the range `[start, end)` (`SwTxtNode::EraseText`). */
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
  // The list may become empty: `normalizeRuns` then puts back an empty run that carries the
  // original formatting, so that the paragraph keeps its style.
  return normalizeRuns([...before, ...after], formattingAt(runs, from));
}

/**
 * Applies an attribute patch on `[start, end)`.
 *
 * On an empty range there is nothing to write into the model: the "pending" formatting of
 * a collapsed cursor is carried by the editing state, not by the document
 * (`SwCrsrShell::GetCurAttr` vs the node's hints).
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
 * Applies a patch to an attribute set.
 *
 * Canonical form enforced: a boolean is `true` or **absent**, never `false`. Without this
 * rule, "bold" and "not bold" would be two distinct formattings and two neighboring runs
 * would no longer merge, so the list would grow at every toggle.
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
 * Attributes that an object **does not pass on** to text typed next to it.
 *
 * A formula and an image frame are objects, not a style: typing after them must produce
 * text, not a second identical object. Writer makes the same distinction:
 * `SwTxtNode::GetAttr` never returns an object's `SwTxtAttr` as the current formatting.
 */
const OBJECT_KEYS = [
  'mathLatex',
  'mathDisplay',
  'imageSrc',
  'imageWidthPt',
  'imageHeightPt',
  'imageAlt',
] as const satisfies readonly RunFormatKey[];

function withoutObjectAttributes(formatting: RunFormatting): RunFormatting {
  const out = { ...formatting };
  for (const key of OBJECT_KEYS) delete out[key];
  return out;
}

/**
 * Formatting that applies to a keystroke made at this offset.
 *
 * Writer takes that of the character on the **left** (`SwTxtNode::GetAttr` with
 * `nStt == nEnd`), except at the start of a paragraph where there is only the right one.
 */
export function formattingAt(runs: readonly TextRun[], offset: number): RunFormatting {
  if (runs.length === 0) return {};
  const clamped = clamp(offset, 0, runsLength(runs));
  if (clamped === 0) return withoutObjectAttributes(runFormatting(runs[0]!));

  const { runIndex, inner } = locateOffset(runs, clamped);
  const run = runs[runIndex]!;
  const base = inner > 0 ? runFormatting(run) : runFormatting(runs[runIndex - 1] ?? run);
  return withoutObjectAttributes(base);
}

/**
 * Attributes common to the whole range, for the state of the toolbar buttons. A key that
 * is missing from the result means "mixed values".
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

/**
 * Applies a transformation to only the runs covering `[start, end)`.
 *
 * Runs that straddle a boundary are cut in two, the equivalent of `SwpHints::SplitAttr`
 * (thints.cxx) when a character attribute is set in the middle of an existing range. It is
 * the operation that the three subsystems anchoring a marker in the text depend on:
 * comments, bookmarks and revisions. It lives here rather than being copied three times,
 * because being off by one character on a boundary is a silent error.
 *
 * The result is **not** normalized: the caller decides, because normalizing would remove
 * the empty run that an empty paragraph must keep.
 */
export function mapRunsInRange(
  runs: readonly TextRun[],
  start: number,
  end: number,
  transform: (run: TextRun) => TextRun,
): TextRun[] {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(start, end);
  if (to <= from) return [...runs];

  const out: TextRun[] = [];
  let offset = 0;

  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;

    // Outside the range, or an empty run (carrier of the formatting of an emptied paragraph):
    // transforming it would set an attribute on nothing.
    if (runEnd <= from || runStart >= to || run.text.length === 0) {
      out.push(run);
      continue;
    }

    const format = runFormatting(run);
    const cutStart = Math.max(from, runStart) - runStart;
    const cutEnd = Math.min(to, runEnd) - runStart;

    if (cutStart > 0) out.push(makeRun(run.text.slice(0, cutStart), format));
    out.push(transform(makeRun(run.text.slice(cutStart, cutEnd), format)));
    if (cutEnd < run.text.length) out.push(makeRun(run.text.slice(cutEnd), format));
  }

  return out;
}
