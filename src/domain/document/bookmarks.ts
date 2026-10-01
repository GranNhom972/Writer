// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Bookmarks and internal cross-references (OpenOffice: `SwBookmark` /
 * `IDocumentMarkAccess`, `sw/source/core/doc/docbm.cxx`, `sw/inc/bookmrk.hxx`).
 *
 * A bookmark is a named place in the text that a link such as `#name` can jump to.
 * In Writer it is a **position marker**, not a node: `MarkBase` holds a start
 * `SwPosition` and, for a range bookmark, an end `SwPosition`. The engine updates
 * the marker on every edit, which is how it follows its text.
 *
 * We get the same behavior without any update machinery: the bookmark's name is a
 * **run attribute**, so it travels with the text by construction. Inserting in the
 * middle of a bookmark extends it, deleting shortens it, and erasing all of the
 * anchored text makes it disappear, which are the three behaviors of `docbm.cxx`
 * without a single line of maintenance code.
 *
 * The accepted trade-off: two bookmarks cannot overlap on the same run, because
 * `bookmarkName` is a scalar (see the `sameFormatting` invariant documented in
 * types.ts). Writer's interface does not let you create such an overlap either.
 *
 * Pure module: no React import, no DOM access.
 */

import { paragraphIndex, replaceParagraph, touch } from './document';
import { makeRun, mapRunsInRange, normalizeRuns, runFormatting } from './runs';
import { isParagraph, type HeadingLevel, type TextRun, type WriterDocumentState } from './types';

/** A bookmark placed in the document. */
export interface Bookmark {
  /** Unique name, the one a `#name` link points to (`::sw::mark::MarkBase::GetName`). */
  name: string;
  blockId: string;
  /** Offsets in the paragraph's raw string. Equal for a point bookmark. */
  startOffset: number;
  endOffset: number;
  /** Text covered, empty for a point bookmark. */
  text: string;
}

/** A target that an internal cross-reference can reach: a bookmark **or** a heading. */
export interface LinkTarget {
  kind: 'bookmark' | 'heading';
  name: string;
  blockId: string;
  /** Label to display: the bookmark's name, or the heading's text. */
  label: string;
  headingLevel?: HeadingLevel;
}

/**
 * Characters refused in a bookmark name: control characters and XML delimiters.
 *
 * Built with `new RegExp` from escape sequences: a range of control characters
 * written literally in the source would be invisible when reading it, and a review
 * that cannot see what it is validating is worth nothing.
 */
const INVALID_BOOKMARK_CHARS = new RegExp('[\\u0000-\\u001F\\u007F"\'<>&]', 'g');

/**
 * Normalizes a bookmark name.
 *
 * ODF requires a non-empty name and uses it as is in `text:name`; spaces are legal
 * there but make `#name` links fragile once the ODT has been converted. So we apply
 * the same normalization Writer applies on HTML export: spaces become underscores
 * and control characters are removed.
 */
export function normalizeBookmarkName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '_')
    .replace(INVALID_BOOKMARK_CHARS, '')
    .slice(0, 120);
}

/* ----------------------------------------------------------------- reading */

/** All the bookmarks, in document order. */
export function listBookmarks(doc: WriterDocumentState): Bookmark[] {
  const out: Bookmark[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    let open: { name: string; start: number; text: string } | null = null;

    for (const run of paragraph.runs) {
      const name = run.bookmarkName;
      if (open && open.name !== name) {
        out.push({
          name: open.name,
          blockId,
          startOffset: open.start,
          endOffset: offset,
          text: open.text,
        });
        open = null;
      }
      if (name) {
        if (open) open.text += run.text;
        else open = { name, start: offset, text: run.text };
      }
      offset += run.text.length;
    }

    if (open) {
      out.push({
        name: open.name,
        blockId,
        startOffset: open.start,
        endOffset: offset,
        text: open.text,
      });
    }
  }

  return out;
}

/** Finds a bookmark by its name, or `null`. */
export function findBookmark(doc: WriterDocumentState, name: string): Bookmark | null {
  const wanted = normalizeBookmarkName(name);
  return listBookmarks(doc).find((mark) => mark.name === wanted) ?? null;
}

/** Reserved prefix for heading anchors, the one Writer uses when exporting. */
const HEADING_ANCHOR_PREFIX = '__RefHeading__';

/**
 * Anchor id of a heading, used for the cross-references of a table of contents.
 *
 * Writer names these anchors `__RefHeading__<id>`; we keep the same reserved
 * prefix, which tells them apart for certain from a bookmark placed by hand.
 */
export function headingAnchorName(blockId: string): string {
  return `${HEADING_ANCHOR_PREFIX}${blockId}`;
}

/** The original blockId of a heading anchor, or `null` if the name is not one. */
export function blockIdFromHeadingAnchor(name: string): string | null {
  return name.startsWith(HEADING_ANCHOR_PREFIX)
    ? name.slice(HEADING_ANCHOR_PREFIX.length)
    : null;
}

/**
 * All the cross-reference targets: bookmarks placed by hand **and** headings.
 *
 * Writer offers both in its cross-reference dialog (`SwFldRefPage`), for the
 * obvious reason that a table of contents points to headings that nobody had to
 * mark one by one.
 */
