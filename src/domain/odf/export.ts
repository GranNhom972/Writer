/**
 * Export OpenDocument. Transposition de `XMLTextParagraphExport`
 * (`xmloff/source/text/txtparae.cxx`, appelé depuis `txtexp.cxx`).
 *
 * L'export inverse exactement l'import : le formatage porté par les runs est
 * **factorisé** en styles automatiques, et les caractères qu'XML ne sait pas
 * transporter tels quels — espaces consécutives, tabulations, sauts de ligne —
 * reprennent leur forme d'éléments ODF.
 *
 * Supporte fidèlement l'export des en-têtes et pieds de page OpenOffice (`<style:header>`,
 * `<style:footer>`, `<style:header-left>`, `<style:footer-left>`) et leurs styles.
 */

import { paragraphText } from '../document/document';
import { runFormatting } from '../document/runs';
import { sheetSizeMm } from '../document/pageSetup';
import type { PageFurniture, FurnitureBand } from '../document/pageFurniture';
import {
  isTable,
  type ParagraphNode,
  type TableNode,
  type WriterDocumentState,
} from '../document/types';
import { escapeXml, NS_DECLARATIONS } from './namespaces';
import { AutomaticStyles } from './styles';
import { formatMmAsCm, formatPt } from './units';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
/** Version d'ODF produite — celle que lit Writer 4.1 comme les suites modernes. */
const ODF_VERSION = '1.2';

/**
 * Sérialise le texte d'un run.
 */
function serializeText(text: string, atParagraphStart: boolean): string {
  let out = '';
  let index = 0;
  let atStart = atParagraphStart;

  while (index < text.length) {
    const char = text[index]!;

    if (char === '\t') {
      out += '<text:tab/>';
      index += 1;
      atStart = false;
      continue;
    }
    if (char === '\n') {
      out += '<text:line-break/>';
      index += 1;
      atStart = true;
      continue;
    }
    if (char === ' ') {
      let count = 0;
      while (text[index + count] === ' ') count += 1;

      if (atStart) {
        out += count > 1 ? `<text:s text:c="${count}"/>` : '<text:s/>';
      } else if (count === 1) {
        out += ' ';
      } else {
        out += count - 1 > 1 ? ` <text:s text:c="${count - 1}"/>` : ' <text:s/>';
      }
      index += count;
      atStart = false;
      continue;
    }

    let end = index;
    while (
      end < text.length &&
      text[end] !== ' ' &&
      text[end] !== '\t' &&
      text[end] !== '\n'
    ) {
      end += 1;
    }
    out += escapeXml(text.slice(index, end));
    index = end;
    atStart = false;
  }

  return out;
}

function serializeTokensToOdf(str: string): string {
  if (!str) return '';
  const parts = str.split(/(\{page\}|\{pages\}|\{titre\}|\{auteur\}|\{author\}|\{date\}|\{heure\}|\{time\})/g);
  let out = '';
  for (const part of parts) {
    if (part === '{page}') {
      out += '<text:page-number>1</text:page-number>';
    } else if (part === '{pages}') {
      out += '<text:page-count>1</text:page-count>';
    } else if (part === '{titre}') {
      out += '<text:title>Titre</text:title>';
    } else if (part === '{auteur}' || part === '{author}') {
      out += '<text:author-name>Auteur</text:author-name>';
    } else if (part === '{date}') {
      out += '<text:date>Date</text:date>';
    } else if (part === '{heure}' || part === '{time}') {
      out += '<text:time>Heure</text:time>';
    } else if (part) {
      out += serializeText(part, false);
    }
  }
  return out;
}

