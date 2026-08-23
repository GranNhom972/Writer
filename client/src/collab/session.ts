/**
 * Session collaborative (couche 1) — Yjs + WebSocket.
 *
 * ADR-001 : le document CRDT est la source de vérité ; le serveur est un relais.
 * Conséquence directe : **l'édition reste possible hors ligne**, et le rattrapage
 * après coupure est le cas nominal (state vector → différentiel).
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';

/** `local` = document non partagé : aucun serveur, aucune synchronisation. */
export type ConnectionStatus = 'connecting' | 'connected' | 'offline' | 'local';

export interface SessionUser {
  userId: string;
  displayName: string;
  /** Variable CSS de présence, dérivée du hachage de `userId` (jamais aléatoire). */
  color: string;
}

export interface CollabSession {
  doc: Y.Doc;
  /** `null` en mode local : le document vit uniquement dans cet onglet. */
  provider: WebsocketProvider | null;
  /**
   * Présence. Toujours présente, même sans serveur : l'éditeur en dépend pour ses
   * curseurs, et une API qui change selon le mode multiplierait les cas.
   */
  awareness: Awareness;
  /** Fragment lié à l'éditeur ProseMirror (nom partagé avec y-prosemirror). */
  fragment: Y.XmlFragment;
  /**
   * Métadonnées répliquées (titre…). Placées dans le CRDT et non dans une simple
   * requête REST : renommer le document doit se voir chez tous, immédiatement.
   */
  meta: Y.Map<unknown>;
  destroy: () => void;
}

export interface SessionOptions {
  docId: string;
  /** Jeton d'accès — transmis par sous-protocole WebSocket, jamais en query string. */
  token: string;
  user: SessionUser;
  /** Origine du serveur ; par défaut celle de la page (proxy Vite en développement). */
  serverOrigin?: string;
  /**
   * Mode local : aucun serveur n'est contacté. Utile pour rédiger seul, pour les
   * démonstrations hors ligne et pour les tests — le modèle de document est
   * exactement le même, seule la couche de transport disparaît.
   */
  local?: boolean;
}

export const EDITOR_FRAGMENT = 'write:body';
export const META_MAP = 'write:meta';

export function createCollabSession(options: SessionOptions): CollabSession {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(EDITOR_FRAGMENT);
  const meta = doc.getMap(META_MAP);

  if (options.local) {
    const awareness = new Awareness(doc);
    setLocalUser(awareness, options.user);

    return {
      doc,
      provider: null,
      awareness,
      fragment,
      meta,
      destroy: () => {
        awareness.destroy();
        doc.destroy();
      },
    };
  }

  const origin = options.serverOrigin ?? window.location.origin;
  const wsOrigin = origin.replace(/^http/, 'ws');

  const provider = new WebsocketProvider(`${wsOrigin}/api/v1/sync`, options.docId, doc, {
    // Le jeton voyage dans le sous-protocole : il ne fuite ni dans les logs
    // d'accès, ni dans le Referer, ni dans l'historique du navigateur.
    protocols: [`bearer.${options.token}`],
    // Resynchronisation périodique : filet de sécurité si une trame a été perdue.
    resyncInterval: 30_000,
    maxBackoffTime: 10_000,
  });

  setLocalUser(provider.awareness, options.user);

  return {
    doc,
    provider,
    awareness: provider.awareness,
    fragment,
    meta,
    destroy: () => {
      provider.awareness.setLocalState(null);
      provider.destroy();
      doc.destroy();
    },
  };
}

function setLocalUser(awareness: Awareness, user: SessionUser): void {
  awareness.setLocalStateField('user', {
    id: user.userId,
    name: user.displayName,
    color: user.color,
  });
}

/** Statut affiché en barre d'état : trois états seulement (directive UX §7). */
export function toConnectionStatus(status: 'connected' | 'disconnected' | 'connecting'): ConnectionStatus {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    default:
      return 'offline';
  }
}

export interface RemotePeer {
  clientId: number;
  userId: string;
  displayName: string;
  color: string;
}

/** Extrait les pairs distants de l'état d'awareness, hors soi-même. */
export function readPeers(awareness: Awareness): RemotePeer[] {
  const peers: RemotePeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = (state as { user?: { id?: string; name?: string; color?: string } }).user;
    if (!user?.id) return;
    peers.push({
      clientId,
      userId: user.id,
      displayName: user.name ?? user.id,
      color: user.color ?? 'var(--presence-1)',
    });
  });
  return peers;
}
