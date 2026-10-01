// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Presence: who else is on the document.
 *
 * Taken over from the Write application. At most five avatars are visible, then "+N": beyond that, the row eats the title bar and
 * nobody can be identified any more.
 *
 * The color is derived from the hash of the id (`presenceColor`), so **the same for everyone**: two participants can talk about the
 * "red cursor" and designate the same person. The count is also given as text: never color alone, presence must not depend on color
 * vision.
 */

import type { JSX } from 'react';
import type { PeerPresence } from '../../domain/collab/session';

const MAX_VISIBLE = 5;

/** Initials of a name: one letter for one word, two beyond that. */
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