function serializeBandToOdf(furniture: PageFurniture, band: FurnitureBand, isEven = false): string {
  const isHeader = band === 'header';
  const left = isEven && furniture.differentEvenOdd
    ? (isHeader ? furniture.headerEvenLeft : furniture.footerEvenLeft) ?? ''
    : (isHeader ? furniture.headerLeft : furniture.footerLeft) ?? '';
  const center = isEven && furniture.differentEvenOdd
    ? (isHeader ? furniture.headerEvenCenter : furniture.footerEvenCenter) ?? ''
    : (isHeader ? furniture.headerCenter : furniture.footerCenter) ?? '';
  const right = isEven && furniture.differentEvenOdd
    ? (isHeader ? furniture.headerEvenRight : furniture.footerEvenRight) ?? ''
    : (isHeader ? furniture.headerRight : furniture.footerRight) ?? '';
  const fallback = isEven && furniture.differentEvenOdd
    ? (isHeader ? furniture.headerEven : furniture.footerEven) ?? ''
    : (isHeader ? furniture.header : furniture.footer) ?? '';

  let content = '';
  if (left || center || right) {
    content += serializeTokensToOdf(left);
    if (center || right) {
      content += '<text:tab/>' + serializeTokensToOdf(center);
    }
    if (right) {
      content += '<text:tab/>' + serializeTokensToOdf(right);
    }
  } else if (fallback) {
    content = serializeTokensToOdf(fallback);
  } else if (!isHeader && furniture.pageNumber) {
    content = '<text:page-number>1</text:page-number>';
  }

  if (!content) return '';
  return `<text:p style:name="${isHeader ? 'Header' : 'Footer'}">${content}</text:p>`;
}

function serializeParagraph(node: ParagraphNode, styles: AutomaticStyles): string {
  const tag = node.type === 'heading' ? 'text:h' : 'text:p';
  const levelAttr = node.headingLevel ? ` text:outline-level="${node.headingLevel}"` : '';
  const styleName = styles.paragraph(node);
  const styleAttr = styleName ? ` text:style-name="${styleName}"` : '';

  if (node.runs.length === 0 || paragraphText(node).length === 0) {
    return `<${tag}${styleAttr}${levelAttr}/>`;
  }

  let body = '';
  let atStart = true;

  for (const run of node.runs) {
    if (run.text.length === 0) continue;
    const formatting = runFormatting(run);
    const content = serializeText(run.text, atStart);
    atStart = false;

    if (Object.keys(formatting).length === 0) {
      body += content;
      continue;
    }

    const spanStyle = styles.text(formatting);
    body += `<text:span text:style-name="${spanStyle}">${content}</text:span>`;
  }

  return `<${tag}${styleAttr}${levelAttr}>${body}</${tag}>`;
}

function serializeTable(table: TableNode, styles: AutomaticStyles): string {
  const tableStyle = styles.table(table);

  const rowsXml = table.rows.map((row) => {
    const cellsXml = row.cells.map((cell) => {
      const cellStyle = styles.cell(cell);
      const colSpanAttr = (cell.colSpan ?? 1) > 1 ? ` table:number-columns-spanned="${cell.colSpan}"` : '';
      const rowSpanAttr = (cell.rowSpan ?? 1) > 1 ? ` table:number-rows-spanned="${cell.rowSpan}"` : '';

      const contentXml = cell.blocks
        .map((p) => serializeParagraph(p, styles))
        .join('');

      return (
        `<table:table-cell table:style-name="${cellStyle}"${colSpanAttr}${rowSpanAttr}>` +
        contentXml +
        `</table:table-cell>`
      );
    });

    return `<table:table-row>${cellsXml.join('')}</table:table-row>`;
  });

  const headerCount = table.rows.filter((row) => row.isHeader).length;
  const rowsSection =
    headerCount > 0
      ? `<table:table-header-rows>${rowsXml.slice(0, headerCount).join('')}</table:table-header-rows>` +
        rowsXml.slice(headerCount).join('')
      : rowsXml.join('');

  return (
    `<table:table table:name="${table.id}" table:style-name="${tableStyle}">` +
    rowsSection +
    `</table:table>`
  );
}

