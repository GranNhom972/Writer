// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Comment gutter. (OpenOffice: `SwPostItMgr` and `SwAnnotationWin`, `sw/source/ui/docvw/PostItMgr.cxx`, `AnnotationWin.cxx`.)
 *
 * Writer puts the bubbles in a band **outside the sheet**, on the right, and not in the page margin: a bubble in the margin would be printed, whereas a comment is a review object. That choice is kept here: the band is a
 * sibling of the page stack, and the `@media print` stylesheet makes it disappear without touching the geometry of the document.
 *
 * `SwPostItMgr::LayoutPostIts` stacks the bubbles in **text** order and shifts them down when two anchors are too close for their bubbles to fit side by side. We keep that rule: without it, two comments on the same
 * line would overlap.
 */

import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { commentThreads, type CommentThread } from '../../domain/document/comments';
import type { WriterDocumentState } from '../../domain/document/types';
import type { DocumentLayout } from '../../domain/engine/paginate';

/** Minimum gap between two bubbles, in pixels (`SwPostItMgr::GetSpaceBetween`). */
const BUBBLE_GAP_PX = 12;

/**
 * Fallback height, for the first stacking pass.
 *
 * It is only used before measuring: a bubble that carries replies or a quotation goes well beyond this value (284 px measured for two replies), and stacking everybody on 92 px made each bubble cover the previous one.
 * The real height is read after rendering (see `useLayoutEffect` in `CommentBand`), and it is what decides the final stacking.
 */
const COLLAPSED_HEIGHT_PX = 92;

/**
 * Width of the band, in pixels.
 *
 * Exported because the surface must reserve this width **before** scaling the stack: the zoom box sizes itself on the content's width, and a second value hard-coded elsewhere would end up diverging from this one.
 */
export const COMMENT_BAND_WIDTH_PX = 260;

