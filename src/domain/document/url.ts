// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Normalisation des adresses.
 *
 * Un lien posé dans un document est **rediffusé à tous les collaborateurs** et
 * survit à l'export : un schéma exécutable y serait un vecteur d'exécution de
 * code différée, le vecteur XSS classique des traitements de texte en ligne.
 * On n'autorise donc que ce qui a un sens dans un document.
 */

/** Schémas admis. Tout le reste est refusé, `javascript:` et `data:` compris. */
const SCHEMAS_ADMIS = ['http:', 'https:', 'mailto:'];

/**
 * Renvoie l'adresse normalisée, ou `null` si elle est refusée.
 *
 * Une saisie sans schéma reçoit `https://` : c'est ce qu'attend l'usager qui
 * tape « exemple.fr », et cela évite qu'une adresse relative ne devienne un
 * lien vers l'application elle-même.
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
 * Adresse sûre à poser dans un `href`, ou `undefined` si elle ne l'est pas.
 *
 * `normalizeUrl` garde l'entrée du CLAVIER ; celle-ci garde la SORTIE. Un
 * `linkHref` peut arriver autrement que par la saisie : import ODF, opération
 * CRDT reçue d'un autre participant, document rechargé depuis le Drive.
 * Aucune de ces sources n'est fiable, et React ne bloque pas `javascript:`
 * dans un `href` — il se contente d'un avertissement en console.
 */
export function safeLinkHref(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  return normalizeUrl(input) ?? undefined;
}
