// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Historique d'annulation. Transposition de `SwUndoManager` / `SwUndo`
 * (`sw/source/core/undo/`).
 *
 * Writer enregistre des **objets d'annulation** qui savent se rejouer à
 * l'envers. Ici, l'état du document est immuable et partagé structurellement :
 * conserver l'état d'avant coûte une référence, pas une copie. Une entrée
 * d'historique est donc le couple (avant, après), ce qui est à la fois
 * transactionnel et exactement inversible — la propriété que `SwUndo` obtient
 * au prix d'un objet par type d'opération.
 *
 * Le regroupement de la frappe reprend `SwUndoInsert::CanGrouping`
 * (`unins.cxx`) : des caractères tapés à la suite ne forment qu'une entrée tant
 * qu'ils restent de la même classe — lettres d'un côté, séparateurs de l'autre.
 * `Ctrl+Z` défait donc un mot, pas une lettre.
 */

import type { DocumentSelection, WriterDocumentState } from '../document/types';
import type { EditorState } from './edit';

/** Nombre d'entrées conservées — le défaut de Writer (`SW_MAX_UNDO`). */
export const MAX_UNDO_STEPS = 100;

interface Snapshot {
  doc: WriterDocumentState;
  selection: DocumentSelection;
}

/** Signature de regroupement d'une frappe. */
export interface GroupingKey {
  kind: 'insert' | 'delete' | 'resize' | 'settings';
  blockId: string;
  /** Position du curseur **avant** l'opération. */
  offsetBefore: number;
  /** Position du curseur **après** : la frappe suivante doit y reprendre. */
  offsetAfter: number;
  /** Le caractère traité est-il un séparateur de mot ? */
  isWordDelimiter: boolean;
}

export interface UndoEntry {
  label: string;
  before: Snapshot;
  after: Snapshot;
  grouping: GroupingKey | null;
}

export interface History {
  past: UndoEntry[];
  future: UndoEntry[];
}

export interface EditorSession {
  state: EditorState;
  history: History;
}

export function createSession(state: EditorState): EditorSession {
  return { state, history: { past: [], future: [] } };
}

export function canUndo(session: EditorSession): boolean {
  return session.history.past.length > 0;
}

export function canRedo(session: EditorSession): boolean {
  return session.history.future.length > 0;
}

/** Intitulé de la prochaine annulation, pour le menu Édition. */
export function undoLabel(session: EditorSession): string | null {
  return session.history.past[session.history.past.length - 1]?.label ?? null;
}

export function redoLabel(session: EditorSession): string | null {
  return session.history.future[session.history.future.length - 1]?.label ?? null;
}

/** Un caractère est-il un séparateur de mot ? (`CharClass::isLetterNumeric`) */
export function isWordDelimiter(char: string): boolean {
  return !/[\p{L}\p{N}_]/u.test(char);
}

function snapshot(state: EditorState): Snapshot {
  return { doc: state.doc, selection: state.selection };
}

/**
 * Deux opérations successives peuvent-elles n'en faire qu'une ?
 *
 * Condition de `SwUndoInsert::CanGrouping` : même nœud, position contiguë, et
 * même classe de caractère. Passer d'une lettre à une espace ferme le groupe,
 * ce qui donne à `Ctrl+Z` une granularité de mot.
 */
function canGroup(previous: GroupingKey | null, next: GroupingKey | null): boolean {
  if (!previous || !next) return false;
  return (
    previous.kind === next.kind &&
    previous.blockId === next.blockId &&
    // Contiguïté : la nouvelle frappe reprend exactement là où la précédente
    // s'est arrêtée. Cliquer ailleurs entre deux lettres ferme donc le groupe.
    previous.offsetAfter === next.offsetBefore &&
    previous.isWordDelimiter === next.isWordDelimiter
  );
}

/**
 * Enregistre une transaction.
 *
 * Le refaire est purgé : après une nouvelle action, la branche abandonnée n'est
 * plus atteignable — même règle que `SwUndoManager::ClearRedo`.
 */
