/**
 * Import OpenDocument. Transposition de `XMLTextImportHelper`
 * (`xmloff/source/text/txtimp.cxx`).
 *
 * Le parcours suit celui du C++ : un contexte par élément, l'état de style
 * hérité du parent, et le texte accumulé au fil des nœuds. Les éléments de
 * substitution d'ODF (`<text:s>`, `<text:tab/>`, `<text:line-break/>`) sont
 * réinjectés dans la chaîne brute — le format XML ne peut pas porter des
 * espaces consécutives, elles y sont comptées dans un attribut.
 *
 * Supporte fidèlement l'import des en-têtes et pieds de page OpenOffice (`<style:header>`,
 * `<style:footer>`, `<style:header-left>`, `<style:footer-left>`) et leurs styles.
 */

import {
  createParagraph,
  DEFAULT_DEFAULTS,
  newId,
} from '../document/document';
import { A4_PORTRAIT } from '../document/pageSetup';
import { makeRun, normalizeRuns } from '../document/runs';
import {
  DEFAULT_FURNITURE,
  type PageFurniture,
  type SeparatorLineStyle,
} from '../document/pageFurniture';
import type {
  DocumentBlock,
  HeadingLevel,
  PageSetup,
  ParagraphNode,
  RunFormatting,
  TableCellNode,
  TableNode,
  TableRowNode,
  TextRun,
  WriterDocumentState,
} from '../document/types';
import { attr, localName, NS } from './namespaces';
import { collectStyles, resolveStyle, type StyleTable } from './styles';
import { parseLengthMm } from './units';

export interface ImportResult {
  document: WriterDocumentState;
  /** Ce qui n'a pas pu être transcrit — annoncé, jamais perdu en silence. */
  warnings: string[];
}

export interface ImportOptions {
  title?: string;
  /** `styles.xml`, s'il est disponible : il porte les styles nommés et la page. */
  stylesXml?: string;
}

/** Analyse une chaîne XML avec un `DOMParser` standard. */
function parseXml(xml: string, warnings: string[]): Document | null {
  if (typeof DOMParser === 'undefined') {
    throw new Error("DOMParser indisponible : l'import ODF requiert un environnement DOM.");
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // `DOMParser` ne lève pas : il produit un document contenant `parsererror`.
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure) {
    warnings.push(`XML illisible : ${failure.textContent?.trim().slice(0, 200) ?? 'erreur inconnue'}`);
    return null;
  }
  return doc;
}

/**
 * Importe le `content.xml` d'un document ODF.
 */
export function importOdfContent(
  contentXml: string,
  options: ImportOptions = {},
): ImportResult {
  const warnings: string[] = [];
  const content = parseXml(contentXml, warnings);

  const document: WriterDocumentState = {
    id: newId('doc'),
    meta: {
      title: options.title ?? 'Document importé',
      author: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    pageSetup: { ...A4_PORTRAIT },
    defaults: { ...DEFAULT_DEFAULTS },
    blocks: [],
  };

  if (!content) {
    document.blocks = [createParagraph('')];
    return { document, warnings };
  }

  const styles: StyleTable = collectStyles(content);

  if (options.stylesXml) {
    const stylesDoc = parseXml(options.stylesXml, warnings);
    if (stylesDoc) {
      for (const [name, style] of collectStyles(stylesDoc)) {
        if (!styles.has(name)) styles.set(name, style);
      }
      const pageSetup = readPageSetup(stylesDoc);
      if (pageSetup) document.pageSetup = pageSetup;

      const furniture = readPageFurniture(stylesDoc, pageSetup ?? document.pageSetup);
      if (furniture) document.furniture = furniture;
    }
  }

  const body = findFirst(content, 'text');
  if (!body) {
    warnings.push("Aucun élément <office:text> : le fichier n'est pas un document texte.");
    document.blocks = [createParagraph('')];
    return { document, warnings };
  }

  document.blocks = readBlocks(body, styles, warnings);
  if (document.blocks.length === 0) document.blocks = [createParagraph('')];

  const title = readMetaTitle(content);
  if (title) document.meta.title = title;

  return { document, warnings };
}

function findFirst(root: Document | Element, name: string): Element | null {
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i += 1) {
    if (localName(all[i]!) === name) return all[i]!;
  }
  return null;
}

