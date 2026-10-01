// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Session de partage — document répliqué Yjs, WebSocket, présence.
 *
 * Reprise de la couche de collaboration de l'application Write
 * (`write/client/src/collab/session.ts`), avec son principe fondateur :
 *
 * > **le document répliqué est la source de vérité, le serveur n'est qu'un
 * > relais.**
 *
 * Trois propriétés en découlent, et ce sont exactement celles qui manquaient à
 * la synchronisation par diff de blocs qu'il remplace :
 *
 *  1. **deux frappes concurrentes fusionnent**, y compris dans la même phrase.
 *     Aucune ne peut effacer l'autre : il n'y a plus de « dernier arrivé
 *     gagne » ;
 *  2. **l'édition hors ligne est le cas nominal.** Rien n'est perdu à la
 *     coupure ; au retour, le rattrapage est un simple différentiel calculé à
 *     partir du vecteur d'état ;
 *  3. **le serveur n'a pas à ordonner quoi que ce soit.** Plus de révision, plus
 *     de filigrane, plus de rétention d'opérations en attente d'accusé : ce sont
 *     autant d'invariants délicats qui disparaissent avec le séquenceur.
 *
 * La correspondance entre `WriterDocumentState` et les types répliqués vit dans
 * [`crdt.ts`](./crdt.ts) ; ce module-ci ne s'occupe que du transport.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';

export type ConnectionStatus = 'local' | 'connecting' | 'connected' | 'offline';

/** Position d'un curseur distant, telle qu'elle voyage dans la présence. */
export interface RemoteCursor {
  blockId: string;
  offset: number;
}

export interface PeerPresence {
  /** Identifiant de connexion Yjs — unique par onglet, y compris pour une même personne. */
  connectionId: number;
  userId: string;
  displayName: string;
  /** Variable CSS de présence, dérivée du hachage de `userId` — jamais aléatoire. */
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
   * Le premier échange avec le serveur est terminé : le document local contient
   * tout ce que le serveur connaît. Avant cela, il peut être vide — c'est ce
   * qui distingue « document vide » de « pas encore reçu », et amorcer un
   * partage sur cette confusion dupliquerait tout le contenu.
   */
  onSynced: (synced: boolean) => void;
  /** Nombre de modifications produites hors ligne, pas encore transmises. */
  onPending: (pending: number) => void;
}

export interface SessionOptions {
  docId: string;
  /** Jeton d'accès — transmis par sous-protocole WebSocket, jamais en query string. */
  token: string;
  user: SessionUser;
  /** Origine du serveur ; par défaut celle de la page (proxy Vite en développement). */
  serverOrigin?: string;
}

/**
 * Couleur de présence, dérivée du hachage de l'identifiant.
 *
 * Déterministe et non aléatoire : la couleur d'une personne doit être la même
 * chez tous les participants, sinon deux personnes discutent d'un « curseur
 * bleu » qui n'est pas le même.
 */
export function presenceColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return `var(--presence-${(Math.abs(hash) % 8) + 1})`;
}

/**
 * Resynchronisation périodique : filet de sécurité si une trame s'est perdue.
 * Sans elle, une perte silencieuse ne se rattraperait qu'à la reconnexion
 * suivante — c'est-à-dire peut-être jamais.
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
   * Modifications produites alors que le lien était rompu.
   *
   * Elles ne sont pas *en attente* au sens de l'ancienne rétention : le document
   * répliqué les porte déjà et les transmettra au retour du réseau. Ce compteur
   * ne sert qu'à le dire à l'usager, qui a le droit de savoir que son travail
   * n'est pas encore parti.
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
      // Le jeton voyage dans le sous-protocole : il ne fuite ni dans les journaux
      // d'accès, ni dans le `Referer`, ni dans l'historique du navigateur — ce
      // qu'une query string ferait dans les trois.
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

  /** Le premier échange est-il terminé ? Voir `SessionEvents.onSynced`. */
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
        // Le lien est rompu : l'édition continue, elle ne fait que ne plus
        // partir. C'est le cas nominal du travail hors ligne, pas une panne.
        this.synced = false;
        this.events.onSynced(false);
        this.setStatus('offline');
        // Les curseurs des autres ne veulent plus rien dire une fois coupé.
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
   * Compte ce qui n'est pas encore parti.
   *
   * `transaction.local` distingue nos modifications de celles qui arrivent du
   * réseau : rediffuser les secondes n'aurait aucun sens, et les compter en
   * afficherait « 12 en attente » sur un document où l'on n'a rien écrit.
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

  /* --------------------------------------------------------------- présence */

  private readonly onAwarenessChange = (): void => {
    this.events.onPeers(readPeers(this.awareness));
  };

  /** Annonce la position du curseur aux autres participants. */
  setCursor(cursor: RemoteCursor | null): void {
    if (this.ferme) return;
    const courant = this.awareness.getLocalState()?.['cursor'] as RemoteCursor | null | undefined;
    // Ne rien annoncer quand rien n'a bougé : la présence part sur le réseau à
    // chaque appel, et le curseur est recalculé à chaque rendu de l'éditeur.
    if (
      (courant ?? null) === (cursor ?? null) ||
      (courant && cursor && courant.blockId === cursor.blockId && courant.offset === cursor.offset)
    ) {
      return;
    }
    this.awareness.setLocalStateField('cursor', cursor);
  }

  /* ------------------------------------------------------------------ fin */

  /** Ferme la session pour de bon : plus aucune reconnexion. */
  destroy(): void {
    if (this.ferme) return;
    this.ferme = true;

    this.provider.off('status', this.onProviderStatus);
    this.provider.off('sync', this.onProviderSync);
    this.awareness.off('change', this.onAwarenessChange);
    this.doc.off('update', this.onLocalUpdate);

    // Retirer sa présence **avant** de fermer : les pairs effacent l'avatar et
    // le curseur tout de suite, sans attendre l'expiration de leur minuterie.
    this.awareness.setLocalState(null);
    this.provider.destroy();
    this.doc.destroy();
  }
}

