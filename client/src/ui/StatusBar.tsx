/**
 * Barre d'état (directive UX §7).
 *
 * Trois états de synchronisation seulement, en langage d'usager :
 * aucun compteur technique, aucun hachage de commit exposé.
 */

import type { ConnectionStatus } from '../collab/session';

/** Raison de la lecture seule : le message DOIT dire laquelle des deux s'applique. */
export type ReadOnlyReason = 'scope' | 'reading-mode' | null;

interface StatusBarProps {
  status: ConnectionStatus;
  readOnlyReason: ReadOnlyReason;
  wordCount: number;
  pageCount: number;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Toutes les modifications sont enregistrées',
  connecting: 'Enregistrement…',
  offline: 'Hors ligne — reprise automatique',
  local: 'Document local — en mémoire',
};

const READ_ONLY_LABEL: Record<'scope' | 'reading-mode', string> = {
  scope: 'Lecture seule — vous n’avez pas les droits d’écriture',
  'reading-mode': 'Mode lecture — désactivez-le dans Affichage pour modifier',
};

export function StatusBar({ status, readOnlyReason, wordCount, pageCount }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        {pageCount} page{pageCount > 1 ? 's' : ''}
      </span>
      <span className="statusbar__item">
        {wordCount} mot{wordCount > 1 ? 's' : ''}
      </span>
      {readOnlyReason && (
        <span className="statusbar__item statusbar__item--badge">
          {READ_ONLY_LABEL[readOnlyReason]}
        </span>
      )}
      <span className="statusbar__spacer" />
      <span className={`statusbar__sync statusbar__sync--${status}`}>
        {/* Icône + texte : la couleur n'est jamais le seul véhicule du sens. */}
        <span className="statusbar__dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
    </footer>
  );
}
