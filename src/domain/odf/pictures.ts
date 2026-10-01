// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Images d'une archive OpenDocument — le dossier `Pictures/`.
 *
 * ODF ne met jamais les octets d'une image dans le XML. `content.xml` porte un
 * `<draw:image xlink:href="Pictures/…"/>`, et les octets vivent dans une entrée
 * distincte du ZIP, déclarée au manifeste. C'est exactement ce que fait
 * `SvXMLGraphicHelper` (`xmloff/source/core/XMLEmbeddedObjectExportFilter`).
 *
 * Notre modèle, lui, porte des adresses `data:` quand le document est hors
 * ligne. Ce module fait donc la traduction dans les deux sens :
 *
 *   export : `data:image/png;base64,…`  →  `Pictures/nom.png` + octets
 *   import : `Pictures/nom.png` + octets  →  `data:image/png;base64,…`
 *
 * Une image déjà servie par une adresse (le dépôt du serveur, une URL) n'est
 * **pas** rapatriée dans l'archive : la télécharger demanderait un accès réseau
 * depuis un module pur, et l'adresse reste valide pour un lecteur ODF.
 */

import { collectImageRuns } from '../document/images';
import { isParagraph, isTable, type TableNode, type WriterDocumentState } from '../document/types';

/** Une entrée binaire du dossier `Pictures/`. */
export interface OdfPicture {
  /** Chemin dans l'archive, `Pictures/xxxx.png`. */
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

/** Une entrée de ZIP est-elle une image du document ? */
export function isPicturePath(path: string): boolean {
  return path.startsWith('Pictures/') && mediaTypeForPath(path) !== 'application/octet-stream';
}

interface ParsedDataUrl {
  mediaType: string;
  bytes: Uint8Array;
}

/** Décode une `data:` base64. Rend `null` sur toute autre forme. */
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
 * Table de correspondance des images d'un document, prête pour l'export.
 *
 * Deux runs portant la **même** source ne produisent qu'une entrée : dupliquer
 * les octets d'un logo répété en tête de chaque section doublerait le poids de
 * l'archive pour rien.
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
        // Adresse servie : elle passe telle quelle dans `xlink:href`.
        hrefBySrc.set(src, src);
        continue;
      }

      const extension = EXTENSION_BY_TYPE[decoded.mediaType] ?? 'png';
      // Nom déterministe, tiré du rang : deux exports du même document donnent
      // deux archives identiques, ce qui rend les tests d'aller-retour possibles.
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
    // Un sommaire ne porte pas d'image : ses lignes n'existent qu'à la
    // pagination et sont toujours du texte pur.
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
 * Base64 écrit à la main.
 *
 * `btoa` n'existe pas partout où tourne la couche 2 — le moteur doit rester
 * exécutable dans un Web Worker et dans un test sans DOM (cf. `MetricTextMeasurer`).
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