/** Les pairs distants annoncés par la présence, soi-même exclu. */
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

/** Paramètres de partage lus dans l'adresse : `?session=…&email=…`. */
export function readShareLink(search: string): { tokenSession: string; email: string } | null {
  const params = new URLSearchParams(search);
  const tokenSession = params.get('session');
  const email = params.get('email');
  if (!tokenSession || !email) return null;
  return { tokenSession, email };
}

/* ------------------------------------------------------- ouverture CloudServ */

/**
 * Ouverture depuis CloudServ : `/doc/<uuid>#token=<billet>` ou `#doc=<uuid>&token=<billet>`.
 *
 * Le billet voyage dans le **fragment**, jamais dans la query string. Un
 * fragment n'est pas transmis au serveur : il n'apparaît donc ni dans les
 * journaux d'accès, ni dans l'en-tête `Referer` envoyé aux ressources tierces.
 * C'est la même raison qui fait passer le jeton par le sous-protocole WebSocket
 * plutôt que par l'URL de connexion.
 *
 * L'identifiant de document est porté par la route `/doc/:docId` pour isoler
 * proprement chaque onglet et fenêtre. Le jeton est sauvegardé dans `sessionStorage`
 * pour permettre le rechargement de page (F5) sans interruption.
 */
export function readCloudServLink(
  hash: string = typeof window !== 'undefined' ? window.location.hash : '',
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): { docId: string; token: string } | null {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(search.replace(/^\?/, ''));

  // 1. Extraire le docId : soit depuis le chemin d'URL /doc/:docId, soit depuis hash/query
  const pathMatch = pathname.match(/^\/(?:doc|documents|d)\/([a-zA-Z0-9_-]+)/i);
  let docId = pathMatch ? pathMatch[1] : null;

  if (!docId) {
    docId = hashParams.get('doc') || searchParams.get('doc');
  }

  // 2. Extraire le token : soit depuis le hash/query, soit depuis sessionStorage
  let token = hashParams.get('token') || searchParams.get('token');
  if (!token && docId && typeof sessionStorage !== 'undefined') {
    try {
      token = sessionStorage.getItem(`writer_token_${docId}`);
    } catch {
      // sessionStorage non accessible
    }
  }

  if (!docId || !token) return null;

  // Persister le jeton pour les rechargements F5 de cet onglet
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(`writer_token_${docId}`, token);
    } catch {
      // ignore
    }
  }

  return { docId, token };
}

/** Ce qu'un billet annonce. Décodé pour l'affichage seul — c'est le serveur qui vérifie. */
export interface TicketClaims {
  userId: string;
  displayName: string;
  permission: 'read' | 'comment' | 'write';
}

/**
 * Lit la charge utile d'un billet, **sans vérifier sa signature**.
 *
 * Ce n'est pas un oubli : le client n'a pas le secret, et n'a pas à l'avoir. Ce
 * qui est lu ici ne sert qu'à afficher un nom et à griser la barre d'outils en
 * lecture seule. La permission qui compte est celle que le serveur applique —
 * mentir dans son propre billet ne donne donc aucun droit, cela ne fait
 * qu'afficher des boutons dont le serveur refusera les effets.
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
