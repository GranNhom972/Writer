// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * OpenDocument XML namespaces (OASIS ODF 1.2, part 3).
 *
 * The prefixes (`text:`, `style:`, ...) are only a writing convention: only the URI counts. We
 * therefore keep both: the URIs to read a document produced by any software, the prefixes to write ours,
 * in the form that Writer and Word expect.
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
  // `xml:id` serves as the list identifier in ODF (`text:continue-list` points to it).
  xml: 'http://www.w3.org/XML/1998/namespace',
  /**
   * LibreOffice extensions.
   *
   * ODF 1.2 has no way to say that a comment thread is **closed**: the notion only appears in 1.3, and
   * LibreOffice first carried it here. We write in that same namespace rather than invent our own: a
   * third-party reader ignores an unknown attribute, but LibreOffice understands this one.
   */
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  /**
   * Caption settings specific to this editor.
   *
   * ODF can write a caption (an enclosing frame, a `draw:text-box`, a paragraph) but nothing in it tells
   * "automatic numbering" from "text typed as is", nor keeps the intended alignment once the text has been
   * laid out. So we write the caption **twice**: in plain form, in the normal ODF structure, so that any
   * reader shows it; and as attributes, here, so we can read it back without loss. A third-party reader
   * ignores an attribute from an unknown namespace, as the specification requires.
   */
  writer: 'urn:cloudantille:names:writer:caption:1.0',
} as const;

/** Declarations to put on the root element of every file we write. */
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
 * Local name of an element, prefix removed.
 *
 * `Element.localName` is enough when the document was parsed with namespaces; the fallback on `tagName`
 * covers malformed files, common among third-party producers, rather than rejecting them wholesale.
 */
export function localName(element: Element): string {
  return element.localName || element.tagName.replace(/^.*:/, '');
}

/** Attribute looked up by URI, falling back on the prefixed name. */
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

/** XML escaping of text and attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
