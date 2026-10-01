// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Change tracking (OpenOffice: `SwRangeRedline` / `SwRedlineTbl`,
 * `sw/source/core/doc/docredln.cxx`, `sw/inc/redline.hxx`, and the `REDLINE_ON` mode of
 * `IDocumentRedlineAccess`, `sw/inc/IDocumentRedlineAccess.hxx`).
 *
 * Writer's principle, kept as it is: **in review mode, nothing is destroyed**. Typing
 * puts a `REDLINE_INSERT` on the added text; a deletion does not remove the text but puts
 * a `REDLINE_DELETE` on it. The content of the document only really changes when the
 * change is accepted (`AcceptRedline`) or rejected (`RejectRedline`).
 *
 * This symmetry explains the four cases of `applyRedline` below, which are those of
 * `docredln.cxx`:
 *
 *   accept an insertion   → keep the text, remove the mark
 *   accept a deletion     → remove the text
 *   reject an insertion   → remove the text
 *   reject a deletion     → keep the text, remove the mark
 *
 * As for bookmarks and comments, the anchor is a **run attribute** and not a pair of
 * `SwPosition`: the mark follows its text without any position-maintenance code having to
 * exist. The document's table therefore only holds the metadata: author, date, kind.
 *
 * Pure module: no React import, no DOM access.
 */

import { newId, paragraphIndex, replaceParagraph, touch } from './document';
import { makeRun, mapRunsInRange, normalizeRuns, runFormatting } from './runs';
import type { RedlineType, TextRun, WriterDocumentState } from './types';

/** Metadata of a tracked change (OpenOffice: `SwRedlineData`). */
export interface Redline {
  id: string;
  /**
   * Kind of change: insert, delete or format (`RedlineType_t`,
   * IDocumentRedlineAccess.hxx:73-75).
   */
  type: RedlineType;
  /** Author of the change (`SwRedlineData::GetAuthorString()`). */
  author: string;
  /** ISO 8601 date (`SwRedlineData::GetTimeStamp()`). */
  date: string;
  /** Optional review comment (`SwRedlineData::GetComment`). */
  comment?: string;
}

/** A tracked change, resolved to its position in the flow. */
export interface RedlineRange {
  redline: Redline;
  blockId: string;
  startOffset: number;
  endOffset: number;
  /** Text covered by the mark. */
  text: string;
}

/**
 * Writer's palette of authors (`SwPostItMgr` and `SwRedlineTbl` share it).
 *
 * Writer gives a color by the author's **rank of appearance**, not by hashing the name:
 * two authors stay distinguishable even if their names look alike, and one reviewer's
 * color does not change because another was renamed.
 */
export const REDLINE_AUTHOR_COLORS = [
  '#c9211e',
  '#2a6099',
  '#158466',
  '#8e5ea2',
  '#c9601e',
  '#7a3b8f',
  '#00709e',
  '#a33e00',
] as const;

/** Authors of the document, in order of first appearance. */
export function redlineAuthors(doc: WriterDocumentState): string[] {
  const seen: string[] = [];
  for (const redline of doc.redlines ?? []) {
    if (!seen.includes(redline.author)) seen.push(redline.author);
  }
  return seen;
}

/** Color assigned to an author, stable for a given document. */
export function redlineAuthorColor(doc: WriterDocumentState, author: string): string {
  const index = redlineAuthors(doc).indexOf(author);
  const palette = REDLINE_AUTHOR_COLORS;
  return palette[(index < 0 ? 0 : index) % palette.length] ?? palette[0];
}

/* ----------------------------------------------------------------- reading */

/** Is the document under review? */
export function hasRedlines(doc: WriterDocumentState): boolean {
  return (doc.redlines ?? []).length > 0;
}

/** Metadata of a mark, by id. */
export function findRedline(doc: WriterDocumentState, id: string): Redline | null {
  return (doc.redlines ?? []).find((redline) => redline.id === id) ?? null;
}

/**
 * All the marks resolved to their position, in flow order.
 *
 * One mark can give several ranges if a later edit cut it in two; each one is returned
 * separately, as `SwRedlineTbl` keeps one entry per interval.
 */
export function listRedlineRanges(doc: WriterDocumentState): RedlineRange[] {
  const byId = new Map((doc.redlines ?? []).map((redline) => [redline.id, redline]));
  if (byId.size === 0) return [];

  const out: RedlineRange[] = [];
  const { order, byId: paragraphs } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = paragraphs.get(blockId)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    let open: { id: string; start: number; text: string } | null = null;

    for (const run of paragraph.runs) {
      const id = run.redlineId;
      if (open && open.id !== id) {
        pushRange(out, byId, blockId, open, offset);
        open = null;
      }
      if (id && byId.has(id)) {
        if (open) open.text += run.text;
        else open = { id, start: offset, text: run.text };
      }
      offset += run.text.length;
    }

    if (open) pushRange(out, byId, blockId, open, offset);
  }

  return out;
}

