// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Suivi des modifications. Transposition de `SwRangeRedline` / `SwRedlineTbl`
 * (`sw/source/core/doc/docredln.cxx`, `sw/inc/redline.hxx`) et du mode
 * `REDLINE_ON` de `IDocumentRedlineAccess` (`sw/inc/IDocumentRedlineAccess.hxx`).
 *
 * Le principe de Writer, conservé tel quel : **en mode révision, on ne détruit
 * rien**. Une frappe pose un `REDLINE_INSERT` sur le texte ajouté ; une
 * suppression ne retire pas le texte mais pose un `REDLINE_DELETE` dessus. Ce
 * n'est qu'à l'acceptation (`AcceptRedline`) ou au rejet (`RejectRedline`) que
 * le document change réellement de contenu.
 *
 * Cette symétrie explique les quatre cas d'`applyRedline` plus bas, qui sont
 * ceux de `docredln.cxx` :
 *
 *   accepter un ajout     → garder le texte, retirer la marque
 *   accepter une coupe    → retirer le texte
 *   rejeter  un ajout     → retirer le texte
 *   rejeter  une coupe    → garder le texte, retirer la marque
 *
 * Comme pour les signets et les commentaires, l'ancre est un **attribut de run**
 * et non un couple de `SwPosition` : la marque suit son texte sans qu'aucun code
 * de maintenance de position n'ait à exister. La table du document ne porte donc
 * que les métadonnées — auteur, date, nature.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

import { newId, paragraphIndex, replaceParagraph, touch } from './document';
import { makeRun, mapRunsInRange, normalizeRuns, runFormatting } from './runs';
import type { RedlineType, TextRun, WriterDocumentState } from './types';

/** Métadonnées d'une modification suivie. Transposition de `SwRedlineData`. */
export interface Redline {
  id: string;
  /** `RedlineType_t` (IDocumentRedlineAccess.hxx:73-75). */
  type: RedlineType;
  /** `SwRedlineData::GetAuthorString()`. */
  author: string;
  /** ISO 8601. `SwRedlineData::GetTimeStamp()`. */
  date: string;
  /** Commentaire de révision, facultatif (`SwRedlineData::GetComment`). */
  comment?: string;
}

/** Une modification suivie, résolue à sa position dans le flux. */
export interface RedlineRange {
  redline: Redline;
  blockId: string;
  startOffset: number;
  endOffset: number;
  /** Texte couvert par la marque. */
  text: string;
}

/**
 * Palette d'auteurs de Writer (`SwPostItMgr` et `SwRedlineTbl` la partagent).
 *
 * Writer attribue une couleur par **rang d'apparition** de l'auteur, pas par
 * hachage du nom : deux auteurs restent ainsi distinguables même si leurs noms
 * se ressemblent, et la couleur d'un relecteur ne change pas parce qu'un autre
 * a été renommé.
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

/** Auteurs du document, dans leur ordre de première apparition. */
export function redlineAuthors(doc: WriterDocumentState): string[] {
  const seen: string[] = [];
  for (const redline of doc.redlines ?? []) {
    if (!seen.includes(redline.author)) seen.push(redline.author);
  }
  return seen;
}

/** Couleur affectée à un auteur, stable pour un document donné. */
export function redlineAuthorColor(doc: WriterDocumentState, author: string): string {
  const index = redlineAuthors(doc).indexOf(author);
  const palette = REDLINE_AUTHOR_COLORS;
  return palette[(index < 0 ? 0 : index) % palette.length] ?? palette[0];
}

/* ----------------------------------------------------------------- lecture */

/** Le document est-il en cours de relecture ? */
export function hasRedlines(doc: WriterDocumentState): boolean {
  return (doc.redlines ?? []).length > 0;
}

/** Métadonnées d'une marque par identifiant. */
export function findRedline(doc: WriterDocumentState, id: string): Redline | null {
  return (doc.redlines ?? []).find((redline) => redline.id === id) ?? null;
}

/**
 * Toutes les marques résolues à leur position, dans l'ordre du flux.
 *
 * Une même marque peut donner plusieurs plages si une édition ultérieure l'a
 * coupée en deux ; chacune est renvoyée séparément, comme `SwRedlineTbl` en
 * conserve une entrée par intervalle.
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
 * Texte du document tel qu'il serait après acceptation de toutes les marques.
 *
 * Utile pour la recherche et le comptage de mots : compter les caractères d'une
 * suppression en attente fausserait les statistiques affichées.
 */
export function visibleText(paragraph: { runs: readonly TextRun[] }): string {
  let out = '';
  for (const run of paragraph.runs) {
    if (run.redlineType === 'delete') continue;
    out += run.text;
  }
  return out;
}

/* ------------------------------------------------------- pose d'une marque */

export interface RedlineAuthor {
  author: string;
  now?: string;
}

/**
 * Marque une plage comme insérée.
 *
 * Appelé par `edit.ts` **après** que le texte a été inséré normalement : en mode
 * révision, l'insertion elle-même ne change pas, seule sa signature s'ajoute.
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
 * Marque une plage comme supprimée, **sans retirer le texte**.
 *
 * C'est le cœur du mode révision : `SwDoc::DeleteRange` sous `REDLINE_ON`
 * n'appelle jamais `DeleteRangeImpl`, il pose un `REDLINE_DELETE`.
 *
 * Un cas particulier reproduit celui de Writer : supprimer du texte que **le
 * même auteur** venait d'insérer sans que sa marque ait été acceptée retire le
 * texte pour de bon. Sans cette règle, corriger sa propre frappe laisserait une
 * traînée de caractères barrés que personne n'a jamais eu l'intention d'écrire.
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

  // Découpe aux deux bornes sans rien transformer : la décision se prend
  // ensuite run par run, et trois issues sont possibles là où `mapRunsInRange`
  // n'en offre qu'une.
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
      // Le texte disparaît réellement : rien n'est poussé dans `kept`.
      removedRanges.push({ start: offset, end: runEnd });
      offset = runEnd;
      continue;
    }

    // Déjà marqué supprimé : une seconde suppression n'ajoute rien.
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

/** Marque une plage comme reformatée (`REDLINE_FORMAT`). */
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
    // Une marque de suppression prime sur une marque d'insertion ou de format :
    // le texte est en instance de disparition, le reformater n'a pas de sens.
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

/* ------------------------------------------------ acceptation et rejet */

/**
 * Applique ou annule une marque. Transposition de `SwDoc::AcceptRedline` /
 * `SwDoc::RejectRedline`.
 *
 * Les quatre combinaisons sont celles décrites en tête de module. Le cas
 * `format` est symétrique et n'a pas de version destructive : le formatage a
 * déjà été appliqué au texte, accepter comme rejeter se contente de retirer la
 * marque — c'est la limite du modèle, `SwRedlineData` conservant en C++ le jeu
 * d'attributs antérieur pour pouvoir le restaurer.
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

/** Accepte toutes les marques, ou seulement celles d'un auteur. */
export function acceptAllRedlines(
  doc: WriterDocumentState,
  author?: string,
): WriterDocumentState {
  return applyAll(doc, 'accept', author);
}

/** Rejette toutes les marques, ou seulement celles d'un auteur. */
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

/* ------------------------------------------------------------- utilitaires */

/**
 * Retire de la table les marques dont plus aucun run ne porte l'ancre.
 *
 * Sans ce nettoyage, éditer par-dessus une révision laisserait dans la table
 * des entrées invisibles, que l'export ODF réémettrait sans plage.
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
