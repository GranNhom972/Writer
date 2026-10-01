// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Undo history. (OpenOffice: `SwUndoManager` / `SwUndo`, `sw/source/core/undo/`.)
 *
 * Writer records **undo objects** that know how to replay themselves backwards. Here the
 * state of the document is immutable and structurally shared: keeping the previous state
 * costs one reference, not a copy. A history entry is therefore the pair (before, after),
 * which is both transactional and exactly invertible, the property `SwUndo` gets at the price
 * of one object per type of operation.
 *
 * The grouping of typing follows `SwUndoInsert::CanGrouping` (`unins.cxx`): characters typed
 * in a row make a single entry as long as they stay in the same class, letters on one side and
 * separators on the other. `Ctrl+Z` therefore undoes a word, not a letter.
 */

import type { DocumentSelection, WriterDocumentState } from '../document/types';
import type { EditorState } from './edit';

/** Number of entries kept: Writer's default (`SW_MAX_UNDO`). */
export const MAX_UNDO_STEPS = 100;

interface Snapshot {
  doc: WriterDocumentState;
  selection: DocumentSelection;
}

/** Grouping signature of a keystroke. */
export interface GroupingKey {
  kind: 'insert' | 'delete' | 'resize' | 'settings';
  blockId: string;
  /** Cursor position **before** the operation. */
  offsetBefore: number;
  /** Cursor position **after**: the next keystroke must resume there. */
  offsetAfter: number;
  /** Is the processed character a word separator? */
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

/** Label of the next undo, for the Edit menu. */
export function undoLabel(session: EditorSession): string | null {
  return session.history.past[session.history.past.length - 1]?.label ?? null;
}

export function redoLabel(session: EditorSession): string | null {
  return session.history.future[session.history.future.length - 1]?.label ?? null;
}

/** Is a character a word separator? (`CharClass::isLetterNumeric`) */
export function isWordDelimiter(char: string): boolean {
  return !/[\p{L}\p{N}_]/u.test(char);
}

function snapshot(state: EditorState): Snapshot {
  return { doc: state.doc, selection: state.selection };
}

/**
 * Can two successive operations be merged into one?
 *
 * Condition of `SwUndoInsert::CanGrouping`: same node, contiguous position, and same character
 * class. Going from a letter to a space closes the group, which gives `Ctrl+Z` a word
 * granularity.
 */
function canGroup(previous: GroupingKey | null, next: GroupingKey | null): boolean {
  if (!previous || !next) return false;
  return (
    previous.kind === next.kind &&
    previous.blockId === next.blockId &&
    // Contiguity: the new keystroke resumes exactly where the previous one stopped. Clicking
    // somewhere else between two letters therefore closes the group.
    previous.offsetAfter === next.offsetBefore &&
    previous.isWordDelimiter === next.isWordDelimiter
  );
}

/**
 * Records a transaction.
 *
 * The redo stack is purged: after a new action, the abandoned branch can no longer be reached.
 * Same rule as `SwUndoManager::ClearRedo`.
 */
export function commit(
  session: EditorSession,
  label: string,
  next: EditorState,
  grouping: GroupingKey | null = null,
): EditorSession {
  if (next.doc === session.state.doc) {
    // Nothing has changed in the document: we update the cursor without creating an entry. Moving
    // the cursor is not an action to undo.
    return { state: next, history: session.history };
  }

  const past = [...session.history.past];
  const last = past[past.length - 1];

  if (last && canGroup(last.grouping, grouping)) {
    // The group grows: its end state and end position advance, but its start state, and so what
    // `Ctrl+Z` will restore, does not move.
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
 * Undoes the last transaction.
 *
 * The cursor goes back to where it was **before** the action: this is what makes undo readable,
 * the user finds the spot where they were working.
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

/** Grouping key of a text keystroke. */
export function typingGroup(
  blockId: string,
  offsetBefore: number,
  offsetAfter: number,
  text: string,
): GroupingKey | null {
  // A paste or a multi-character input (IME) is not typing: it forms its own entry, which can be
  // undone in one go.
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
 * Grouping key of a continuous gesture, such as dragging a column handle.
 *
 * A drag emits one transaction per mouse movement. Without grouping, undoing a single gesture
 * would take as many `Ctrl+Z` as it produced events. The offsets are constant: it is the identity
 * of the handle, carried by `blockId`, that decides continuity.
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
 * Grouping key of a **setting** changed continuously, such as a header field being typed or a
 * margin dragged on the ruler.
 *
 * Same shape as `dragGroup`, and for the same reason: the gesture emits one transaction per
 * keystroke or per movement, and it is the identity of the setting, carried by `blockId` for lack
 * of a node to name, that decides their continuity. Without it, typing a twenty-character header
 * would put twenty undo entries; `Ctrl+Z` undoes one, like a word.
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

/** Grouping key of character-by-character deletion. */
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
