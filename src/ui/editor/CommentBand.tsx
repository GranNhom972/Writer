// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Gouttière de commentaires. Transposition de `SwPostItMgr` et
 * `SwAnnotationWin` (`sw/source/ui/docvw/PostItMgr.cxx`, `AnnotationWin.cxx`).
 *
 * Writer pose les bulles dans une bande **hors de la feuille**, à droite, et
 * non dans la marge de la page : une bulle dans la marge s'imprimerait, alors
 * qu'un commentaire est un objet de relecture. C'est le choix repris ici — la
 * bande est un frère de la pile de pages, et la feuille `@media print` la fait
 * disparaître sans toucher à la géométrie du document.
 *
 * `SwPostItMgr::LayoutPostIts` empile les bulles dans l'ordre du **texte** et
 * les décale vers le bas quand deux ancres sont trop proches pour que leurs
 * bulles tiennent côte à côte. On reprend cette règle : sans elle, deux
 * commentaires sur la même ligne se superposeraient.
 */

import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { commentThreads, type CommentThread } from '../../domain/document/comments';
import type { WriterDocumentState } from '../../domain/document/types';
import type { DocumentLayout } from '../../domain/engine/paginate';

/** Écart minimal entre deux bulles, en pixels (`SwPostItMgr::GetSpaceBetween`). */
const BUBBLE_GAP_PX = 12;

/**
 * Hauteur de repli, pour la première passe d'empilement.
 *
 * Elle ne sert qu'avant la mesure : une bulle qui porte des réponses ou une
 * citation dépasse largement cette valeur — 284 px relevés pour deux réponses —
 * et empiler tout le monde sur 92 px faisait recouvrir la précédente par la
 * suivante. La hauteur réelle est relevée après le rendu (cf. `useLayoutEffect`
 * dans `CommentBand`), et c'est elle qui décide de l'empilement définitif.
 */
const COLLAPSED_HEIGHT_PX = 92;

/**
 * Largeur de la bande, en pixels.
 *
 * Exportée parce que la surface doit réserver cette largeur **avant** de
 * mettre la pile à l'échelle : la boîte du zoom se dimensionne sur la largeur
 * du contenu, et une seconde valeur écrite en dur ailleurs finirait par
 * diverger de celle-ci.
 */
export const COMMENT_BAND_WIDTH_PX = 260;

export interface CommentBandProps {
  doc: WriterDocumentState;
  layout: DocumentLayout;
  /** Hauteur d'une page plus l'espace inter-pages — pour situer une ancre. */
  pageStridePx: number;
  contentTopPx: number;
  /** Auteur des réponses saisies ici. */
  author: string;
  /** Fil mis en avant, généralement celui que traverse le curseur. */
  activeThreadId?: string | null;
  readOnly?: boolean;
  onReply: (threadId: string, text: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onDelete: (threadId: string) => void;
  onEdit: (commentId: string, text: string) => void;
  /** Amène le curseur sur l'ancre du fil. */
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
   * Hauteurs réelles des bulles, relevées après le rendu.
   *
   * L'empilement a besoin de la hauteur de la bulle précédente pour poser la
   * suivante, et cette hauteur n'existe qu'une fois le texte mis en page : elle
   * dépend du nombre de réponses, de la longueur de la citation et de
   * l'ouverture du champ de réponse. On peint donc une première fois sur la
   * hauteur de repli, on mesure, et le second rendu est le bon — c'est ce
   * qu'obtient `SwPostItMgr::LayoutPostIts` en interrogeant chaque fenêtre.
   *
   * Les hooks précèdent le retour anticipé : leur ordre doit être le même à
   * chaque rendu, y compris celui où le document n'a plus aucun commentaire.
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

    // Comparaison avant d'écrire : un `setState` inconditionnel dans un effet
    // sans dépendances relancerait le rendu sans fin.
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
 * Empile les bulles sans chevauchement.
 *
 * L'ordonnée idéale d'une bulle est celle de son ancre ; deux ancres proches
 * donneraient deux bulles superposées. On descend donc chaque bulle juste assez
 * pour dégager la précédente — la règle de `SwPostItMgr::LayoutPostIts`, qui
 * garde ainsi l'ordre de lecture intact.
 */
function stackThreads(
  threads: readonly CommentThread[],
  layout: DocumentLayout,
  pageStridePx: number,
  contentTopPx: number,
  /** Hauteurs relevées au rendu précédent ; la hauteur de repli à défaut. */
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
  /** Confie l'élément à la bande, qui mesure sa hauteur pour l'empilement. */
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
            // Une seule ligne : la citation situe le fil, elle ne le remplace pas.
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
              // `Ctrl+Entrée` envoie, `Entrée` seul passe à la ligne : une
              // réponse de plusieurs phrases doit rester possible.
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

/** Date courte, ou la chaîne brute si elle n'est pas lisible. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}
