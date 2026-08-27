/**
 * Commentaires marginaux. Transposition de `SwPostItField`
 * (`sw/source/core/fields/postit.cxx`) et de `SwPostItMgr`
 * (`sw/source/ui/docvw/PostItMgr.cxx`).
 *
 * Writer range un commentaire en deux morceaux, et c'est ce partage qu'on
 * reprend ici :
 *
 *   – l'**ancre** est un attribut de texte posé sur la plage commentée
 *     (`SwFmtFld` sur un `SwPostItField`) ; elle vit donc dans le paragraphe et
 *     suit le texte quand celui-ci se déplace, sans qu'aucun code de curseur
 *     n'ait à la connaître ;
 *   – le **contenu** (auteur, date, texte, réponses) vit dans une table du
 *     document, indexée par identifiant.
 *
 * Ce découpage a une conséquence directe qu'on veut : supprimer le texte
 * commenté supprime l'ancre — donc le commentaire disparaît de la gouttière —
 * mais son contenu reste récupérable tant que le document n'a pas été nettoyé.
 * `SwPostItMgr` fonctionne exactement ainsi.
 *
 * Les fils de discussion sont plats, comme dans Writer : une réponse porte le
 * `threadId` du commentaire racine. Un fil de fil n'existe pas.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

import { newId, paragraphIndex, replaceParagraph, touch } from './document';
import { makeRun, mapRunsInRange, normalizeRuns, runFormatting } from './runs';
import type { TextRun, WriterDocumentState } from './types';

/** Un commentaire ou une réponse. Transposition de `SwPostItField`. */
export interface DocumentComment {
  id: string;
  /**
   * Identifiant du fil. Pour un commentaire racine, `threadId === id` ; pour
   * une réponse, c'est l'identifiant du commentaire racine.
   */
  threadId: string;
  /** `SwPostItField::GetPar1()` — l'auteur. */
  author: string;
  /** Initiales affichées dans la pastille (`SwPostItField::GetInitials`). */
  initials?: string;
  /** ISO 8601. `SwPostItField::GetDateTime()`. */
  createdAt: string;
  /** `SwPostItField::GetPar2()` — le corps du commentaire. */
  text: string;
  /** Fil clos : conservé, mais grisé et sorti du flux de relecture. */
  resolved?: boolean;
}

/** Un fil : le commentaire racine et ses réponses, dans l'ordre de dépôt. */
export interface CommentThread {
  id: string;
  root: DocumentComment;
  replies: DocumentComment[];
  resolved: boolean;
  /** Extrait du texte ancré, pour situer le fil sans ouvrir la page. */
  quotedText: string;
  /** Paragraphe portant l'ancre, ou `null` si l'ancre a été supprimée. */
  anchorBlockId: string | null;
}

/* ------------------------------------------------------- ancres sur les runs */

/**
 * Décompose la clé scalaire `commentIds` en liste.
 *
 * Le stockage est une chaîne triée jointe par des virgules, et non un tableau :
 * `sameFormatting` compare les attributs de run par `!==`, et deux tableaux de
 * même contenu n'y seraient jamais égaux — deux runs voisins cesseraient de
 * fusionner et l'invariant `SwpHints::MergePortions` tomberait. Cf. types.ts.
 */
export function commentIdsOf(run: Pick<TextRun, 'commentIds'>): string[] {
  if (!run.commentIds) return [];
  return run.commentIds.split(',').filter((id) => id.length > 0);
}

/** Recompose la clé scalaire à partir d'une liste, triée et dédupliquée. */
export function joinCommentIds(ids: readonly string[]): string | undefined {
  const unique = Array.from(new Set(ids.filter((id) => id.length > 0))).sort();
  return unique.length > 0 ? unique.join(',') : undefined;
}

/** Ajoute un identifiant de fil au jeu d'ancres d'un run. */
function withCommentId(run: TextRun, threadId: string): TextRun {
  const next = joinCommentIds([...commentIdsOf(run), threadId]);
  const out = makeRun(run.text, runFormatting(run));
  if (next !== undefined) out.commentIds = next;
  else delete out.commentIds;
  return out;
}

/** Retire un identifiant de fil du jeu d'ancres d'un run. */
function withoutCommentId(run: TextRun, threadId: string): TextRun {
  const next = joinCommentIds(commentIdsOf(run).filter((id) => id !== threadId));
  const out = makeRun(run.text, runFormatting(run));
  if (next !== undefined) out.commentIds = next;
  else delete out.commentIds;
  return out;
}

/* ----------------------------------------------------------------- lecture */

/** Tous les fils du document, dans l'ordre d'apparition de leur ancre. */
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

  // L'ordre de la gouttière est celui du texte, pas celui de la table : c'est
  // ce que fait `SwPostItMgr::Sort`, et c'est le seul ordre qui permette de
  // suivre une relecture de haut en bas.
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

  // Fils dont l'ancre a disparu : ils restent listés, sans position.
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
  /** Offset de début dans la chaîne brute du paragraphe. */
  startOffset: number;
  endOffset: number;
  text: string;
}

/**
 * Position de chaque ancre dans le flux.
 *
 * Un même fil peut avoir plusieurs plages non contiguës (le texte commenté a
 * été coupé par une édition) : on renvoie chaque plage, et c'est la première
 * qui donne la position du fil dans la gouttière.
 */
export function commentAnchors(doc: WriterDocumentState): CommentAnchor[] {
  const out: CommentAnchor[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    // Plage courante par fil : un fil interrompu puis repris donne deux plages.
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

/* ---------------------------------------------------------------- écriture */

export interface CommentRange {
  blockId: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Pose un commentaire sur une plage de texte.
 *
 * Transposition de `SwEditShell::InsertPostIt`. La plage est découpée aux deux
 * bornes puis chaque run intérieur reçoit l'identifiant du fil ; le contenu est
 * poussé dans la table du document.
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
  // Une plage vide n'a rien à ancrer : Writer refuse aussi le commentaire sans
  // sélection sur un paragraphe vide.
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

/** Ajoute une réponse à un fil existant (`SwPostItMgr::Reply`). */
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

/** Marque un fil comme résolu, ou le rouvre. */
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

/** Modifie le corps d'un commentaire ou d'une réponse. */
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
 * Supprime un fil : son contenu **et** ses ancres.
 *
 * Retirer l'ancre sans le contenu laisserait un fil fantôme dans la table ;
 * retirer le contenu sans l'ancre laisserait un attribut de run pointant dans
 * le vide, qui empêcherait deux runs voisins de fusionner. Les deux vont donc
 * ensemble — c'est ce que fait `SwDoc::DelFullPara` sur un champ de note.
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

/** Supprime une seule réponse d'un fil (jamais la racine — cf. `deleteCommentThread`). */
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
 * Retire les fils dont plus aucune ancre ne subsiste (`SwPostItMgr::Delete`).
 *
 * À appeler après une suppression de texte : sans cela, la table enfle de fils
 * invisibles que l'export ODF réémettrait sans plage correspondante.
 */
export function pruneOrphanComments(doc: WriterDocumentState): WriterDocumentState {
  const comments = doc.comments ?? [];
  if (comments.length === 0) return doc;

  const anchored = new Set(commentAnchors(doc).map((a) => a.threadId));
  const kept = comments.filter((c) => anchored.has(c.threadId));
  if (kept.length === comments.length) return doc;
  return touch({ ...doc, comments: kept });
}
