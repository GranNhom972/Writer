// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Margin comments (OpenOffice: `SwPostItField`, `sw/source/core/fields/postit.cxx`,
 * and `SwPostItMgr`, `sw/source/ui/docvw/PostItMgr.cxx`).
 *
 * Writer stores a comment in two pieces, and that split is what we reuse here:
 *
 *   - the **anchor** is a text attribute set on the commented range (`SwFmtFld` on
 *     a `SwPostItField`); it lives in the paragraph and follows the text when the
 *     text moves, without any cursor code having to know about it;
 *   - the **content** (author, date, text, replies) lives in a table of the
 *     document, indexed by id.
 *
 * This split has a direct consequence that we want: deleting the commented text
 * deletes the anchor, so the comment disappears from the gutter, but its content can
 * still be recovered until the document is cleaned up. `SwPostItMgr` works exactly
 * that way.
 *
 * Discussion threads are flat, as in Writer: a reply carries the `threadId` of the
 * root comment. A thread of threads does not exist.
 *
 * Pure module: no React import, no DOM access.
 */

import { newId, paragraphIndex, replaceParagraph, touch } from './document';
import { makeRun, mapRunsInRange, normalizeRuns, runFormatting } from './runs';
import type { TextRun, WriterDocumentState } from './types';

/** A comment or a reply (OpenOffice: `SwPostItField`). */
export interface DocumentComment {
  id: string;
  /**
   * Id of the thread. For a root comment `threadId === id`; for a reply it is the id
   * of the root comment.
   */
  threadId: string;
  /** The author (`SwPostItField::GetPar1()`). */
  author: string;
  /** Initials shown in the badge (`SwPostItField::GetInitials`). */
  initials?: string;
  /** ISO 8601 date (`SwPostItField::GetDateTime()`). */
  createdAt: string;
  /** The body of the comment (`SwPostItField::GetPar2()`). */
  text: string;
  /** Closed thread: kept, but greyed out and removed from the review flow. */
  resolved?: boolean;
}

/** A thread: the root comment and its replies, in the order they were posted. */
export interface CommentThread {
  id: string;
  root: DocumentComment;
  replies: DocumentComment[];
  resolved: boolean;
  /** Excerpt of the anchored text, to place the thread without opening the page. */
  quotedText: string;
  /** Paragraph holding the anchor, or `null` if the anchor has been deleted. */
  anchorBlockId: string | null;
}

/* ------------------------------------------------------- anchors on the runs */

/**
 * Splits the scalar `commentIds` key into a list.
 *
 * The storage is a sorted string joined by commas, and not an array:
 * `sameFormatting` compares run attributes with `!==`, and two arrays with the same
 * content would never be equal there, so neighboring runs would stop merging and
 * the `SwpHints::MergePortions` invariant would fall. See types.ts.
 */
export function commentIdsOf(run: Pick<TextRun, 'commentIds'>): string[] {
  if (!run.commentIds) return [];
  return run.commentIds.split(',').filter((id) => id.length > 0);
}

/** Builds the scalar key back from a list, sorted and without duplicates. */
export function joinCommentIds(ids: readonly string[]): string | undefined {
  const unique = Array.from(new Set(ids.filter((id) => id.length > 0))).sort();
  return unique.length > 0 ? unique.join(',') : undefined;
}

/** Adds a thread id to the set of anchors of a run. */
function withCommentId(run: TextRun, threadId: string): TextRun {
  const next = joinCommentIds([...commentIdsOf(run), threadId]);
  const out = makeRun(run.text, runFormatting(run));
  if (next !== undefined) out.commentIds = next;
  else delete out.commentIds;
  return out;
}

/** Removes a thread id from the set of anchors of a run. */
function withoutCommentId(run: TextRun, threadId: string): TextRun {
  const next = joinCommentIds(commentIdsOf(run).filter((id) => id !== threadId));
  const out = makeRun(run.text, runFormatting(run));
  if (next !== undefined) out.commentIds = next;
  else delete out.commentIds;
  return out;
}

/* ----------------------------------------------------------------- reading */