function pushRange(
  out: RedlineRange[],
  byId: Map<string, Redline>,
  blockId: string,
  open: { id: string; start: number; text: string },
  end: number,
): void {
  const redline = byId.get(open.id);
  if (!redline) return;
  out.push({ redline, blockId, startOffset: open.start, endOffset: end, text: open.text });
}

/**
 * Text of the document as it would be after accepting every mark.
 *
 * Useful for search and word counting: counting the characters of a pending deletion
 * would distort the displayed statistics.
 */
export function visibleText(paragraph: { runs: readonly TextRun[] }): string {
  let out = '';
  for (const run of paragraph.runs) {
    if (run.redlineType === 'delete') continue;
    out += run.text;
  }
  return out;
}

/* ------------------------------------------------------- placing a mark */

export interface RedlineAuthor {
  author: string;
  now?: string;
}

/**
 * Marks a range as inserted.
 *
 * Called by `edit.ts` **after** the text has been inserted in the normal way: in review
 * mode the insertion itself does not change, only its signature is added.
 */
export function markInserted(
  doc: WriterDocumentState,
  blockId: string,
  startOffset: number,
  endOffset: number,
  who: RedlineAuthor,
): WriterDocumentState {
  return markRange(doc, blockId, startOffset, endOffset, 'insert', who);
}

/**
 * Marks a range as deleted, **without removing the text**.
 *
 * This is the heart of review mode: `SwDoc::DeleteRange` under `REDLINE_ON` never calls
 * `DeleteRangeImpl`, it puts a `REDLINE_DELETE`.
 *
 * One special case reproduces Writer's: deleting text that **the same author** had just
 * inserted, before that mark was accepted, removes the text for good. Without this rule,
 * correcting your own typing would leave a trail of struck-through characters that nobody
 * ever meant to write.
 */
export function markDeleted(
  doc: WriterDocumentState,
  blockId: string,
  startOffset: number,
  endOffset: number,
  who: RedlineAuthor,
): { doc: WriterDocumentState; removedRanges: { start: number; end: number }[] } {
  const node = paragraphIndex(doc).byId.get(blockId)?.paragraph;
  if (!node) return { doc, removedRanges: [] };

  const start = Math.max(0, Math.min(startOffset, endOffset));
  const end = Math.max(startOffset, endOffset);
  if (end <= start) return { doc, removedRanges: [] };

  // Split at both ends without transforming anything: the decision is then made run by run,
  // and there are three possible outcomes where `mapRunsInRange` only offers one.
  const split = mapRunsInRange(node.runs, start, end, (run) => run);
  const kept: TextRun[] = [];
  const removedRanges: { start: number; end: number }[] = [];
  const redlineId = newId('rl');
  let offset = 0;
  let used = false;

  for (const run of split) {
    const runEnd = offset + run.text.length;
    const inside = offset >= start && runEnd <= end && run.text.length > 0;

    if (!inside) {
      kept.push(run);
      offset = runEnd;
      continue;
    }

    const ownFreshInsert =
      run.redlineType === 'insert' &&
      run.redlineId !== undefined &&
      findRedline(doc, run.redlineId)?.author === who.author;

    if (ownFreshInsert) {
      // The text really disappears: nothing is pushed into `kept`.
      removedRanges.push({ start: offset, end: runEnd });
      offset = runEnd;
      continue;
    }

    // Already marked as deleted: a second deletion adds nothing.
    if (run.redlineType === 'delete') {
      kept.push(run);
      offset = runEnd;
      continue;
    }

    used = true;
    kept.push(withRedline(run, redlineId, 'delete'));
    offset = runEnd;
  }

  const runs = normalizeRuns(kept, node.runs[0] ? runFormatting(node.runs[0]) : {});
  let next = replaceParagraph(doc, blockId, { ...node, runs });

  if (used) {
    next = {
      ...next,
      redlines: [...(next.redlines ?? []), makeRedline(redlineId, 'delete', who)],
    };
  }

  return { doc: pruneOrphanRedlines(touch(next)), removedRanges };
}

/** Marks a range as reformatted (`REDLINE_FORMAT`). */
export function markFormatted(
  doc: WriterDocumentState,
  blockId: string,
  startOffset: number,
  endOffset: number,
  who: RedlineAuthor,
): WriterDocumentState {
  return markRange(doc, blockId, startOffset, endOffset, 'format', who);
}

