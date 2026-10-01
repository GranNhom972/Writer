// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Branchement du partage sur l'éditeur.
 *
 * Le nœud du problème n'a pas changé : le document local est produit par la
 * frappe, et les modifications distantes le modifient aussi. Ce qui change,
 * c'est la façon de les faire cohabiter.
 *
 * L'ancienne version comparait deux états et en déduisait des opérations de
 * bloc. Deux personnes dans le même paragraphe produisaient chacune un
 * « remplace ce paragraphe », et la seconde effaçait la première.
 *
 * Ici, le document répliqué (Yjs) est la référence, et il fusionne caractère
 * par caractère. Le cycle tient en deux règles :
 *
 *  - **ce que l'éditeur produit descend dans le CRDT** (`reconcile`), à
 *    l'endroit exact de la modification et nulle part ailleurs ;
 *  - **ce que le CRDT reçoit remonte dans l'éditeur** (`DocumentMirror.read`),
 *    en réutilisant les blocs inchangés pour ne repaginer que ce qui a bougé.
 *
 * Le renvoi en boucle n'est pas empêché par un drapeau mais par l'origine de la
 * transaction : une modification étiquetée locale ne remonte jamais à l'éditeur,
 * qui l'a déjà.
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
 * Étiquette des transactions produites par cet onglet.
 *
 * C'est elle, et rien d'autre, qui distingue « je viens de l'écrire » de « on
 * vient de me l'envoyer ». Un drapeau qu'il faudrait lever puis baisser
 * finirait tôt ou tard coincé dans un état ou dans l'autre.
 */
const ORIGINE_LOCALE = Symbol('writer:local');

/** Une modification de texte, telle qu'elle décale un curseur. */
interface Changement {
  at: number;
  removed: number;
  inserted: string;
}

export interface CollabState {
  status: ConnectionStatus;
  permission: Permission;
  peers: PeerPresence[];
  /** Modifications produites hors ligne, pas encore transmises. */
  pending: number;
  /** Dernier refus à afficher une fois. */
  rejection: string | null;
}

export interface UseCollabOptions {
  /** Résultat de `joinSession`, ou `null` tant que le document n'est pas partagé. */
  join: SessionJoin | null;
  /** Applique un document venu du réseau, sans le réémettre. */
  onRemoteDocument: (
    apply: (current: WriterDocumentState) => WriterDocumentState,
    remapSelection?: (selection: DocumentSelection) => DocumentSelection,
  ) => void;
}

export interface CollabHandle extends CollabState {
  /** Identité locale, pour l'avatar de présence. */
  self: { userId: string; displayName: string; color: string } | null;
  /** À appeler à chaque nouvel état local : il descend dans le document répliqué. */
  publish: (doc: WriterDocumentState) => void;
  /** Position du curseur, annoncée aux autres participants. */
  setCursor: (cursor: RemoteCursor | null) => void;
  /** Vrai quand le document n'est pas partagé, ou qu'on peut y écrire. */
  canWrite: boolean;
  clearRejection: () => void;
  /** Jeton d'accès, pour déposer les images sur le serveur. */
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
   * Vrai une fois le **premier** échange terminé, et plus jamais faux ensuite.
   *
   * Ce n'est pas l'état de la connexion : une coupure ne le remet pas à zéro.
   * La distinction est tout sauf cosmétique — c'est elle qui rend l'édition
   * hors ligne possible. Suspendre la descente des frappes dans le CRDT pendant
   * une coupure les perdrait purement et simplement, puisque rien d'autre ne
   * les retient : au retour du réseau, le document répliqué serait resté celui
   * d'avant la coupure et l'écraserait.
   */
  const amorceRef = useRef(false);
  /**
   * Dernier état local, et le dernier qui soit **déjà descendu** dans le CRDT.
   *
   * Les deux diffèrent le temps d'un rendu : l'éditeur change son état, puis
   * publie. C'est cet écart que rattrape `pousserLocal` avant toute lecture du
   * document répliqué — sans quoi une frappe arrivée dans cet intervalle serait
   * effacée par la relecture.
   */
  const localRef = useRef<WriterDocumentState | null>(null);
  const descenduRef = useRef<WriterDocumentState | null>(null);

  // Le rappel vit dans une réf : la session est créée une seule fois, et en
  // dépendre la ferait recréer à chaque rendu — donc reconnecter le WebSocket
  // à chaque frappe.
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
          // Le premier échange décide de l'amorçage ; les suivants — après une
          // reconnexion — n'ont plus rien à décider, le document répliqué porte
          // déjà tout ce qu'il faut.
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
     * Remonte l'état du CRDT dans l'éditeur, curseur reporté.
     *
     * On **ne redescend rien** au passage. La tentation serait de pousser
     * d'abord une frappe locale qui n'aurait pas encore été publiée ; ce serait
     * une faute. La comparaison se ferait alors contre un document répliqué qui
     * porte déjà la modification distante, et l'absence de celle-ci dans l'état
     * local serait lue comme une suppression : on effacerait le texte du pair.
     *
     * L'intervalle n'existe d'ailleurs pas pour la frappe : l'éditeur publie
     * dans un effet de *mise en page*, donc avant de rendre la main au
     * navigateur, et aucune trame réseau ne peut s'y glisser (`WriterEditor`).
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

    /** Amorce un partage vide avec ce que l'on a sous les yeux. */
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

      // Un déplacement de texte distant décale le curseur local. Sans ce
      // relevé, écrire au-dessus de quelqu'un lui fait taper à côté.
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

    // Les racines plates — titre, mise en page, style par défaut — n'ont pas
    // de curseur à reporter : il n'y a rien à relever, seulement à signaler
    // qu'il faudra relire.
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
    // `afterTransaction` s'exécute **après** les observateurs : c'est le seul
    // point où l'on sait qu'une transaction est complète, et donc le seul où
    // remonter une fois plutôt qu'une fois par racine touchée.
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
   * Publication de l'état local.
   *
   * Immédiate, sans regroupement : une transaction Yjs pèse quelques dizaines
   * d'octets et le calcul se limite au paragraphe modifié. Différer l'envoi ne
   * ferait qu'ajouter une fenêtre pendant laquelle une trame distante relirait
   * un document incomplet.
   *
   * Elle a lieu même hors ligne. C'est le point de bascule par rapport à la
   * version précédente, qui suspendait tout tant que la connexion n'était pas
   * établie : ici la frappe entre dans le document répliqué tout de suite, et
   * c'est lui qui la garde jusqu'au retour du réseau.
   */
  const publish = useCallback((doc: WriterDocumentState) => {
    localRef.current = doc;
    const session = sessionRef.current;
    // Avant la fin du premier échange, le document répliqué peut être vide
    // parce qu'il n'est pas encore arrivé — et non parce qu'il l'est. Y
    // descendre l'état local y ajouterait un second exemplaire du contenu.
    //
    // Après, on descend **toujours**, connecté ou non : le document répliqué
    // est ce qui retient la frappe le temps d'une coupure, et la transmettra au
    // retour du réseau.
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
 * Report du curseur local après une modification distante.
 *
 * Règle de `SwIndexReg` : une insertion faite **avant** le point le pousse d'
 * autant, une insertion faite après ne le concerne pas, et une suppression qui
 * l'englobe le ramène au début de la plage effacée.
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
