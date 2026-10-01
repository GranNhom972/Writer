// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Sharing session: replicated Yjs document, WebSocket, presence.
 *
 * Taken over from the collaboration layer of the Write application (`write/client/src/collab/session.ts`), with its founding
 * principle:
 *
 * > **the replicated document is the source of truth, the server is only a relay.**
 *
 * Three properties follow, and they are exactly those that the block-diff synchronization it replaces lacked:
 *
 *  1. **two concurrent keystrokes merge**, even in the same sentence. Neither can erase the other: there is no more "last one to
 *     arrive wins";
 *  2. **offline editing is the normal case.** Nothing is lost when the connection drops; on return, catching up is a simple
 *     difference computed from the state vector;
 *  3. **the server does not have to order anything.** No more revisions, no more watermark, no more holding operations until they
 *     are acknowledged: all of these delicate invariants disappear along with the sequencer.
 *
 * The mapping between `WriterDocumentState` and the replicated types lives in [`crdt.ts`](./crdt.ts); this module only deals with
 * transport.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';

export type ConnectionStatus = 'local' | 'connecting' | 'connected' | 'offline';

/** Position of a remote cursor, as it travels in the presence. */
export interface RemoteCursor {
  blockId: string;
  offset: number;
}

export interface PeerPresence {
  /** Yjs connection id: unique per tab, even for the same person. */
  connectionId: number;
  userId: string;
  displayName: string;
  /** Presence CSS variable, derived from the hash of `userId`, never random. */
  color: string;
  cursor?: RemoteCursor | undefined;
}

export interface SessionUser {
  userId: string;
  displayName: string;
}

export interface SessionEvents {
  onStatus: (status: ConnectionStatus) => void;
  onPeers: (peers: PeerPresence[]) => void;
  /**
   * The first exchange with the server is over: the local document holds everything the server knows. Before that it may be empty,
   * which is what separates "empty document" from "not received yet", and seeding a share on that confusion would duplicate all the
   * content.
   */
  onSynced: (synced: boolean) => void;
  /** Number of changes made offline and not sent yet. */
  onPending: (pending: number) => void;
}

export interface SessionOptions {
  docId: string;
  /** Access token, sent through the WebSocket sub-protocol, never in a query string. */
  token: string;
  user: SessionUser;
  /** Origin of the server; by default that of the page (Vite proxy in development). */
  serverOrigin?: string;
}

/**
 * Presence color, derived from the hash of the id.
 *
 * Deterministic and not random: a person's color must be the same for all participants, otherwise two people discuss a "blue
 * cursor" that is not the same one.
 */
export function presenceColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return `var(--presence-${(Math.abs(hash) % 8) + 1})`;
}

/**
 * Periodic resynchronization: a safety net if a frame was lost. Without it, a silent loss would only be caught up at the next
 * reconnection, which may mean never.
 */
const RESYNC_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 10_000;

export class CollabSession {
  readonly doc: Y.Doc;
  private readonly provider: WebsocketProvider;
  private readonly awareness: Awareness;

  private status: ConnectionStatus = 'connecting';
  private synced = false;
  /**
   * Changes made while the link was down.
   *
   * They are not *pending* in the sense of the old retention: the replicated document already holds them and will send them when the
   * network returns. This counter only exists to tell the user, who has the right to know that their work has not left yet.
   */
  private pending = 0;
  private ferme = false;

  constructor(
    options: SessionOptions,
    private readonly events: SessionEvents,
  ) {
    this.doc = new Y.Doc();

    const origin = options.serverOrigin ?? window.location.origin;
    const wsOrigin = origin.replace(/^http/, 'ws');

    this.provider = new WebsocketProvider(`${wsOrigin}/api/v1/sync`, options.docId, this.doc, {
      // The token travels in the sub-protocol: it does not leak into access logs, into the `Referer`, or into the browser history, which a
      // query string would do in all three.
      protocols: [`bearer.${options.token}`],
      resyncInterval: RESYNC_INTERVAL_MS,
      maxBackoffTime: MAX_BACKOFF_MS,
    });

    this.awareness = this.provider.awareness;
    this.awareness.setLocalStateField('user', {
      id: options.user.userId,
      name: options.user.displayName,
      color: presenceColor(options.user.userId),
    });

    this.provider.on('status', this.onProviderStatus);
    this.provider.on('sync', this.onProviderSync);
    this.awareness.on('change', this.onAwarenessChange);
    this.doc.on('update', this.onLocalUpdate);
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** Is the first exchange over? See `SessionEvents.onSynced`. */
  get isSynced(): boolean {
    return this.synced;
  }

  get pendingCount(): number {
    return this.pending;
  }

  /* -------------------------------------------------------------- transport */

  private readonly onProviderStatus = (event: { status: string }): void => {
    switch (event.status) {
      case 'connected':
        this.setStatus('connected');
        break;
      case 'connecting':
        this.setStatus('connecting');
        break;
      default:
        // The link is broken: editing continues, it just no longer leaves. This is the normal case of offline work, not a failure.
        this.synced = false;
        this.events.onSynced(false);
        this.setStatus('offline');
        // Other people's cursors mean nothing once disconnected.
        this.events.onPeers([]);
        break;
    }
  };

  private readonly onProviderSync = (synced: boolean): void => {
    this.synced = synced;
    if (synced && this.pending !== 0) {
      this.pending = 0;
      this.events.onPending(0);
    }
    this.events.onSynced(synced);
  };

  /**
   * Counts what has not left yet.
   *
   * `transaction.local` tells our changes from those arriving from the network: re-broadcasting the latter would make no sense, and
   * counting them would show "12 pending" on a document where we wrote nothing.
   */
  private readonly onLocalUpdate = (
    _update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ): void => {
    if (!transaction.local) return;
    if (this.status === 'connected' && this.synced) return;
    this.pending += 1;
    this.events.onPending(this.pending);
  };

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status || this.ferme) return;
    this.status = status;
    this.events.onStatus(status);
  }

  /* --------------------------------------------------------------- presence */

  private readonly onAwarenessChange = (): void => {
    this.events.onPeers(readPeers(this.awareness));
  };

  /** Announces the cursor position to the other participants. */
  setCursor(cursor: RemoteCursor | null): void {
    if (this.ferme) return;
    const courant = this.awareness.getLocalState()?.['cursor'] as RemoteCursor | null | undefined;
    // Announce nothing when nothing has moved: presence goes out on the network at every call, and the cursor is recomputed at every
    // render of the editor.
    if (
      (courant ?? null) === (cursor ?? null) ||
      (courant && cursor && courant.blockId === cursor.blockId && courant.offset === cursor.offset)
    ) {
      return;
    }
    this.awareness.setLocalStateField('cursor', cursor);
  }

  /* ------------------------------------------------------------------ end */

  /** Closes the session for good: no further reconnection. */
  destroy(): void {
    if (this.ferme) return;
    this.ferme = true;

    this.provider.off('status', this.onProviderStatus);
    this.provider.off('sync', this.onProviderSync);
    this.awareness.off('change', this.onAwarenessChange);
    this.doc.off('update', this.onLocalUpdate);

    // Remove your presence **before** closing: the peers clear the avatar and the cursor at once, without waiting for their timer to
    // expire.
    this.awareness.setLocalState(null);
    this.provider.destroy();
    this.doc.destroy();
  }
}

