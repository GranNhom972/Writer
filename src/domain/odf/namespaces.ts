/**
 * Espaces de noms OpenDocument (OASIS ODF 1.2, partie 3).
 *
 * Les préfixes (`text:`, `style:`, …) ne sont qu'une convention d'écriture :
 * seul l'URI fait foi. On garde donc les deux — les URI pour lire un document
 * produit par n'importe quel logiciel, les préfixes pour écrire les nôtres,
 * dans la forme qu'attendent Writer et Word.
 */

export const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
} as const;

/** Déclarations à poser sur l'élément racine de tout fichier que l'on écrit. */
export const NS_DECLARATIONS = [
  `xmlns:office="${NS.office}"`,
  `xmlns:text="${NS.text}"`,
  `xmlns:style="${NS.style}"`,
  `xmlns:fo="${NS.fo}"`,
  `xmlns:table="${NS.table}"`,
  `xmlns:draw="${NS.draw}"`,
  `xmlns:svg="${NS.svg}"`,
  `xmlns:meta="${NS.meta}"`,
  `xmlns:xlink="${NS.xlink}"`,
  `xmlns:dc="${NS.dc}"`,
].join(' ');

/**
 * Nom local d'un élément, préfixe retiré.
 *
 * `Element.localName` suffit quand le document a été analysé avec les espaces
 * de noms ; le repli sur `tagName` couvre les fichiers mal formés, fréquents
 * chez les producteurs tiers, plutôt que de les rejeter en bloc.
 */
export function localName(element: Element): string {
  return element.localName || element.tagName.replace(/^.*:/, '');
}

/** Attribut recherché par URI, avec repli sur le nom préfixé. */
export function attr(element: Element, ns: string, name: string): string | null {
  return element.getAttributeNS(ns, name) ?? element.getAttribute(qualified(ns, name));
}

const PREFIX_BY_NS = new Map<string, string>(
  Object.entries(NS).map(([prefix, uri]) => [uri, prefix]),
);

function qualified(ns: string, name: string): string {
  const prefix = PREFIX_BY_NS.get(ns);
  return prefix ? `${prefix}:${name}` : name;
}

/** Échappement XML du texte et des valeurs d'attribut. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
