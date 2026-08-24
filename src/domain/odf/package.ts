/**
 * Conteneur ODF : l'archive ZIP d'un fichier `.odt`.
 *
 * Un document OpenDocument est un ZIP contenant `mimetype`, `content.xml`,
 * `styles.xml`, `meta.xml` et `META-INF/manifest.xml`. La compression passe par
 * `CompressionStream('deflate-raw')`, présent dans les navigateurs modernes
 * comme dans Node : aucune bibliothèque tierce, conformément à la règle d'or du
 * CLAUDE.md.
 *
 * Deux contraintes du format, qui ne sont pas des détails :
 *   – `mimetype` doit être la **première** entrée et être stockée **sans
 *     compression**, pour qu'un lecteur reconnaisse le type en lisant les
 *     premiers octets du fichier ;
 *   – les tailles et le CRC figurent dans l'en-tête local, donc chaque entrée
 *     est compressée avant d'être écrite.
 */

import { buildOdfPackage, ODT_MIMETYPE, type OdfPackageFiles } from './export';
import { importOdfContent, readOdfMetaTitle, type ImportResult } from './import';
import type { WriterDocumentState } from '../document/types';

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Garde anti « bombe zip » : un document texte n'atteint jamais cette taille. */
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
 * Fait passer un bloc d'octets dans un flux de (dé)compression.
 *
 * On alimente le flux directement, sans passer par `Blob` ni `Response` : ces
 * deux-là ne sont pas garantis hors navigateur, alors que `CompressionStream`
 * l'est aussi bien dans Node que dans le DOM. Le conteneur ODF doit pouvoir
 * s'écrire des deux côtés — côté client comme dans un test.
 */
async function through(
  bytes: Uint8Array,
  stream: TransformStream<BufferSource, Uint8Array>,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Recopie dans un `ArrayBuffer` propre : une vue peut porter sur un
  // `SharedArrayBuffer`, que les flux refusent. Le coût est celui d'une copie
  // d'un fichier texte, négligeable devant la compression qui suit.
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

/** Écrit une archive `.odt` complète. */
export async function writeOdt(files: OdfPackageFiles): Promise<Uint8Array> {
  const staged: StagedEntry[] = [];

  // `mimetype` d'abord, non compressé : c'est ce qui rend le type détectable
  // sans dézipper.
  staged.push(await stage('mimetype', files.mimetype, METHOD_STORE));
  for (const [name, content] of Object.entries(files)) {
    if (name === 'mimetype') continue;
    staged.push(await stage(name, content, METHOD_DEFLATE));
  }

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of staged) {
    const header = new Uint8Array(30 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, SIGNATURE_LOCAL, true);
    view.setUint16(4, 20, true); // version minimale
    view.setUint16(6, 0, true); // indicateurs
    view.setUint16(8, entry.method, true);
    view.setUint16(10, 0, true); // heure
    view.setUint16(12, 0x21, true); // date : 1980-01-01, pour un binaire reproductible
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

async function stage(name: string, content: string, method: number): Promise<StagedEntry> {
  const raw = encoder.encode(content);
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
 * Lit les entrées textuelles d'une archive `.odt`.
 *
 * La lecture part du **répertoire central**, en fin de fichier, et non des
 * en-têtes locaux : c'est ce que prescrit le format, et le seul moyen fiable
 * quand un producteur a écrit ses tailles dans un descripteur différé.
 */
export async function readOdtEntries(data: Uint8Array): Promise<Map<string, string>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const endOffset = findEndOfCentralDirectory(view, data.length);
  if (endOffset < 0) throw new Error("Archive illisible : fin de répertoire central introuvable.");

  const count = view.getUint16(endOffset + 10, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, string>();

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
    // Seuls les fichiers XML nous intéressent ; les images embarquées ne sont
    // pas encore transcrites (cf. README).
    if (!name.endsWith('.xml') && name !== 'mimetype') continue;

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = data.subarray(start, start + compressedSize);

    const raw = method === METHOD_DEFLATE ? await inflate(payload) : payload;
    entries.set(name, decoder.decode(raw));
  }

  return entries;
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // Le commentaire d'archive peut suivre la fin du répertoire : on remonte
  // depuis la queue jusqu'à retrouver la signature.
  const lowest = Math.max(0, length - 0xffff - 22);
  for (let offset = length - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === SIGNATURE_END) return offset;
  }
  return -1;
}

/** Sérialise un document complet en archive `.odt`. */
export async function exportOdt(doc: WriterDocumentState): Promise<Uint8Array> {
  return writeOdt(buildOdfPackage(doc));
}

/** Vérifie l'entrée `mimetype` d'une archive ouverte. */
export function isTextDocument(entries: ReadonlyMap<string, string>): boolean {
  const mimetype = entries.get('mimetype');
  return mimetype === undefined || mimetype.trim() === ODT_MIMETYPE;
}

/**
 * Ouvre une archive `.odt` complète : conteneur, puis contenu et styles.
 *
 * `styles.xml` est passé à l'import parce qu'il porte les styles nommés et la
 * géométrie de page ; sans lui, un document produit par Writer perdrait ses
 * marges et son format de feuille.
 */
export async function openOdt(
  data: Uint8Array,
  options: { title?: string } = {},
): Promise<ImportResult> {
  const entries = await readOdtEntries(data);

  if (!isTextDocument(entries)) {
    throw new Error("Cette archive n'est pas un document texte OpenDocument.");
  }

  const content = entries.get('content.xml');
  if (!content) throw new Error('Archive incomplète : `content.xml` absent.');

  const stylesXml = entries.get('styles.xml');
  const metaXml = entries.get('meta.xml');
  const title = options.title ?? (metaXml ? readOdfMetaTitle(metaXml) : null);

  return importOdfContent(content, {
    ...(title !== null && title !== undefined ? { title } : {}),
    ...(stylesXml !== undefined ? { stylesXml } : {}),
  });
}
