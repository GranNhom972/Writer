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