/** The remote peers announced by presence, ourselves excluded. */
export function readPeers(awareness: Awareness): PeerPresence[] {
  const peers: PeerPresence[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const brut = state as {
      user?: { id?: string; name?: string; color?: string };
      cursor?: RemoteCursor | null;
    };
    const user = brut.user;
    if (!user?.id) return;

    peers.push({
      connectionId: clientId,
      userId: user.id,
      displayName: user.name ?? user.id,
      color: user.color ?? presenceColor(user.id),
      cursor: brut.cursor ?? undefined,
    });
  });
  return peers;
}

/** Sharing parameters read from the address: `?session=…&email=…`. */
export function readShareLink(search: string): { tokenSession: string; email: string } | null {
  const params = new URLSearchParams(search);
  const tokenSession = params.get('session');
  const email = params.get('email');
  if (!tokenSession || !email) return null;
  return { tokenSession, email };
}

/* ------------------------------------------------------- opening from CloudServ */

/**
 * Opening from CloudServ: `/doc/<uuid>#token=<ticket>` or `#doc=<uuid>&token=<ticket>`.
 *
 * The ticket travels in the **fragment**, never in the query string. A fragment is not sent to the server: it therefore appears
 * neither in the access logs nor in the `Referer` header sent to third-party resources. This is the same reason why the token goes
 * through the WebSocket sub-protocol rather than through the connection URL.
 *
 * The document id is carried by the `/doc/:docId` route to cleanly isolate each tab and window. The token is saved in
 * `sessionStorage` to allow a page reload (F5) without interruption.
 */
export function readCloudServLink(
  hash: string = typeof window !== 'undefined' ? window.location.hash : '',
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): { docId: string; token: string } | null {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(search.replace(/^\?/, ''));

  // 1. Extract the docId: either from the URL path /doc/:docId, or from the hash/query
  const pathMatch = pathname.match(/^\/(?:doc|documents|d)\/([a-zA-Z0-9_-]+)/i);
  let docId = pathMatch ? pathMatch[1] : null;

  if (!docId) {
    docId = hashParams.get('doc') || searchParams.get('doc');
  }

  // 2. Extract the token: either from the hash/query, or from sessionStorage
  let token = hashParams.get('token') || searchParams.get('token');
  if (!token && docId && typeof sessionStorage !== 'undefined') {
    try {
      token = sessionStorage.getItem(`writer_token_${docId}`);
    } catch {
      // sessionStorage not accessible
    }
  }

  if (!docId || !token) return null;

  // Persist the token for F5 reloads of this tab
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(`writer_token_${docId}`, token);
    } catch {
      // ignore
    }
  }

  return { docId, token };
}

/** What a ticket announces. Decoded for display only: it is the server that verifies. */
export interface TicketClaims {
  userId: string;
  displayName: string;
  permission: 'read' | 'comment' | 'write';
}

/**
 * Reads the payload of a ticket, **without verifying its signature**.
 *
 * This is not an oversight: the client does not have the secret, and must not have it. What is read here only serves to display a
 * name and to grey out the toolbar in read-only mode. The permission that counts is the one the server applies: lying in your own
 * ticket therefore gives no right, it only shows buttons whose effects the server will refuse.
 */
export function readTicketClaims(token: string): TicketClaims | null {
  const charge = token.split('.')[1];
  if (!charge) return null;
  try {
    const normalise = charge.replace(/-/g, '+').replace(/_/g, '/');
    const complete = normalise.padEnd(normalise.length + ((4 - (normalise.length % 4)) % 4), '=');
    const brut = JSON.parse(
      decodeURIComponent(
        atob(complete)
          .split('')
          .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
          .join(''),
      ),
    ) as { sub?: string; name?: string; scope?: string };

    if (!brut.sub) return null;
    const permission =
      brut.scope === 'write' || brut.scope === 'comment' ? brut.scope : ('read' as const);
    return {
      userId: brut.sub,
      displayName: brut.name || brut.sub,
      permission,
    };
  } catch {
    return null;
  }
}