/** All the threads of the document, in the order their anchors appear. */
export function commentThreads(doc: WriterDocumentState): CommentThread[] {
  const comments = doc.comments ?? [];
  if (comments.length === 0) return [];

  const roots = new Map<string, DocumentComment>();
  const replies = new Map<string, DocumentComment[]>();
  for (const comment of comments) {
    if (comment.id === comment.threadId) {
      roots.set(comment.id, comment);
    } else {
      const list = replies.get(comment.threadId) ?? [];
      list.push(comment);
      replies.set(comment.threadId, list);
    }
  }

  // The gutter order is the order of the text, not the order of the table: this is
  // what `SwPostItMgr::Sort` does, and it is the only order that lets someone follow
  // a review from top to bottom.
  const anchors = commentAnchors(doc);
  const ordered: CommentThread[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const root = roots.get(anchor.threadId);
    if (!root || seen.has(anchor.threadId)) continue;
    seen.add(anchor.threadId);
    ordered.push({
      id: root.id,
      root,
      replies: replies.get(root.id) ?? [],
      resolved: root.resolved === true,
      quotedText: anchor.text,
      anchorBlockId: anchor.blockId,
    });
  }

  // Threads whose anchor has disappeared: they stay listed, without a position.
  for (const root of roots.values()) {
    if (seen.has(root.id)) continue;
    ordered.push({
      id: root.id,
      root,
      replies: replies.get(root.id) ?? [],
      resolved: root.resolved === true,
      quotedText: '',
      anchorBlockId: null,
    });
  }

  return ordered;
}

export interface CommentAnchor {
  threadId: string;
  blockId: string;
  /** Start offset in the paragraph's raw string. */
  startOffset: number;
  endOffset: number;
  text: string;
}

/**
 * Position of each anchor in the flow.
 *
 * One thread can have several non-contiguous ranges (the commented text was split
 * by an edit): we return every range, and the first one gives the thread's position
 * in the gutter.
 */
export function commentAnchors(doc: WriterDocumentState): CommentAnchor[] {
  const out: CommentAnchor[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    // Current range per thread: a thread that is interrupted then resumed gives two
    // ranges.
    const open = new Map<string, { start: number; text: string }>();
    let offset = 0;

    for (const run of paragraph.runs) {
      const ids = new Set(commentIdsOf(run));
      for (const [threadId, range] of [...open]) {
        if (ids.has(threadId)) continue;
        out.push({ threadId, blockId, startOffset: range.start, endOffset: offset, text: range.text });
        open.delete(threadId);
      }
      for (const threadId of ids) {
        const range = open.get(threadId);
        if (range) range.text += run.text;
        else open.set(threadId, { start: offset, text: run.text });
      }
      offset += run.text.length;
    }

    for (const [threadId, range] of open) {
      out.push({ threadId, blockId, startOffset: range.start, endOffset: offset, text: range.text });
    }
  }

  return out;
}

/* ---------------------------------------------------------------- writing */

