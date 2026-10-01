// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Wiring the sharing into the editor.
 *
 * The heart of the problem has not changed: the local document is produced by typing, and remote changes modify it too. What changes is how to make them live together.
 *
 * The old version compared two states and derived block operations from them. Two people in the same paragraph each produced a "replace this paragraph", and the second erased the first.
 *
 * Here, the replicated document (Yjs) is the reference, and it merges character by character. The cycle comes down to two rules:
 *
 *  - **what the editor produces goes down into the CRDT** (`reconcile`), at the exact spot of the change and nowhere else;
 *  - **what the CRDT receives goes up into the editor** (`DocumentMirror.read`), reusing the unchanged blocks so as to re-paginate only what moved.
 *
 * The loop back is not prevented by a flag but by the origin of the transaction: a change labeled local never goes back up to the editor, which already has it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';

import type {
  DocumentPosition,
  DocumentSelection,
  WriterDocumentState,
} from '../../domain/document/types';
import {
  BLOCKS_ROOT,
  changeOfTextEvent,
  DocumentMirror,
  META_ROOT,
  reconcile,
  remapOffset,
  seed,
  SETUP_ROOT,
} from '../../domain/collab/crdt';
import {
  CollabSession,
  presenceColor,
  type ConnectionStatus,
  type PeerPresence,
  type RemoteCursor,
} from '../../domain/collab/session';
import type { Permission, SessionJoin } from '../../domain/collab/api';

/**
 * Label of the transactions produced by this tab.
 *
 * It is this, and nothing else, that tells "I have just written it" from "it has just been sent to me". A flag that would have to be raised and then lowered would sooner or later get stuck in one state or the
 * other.
 */
const ORIGINE_LOCALE = Symbol('writer:local');

/** A text change, as it shifts a cursor. */
interface Changement {
  at: number;
  removed: number;
  inserted: string;
}

export interface CollabState {
  status: ConnectionStatus;
  permission: Permission;
  peers: PeerPresence[];
  /** Changes made offline, not sent yet. */
  pending: number;
  /** Last refusal to display, once. */
  rejection: string | null;
}

export interface UseCollabOptions {
  /** Result of `joinSession`, or `null` as long as the document is not shared. */
  join: SessionJoin | null;
  /** Applies a document that came from the network, without re-emitting it. */
  onRemoteDocument: (
    apply: (current: WriterDocumentState) => WriterDocumentState,
    remapSelection?: (selection: DocumentSelection) => DocumentSelection,
  ) => void;
}

export interface CollabHandle extends CollabState {
  /** Local identity, for the presence avatar. */
  self: { userId: string; displayName: string; color: string } | null;
  /** To call on every new local state: it goes down into the replicated document. */
  publish: (doc: WriterDocumentState) => void;
  /** Cursor position, announced to the other participants. */
  setCursor: (cursor: RemoteCursor | null) => void;
  /** True when the document is not shared, or when we can write in it. */
  canWrite: boolean;
  clearRejection: () => void;
  /** Access token, to upload the images to the server. */
  token: string | null;
  docId: string | null;
}