function readMetaTitle(content: Document): string | null {
  const all = content.getElementsByTagName('*');
  for (let i = 0; i < all.length; i += 1) {
    const element = all[i]!;
    if (localName(element) === 'title' && element.namespaceURI === NS.dc) {
      const text = element.textContent?.trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * Lit le titre dans `meta.xml`.
 */
export function readOdfMetaTitle(metaXml: string): string | null {
  const warnings: string[] = [];
  const meta = parseXml(metaXml, warnings);
  return meta ? readMetaTitle(meta) : null;
}

/** Géométrie de page depuis `<style:page-layout-properties>` de `styles.xml`. */
function readPageSetup(stylesDoc: Document): PageSetup | null {
  const properties = findFirst(stylesDoc, 'page-layout-properties');
  if (!properties) return null;

  const widthMm = parseLengthMm(attr(properties, NS.fo, 'page-width'));
  const heightMm = parseLengthMm(attr(properties, NS.fo, 'page-height'));
  if (widthMm === null || heightMm === null) return null;

  const landscape = attr(properties, NS.style, 'print-orientation') === 'landscape';

  return {
    format: Math.abs(widthMm - 210) < 2 && Math.abs(heightMm - 297) < 2 ? 'A4' : 'Letter',
    widthMm: landscape ? heightMm : widthMm,
    heightMm: landscape ? widthMm : heightMm,
    orientation: landscape ? 'landscape' : 'portrait',
    marginTopMm: parseLengthMm(attr(properties, NS.fo, 'margin-top')) ?? 20,
    marginBottomMm: parseLengthMm(attr(properties, NS.fo, 'margin-bottom')) ?? 20,
    marginLeftMm: parseLengthMm(attr(properties, NS.fo, 'margin-left')) ?? 25,
    marginRightMm: parseLengthMm(attr(properties, NS.fo, 'margin-right')) ?? 25,
    headerHeightMm: 0,
    footerHeightMm: 0,
  };
}

function extractOdfTextTokens(node: Node): string {
  let res = '';
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]!;
    if (child.nodeType === 3) {
      // TEXT_NODE
      res += child.textContent ?? '';
    } else if (child.nodeType === 1) {
      // ELEMENT_NODE
      const el = child as Element;
      const tag = localName(el);
      if (tag === 'page-number') {
        res += '{page}';
      } else if (tag === 'page-count') {
        res += '{pages}';
      } else if (tag === 'title') {
        res += '{titre}';
      } else if (tag === 'author-name' || tag === 'initial-creator') {
        res += '{auteur}';
      } else if (tag === 'date') {
        res += '{date}';
      } else if (tag === 'time') {
        res += '{heure}';
      } else if (tag === 'tab') {
        res += '\t';
      } else if (tag === 's') {
        const count = Number(attr(el, NS.text, 'c') ?? '1');
        res += ' '.repeat(Number.isFinite(count) && count > 0 ? count : 1);
      } else if (tag === 'line-break') {
        res += '\n';
      } else {
        res += extractOdfTextTokens(child);
      }
    }
  }
  return res;
}

function parseBandFromOdf(container: Element | null): { text: string; left?: string; center?: string; right?: string } {
  if (!container) return { text: '' };
  const p = findFirst(container, 'p');
  if (!p) return { text: '' };
  const raw = extractOdfTextTokens(p).trim();
  if (raw.includes('\t')) {
    const parts = raw.split('\t');
    if (parts.length === 2) {
      return { text: raw, left: parts[0]?.trim() ?? '', right: parts[1]?.trim() ?? '' };
    }
    if (parts.length >= 3) {
      return { text: raw, left: parts[0]?.trim() ?? '', center: parts[1]?.trim() ?? '', right: parts[2]?.trim() ?? '' };
    }
  }
  return { text: raw };
}

function readPageFurniture(stylesDoc: Document, setup: PageSetup): PageFurniture | null {
  const masterPage = findFirst(stylesDoc, 'master-page');
  if (!masterPage) return null;

  const headerEl = findFirst(masterPage, 'header');
  const headerLeftEl = findFirst(masterPage, 'header-left');
  const footerEl = findFirst(masterPage, 'footer');
  const footerLeftEl = findFirst(masterPage, 'footer-left');

  if (!headerEl && !headerLeftEl && !footerEl && !footerLeftEl) {
    return null;
  }

  const headerData = parseBandFromOdf(headerEl);
  const headerLeftData = parseBandFromOdf(headerLeftEl);
  const footerData = parseBandFromOdf(footerEl);
  const footerLeftData = parseBandFromOdf(footerLeftEl);

  const headerStyleEl = findFirst(stylesDoc, 'header-style');
  const headerPropsEl = headerStyleEl ? findFirst(headerStyleEl, 'header-footer-properties') : null;

  const footerStyleEl = findFirst(stylesDoc, 'footer-style');
  const footerPropsEl = footerStyleEl ? findFirst(footerStyleEl, 'header-footer-properties') : null;

  let headerMm = DEFAULT_FURNITURE.headerMm;
  let headerSeparator = false;
  let headerSeparatorWidthPt = 0.75;
  let headerSeparatorColor = '#d0d5dd';
  let headerSeparatorStyle: SeparatorLineStyle = 'solid';
  let headerBackground = '';

  if (headerPropsEl) {
    const minH = parseLengthMm(attr(headerPropsEl, NS.fo, 'min-height'));
    if (minH !== null && minH > 0) headerMm = minH;

    const borderBottom = attr(headerPropsEl, NS.fo, 'border-bottom');
    if (borderBottom && borderBottom !== 'none') {
      headerSeparator = true;
      if (borderBottom.includes('dashed')) headerSeparatorStyle = 'dashed';
      else if (borderBottom.includes('dotted')) headerSeparatorStyle = 'dotted';
    }

    const bg = attr(headerPropsEl, NS.fo, 'background-color');
    if (bg && bg !== 'transparent') headerBackground = bg;
  }

  let footerMm = DEFAULT_FURNITURE.footerMm;
  let footerSeparator = false;
  let footerSeparatorWidthPt = 0.75;
  let footerSeparatorColor = '#d0d5dd';
  let footerSeparatorStyle: SeparatorLineStyle = 'solid';
  let footerBackground = '';

  if (footerPropsEl) {
    const minH = parseLengthMm(attr(footerPropsEl, NS.fo, 'min-height'));
    if (minH !== null && minH > 0) footerMm = minH;

    const borderTop = attr(footerPropsEl, NS.fo, 'border-top');
    if (borderTop && borderTop !== 'none') {
      footerSeparator = true;
      if (borderTop.includes('dashed')) footerSeparatorStyle = 'dashed';
      else if (borderTop.includes('dotted')) footerSeparatorStyle = 'dotted';
    }

    const bg = attr(footerPropsEl, NS.fo, 'background-color');
    if (bg && bg !== 'transparent') footerBackground = bg;
  }

  const differentEvenOdd = !!(headerLeftEl || footerLeftEl);
  const hasPageNum = footerData.text.includes('{page}') || (footerData.right?.includes('{page}') ?? false);

  return {
    ...DEFAULT_FURNITURE,
    header: headerData.text,
    headerLeft: headerData.left ?? '',
    headerCenter: headerData.center ?? '',
    headerRight: headerData.right ?? '',
    footer: footerData.text,
    footerLeft: footerData.left ?? '',
    footerCenter: footerData.center ?? '',
    footerRight: footerData.right ?? '',
    differentEvenOdd,
    headerEven: headerLeftData.text,
    headerEvenLeft: headerLeftData.left ?? '',
    headerEvenCenter: headerLeftData.center ?? '',
    headerEvenRight: headerLeftData.right ?? '',
    footerEven: footerLeftData.text,
    footerEvenLeft: footerLeftData.left ?? '',
    footerEvenCenter: footerLeftData.center ?? '',
    footerEvenRight: footerLeftData.right ?? '',
    pageNumber: hasPageNum,
    headerMm,
    footerMm,
    headerSeparator,
    headerSeparatorWidthPt,
    headerSeparatorColor,
    headerSeparatorStyle,
    footerSeparator,
    footerSeparatorWidthPt,
    footerSeparatorColor,
    footerSeparatorStyle,
    headerBackground,
    footerBackground,
    marginTopMm: setup.marginTopMm,
    marginBottomMm: setup.marginBottomMm,
    marginLeftMm: setup.marginLeftMm,
    marginRightMm: setup.marginRightMm,
  };
}

/** Parcourt les enfants d'un conteneur de flux et produit les blocs du modèle. */
function readBlocks(
  container: Element,
  styles: StyleTable,
  warnings: string[],
  listDepth = 0,
): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];

  for (let i = 0; i < container.children.length; i += 1) {
    const element = container.children[i]!;
    switch (localName(element)) {
      case 'p':
        blocks.push(readParagraph(element, styles, null, listDepth));
        break;
      case 'h': {
        const raw = Number(attr(element, NS.text, 'outline-level') ?? '1');
        const level = (Math.min(6, Math.max(1, Number.isFinite(raw) ? raw : 1)) as HeadingLevel);
        blocks.push(readParagraph(element, styles, level, listDepth));
        break;
      }
      case 'list':
      case 'ordered-list':
      case 'unordered-list':
        blocks.push(...readBlocks(element, styles, warnings, listDepth + 1));
        break;
      case 'list-item':
      case 'list-header':
        blocks.push(...readBlocks(element, styles, warnings, listDepth));
        break;
      case 'table':
        blocks.push(readTable(element, styles));
        break;
      case 'section':
      case 'text-box':
        blocks.push(...readBlocks(element, styles, warnings, listDepth));
        break;
      default:
        break;
    }
  }

  return blocks;
}