/** Produit le `content.xml` complet. */
export function buildContentXml(doc: WriterDocumentState): string {
  const styles = new AutomaticStyles();
  const body = doc.blocks
    .map((block) => (isTable(block) ? serializeTable(block, styles) : serializeParagraph(block, styles)))
    .join('');

  return (
    `${XML_HEADER}` +
    `<office:document-content ${NS_DECLARATIONS} office:version="${ODF_VERSION}">` +
    `<office:scripts/>` +
    `<office:automatic-styles>${styles.toXml()}</office:automatic-styles>` +
    `<office:body><office:text>${body}</office:text></office:body>` +
    `</office:document-content>`
  );
}

/** Produit le `styles.xml` : styles nommés, géométrie de la page et en-têtes/pieds. */
export function buildStylesXml(doc: WriterDocumentState): string {
  const { widthMm, heightMm } = sheetSizeMm(doc.pageSetup);
  const setup = doc.pageSetup;
  const defaults = doc.defaults;
  const furniture = doc.furniture;

  let headerStyleXml = '';
  let footerStyleXml = '';
  let masterHeaderXml = '';
  let masterFooterXml = '';

  if (furniture) {
    const hasHeader = !!(furniture.header || furniture.headerLeft || furniture.headerCenter || furniture.headerRight || furniture.blocks.some(b => b.band === 'header'));
    const hasFooter = !!(furniture.footer || furniture.footerLeft || furniture.footerCenter || furniture.footerRight || furniture.pageNumber || furniture.blocks.some(b => b.band === 'footer'));

    if (hasHeader) {
      const sep = furniture.headerSeparator ? ` fo:border-bottom="${furniture.headerSeparatorWidthPt ?? 0.75}pt solid ${furniture.headerSeparatorColor ?? '#d0d5dd'}"` : '';
      const bg = furniture.headerBackground ? ` fo:background-color="${furniture.headerBackground}"` : '';
      headerStyleXml = `<style:header-style><style:header-footer-properties fo:min-height="${formatMmAsCm(furniture.headerMm)}" fo:margin-bottom="0.5cm"${sep}${bg}/></style:header-style>`;

      const oddHeader = serializeBandToOdf(furniture, 'header', false);
      if (oddHeader) {
        masterHeaderXml += `<style:header>${oddHeader}</style:header>`;
      }
      if (furniture.differentEvenOdd) {
        const evenHeader = serializeBandToOdf(furniture, 'header', true);
        if (evenHeader) {
          masterHeaderXml += `<style:header-left>${evenHeader}</style:header-left>`;
        }
      }
    }

    if (hasFooter) {
      const sep = furniture.footerSeparator ? ` fo:border-top="${furniture.footerSeparatorWidthPt ?? 0.75}pt solid ${furniture.footerSeparatorColor ?? '#d0d5dd'}"` : '';
      const bg = furniture.footerBackground ? ` fo:background-color="${furniture.footerBackground}"` : '';
      footerStyleXml = `<style:footer-style><style:header-footer-properties fo:min-height="${formatMmAsCm(furniture.footerMm)}" fo:margin-top="0.5cm"${sep}${bg}/></style:footer-style>`;

      const oddFooter = serializeBandToOdf(furniture, 'footer', false);
      if (oddFooter) {
        masterFooterXml += `<style:footer>${oddFooter}</style:footer>`;
      }
      if (furniture.differentEvenOdd) {
        const evenFooter = serializeBandToOdf(furniture, 'footer', true);
        if (evenFooter) {
          masterFooterXml += `<style:footer-left>${evenFooter}</style:footer-left>`;
        }
      }
    }
  }

  const pageLayout =
    `<style:page-layout style:name="Mpm1">` +
    `<style:page-layout-properties ` +
    `fo:page-width="${formatMmAsCm(widthMm)}" fo:page-height="${formatMmAsCm(heightMm)}" ` +
    `style:print-orientation="${setup.orientation}" ` +
    `fo:margin-top="${formatMmAsCm(setup.marginTopMm)}" ` +
    `fo:margin-bottom="${formatMmAsCm(setup.marginBottomMm)}" ` +
    `fo:margin-left="${formatMmAsCm(setup.marginLeftMm)}" ` +
    `fo:margin-right="${formatMmAsCm(setup.marginRightMm)}">` +
    headerStyleXml +
    footerStyleXml +
    `</style:page-layout-properties>` +
    `</style:page-layout>`;

  const standard =
    `<style:style style:name="Standard" style:family="paragraph">` +
    `<style:text-properties style:font-name="${escapeXml(defaults.fontFamily)}" ` +
    `fo:font-size="${formatPt(defaults.fontSizePt)}" fo:color="${defaults.color}"/>` +
    `<style:paragraph-properties fo:line-height="${Math.round(defaults.lineSpacing * 100)}%"/>` +
    `</style:style>` +
    `<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard">` +
    `<style:text-properties fo:font-weight="bold"/>` +
    `</style:style>` +
    `<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard">` +
    `<style:text-properties fo:font-size="9pt" fo:color="#475467"/>` +
    `</style:style>` +
    `<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard">` +
    `<style:text-properties fo:font-size="9pt" fo:color="#475467"/>` +
    `</style:style>`;

  return (
    `${XML_HEADER}` +
    `<office:document-styles ${NS_DECLARATIONS} office:version="${ODF_VERSION}">` +
    `<office:styles>${standard}</office:styles>` +
    `<office:automatic-styles>${pageLayout}</office:automatic-styles>` +
    `<office:master-styles>` +
    `<style:master-page style:name="Standard" style:page-layout-name="Mpm1">` +
    masterHeaderXml +
    masterFooterXml +
    `</style:master-page>` +
    `</office:master-styles>` +
    `</office:document-styles>`
  );
}

