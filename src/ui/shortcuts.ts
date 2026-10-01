// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Display of keyboard shortcuts.
 *
 * A shortcut that cannot be discovered does not exist: every ribbon button and every menu entry shows its own (UX directive §5.1). Hence
 * a single notation, written here, and translated according to the platform when it is displayed.
 */

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');

/** `Mod-Shift-x` becomes "Ctrl+Maj+X" (shown with the localized key name), or "⌘+Maj+X" on Mac. */
export function shortcutLabel(binding: string): string {
  return binding
    .replace('Mod', isMac ? '⌘' : 'Ctrl')
    .replace('Shift', 'Maj')
    .split('-')
    // Keys are written in capitals: "Ctrl+B", never "Ctrl+b".
    .map((touche) => (touche.length === 1 ? touche.toUpperCase() : touche))
    .join('+');
}