const LIST_INDENT_PT = 18;

function readParagraph(
  element: Element,
  styles: StyleTable,
  headingLevel: HeadingLevel | null,
  listDepth: number,
): ParagraphNode {
  const styleName = attr(element, NS.text, 'style-name');
  const resolved = resolveStyle(styles, styleName);

  const runs: TextRun[] = [];
  collectRuns(element, styles, resolved.text, runs);

  const normalized = normalizeRuns(runs);

  const paragraph: ParagraphNode = {
    id: newId('p'),
    type: headingLevel !== null ? 'heading' : 'paragraph',
    ...(headingLevel !== null ? { headingLevel } : {}),
    runs: normalized.length > 0 ? normalized : [makeRun('')],
    ...(resolved.paragraph.alignment ? { alignment: resolved.paragraph.alignment } : {}),
    ...(resolved.paragraph.lineSpacing !== undefined ? { lineSpacing: resolved.paragraph.lineSpacing } : {}),
    ...(resolved.paragraph.marginTopPt !== undefined ? { marginTopPt: resolved.paragraph.marginTopPt } : {}),
    ...(resolved.paragraph.marginBottomPt !== undefined ? { marginBottomPt: resolved.paragraph.marginBottomPt } : {}),
    ...(resolved.paragraph.firstLineIndentPt !== undefined ? { firstLineIndentPt: resolved.paragraph.firstLineIndentPt } : {}),
    ...(resolved.paragraph.pageBreakBefore ? { pageBreakBefore: true } : {}),
    ...(resolved.paragraph.orphans !== undefined ? { orphans: resolved.paragraph.orphans } : {}),
    ...(resolved.paragraph.widows !== undefined ? { widows: resolved.paragraph.widows } : {}),
    ...(resolved.paragraph.keepTogether ? { keepTogether: true } : {}),
  };

  if (listDepth > 0) {
    paragraph.indentLeftPt = (resolved.paragraph.indentLeftPt ?? 0) + listDepth * LIST_INDENT_PT;
  } else if (resolved.paragraph.indentLeftPt !== undefined) {
    paragraph.indentLeftPt = resolved.paragraph.indentLeftPt;
  }
  if (resolved.paragraph.indentRightPt !== undefined) {
    paragraph.indentRightPt = resolved.paragraph.indentRightPt;
  }

  return paragraph;
}

