import type { RemotePeer } from '../../collab/session';
import { initials } from '../../domain/presence';

const MAX_VISIBLE = 5;

interface PresenceAvatarsProps {
  peers: readonly RemotePeer[];
  self: { displayName: string; color: string };
}

/**
 * Présence (directive UX §7) : 5 avatars visibles au plus, puis « +N ».
 * La couleur est dérivée du hachage de l'identifiant : identique chez tous.
 */
export function PresenceAvatars({ peers, self }: PresenceAvatarsProps) {
  const visible = peers.slice(0, MAX_VISIBLE);
  const overflow = peers.length - visible.length;
  const total = peers.length + 1;

  return (
    <div className="presence" role="group" aria-label={`${total} personne(s) sur ce document`}>
      <span className="presence__avatar" style={{ background: self.color }} title={`${self.displayName} (vous)`}>
        {initials(self.displayName)}
      </span>
      {visible.map((peer) => (
        <span
          key={peer.clientId}
          className="presence__avatar"
          style={{ background: peer.color }}
          title={peer.displayName}
        >
          {initials(peer.displayName)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="presence__avatar presence__avatar--overflow" title={`${overflow} de plus`}>
          +{overflow}
        </span>
      )}
      {/* Le décompte est aussi disponible en texte : jamais la couleur seule. */}
      <span className="visually-hidden">{total} personne(s) connectée(s)</span>
    </div>
  );
}