function markRange(
  doc: WriterDocumentState,
  blockId: string,
  startOffset: number,
  endOffset: number,
  type: RedlineType,
  who: RedlineAuthor,
): WriterDocumentState {
  const node = paragraphIndex(doc).byId.get(blockId)?.paragraph;
  if (!node) return doc;

  const start = Math.max(0, Math.min(startOffset, endOffset));
  const end = Math.max(startOffset, endOffset);
  if (end <= start) return doc;

  const redlineId = newId('rl');
  const split = mapRunsInRange(node.runs, start, end, (run) => run);
  const out: TextRun[] = [];
  let offset = 0;
  let used = false;

  for (const run of split) {
    const runEnd = offset + run.text.length;
    const inside = offset >= start && runEnd <= end && run.text.length > 0;
    // A deletion mark takes precedence over an insertion or format mark: the text is about to
    // disappear, so reformatting it makes no sense.
    if (inside && run.redlineType !== 'delete') {
      used = true;
      out.push(withRedline(run, redlineId, type));
    } else {
      out.push(run);
    }
    offset = runEnd;
  }

  if (!used) return doc;

  const withMark = replaceParagraph(doc, blockId, {
    ...node,
    runs: normalizeRuns(out, node.runs[0] ? runFormatting(node.runs[0]) : {}),
  });

  return pruneOrphanRedlines(
    touch({ ...withMark, redlines: [...(doc.redlines ?? []), makeRedline(redlineId, type, who)] }),
  );
}

function makeRedline(id: string, type: RedlineType, who: RedlineAuthor): Redline {
  return {
    id,
    type,
    author: who.author,
    date: who.now ?? new Date().toISOString(),
  };
}

/* ------------------------------------------------ accepting and rejecting */

/**
 * Applies or cancels a mark. (OpenOffice: `SwDoc::AcceptRedline` /
 * `SwDoc::RejectRedline`.)
 *
 * The four combinations are the ones described at the top of the module. The `format`
 * case is symmetric and has no destructive version: the formatting has already been
 * applied to the text, so accepting and rejecting both just remove the mark. This is the
 * limit of the model: in C++, `SwRedlineData` keeps the previous attribute set so that it
 * can restore it.
 */
export function applyRedline(
  doc: WriterDocumentState,
  redlineId: string,
  action: 'accept' | 'reject',
): WriterDocumentState {
  const redline = findRedline(doc, redlineId);
  if (!redline) return doc;

  const removesText =
    (redline.type === 'delete' && action === 'accept') ||
    (redline.type === 'insert' && action === 'reject');

  let next = doc;
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    if (!paragraph.runs.some((run) => run.redlineId === redlineId)) continue;

    const kept = removesText
      ? paragraph.runs.filter((run) => run.redlineId !== redlineId)
      : paragraph.runs.map((run) =>
          run.redlineId === redlineId ? withRedline(run, undefined, undefined) : run,
        );

    next = replaceParagraph(next, blockId, {
      ...paragraph,
      runs: normalizeRuns(kept, paragraph.runs[0] ? runFormatting(paragraph.runs[0]) : {}),
    });
  }

  return touch({
    ...next,
    redlines: (next.redlines ?? []).filter((entry) => entry.id !== redlineId),
  });
}

/** Accepts every mark, or only those of one author. */
export function acceptAllRedlines(
  doc: WriterDocumentState,
  author?: string,
): WriterDocumentState {
  return applyAll(doc, 'accept', author);
}

/** Rejects every mark, or only those of one author. */
export function rejectAllRedlines(
  doc: WriterDocumentState,
  author?: string,
): WriterDocumentState {
  return applyAll(doc, 'reject', author);
}

function applyAll(
  doc: WriterDocumentState,
  action: 'accept' | 'reject',
  author?: string,
): WriterDocumentState {
  const targets = (doc.redlines ?? [])
    .filter((redline) => author === undefined || redline.author === author)
    .map((redline) => redline.id);

  let next = doc;
  for (const id of targets) next = applyRedline(next, id, action);
  return next;
}

/* ------------------------------------------------------------- utilities */

/**
 * Removes from the table the marks whose anchor no run carries any more.
 *
 * Without this cleanup, editing over a revision would leave invisible entries in the
 * table, which the ODF export would write out again with no range.
 */
export function pruneOrphanRedlines(doc: WriterDocumentState): WriterDocumentState {
  const redlines = doc.redlines ?? [];
  if (redlines.length === 0) return doc;

  const anchored = new Set<string>();
  const { order, byId } = paragraphIndex(doc);
  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    for (const run of paragraph.runs) {
      if (run.redlineId) anchored.add(run.redlineId);
    }
  }

  const kept = redlines.filter((redline) => anchored.has(redline.id));
  return kept.length === redlines.length ? doc : { ...doc, redlines: kept };
}

function withRedline(
  run: TextRun,
  redlineId: string | undefined,
  redlineType: RedlineType | undefined,
): TextRun {
  const out = makeRun(run.text, runFormatting(run));
  if (redlineId !== undefined) out.redlineId = redlineId;
  else delete out.redlineId;
  if (redlineType !== undefined) out.redlineType = redlineType;
  else delete out.redlineType;
  return out;
}
