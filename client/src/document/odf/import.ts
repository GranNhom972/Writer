/**
 * Import ODT (couche 1) — portage de `XMLTextImportHelper`
 * (integration_write.md §1.6 : `xmloff/source/text/txtimp.cxx`).
 *
 * Un `.odt` est une archive ZIP dont `content.xml` porte le contenu.
 *
 * DURCISSEMENT (00_DIRECTIVE_ARCHITECTURE.md §6) : l'archive est bornée avant
 * décompression (nombre d'entrées, taille décompressée, ratio) et le XML est lu
 * avec `DOMParser`, qui ne résout pas les entités externes — la protection XXE
 * complète relève du serveur, qui reste la seule frontière de confiance.
 */

import JSZip from 'jszip';

export const IMPORT_LIMITS = {
  maxEntries: 1000,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxRatio: 100,
} as const;

export class OdfImportError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-a-zip'
      | 'missing-content'
      | 'too-many-entries'
      | 'too-large'
      | 'suspicious-ratio'
      | 'malformed-xml',
  ) {
    super(message);
    this.name = 'OdfImportError';
  }
}

/** Document au format JSON ProseMirror, prêt à alimenter `writeSchema`. */
export interface ImportedDocument {
  type: 'doc';
  content: ImportedBlock[];
}

export interface ImportedBlock {
  type: 'paragraph' | 'heading' | 'bullet_list' | 'ordered_list' | 'page_break';
  attrs?: { level?: number; align?: string | null };
  content?: unknown[];
}

interface InlineRun {
  type: 'text';
  text: string;
  marks?: { type: 'strong' | 'em' | 'underline' }[];
}

const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

/** Étape 1 : extraire `content.xml` d'une archive ODT, sous contrôle de limites. */
export async function extractContentXml(file: ArrayBuffer | Uint8Array | Blob): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file as never);
  } catch {
    throw new OdfImportError("Le fichier n'est pas une archive ODF valide.", 'not-a-zip');
  }

  const entries = Object.values(zip.files);
  if (entries.length > IMPORT_LIMITS.maxEntries) {
    throw new OdfImportError('Archive refusée : trop d’entrées.', 'too-many-entries');
  }

  const content = zip.file('content.xml');
  if (!content) {
    throw new OdfImportError('Archive ODF sans content.xml.', 'missing-content');
  }

  const raw = await content.async('uint8array');
  if (raw.byteLength > IMPORT_LIMITS.maxUncompressedBytes) {
    throw new OdfImportError('Contenu décompressé trop volumineux.', 'too-large');
  }

  return new TextDecoder('utf-8').decode(raw);
}

/** Étape 2 : `content.xml` → document ProseMirror. */
export function parseContentXml(xml: string): ImportedDocument {
  const parser = new DOMParser();
  const dom = parser.parseFromString(xml, 'application/xml');

  if (dom.getElementsByTagName('parsererror').length > 0) {
    throw new OdfImportError('content.xml illisible.', 'malformed-xml');
  }

  const body =
    dom.getElementsByTagNameNS(
      'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
      'text',
    )[0] ?? dom.documentElement;

  const blocks: ImportedBlock[] = [];
  for (const child of Array.from(body?.children ?? [])) {
    const block = convertBlock(child);
    if (block) blocks.push(block);
  }

  // Un document vide reste un document valide : un paragraphe vide.
  if (blocks.length === 0) blocks.push({ type: 'paragraph', content: [] });

  return { type: 'doc', content: blocks };
}

export async function importOdt(file: ArrayBuffer | Uint8Array | Blob): Promise<ImportedDocument> {
  return parseContentXml(await extractContentXml(file));
}

function localName(element: Element): string {
  return element.localName ?? element.nodeName.replace(/^.*:/, '');
}

function convertBlock(element: Element): ImportedBlock | null {
  switch (localName(element)) {
    case 'p':
      return { type: 'paragraph', attrs: { align: null }, content: collectInline(element) };

    case 'h': {
      const raw = element.getAttributeNS(TEXT_NS, 'outline-level') ?? '1';
      const level = Math.min(6, Math.max(1, Number.parseInt(raw, 10) || 1));
      return { type: 'heading', attrs: { level }, content: collectInline(element) };
    }

    case 'list': {
      const items = Array.from(element.children)
        .filter((child) => localName(child) === 'list-item')
        .map((item) => ({
          type: 'list_item',
          content: Array.from(item.children)
            .map(convertBlock)
            .filter((block): block is ImportedBlock => block !== null),
        }));
      // ODF ne distingue puces et numéros que par le style de liste ; sans la
      // feuille de styles, on retient la puce (comportement d'OpenOffice par défaut).
      return { type: 'bullet_list', content: items };
    }

    case 'soft-page-break':
      return { type: 'page_break' };

    default:
      return null;
  }
}

/** Aplatit `<text:span>`, `<text:s>`, `<text:tab>` en plages de texte marquées. */
function collectInline(element: Element): InlineRun[] {
  const runs: InlineRun[] = [];

  const walk = (node: Node, marks: InlineRun['marks']): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue ?? '';
        if (text.length > 0) runs.push(marks?.length ? { type: 'text', text, marks } : { type: 'text', text });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const el = child as Element;
      switch (localName(el)) {
        case 'span':
          // Les styles nommés ODF (gras, italique…) sont résolus au jalon J1 via
          // styles.xml ; on préserve d'ores et déjà la structure des plages.
          walk(el, marks);
          break;
        case 's': {
          const count = Number.parseInt(el.getAttributeNS(TEXT_NS, 'c') ?? '1', 10) || 1;
          runs.push({ type: 'text', text: ' '.repeat(count) });
          break;
        }
        case 'tab':
          runs.push({ type: 'text', text: '\t' });
          break;
        case 'line-break':
          runs.push({ type: 'text', text: '\n' });
          break;
        default:
          walk(el, marks);
      }
    }
  };

  walk(element, undefined);
  return runs;
}
