// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

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
  // `xml:id` sert d'identifiant de liste à ODF (`text:continue-list` le vise).
  xml: 'http://www.w3.org/XML/1998/namespace',
  /**
   * Extensions LibreOffice.
   *
   * ODF 1.2 ne sait pas dire qu'un fil de commentaires est **clos** : la notion
   * n'apparaît qu'en 1.3, et LibreOffice l'a d'abord portée ici. On écrit dans
   * ce même espace de noms plutôt que d'inventer le nôtre — un lecteur tiers
   * ignore un attribut inconnu, mais LibreOffice, lui, comprend celui-là.
   */
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  /**
   * Réglages de légende propres à cet éditeur.
   *
   * ODF sait écrire une légende — un cadre englobant, un `draw:text-box`, un
   * paragraphe — mais rien n'y distingue « numérotation automatique » de
   * « texte saisi tel quel », ni ne conserve l'alignement voulu quand le texte
   * a déjà été composé. On écrit donc la légende **deux fois** : en clair, dans
   * la structure ODF normale, pour que tout lecteur l'affiche ; et sous forme
   * d'attributs, ici, pour se relire sans perte. Un lecteur tiers ignore un
   * attribut d'espace de noms inconnu, comme le veut la spécification.
   */
  writer: 'urn:cloudantille:names:writer:caption:1.0',
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
  `xmlns:loext="${NS.loext}"`,
  `xmlns:writer="${NS.writer}"`,
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
