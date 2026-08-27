/**
 * Présence : qui d'autre est sur le document.
 *
 * Repris de l'application Write. Cinq avatars visibles au plus, puis « +N » :
 * au-delà, la rangée mange la barre de titre et plus personne n'est
 * identifiable.
 *
 * La couleur est dérivée du hachage de l'identifiant (`presenceColor`), donc
 * **identique chez tous** — deux participants peuvent parler du « curseur
 * rouge » et désigner la même personne. Le décompte est aussi donné en texte :
 * jamais la couleur seule, la présence ne doit pas dépendre de la vision des
 * couleurs.
 */

import type { JSX } from 'react';
import type { PeerPresence } from '../../domain/collab/session';

const MAX_VISIBLE = 5;

/** Initiales d'un nom : une lettre pour un mot, deux au-delà. */
export function initials(name: string): string {
  const mots = name.trim().split(/\s+/).filter(Boolean);
  if (mots.length === 0) return '?';
  if (mots.length === 1) return mots[0]!.slice(0, 2).toUpperCase();
  return (mots[0]![0]! + mots[mots.length - 1]![0]!).toUpperCase();
}

export interface PresenceAvatarsProps {
  peers: readonly PeerPresence[];
  self: { displayName: string; color: string };
}

export function PresenceAvatars({ peers, self }: PresenceAvatarsProps): JSX.Element {
  const visibles = peers.slice(0, MAX_VISIBLE);
  const surplus = peers.length - visibles.length;
  const total = peers.length + 1;

  return (
    <div className="presence" role="group" aria-label={`${total} personne(s) sur ce document`}>
      <span
        className="presence__avatar"
        style={{ background: self.color }}
        title={`${self.displayName} (vous)`}
      >
        {initials(self.displayName)}
      </span>
      {visibles.map((peer) => (
        <span
          key={peer.connectionId}
          className="presence__avatar"
          style={{ background: peer.color }}
          title={peer.displayName}
        >
          {initials(peer.displayName)}
        </span>
      ))}
      {surplus > 0 && (
        <span className="presence__avatar presence__avatar--overflow" title={`${surplus} de plus`}>
          +{surplus}
        </span>
      )}
      <span className="visually-hidden">{total} personne(s) connectée(s)</span>
    </div>
  );
}