function collectRuns(
  node: Node,
  styles: StyleTable,
  currentFormatting: RunFormatting,
  runs: TextRun[],
): void {
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes[i]!;

    if (child.nodeType === 3) {
      // TEXT_NODE
      const text = child.textContent ?? '';
      if (text.length > 0) runs.push(makeRun(text, currentFormatting));
      continue;
    }

    if (child.nodeType !== 1) continue; // ELEMENT_NODE

    const element = child as Element;
    const kind = localName(element);

    switch (kind) {
      case 'span': {
        const spanStyle = attr(element, NS.text, 'style-name');
        const resolved = resolveStyle(styles, spanStyle);
        const merged: RunFormatting = { ...currentFormatting, ...resolved.text };
        collectRuns(element, styles, merged, runs);
        break;
      }
      case 'a': {
        const href = attr(element, NS.xlink, 'href') ?? '';
        const linkFormatting: RunFormatting = { ...currentFormatting, linkHref: href };
        collectRuns(element, styles, linkFormatting, runs);
        break;
      }
      case 's': {
        const countRaw = Number(attr(element, NS.text, 'c') ?? '1');
        const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 1;
        runs.push(makeRun(' '.repeat(count), currentFormatting));
        break;
      }
      case 'tab':
        runs.push(makeRun('\t', currentFormatting));
        break;
      case 'line-break':
        runs.push(makeRun('\n', currentFormatting));
        break;
      case 'page-number':
      case 'page-count':
      case 'title':
      case 'date':
      case 'time':
      case 'author-name':
      case 'initial-creator':
        // Substitutions directes pour le texte dans le corps
        runs.push(makeRun(element.textContent ?? '', currentFormatting));
        break;
      default:
        collectRuns(element, styles, currentFormatting, runs);
        break;
    }
  }
}

