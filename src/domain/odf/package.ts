// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * ODF container: the ZIP archive of an `.odt` file.
 *
 * An OpenDocument document is a ZIP containing `mimetype`, `content.xml`, `styles.xml`, `meta.xml` and
 * `META-INF/manifest.xml`. Compression goes through `CompressionStream('deflate-raw')`, available in
 * modern browsers as well as in Node: zero external binary dependency.
 *
 * Two constraints of the format, which are not details:
 *   - `mimetype` must be the **first** entry and be stored **uncompressed**, so that a reader recognizes
 *     the type by reading the first bytes of the file;
 *   - the sizes and the CRC are in the local header, so every entry is compressed before being written.
 */

import { buildOdfPackage, ODT_MIMETYPE, type OdfPackage } from './export';
import { isPicturePath, mediaTypeForPath, toDataUrl } from './pictures';
import { importOdfContent, readOdfMetaTitle, type ImportResult } from './import';
import type { WriterDocumentState } from '../document/types';

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Zip-bomb guard: a text document never reaches this size. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Runs a block of bytes through a (de)compression stream.
 *
 * We feed the stream directly, without going through `Blob` or `Response`: those two are not guaranteed
 * outside a browser, whereas `CompressionStream` is as much in Node as in the DOM. The ODF container must be
 * writable on both sides, in the client as well as in a test.
 */
async function through(
  bytes: Uint8Array,
  stream: TransformStream<BufferSource, Uint8Array>,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Copy into a clean `ArrayBuffer`: a view can be backed by a `SharedArrayBuffer`, which streams refuse. The
  // cost is that of copying a text file, negligible next to the compression that follows.
  const written = writer.write(new Uint8Array(bytes)).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await written;
  return concat(chunks);
}

function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new CompressionStream('deflate-raw'));
}

function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new DecompressionStream('deflate-raw'));
}

interface StagedEntry {
  name: Uint8Array;
  data: Uint8Array;
  method: number;
  crc: number;
  uncompressedSize: number;
}

/** Writes a complete `.odt` archive, images included. */
export async function writeOdt(pack: OdfPackage): Promise<Uint8Array> {
  const staged: StagedEntry[] = [];
  const { files, pictures } = pack;

  // `mimetype` first, uncompressed: this is what makes the type detectable without unzipping.
  staged.push(await stage('mimetype', encoder.encode(files.mimetype), METHOD_STORE));
  for (const [name, content] of Object.entries(files)) {
    if (name === 'mimetype') continue;
    staged.push(await stage(name, encoder.encode(content), METHOD_DEFLATE));
  }

  // PNG, JPEG, GIF and WebP are **already** compressed: running them through deflate again would add the stream
  // header for nothing. We store them as they are.
  for (const picture of pictures) {
    staged.push(await stage(picture.path, picture.bytes, METHOD_STORE));
  }

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of staged) {
    const header = new Uint8Array(30 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, SIGNATURE_LOCAL, true);
    view.setUint16(4, 20, true); // minimum version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, entry.method, true);
    view.setUint16(10, 0, true); // time
    view.setUint16(12, 0x21, true); // date: 1980-01-01, for a reproducible binary
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.uncompressedSize, true);
    view.setUint16(26, entry.name.length, true);
    view.setUint16(28, 0, true);
    header.set(entry.name, 30);

    const central = new Uint8Array(46 + entry.name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIGNATURE_CENTRAL, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, entry.method, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x21, true);
    centralView.setUint32(16, entry.crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.uncompressedSize, true);
    centralView.setUint16(28, entry.name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(entry.name, 46);

    locals.push(header, entry.data);
    centrals.push(central);
    offset += header.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, SIGNATURE_END, true);
  endView.setUint16(8, staged.length, true);
  endView.setUint16(10, staged.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, end]);
}