export function buildMetaXml(doc: WriterDocumentState): string {
  return (
    `${XML_HEADER}` +
    `<office:document-meta ${NS_DECLARATIONS} office:version="${ODF_VERSION}">` +
    `<office:meta>` +
    `<meta:generator>Cloudantille Writer</meta:generator>` +
    `<dc:title>${escapeXml(doc.meta.title)}</dc:title>` +
    `<meta:creation-date>${escapeXml(doc.meta.createdAt)}</meta:creation-date>` +
    `<dc:date>${escapeXml(doc.meta.updatedAt)}</dc:date>` +
    (doc.meta.author ? `<dc:creator>${escapeXml(doc.meta.author)}</dc:creator>` : '') +
    `</office:meta>` +
    `</office:document-meta>`
  );
}

export function buildManifestXml(): string {
  const entry = (path: string, type = 'text/xml'): string =>
    `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>`;

  return (
    `${XML_HEADER}` +
    `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ` +
    `manifest:version="${ODF_VERSION}">` +
    entry('/', 'application/vnd.oasis.opendocument.text') +
    entry('content.xml') +
    entry('styles.xml') +
    entry('meta.xml') +
    `</manifest:manifest>`
  );
}

/** Les cinq fichiers d'une archive `.odt`. */
export interface OdfPackageFiles {
  mimetype: string;
  'META-INF/manifest.xml': string;
  'content.xml': string;
  'styles.xml': string;
  'meta.xml': string;
}

export const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';

/** Produit l'arborescence complète des fichiers d'une archive `.odt`. */
export function buildOdfPackage(doc: WriterDocumentState): OdfPackageFiles {
  return {
    mimetype: ODT_MIMETYPE,
    'META-INF/manifest.xml': buildManifestXml(),
    'content.xml': buildContentXml(doc),
    'styles.xml': buildStylesXml(doc),
    'meta.xml': buildMetaXml(doc),
  };
}

/**
 * Texte brut du document, tableaux compris.
 *
 * Sert aux tests d'aller-retour et à l'aperçu : deux documents dont le texte
 * brut diffère n'ont pas survécu au passage par le format.
 */
export function documentPlainText(doc: WriterDocumentState): string {
  const lignes: string[] = [];
  for (const block of doc.blocks) {
    if (!isTable(block)) {
      lignes.push(paragraphText(block));
      continue;
    }
    for (const row of block.rows) {
      lignes.push(row.cells.map((cell) => cell.blocks.map(paragraphText).join(' ')).join('\t'));
    }
  }
  return lignes.join('\n');
}