export interface CommentBandProps {
  doc: WriterDocumentState;
  layout: DocumentLayout;
  /** Height of a page plus the space between pages: to locate an anchor. */
  pageStridePx: number;
  contentTopPx: number;
  /** Author of the replies typed here. */
  author: string;
  /** Thread put forward, usually the one the cursor is in. */
  activeThreadId?: string | null;
  readOnly?: boolean;
  onReply: (threadId: string, text: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onDelete: (threadId: string) => void;
  onEdit: (commentId: string, text: string) => void;
  /** Brings the cursor to the thread's anchor. */
  onGoToAnchor: (blockId: string) => void;
}

export function CommentBand({
  doc,
  layout,
  pageStridePx,
  contentTopPx,
  author,
  activeThreadId = null,
  readOnly = false,
  onReply,
  onResolve,
  onDelete,
  onEdit,
  onGoToAnchor,
}: CommentBandProps): JSX.Element | null {
  /*
   * Real heights of the bubbles, read after rendering.
   *
   * Stacking needs the height of the previous bubble to place the next one, and that height only exists once the text is laid out: it depends on the number of replies, the length of the quotation and whether the reply
   * field is open. So we paint a first time on the fallback height, measure, and the second render is the right one, which is what `SwPostItMgr::LayoutPostIts` gets by querying each window.
   *
   * The hooks come before the early return: their order must be the same on every render, including the one where the document has no comment left.
   */
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const nodes = useRef(new Map<string, HTMLElement>());

  const register = useCallback((threadId: string, node: HTMLElement | null): void => {
    if (node) nodes.current.set(threadId, node);
    else nodes.current.delete(threadId);
  }, []);

  useLayoutEffect(() => {
    const mesures = new Map<string, number>();
    nodes.current.forEach((node, id) => mesures.set(id, node.offsetHeight));

    // Compare before writing: an unconditional `setState` in an effect with no dependencies would restart the render forever.
    let identique = mesures.size === heights.size;
    if (identique) {
      for (const [id, h] of mesures) {
        if (heights.get(id) !== h) {
          identique = false;
          break;
        }
      }
    }
    if (!identique) setHeights(mesures);
  });

  const threads = commentThreads(doc);
  if (threads.length === 0) return null;

  const positioned = stackThreads(threads, layout, pageStridePx, contentTopPx, heights);

  return (
    <aside
      className="writer-comment-band"
      aria-label="Commentaires du document"
      style={{ position: 'relative', width: `${COMMENT_BAND_WIDTH_PX}px`, flexShrink: 0 }}
    >
      {positioned.map(({ thread, topPx }) => (
        <CommentBubble
          key={thread.id}
          thread={thread}
          topPx={topPx}
          register={register}
          author={author}
          isActive={thread.id === activeThreadId}
          readOnly={readOnly}
          onReply={onReply}
          onResolve={onResolve}
          onDelete={onDelete}
          onEdit={onEdit}
          onGoToAnchor={onGoToAnchor}
        />
      ))}
    </aside>
  );
}

/**
 * Stacks the bubbles without overlap.
 *
 * The ideal y coordinate of a bubble is that of its anchor; two close anchors would give two overlapping bubbles. So we move each bubble down just enough to clear the previous one: the rule of
 * `SwPostItMgr::LayoutPostIts`, which keeps the reading order intact.
 */
function stackThreads(
  threads: readonly CommentThread[],
  layout: DocumentLayout,
  pageStridePx: number,
  contentTopPx: number,
  /** Heights read at the previous render; the fallback height otherwise. */
  heights: ReadonlyMap<string, number>,
): { thread: CommentThread; topPx: number }[] {
  const out: { thread: CommentThread; topPx: number }[] = [];
  let floor = 0;

  for (const thread of threads) {
    const placement = thread.anchorBlockId
      ? layout.placements.get(thread.anchorBlockId)?.[0]
      : undefined;

    const ideal = placement
      ? placement.pageIndex * pageStridePx + contentTopPx + placement.placed.topPx
      : floor;

    const topPx = Math.max(ideal, floor);
    out.push({ thread, topPx });
    floor = topPx + (heights.get(thread.id) ?? COLLAPSED_HEIGHT_PX) + BUBBLE_GAP_PX;
  }

  return out;
}

function CommentBubble({
  thread,
  topPx,
  register,
  author,
  isActive,
  readOnly,
  onReply,
  onResolve,
  onDelete,
  onEdit,
  onGoToAnchor,
}: {
  thread: CommentThread;
  topPx: number;
  /** Hands the element to the band, which measures its height for stacking. */
  register: (threadId: string, node: HTMLElement | null) => void;
  author: string;
  isActive: boolean;
  readOnly: boolean;
  onReply: (threadId: string, text: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onDelete: (threadId: string) => void;
  onEdit: (commentId: string, text: string) => void;
  onGoToAnchor: (blockId: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const messages = [thread.root, ...thread.replies];

  const submitReply = (): void => {
    const text = draft.trim();
    if (!text) return;
    onReply(thread.id, text);
    setDraft('');
  };

  const submitEdit = (): void => {
    const text = editDraft.trim();
    if (editingId && text) onEdit(editingId, text);
    setEditingId(null);
    setEditDraft('');
  };

  return (
    <article
      ref={(node) => register(thread.id, node)}
      className={`writer-comment${thread.resolved ? ' writer-comment--resolved' : ''}${
        isActive ? ' writer-comment--active' : ''
      }`}
      style={{
        position: 'absolute',
        top: `${topPx}px`,
        left: 0,
        right: 0,
        padding: '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${isActive ? 'var(--accent, #1a73e8)' : 'var(--border, #dadce0)'}`,
        background: 'var(--surface, #fff)',
        boxShadow: isActive ? '0 2px 10px rgba(0,0,0,0.14)' : '0 1px 4px rgba(0,0,0,0.08)',
        opacity: thread.resolved ? 0.6 : 1,
        fontSize: '13px',
        transition: 'top 120ms ease-out',
      }}
    >
      {thread.quotedText && (
        <button
          type="button"
          onClick={() => thread.anchorBlockId && onGoToAnchor(thread.anchorBlockId)}
          title="Aller au texte commenté"
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 'none',
            background: 'transparent',
            padding: 0,
            marginBottom: '6px',
            cursor: 'pointer',
            color: 'var(--fg-secondary)',
            fontStyle: 'italic',
            // A single line: the quotation locates the thread, it does not replace it.
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          « {thread.quotedText} »
        </button>
      )}

      {messages.map((comment) => (
        <div key={comment.id} style={{ marginBottom: '8px' }}>
          <header style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
            <strong style={{ fontSize: '12px' }}>{comment.author}</strong>
            <time
              dateTime={comment.createdAt}
              style={{ fontSize: '11px', color: 'var(--fg-secondary)' }}
            >
              {formatDate(comment.createdAt)}
            </time>
          </header>

          {editingId === comment.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
              <textarea
                value={editDraft}
                onChange={(event) => setEditDraft(event.target.value)}
                rows={3}
                style={{ width: '100%', fontSize: '13px', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button type="button" onClick={submitEdit}>
                  Enregistrer
                </button>
                <button type="button" onClick={() => setEditingId(null)}>
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{comment.text}</p>
          )}

          {!readOnly && editingId !== comment.id && (
            <button
              type="button"
              onClick={() => {
                setEditingId(comment.id);
                setEditDraft(comment.text);
              }}
              style={bareButtonStyle}
            >
              Modifier
            </button>
          )}
        </div>
      ))}

      {!readOnly && (
        <>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // `Ctrl+Enter` sends, `Enter` alone starts a new line: a reply of several sentences must remain possible.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submitReply();
              }
            }}
            placeholder={`Répondre en tant que ${author}…`}
            rows={2}
            aria-label="Répondre au commentaire"
            style={{ width: '100%', fontSize: '13px', resize: 'vertical', marginTop: '4px' }}
          />
          <footer style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
            <button type="button" onClick={submitReply} disabled={!draft.trim()}>
              Répondre
            </button>
            <button type="button" onClick={() => onResolve(thread.id, !thread.resolved)}>
              {thread.resolved ? 'Rouvrir' : 'Résoudre'}
            </button>
            <button type="button" onClick={() => onDelete(thread.id)} style={bareButtonStyle}>
              Supprimer
            </button>
          </footer>
        </>
      )}
    </article>
  );
}

const bareButtonStyle = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  fontSize: '12px',
  color: 'var(--fg-secondary)',
  cursor: 'pointer',
  textDecoration: 'underline',
} as const;

/** Short date, or the raw string if it is not readable. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}