async function stage(name: string, raw: Uint8Array, method: number): Promise<StagedEntry> {
  const data = method === METHOD_DEFLATE ? await deflate(raw) : raw;
  return {
    name: encoder.encode(name),
    data,
    method,
    crc: crc32(raw),
    uncompressedSize: raw.length,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Reads the text entries of an `.odt` archive.
 *
 * Reading starts from the **central directory**, at the end of the file, and not from the local headers: this
 * is what the format prescribes, and the only reliable way when a producer wrote its sizes in a deferred
 * descriptor.
 */
export async function readOdtEntries(data: Uint8Array): Promise<Map<string, string>> {
  return (await readOdtArchive(data)).texts;
}

/** What an archive holds: its XML files, and its images as `data:` URLs. */
export interface OdtArchive {
  texts: Map<string, string>;
  /** `Pictures/…` path → complete `data:` URL, ready to put in a run. */
  pictures: Map<string, string>;
}

/**
 * Reads an `.odt` archive: text entries **and** images.
 *
 * Images are returned as `data:` URLs rather than raw bytes because that is the form the model carries
 * offline: the reopened document is complete, without depending on a store or a network.
 */
export async function readOdtArchive(data: Uint8Array): Promise<OdtArchive> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const endOffset = findEndOfCentralDirectory(view, data.length);
  if (endOffset < 0) throw new Error("Archive illisible : fin de répertoire central introuvable.");

  const count = view.getUint16(endOffset + 10, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const texts = new Map<string, string>();
  const pictures = new Map<string, string>();

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > data.length) break;
    if (view.getUint32(cursor, true) !== SIGNATURE_CENTRAL) break;

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const name = decoder.decode(data.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`Entrée « ${name} » trop volumineuse : archive refusée.`);
    }
    const estImage = isPicturePath(name);
    if (!estImage && !name.endsWith('.xml') && name !== 'mimetype') continue;

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = data.subarray(start, start + compressedSize);

    const raw = method === METHOD_DEFLATE ? await inflate(payload) : payload;
    // An image is not text: decoding it as UTF-8 would silently destroy it, the invalid bytes turning into U+FFFD.
    if (estImage) pictures.set(name, toDataUrl(mediaTypeForPath(name), raw));
    else texts.set(name, decoder.decode(raw));
  }

  return { texts, pictures };
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // The archive comment can follow the end of the directory: we go back from the tail until we find the
  // signature.
  const lowest = Math.max(0, length - 0xffff - 22);
  for (let offset = length - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === SIGNATURE_END) return offset;
  }
  return -1;
}

/** Serializes a whole document into an `.odt` archive. */
export async function exportOdt(doc: WriterDocumentState): Promise<Uint8Array> {
  return writeOdt(buildOdfPackage(doc));
}

/** Checks the `mimetype` entry of an opened archive. */
export function isTextDocument(entries: ReadonlyMap<string, string>): boolean {
  const mimetype = entries.get('mimetype');
  return mimetype === undefined || mimetype.trim() === ODT_MIMETYPE;
}

/**
 * Opens a complete `.odt` archive: the container, then content and styles.
 *
 * `styles.xml` is passed to the import because it carries the named styles and the page geometry; without
 * it, a document produced by Writer would lose its margins and its sheet format.
 */
export async function openOdt(
  data: Uint8Array,
  options: { title?: string } = {},
): Promise<ImportResult> {
  const { texts, pictures } = await readOdtArchive(data);

  if (!isTextDocument(texts)) {
    throw new Error("Cette archive n'est pas un document texte OpenDocument.");
  }

  const content = texts.get('content.xml');
  if (!content) throw new Error('Archive incomplète : `content.xml` absent.');

  const stylesXml = texts.get('styles.xml');
  const metaXml = texts.get('meta.xml');
  const title = options.title ?? (metaXml ? readOdfMetaTitle(metaXml) : null);

  return importOdfContent(content, {
    ...(title !== null && title !== undefined ? { title } : {}),
    ...(stylesXml !== undefined ? { stylesXml } : {}),
    pictures,
  });
}