function readTable(element: Element, styles: StyleTable): TableNode {
  const rows: TableRowNode[] = [];
  let headerRows = 0;

  const walkRows = (container: Element, isHeader: boolean): void => {
    for (let i = 0; i < container.children.length; i += 1) {
      const child = container.children[i]!;
      const kind = localName(child);

      if (kind === 'table-header-rows') {
        walkRows(child, true);
        continue;
      }
      if (kind === 'table-row-group') {
        walkRows(child, isHeader);
        continue;
      }
      if (kind !== 'table-row') continue;

      const cells: TableCellNode[] = [];
      for (let j = 0; j < child.children.length; j += 1) {
        const cellElement = child.children[j]!;
        if (localName(cellElement) !== 'table-cell') continue;

        const cellStyleName = attr(cellElement, NS.table, 'style-name');
        const cellStyle = resolveStyle(styles, cellStyleName);

        const colSpan = Number(attr(cellElement, NS.table, 'number-columns-spanned') ?? '1');
        const rowSpan = Number(attr(cellElement, NS.table, 'number-rows-spanned') ?? '1');

        const cellBlocks: ParagraphNode[] = [];
        for (let k = 0; k < cellElement.children.length; k += 1) {
          const inner = cellElement.children[k]!;
          if (localName(inner) === 'p') {
            cellBlocks.push(readParagraph(inner, styles, null, 0));
          }
        }
        if (cellBlocks.length === 0) cellBlocks.push(createParagraph(''));

        cells.push({
          id: newId('cell'),
          blocks: cellBlocks,
          ...(colSpan > 1 ? { colSpan } : {}),
          ...(rowSpan > 1 ? { rowSpan } : {}),
          ...(cellStyle?.cell?.backgroundColor ? { backgroundColor: cellStyle.cell.backgroundColor } : {}),
          ...(cellStyle?.cell?.borderColor ? { borderColor: cellStyle.cell.borderColor } : {}),
          ...(cellStyle?.cell?.paddingPt !== undefined ? { paddingPt: cellStyle.cell.paddingPt } : {}),
        });
      }

      const row: TableRowNode = { id: newId('row'), cells };
      if (isHeader) {
        row.isHeader = true;
        headerRows += 1;
      }
      rows.push(row);
    }
  };

  walkRows(element, false);

  if (headerRows === 0 && rows.length > 0) {
    // Par défaut, première ligne en en-tête si pas spécifié
  }

  return {
    id: newId('table'),
    type: 'table',
    rows: rows.length > 0 ? rows : [{ id: newId('row'), cells: [{ id: newId('cell'), blocks: [createParagraph('')] }] }],
  };
}
