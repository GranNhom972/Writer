// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Images of an OpenDocument archive: the `Pictures/` folder.
 *
 * ODF never puts the bytes of an image in the XML. `content.xml` carries a
 * `<draw:image xlink:href="Pictures/…"/>`, and the bytes live in a separate ZIP entry declared in the
 * manifest. This is exactly what `SvXMLGraphicHelper` does
 * (`xmloff/source/core/XMLEmbeddedObjectExportFilter`).
 *
 * Our model carries `data:` addresses when the document is offline. This module therefore translates in
 * both directions:
 *
 *   export: `data:image/png;base64,…`  →  `Pictures/name.png` + bytes
 *   import: `Pictures/name.png` + bytes  →  `data:image/png;base64,…`
 *
 * An image already served by an address (the server's store, a URL) is **not** brought into the archive:
 * downloading it would need network access from a pure module, and the address stays valid for an ODF
 * reader.
 */

import { collectImageRuns } from '../document/images';
import { isParagraph, isTable, type TableNode, type WriterDocumentState } from '../document/types';

/** A binary entry of the `Pictures/` folder. */
export interface OdfPicture {
  /** Path inside the archive, `Pictures/xxxx.png`. */
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function mediaTypeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Is a ZIP entry an image of the document? */
export function isPicturePath(path: string): boolean {
  return path.startsWith('Pictures/') && mediaTypeForPath(path) !== 'application/octet-stream';
}

interface ParsedDataUrl {
  mediaType: string;
  bytes: Uint8Array;
}

/** Decodes a base64 `data:` URL. Returns `null` for any other form. */
export function parseDataUrl(src: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(src.trim());
  if (!match) return null;
  const mediaType = match[1]!.toLowerCase();
  if (!(mediaType in EXTENSION_BY_TYPE)) return null;
  try {
    return { mediaType, bytes: base64ToBytes(match[2]!) };
  } catch {
    return null;
  }
}

export function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}

/**
 * Lookup table of a document's images, ready for export.
 *
 * Two runs carrying the **same** source only produce one entry: duplicating the bytes of a logo repeated at
 * the top of every section would double the weight of the archive for nothing.
 */
export function collectPictures(doc: WriterDocumentState): {
  pictures: OdfPicture[];
  hrefBySrc: Map<string, string>;
} {
  const pictures: OdfPicture[] = [];
  const hrefBySrc = new Map<string, string>();

  const visiter = (runs: readonly { imageSrc?: string }[]): void => {
    for (const { run } of collectImageRuns(runs as never)) {
      const src = run.imageSrc!;
      if (hrefBySrc.has(src)) continue;

      const decoded = parseDataUrl(src);
      if (!decoded) {
        // Served address: it goes into `xlink:href` as it is.
        hrefBySrc.set(src, src);
        continue;
      }

      const extension = EXTENSION_BY_TYPE[decoded.mediaType] ?? 'png';
      // Deterministic name, derived from the rank: two exports of the same document give two identical archives,
      // which makes round-trip tests possible.
      const path = `Pictures/image${pictures.length + 1}.${extension}`;
      pictures.push({ path, mediaType: decoded.mediaType, bytes: decoded.bytes });
      hrefBySrc.set(src, path);
    }
  };

  for (const block of doc.blocks) {
    if (isTable(block)) {
      visiterTableau(block, visiter);
      continue;
    }
    // A table of contents carries no image: its lines only exist at pagination time and are always plain text.
    if (isParagraph(block)) visiter(block.runs);
  }

  return { pictures, hrefBySrc };
}

function visiterTableau(
  table: TableNode,
  visiter: (runs: readonly { imageSrc?: string }[]) => void,
): void {
  for (const row of table.rows) {
    for (const cell of row.cells) {
      for (const paragraph of cell.blocks) visiter(paragraph.runs);
    }
  }
}

/* ------------------------------------------------------------------ base64 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Hand-written base64.
 *
 * `btoa` does not exist everywhere layer 2 runs: the engine must stay runnable in a Web Worker and in a test
 * with no DOM (see `MetricTextMeasurer`).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b1 === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += b2 === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

const B64_INDEX = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  return table;
})();

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? B64_INDEX[code]! : -1;
    if (value < 0) throw new Error('Base64 invalide.');
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (accumulator >> bits) & 0xff;
      at += 1;
    }
  }

  return out.subarray(0, at);
}
