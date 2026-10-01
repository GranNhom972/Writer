// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Affichage des raccourcis clavier.
 *
 * Un raccourci non découvrable n'existe pas : chaque bouton du ruban et chaque
 * entrée de menu affiche le sien (directive UX §5.1). D'où une notation unique,
 * écrite ici, et traduite selon la plateforme au moment de l'affichage.
 */

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');

/** `Mod-Shift-x` devient « Ctrl+Maj+X », ou « ⌘+Maj+X » sur Mac. */
export function shortcutLabel(binding: string): string {
  return binding
    .replace('Mod', isMac ? '⌘' : 'Ctrl')
    .replace('Shift', 'Maj')
    .split('-')
    // Les touches s'écrivent en capitale : « Ctrl+B », jamais « Ctrl+b ».
    .map((touche) => (touche.length === 1 ? touche.toUpperCase() : touche))
    .join('+');
}
