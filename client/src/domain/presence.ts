/**
 * Identité visuelle des collaborateurs (01_DIRECTIVE_UX_ERGONOMIE.md §7).
 *
 * Contrainte : la couleur DOIT être **dérivée d'un hachage de l'identifiant
 * utilisateur**, donc identique chez tous les participants. Une couleur tirée au
 * hasard côté client donnerait à Alice deux couleurs différentes selon l'écran.
 *
 * Module pur : aucune dépendance React, testable sans navigateur (couche 2).
 */

import { PRESENCE_COLOR_COUNT } from '../design/tokens';

/** FNV-1a 32 bits — déterministe, stable entre navigateurs et versions. */
export function hashUserId(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function presenceColorIndex(userId: string): number {
  return (hashUserId(userId) % PRESENCE_COLOR_COUNT) + 1;
}

/** Variable CSS à appliquer (jamais une valeur littérale). */
export function presenceColorVar(userId: string): string {
  return `var(--presence-${presenceColorIndex(userId)})`;
}

/** Initiales pour l'avatar : 2 caractères maximum, insensible aux accents. */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || '?';
}