export function useCollab({ join, onRemoteDocument }: UseCollabOptions): CollabHandle {
  const [state, setState] = useState<CollabState>({
    status: 'local',
    permission: 'write',
    peers: [],
    pending: 0,
    rejection: null,
  });

  const sessionRef = useRef<CollabSession | null>(null);
  const mirrorRef = useRef<DocumentMirror | null>(null);
  /**
   * True once the **first** exchange is over, and never false again afterwards.
   *
   * It is not the state of the connection: a disconnection does not reset it. The distinction is anything but cosmetic: it is what makes offline editing possible. Suspending the descent of keystrokes into the CRDT
   * during a disconnection would simply lose them, since nothing else holds them: when the network came back, the replicated document would have stayed the one from before the disconnection and would overwrite them.
   */
  const amorceRef = useRef(false);
  /**
   * Last local state, and the last one that has **already gone down** into the CRDT.
   *
   * The two differ for the duration of one render: the editor changes its state, then publishes. It is that gap that `pousserLocal` closes before any read of the replicated document; otherwise a keystroke that arrived
   * in that interval would be erased by the re-read.
   */
  const localRef = useRef<WriterDocumentState | null>(null);
  const descenduRef = useRef<WriterDocumentState | null>(null);

  // The callback lives in a ref: the session is created only once, and depending on it would recreate it on every render, so reconnect the WebSocket on every keystroke.
  const remoteRef = useRef(onRemoteDocument);
  remoteRef.current = onRemoteDocument;

  const permission: Permission = join?.permission ?? 'write';
  const canWrite = join === null || permission === 'write';
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;

  useEffect(() => {
    if (!join?.access_token) {
      sessionRef.current = null;
      mirrorRef.current = null;
      amorceRef.current = false;
      descenduRef.current = null;
      setState((prev) => ({ ...prev, status: 'local', permission: 'write', peers: [] }));
      return;
    }

    setState((prev) => ({ ...prev, permission: join.permission, status: 'connecting' }));

    const session = new CollabSession(
      {
        docId: join.doc_id,
        token: join.access_token,
        user: {
          userId: join.user_id,
          displayName: join.email.split('@')[0] ?? join.user_id,
        },
      },
      {
        onStatus: (status) => setState((prev) => ({ ...prev, status })),
        onPeers: (peers) => setState((prev) => ({ ...prev, peers })),
        onPending: (pending) => setState((prev) => ({ ...prev, pending })),
        onSynced: (synced) => {
          if (!synced) return;
          // The first exchange decides the seeding; the following ones, after a reconnection, have nothing left to decide: the replicated document already carries everything it needs.
          if (amorceRef.current) return;
          amorceRef.current = true;
          amorcerSiVide();
        },
      },
    );

    const ydoc = session.doc;
    const mirror = new DocumentMirror(ydoc);
    sessionRef.current = session;
    mirrorRef.current = mirror;

    /**
     * Brings the state of the CRDT up into the editor, cursor carried over.
     *
     * We **push nothing down** on the way. The temptation would be to first push a local keystroke that had not been published yet; that would be a mistake. The comparison would then be made against a replicated
     * document that already carries the remote change, and the absence of that change from the local state would be read as a deletion: we would erase the peer's text.
     *
     * The interval does not exist for typing anyway: the editor publishes in a *layout* effect, so before handing control back to the browser, and no network frame can slip in (`WriterEditor`).
     */
    const remonter = (changements: Map<string, Changement[]>): void => {
      const suivant = mirror.read();
      descenduRef.current = suivant;
      localRef.current = suivant;
      remoteRef.current(
        () => suivant,
        changements.size > 0 ? reporterSelection(changements) : undefined,
      );
    };

    /** Seeds an empty share with what we have in front of us. */
    const amorcerSiVide = (): void => {
      const depart = localRef.current;
      if (mirror.seeded || !depart || !canWriteRef.current) {
        remonter(new Map());
        return;
      }
      seed(ydoc, depart, ORIGINE_LOCALE);
      descenduRef.current = depart;
      remonter(new Map());
    };

    /* --------------------------------------------------------- observation */

    let sale = false;
    const changements = new Map<string, Changement[]>();

    const observer = (
      events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
      transaction: Y.Transaction,
    ): void => {
      mirror.invalidate(events);
      if (transaction.origin === ORIGINE_LOCALE) return;
      sale = true;

      // A remote text shift moves the local cursor. Without this reading, writing above someone makes them type next to where they meant to.
      for (const event of events) {
        if (!(event instanceof Y.YTextEvent)) continue;
        const bloc = event.target.parent;
        if (!(bloc instanceof Y.Map)) continue;
        const blockId = bloc.get('id');
        if (typeof blockId !== 'string') continue;
        const changement = changeOfTextEvent(event);
        if (!changement) continue;
        const liste = changements.get(blockId);
        if (liste) liste.push(changement);
        else changements.set(blockId, [changement]);
      }
    };

    // The flat roots (title, page layout, default style) have no cursor to carry over: there is nothing to read, only to signal that a re-read will be needed.
    const observerPlat = (
      _event: Y.YMapEvent<unknown>,
      transaction: Y.Transaction,
    ): void => {
      if (transaction.origin === ORIGINE_LOCALE) return;
      sale = true;
    };

    const apresTransaction = (): void => {
      if (!sale) return;
      sale = false;
      const releve = new Map(changements);
      changements.clear();
      remonter(releve);
    };

    const yblocks = ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT);
    const ymeta = ydoc.getMap<unknown>(META_ROOT);
    const ysetup = ydoc.getMap<unknown>(SETUP_ROOT);

    yblocks.observeDeep(observer);
    ymeta.observe(observerPlat);
    ysetup.observe(observerPlat);
    // `afterTransaction` runs **after** the observers: it is the only point where we know a transaction is complete, and therefore the only one where we can go up once rather than once per touched root.
    ydoc.on('afterTransaction', apresTransaction);

    return () => {
      yblocks.unobserveDeep(observer);
      ymeta.unobserve(observerPlat);
      ysetup.unobserve(observerPlat);
      ydoc.off('afterTransaction', apresTransaction);
      session.destroy();
      sessionRef.current = null;
      mirrorRef.current = null;
      amorceRef.current = false;
      descenduRef.current = null;
    };
  }, [join?.doc_id, join?.access_token, join?.permission, join?.user_id, join?.email]);

  /**
   * Publication of the local state.
   *
   * Immediate, with no grouping: a Yjs transaction weighs a few dozen bytes and the computation is limited to the modified paragraph. Deferring the send would only add a window during which a remote frame would
   * re-read an incomplete document.
   *
   * It happens even offline. That is the turning point compared with the previous version, which suspended everything until the connection was established: here the keystroke goes into the replicated document right
   * away, and it is the document that keeps it until the network returns.
   */
  const publish = useCallback((doc: WriterDocumentState) => {
    localRef.current = doc;
    const session = sessionRef.current;
    // Before the first exchange is over, the replicated document may be empty because it has not arrived yet, and not because it is empty. Pushing the local state into it would add a second copy of the content.
    //
    // Afterwards, we **always** push, connected or not: the replicated document is what holds the keystroke during a disconnection, and will send it when the network returns.
    if (!session || !amorceRef.current) return;
    if (!canWriteRef.current) return;
    if (doc === descenduRef.current) return;

    reconcile(session.doc, doc, ORIGINE_LOCALE);
    descenduRef.current = doc;
  }, []);

  const setCursor = useCallback((cursor: RemoteCursor | null) => {
    sessionRef.current?.setCursor(cursor);
  }, []);

  const clearRejection = useCallback(() => {
    setState((prev) => ({ ...prev, rejection: null }));
  }, []);

  const self = useMemo(
    () =>
      join
        ? {
            userId: join.user_id,
            displayName: join.email.split('@')[0] ?? join.user_id,
            color: presenceColor(join.user_id),
          }
        : null,
    [join],
  );

  return {
    ...state,
    self,
    publish,
    setCursor,
    canWrite,
    clearRejection,
    token: join?.access_token ?? null,
    docId: join?.doc_id ?? null,
  };
}

/**
 * Carrying the local cursor over after a remote change.
 *
 * The `SwIndexReg` rule: an insertion made **before** the point pushes it by as much, an insertion made after does not concern it, and a deletion that encloses it brings it back to the start of the erased range.
 */
function reporterSelection(
  changements: Map<string, Changement[]>,
): (selection: DocumentSelection) => DocumentSelection {
  const reporterPosition = (position: DocumentPosition): DocumentPosition => {
    const liste = changements.get(position.blockId);
    if (!liste) return position;
    let offset = position.offset;
    for (const changement of liste) offset = remapOffset(offset, changement);
    return offset === position.offset ? position : { ...position, offset };
  };

  return (selection) => {
    const anchor = reporterPosition(selection.anchor);
    const focus = reporterPosition(selection.focus);
    if (anchor === selection.anchor && focus === selection.focus) return selection;
    return { ...selection, anchor, focus };
  };
}
