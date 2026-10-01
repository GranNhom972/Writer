// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Normalization of addresses.
 *
 * A link placed in a document is **re-sent to every collaborator** and survives the
 * export: an executable scheme in it would be a way to run code later, the classic XSS
 * vector of online word processors. So we only allow what makes sense in a document.
 */

/** Accepted schemes. Everything else is refused, `javascript:` and `data:` included. */
const SCHEMAS_ADMIS = ['http:', 'https:', 'mailto:'];

/**
 * Returns the normalized address, or `null` if it is refused.
 *
 * Input without a scheme gets `https://`: it is what a user who types "example.org"
 * expects, and it keeps a relative address from becoming a link to the application
 * itself.
 */
export function normalizeUrl(input: string): string | null {
  const nettoye = input.trim();
  if (!nettoye) return null;

  const candidat = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(nettoye) ? nettoye : `https://${nettoye}`;

  let url: URL;
  try {
    url = new URL(candidat);
  } catch {
    return null;
  }

  return SCHEMAS_ADMIS.includes(url.protocol) ? url.toString() : null;
}

/**
 * An address that is safe to put in an `href`, or `undefined` if it is not.
 *
 * `normalizeUrl` guards the KEYBOARD input; this one guards the OUTPUT. A `linkHref`
 * can arrive in other ways than typing: ODF import, a CRDT operation received from
 * another participant, a document reloaded from the Drive. None of these sources can be
 * trusted, and React does not block `javascript:` in an `href`: it only prints a warning
 * in the console.
 */
export function safeLinkHref(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  return normalizeUrl(input) ?? undefined;
}