export interface CommentRange {
  blockId: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Puts a comment on a range of text.
 *
 * Counterpart of `SwEditShell::InsertPostIt`. The range is split at both ends, then
 * each run inside gets the thread id; the content is pushed into the document's
 * table.
 */
export function addComment(
  doc: WriterDocumentState,
  range: CommentRange,
  author: string,
  text: string,
  options: { initials?: string; now?: string } = {},
): { doc: WriterDocumentState; threadId: string } {
  const body = text.trim();
  const node = paragraphIndex(doc).byId.get(range.blockId)?.paragraph;
  if (!body || !node) return { doc, threadId: '' };

  const start = Math.max(0, Math.min(range.startOffset, range.endOffset));
  const end = Math.max(range.startOffset, range.endOffset);
  // An empty range has nothing to anchor: Writer also refuses a comment with no
  // selection on an empty paragraph.
  if (end <= start) return { doc, threadId: '' };

  const threadId = newId('cmt');
  const runs = normalizeRuns(
    mapRunsInRange(node.runs, start, end, (run) => withCommentId(run, threadId)),
    runFormatting(node.runs[0] ?? makeRun('')),
  );

  const comment: DocumentComment = {
    id: threadId,
    threadId,
    author,
    createdAt: options.now ?? new Date().toISOString(),
    text: body,
    ...(options.initials !== undefined ? { initials: options.initials } : {}),
  };

  const withAnchor = replaceParagraph(doc, range.blockId, { ...node, runs });
  return {
    doc: touch({ ...withAnchor, comments: [...(doc.comments ?? []), comment] }),
    threadId,
  };
}

/** Adds a reply to an existing thread (`SwPostItMgr::Reply`). */
export function replyToComment(
  doc: WriterDocumentState,
  threadId: string,
  author: string,
  text: string,
  options: { initials?: string; now?: string } = {},
): WriterDocumentState {
  const body = text.trim();
  const comments = doc.comments ?? [];
  if (!body || !comments.some((c) => c.id === threadId)) return doc;

  const reply: DocumentComment = {
    id: newId('cmt'),
    threadId,
    author,
    createdAt: options.now ?? new Date().toISOString(),
    text: body,
    ...(options.initials !== undefined ? { initials: options.initials } : {}),
  };

  return touch({ ...doc, comments: [...comments, reply] });
}

/** Marks a thread as resolved, or reopens it. */
export function resolveCommentThread(
  doc: WriterDocumentState,
  threadId: string,
  resolved = true,
): WriterDocumentState {
  const comments = doc.comments ?? [];
  if (!comments.some((c) => c.id === threadId)) return doc;
  return touch({
    ...doc,
    comments: comments.map((c) => (c.id === threadId ? { ...c, resolved } : c)),
  });
}

/** Edits the body of a comment or a reply. */
export function editComment(
  doc: WriterDocumentState,
  commentId: string,
  text: string,
): WriterDocumentState {
  const body = text.trim();
  const comments = doc.comments ?? [];
  if (!body || !comments.some((c) => c.id === commentId)) return doc;
  return touch({
    ...doc,
    comments: comments.map((c) => (c.id === commentId ? { ...c, text: body } : c)),
  });
}

/**
 * Deletes a thread: its content **and** its anchors.
 *
 * Removing the anchor without the content would leave a ghost thread in the table;
 * removing the content without the anchor would leave a run attribute pointing at
 * nothing, which would stop two neighboring runs from merging. So the two go
 * together, which is what `SwDoc::DelFullPara` does for a note field.
 */
export function deleteCommentThread(
  doc: WriterDocumentState,
  threadId: string,
): WriterDocumentState {
  const comments = (doc.comments ?? []).filter((c) => c.threadId !== threadId);

  let next = doc;
  const { order, byId } = paragraphIndex(doc);
  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    if (!paragraph.runs.some((run) => commentIdsOf(run).includes(threadId))) continue;
    const runs = paragraph.runs.map((run) => withoutCommentId(run, threadId));
    next = replaceParagraph(next, blockId, { ...paragraph, runs });
  }

  return touch({ ...next, comments });
}

/** Deletes a single reply of a thread (never the root, see `deleteCommentThread`). */
export function deleteCommentReply(
  doc: WriterDocumentState,
  commentId: string,
): WriterDocumentState {
  const comments = doc.comments ?? [];
  const target = comments.find((c) => c.id === commentId);
  if (!target || target.id === target.threadId) return doc;
  return touch({ ...doc, comments: comments.filter((c) => c.id !== commentId) });
}

/**
 * Removes the threads that no longer have any anchor (`SwPostItMgr::Delete`).
 *
 * Call it after deleting text: otherwise the table fills up with invisible threads
 * that the ODF export would write out again with no matching range.
 */
export function pruneOrphanComments(doc: WriterDocumentState): WriterDocumentState {
  const comments = doc.comments ?? [];
  if (comments.length === 0) return doc;

  const anchored = new Set(commentAnchors(doc).map((a) => a.threadId));
  const kept = comments.filter((c) => anchored.has(c.threadId));
  if (kept.length === comments.length) return doc;
  return touch({ ...doc, comments: kept });
}