export function linkTargets(doc: WriterDocumentState): LinkTarget[] {
  const out: LinkTarget[] = [];

  for (const mark of listBookmarks(doc)) {
    out.push({ kind: 'bookmark', name: mark.name, blockId: mark.blockId, label: mark.name });
  }

  for (const block of doc.blocks) {
    if (!isParagraph(block) || block.type !== 'heading') continue;
    const label = block.runs
      .map((run) => run.text)
      .join('')
      .trim();
    if (!label) continue;
    const target: LinkTarget = {
      kind: 'heading',
      name: headingAnchorName(block.id),
      blockId: block.id,
      label,
    };
    if (block.headingLevel !== undefined) target.headingLevel = block.headingLevel;
    out.push(target);
  }

  return out;
}

/**
 * Resolves the `href` of an internal cross-reference to the paragraph it points to.
 *
 * Returns `null` for an external address (`http:`, `mailto:` ...): the caller must
 * then let the browser do its job.
 */
export function resolveInternalLink(
  doc: WriterDocumentState,
  href: string,
): { blockId: string; offset: number } | null {
  if (!href.startsWith('#')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(href.slice(1));
  } catch {
    // A badly formed `%` sequence is no reason to make the resolution fail: the link is
    // simply treated as broken.
    decoded = href.slice(1);
  }

  const name = normalizeBookmarkName(decoded);
  if (!name) return null;

  const headingBlockId = blockIdFromHeadingAnchor(name);
  if (headingBlockId) {
    const exists = paragraphIndex(doc).byId.has(headingBlockId);
    return exists ? { blockId: headingBlockId, offset: 0 } : null;
  }

  const mark = findBookmark(doc, name);
  return mark ? { blockId: mark.blockId, offset: mark.startOffset } : null;
}

/** A `#name` link that points to a target which no longer exists is broken. */
export function brokenInternalLinks(doc: WriterDocumentState): string[] {
  const broken = new Set<string>();
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    for (const run of paragraph.runs) {
      const href = run.linkHref;
      if (!href || !href.startsWith('#')) continue;
      if (!resolveInternalLink(doc, href)) broken.add(href);
    }
  }

  return [...broken].sort();
}

/* ---------------------------------------------------------------- writing */

export interface BookmarkRange {
  blockId: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Places a bookmark on a range (OpenOffice: `IDocumentMarkAccess::makeMark`).
 *
 * A name that is already taken is released first: Writer refuses two bookmarks with
 * the same name, and an ambiguous `#name` link could only point to one of the two
 * positions anyway.
 */
export function setBookmark(
  doc: WriterDocumentState,
  range: BookmarkRange,
  rawName: string,
): WriterDocumentState {
  const name = normalizeBookmarkName(rawName);
  if (!name) return doc;
  // A name reserved for heading anchors cannot be set by hand: it would be
  // overwritten the next time the table of contents is regenerated.
  if (blockIdFromHeadingAnchor(name)) return doc;

  const cleared = removeBookmark(doc, name);
  const node = paragraphIndex(cleared).byId.get(range.blockId)?.paragraph;
  if (!node) return doc;

  const length = node.runs.reduce((sum, run) => sum + run.text.length, 0);
  const start = Math.max(0, Math.min(range.startOffset, range.endOffset, length));
  const end = Math.min(length, Math.max(range.startOffset, range.endOffset));

  // A point bookmark on a non-empty paragraph: Writer attaches it to the character
  // that follows, otherwise it would have no carrier and would disappear.
  const from = start;
  const to = end > start ? end : Math.min(length, start + 1);

  const runs =
    length === 0
      ? node.runs.map((run) => withBookmarkName(run, name))
      : normalizeRuns(
          mapRunsInRange(node.runs, from, to, (run) => withBookmarkName(run, name)),
          runFormatting(node.runs[0] ?? makeRun('')),
        );

  return touch(replaceParagraph(cleared, range.blockId, { ...node, runs }));
}

/** Removes a bookmark by its name (`IDocumentMarkAccess::deleteMark`). */
export function removeBookmark(doc: WriterDocumentState, rawName: string): WriterDocumentState {
  const name = normalizeBookmarkName(rawName);
  if (!name) return doc;

  let next = doc;
  let changed = false;
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    if (!paragraph.runs.some((run) => run.bookmarkName === name)) continue;
    changed = true;
    const runs = paragraph.runs.map((run) =>
      run.bookmarkName === name ? withBookmarkName(run, undefined) : run,
    );
    next = replaceParagraph(next, blockId, { ...paragraph, runs });
  }

  return changed ? touch(next) : doc;
}

/** Renames a bookmark, carrying over the `#old` links that pointed to it. */
export function renameBookmark(
  doc: WriterDocumentState,
  fromRaw: string,
  toRaw: string,
): WriterDocumentState {
  const from = normalizeBookmarkName(fromRaw);
  const to = normalizeBookmarkName(toRaw);
  if (!from || !to || from === to) return doc;
  if (!findBookmark(doc, from) || findBookmark(doc, to)) return doc;

  let next = doc;
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    const affected = paragraph.runs.some(
      (run) => run.bookmarkName === from || run.linkHref === `#${from}`,
    );
    if (!affected) continue;

    const runs = paragraph.runs.map((run) => {
      let out = run;
      if (out.bookmarkName === from) out = withBookmarkName(out, to);
      if (out.linkHref === `#${from}`) {
        const copy = makeRun(out.text, runFormatting(out));
        copy.linkHref = `#${to}`;
        out = copy;
      }
      return out;
    });
    next = replaceParagraph(next, blockId, { ...paragraph, runs });
  }

  return touch(next);
}

/* ------------------------------------------------------------- utilities */

function withBookmarkName(run: TextRun, name: string | undefined): TextRun {
  const out = makeRun(run.text, runFormatting(run));
  if (name !== undefined) out.bookmarkName = name;
  else delete out.bookmarkName;
  return out;
}