export function commit(
  session: EditorSession,
  label: string,
  next: EditorState,
  grouping: GroupingKey | null = null,
): EditorSession {
  if (next.doc === session.state.doc) {
    // Rien n'a changé dans le document : on met à jour le curseur sans créer
    // d'entrée. Un déplacement de curseur n'est pas une action à annuler.
    return { state: next, history: session.history };
  }

  const past = [...session.history.past];
  const last = past[past.length - 1];

  if (last && canGroup(last.grouping, grouping)) {
    // Le groupe s'étend : son état d'arrivée et sa position de fin avancent,
    // mais son état de départ — donc ce que `Ctrl+Z` restaurera — ne bouge pas.
    past[past.length - 1] = {
      ...last,
      after: snapshot(next),
      grouping: grouping ? { ...grouping, offsetBefore: last.grouping!.offsetBefore } : null,
    };
  } else {
    past.push({
      label,
      before: snapshot(session.state),
      after: snapshot(next),
      grouping,
    });
    if (past.length > MAX_UNDO_STEPS) past.shift();
  }

  return { state: next, history: { past, future: [] } };
}

/**
 * Annule la dernière transaction.
 *
 * Le curseur revient là où il était **avant** l'action : c'est ce qui rend
 * l'annulation lisible, l'usager retrouve le point où il travaillait.
 */
export function undo(session: EditorSession): EditorSession {
  const past = [...session.history.past];
  const entry = past.pop();
  if (!entry) return session;

  return {
    state: {
      doc: entry.before.doc,
      selection: entry.before.selection,
      pendingFormat: null,
    },
    history: { past, future: [...session.history.future, entry] },
  };
}

export function redo(session: EditorSession): EditorSession {
  const future = [...session.history.future];
  const entry = future.pop();
  if (!entry) return session;

  return {
    state: {
      doc: entry.after.doc,
      selection: entry.after.selection,
      pendingFormat: null,
    },
    history: { past: [...session.history.past, entry], future },
  };
}

/** Clé de regroupement d'une frappe de texte. */
export function typingGroup(
  blockId: string,
  offsetBefore: number,
  offsetAfter: number,
  text: string,
): GroupingKey | null {
  // Un collage ou une saisie multi-caractères (IME) n'est pas de la frappe :
  // il forme sa propre entrée, annulable d'un seul coup.
  if (text.length !== 1) return null;
  return {
    kind: 'insert',
    blockId,
    offsetBefore,
    offsetAfter,
    isWordDelimiter: isWordDelimiter(text),
  };
}

/**
 * Clé de regroupement d'un geste continu — tirer une poignée de colonne.
 *
 * Un glissement émet une transaction par mouvement de souris. Sans
 * regroupement, défaire un seul geste demanderait autant de `Ctrl+Z` qu'il a
 * produit d'événements. Les offsets sont constants : c'est l'identité de la
 * poignée, portée par `blockId`, qui décide de la continuité.
 */
export function dragGroup(handleId: string): GroupingKey {
  return {
    kind: 'resize',
    blockId: handleId,
    offsetBefore: 0,
    offsetAfter: 0,
    isWordDelimiter: false,
  };
}

/**
 * Clé de regroupement d'un **réglage** modifié en continu — un champ d'en-tête
 * qu'on tape, une marge qu'on tire à la règle.
 *
 * Même forme que `dragGroup`, et pour la même raison : le geste émet une
 * transaction par frappe ou par mouvement, et c'est l'identité du réglage —
 * portée par `blockId`, faute d'un nœud à nommer — qui décide de leur
 * continuité. Sans elle, taper un en-tête de vingt caractères poserait vingt
 * entrées d'annulation ; `Ctrl+Z` en défait une, comme un mot.
 */
export function settingsGroup(settingId: string): GroupingKey {
  return {
    kind: 'settings',
    blockId: settingId,
    offsetBefore: 0,
    offsetAfter: 0,
    isWordDelimiter: false,
  };
}

/** Clé de regroupement d'un effacement caractère par caractère. */
export function deletionGroup(
  blockId: string,
  offsetBefore: number,
  offsetAfter: number,
  removed: string,
): GroupingKey | null {
  if (removed.length !== 1) return null;
  return {
    kind: 'delete',
    blockId,
    offsetBefore,
    offsetAfter,
    isWordDelimiter: isWordDelimiter(removed),
  };
}
