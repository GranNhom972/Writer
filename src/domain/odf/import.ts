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
import {
  isParagraph,
  isTable,
  MAX_LIST_LEVEL,
  type DocumentBlock,
  type HeadingLevel,
  type FlyAnchor,
  type FlySurround,
  type ListKind,
  type PageSetup,
  type ParagraphNode,
  type RedlineType,
  type RunFormatting,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
  type TextRun,
  type TocNode,
  type WriterDocumentState,
} from '../document/types';
import { joinCommentIds, type DocumentComment } from '../document/comments';
import { blockIdFromHeadingAnchor, normalizeBookmarkName } from '../document/bookmarks';
import { DEFAULT_TOC_MAX_LEVEL, DEFAULT_TOC_TITLE } from '../document/tox';
import type { Redline } from '../document/redline';
import { attr, localName, NS } from './namespaces';
import { clampSize, cropFormatting, isSafeImageSrc, IMAGE_PLACEHOLDER } from '../document/images';
import { collectStyles, resolveStyle, type StyleTable } from './styles';
import { parseLengthMm } from './units';
import { normalizeUrl } from '../document/url';

export interface ImportResult {
  document: WriterDocumentState;
  /** Ce qui n'a pas pu être transcrit — annoncé, jamais perdu en silence. */
  warnings: string[];
}

export interface ImportOptions {
  title?: string;
  /** `styles.xml`, s'il est disponible : il porte les styles nommés et la page. */
  stylesXml?: string;
  /**
   * Images extraites de l'archive : `Pictures/…` → `data:`.
   *
   * Sans cette table, un `<draw:image xlink:href="Pictures/image1.png"/>` ne
   * désignerait rien : le chemin n'a de sens qu'à l'intérieur du ZIP.
   */
  pictures?: ReadonlyMap<string, string>;
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

  // Les révisions se lisent **avant** le corps : un jalon `<text:change>`
  // rencontré en chemin doit pouvoir restituer aussitôt le texte supprimé que
  // l'en-tête conserve.
  const { redlines, deletedText } = readTrackedChanges(body);

  const ctx: ImportContext = {
    styles,
    warnings,
    pictures: options.pictures ?? EMPTY_PICTURES,
    listStyles: readListStyles(content),
    comments: [],
    redlines,
    deletedText,
  };

  document.blocks = readBlocks(body, ctx);
  if (document.blocks.length === 0) document.blocks = [createParagraph('')];

  if (ctx.comments.length > 0) document.comments = ctx.comments;
  // Seules les révisions réellement ancrées sont conservées : une région
  // déclarée sans jalon correspondant dans le corps n'a rien à annuler.
  const anchored = new Set<string>();
  for (const block of document.blocks) {
    if (isTable(block)) {
      for (const row of block.rows)
        for (const cell of row.cells)
          for (const paragraph of cell.blocks)
            for (const run of paragraph.runs) if (run.redlineId) anchored.add(run.redlineId);
    } else if (isParagraph(block)) {
      for (const run of block.runs) if (run.redlineId) anchored.add(run.redlineId);
    }
  }
  const kept = [...redlines.values()].filter((redline) => anchored.has(redline.id));
  if (kept.length > 0) document.redlines = kept;

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

/**
 * Portée de liste courante. Transposition de `XMLTextListBlockContext`
 * (`xmloff/source/text/XMLTextListBlockContext.cxx`).
 *
 * Une liste ODF est une **structure imbriquée** (`<text:list>` contenant des
 * `<text:list-item>`), là où le modèle — comme `SwTxtNode` — n'a que des
 * attributs de paragraphe. La conversion se fait en descendant : la portée
 * accumule l'identifiant de liste et le niveau, et chaque paragraphe rencontré
 * en hérite.
 *
 * L'identifiant est capital et c'est lui que l'ancienne version perdait :
 * sans lui, deux listes séparées par du texte partageraient leur compteur, et
 * la seconde reprendrait à 4 là où elle doit repartir à 1.
 */
interface ListScope {
  kind: ListKind;
  id: string;
  /** 0 pour le premier niveau, comme `RES_PARATR_LIST_LEVEL`. */
  level: number;
  /** Valeur de reprise portée par `text:start-value` du premier élément. */
  startValue?: number;
}

/** Ce que le parcours des blocs doit transporter de haut en bas. */
interface ImportContext {
  styles: StyleTable;
  warnings: string[];
  pictures: ReadonlyMap<string, string>;
  /** Nature de chaque niveau des styles de liste, par nom de style. */
  listStyles: ReadonlyMap<string, ListKind[]>;
  /** Commentaires collectés en cours de route (`office:annotation`). */
  comments: DocumentComment[];
  /** Révisions déclarées par `<text:tracked-changes>`, par identifiant. */
  redlines: ReadonlyMap<string, Redline>;
  /** Texte supprimé, à réinjecter aux jalons `<text:change>`. */
  deletedText: ReadonlyMap<string, string>;
}

/** Parcourt les enfants d'un conteneur de flux et produit les blocs du modèle. */
function readBlocks(
  container: Element,
  ctx: ImportContext,
  list: ListScope | null = null,
): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];

  for (let i = 0; i < container.children.length; i += 1) {
    const element = container.children[i]!;
    switch (localName(element)) {
      case 'p':
        blocks.push(readParagraph(element, ctx, null, list));
        break;
      case 'h': {
        const raw = Number(attr(element, NS.text, 'outline-level') ?? '1');
        const level = (Math.min(6, Math.max(1, Number.isFinite(raw) ? raw : 1)) as HeadingLevel);
        blocks.push(readParagraph(element, ctx, level, list));
        break;
      }
      case 'list':
      case 'ordered-list':
      case 'unordered-list':
        blocks.push(...readBlocks(element, ctx, enterList(element, ctx, list)));
        break;
      case 'list-item':
      case 'list-header': {
        // `text:start-value` porté par l'élément redémarre le compteur ici.
        const startRaw = attr(element, NS.text, 'start-value');
        const start = startRaw !== null ? Number(startRaw) : NaN;
        const scoped =
          list && Number.isFinite(start)
            ? { ...list, startValue: start }
            : list;
        blocks.push(...readBlocks(element, ctx, scoped));
        break;
      }
      case 'table':
        blocks.push(readTable(element, ctx));
        break;
      case 'table-of-content':
        blocks.push(readToc(element));
        break;
      case 'index-body':
      case 'index-title':
        // Corps **rendu** d'un index : ignoré à l'import, puisque le sommaire
        // est régénéré à la pagination depuis sa définition. Le lire produirait
        // un doublon figé de chaque titre.
        break;
      case 'tracked-changes':
        // Déjà lu en amont : `readTrackedChanges` a besoin du document entier
        // avant que le corps ne soit parcouru.
        break;
      case 'section':
      case 'text-box':
        blocks.push(...readBlocks(element, ctx, list));
        break;
      default:
        break;
    }
  }

  return blocks;
}

/**
 * Ouvre une portée de liste en entrant dans un `<text:list>`.
 *
 * L'identifiant vient de `xml:id` quand il existe — ODF s'en sert pour
 * enchaîner deux listes séparées via `text:continue-list` — et est tiré au sort
 * sinon. Deux `<text:list>` frères sans identifiant sont donc deux listes
 * distinctes, ce qui est le comportement attendu.
 */
function enterList(
  element: Element,
  ctx: ImportContext,
  parent: ListScope | null,
): ListScope {
  const level = parent ? Math.min(parent.level + 1, MAX_LIST_LEVEL - 1) : 0;

  const continued = attr(element, NS.text, 'continue-list');
  const explicitId = attr(element, NS.xml, 'id') ?? continued;

  const styleName = attr(element, NS.text, 'style-name');
  const levels = styleName ? ctx.listStyles.get(styleName) : undefined;
  const kind: ListKind =
    levels?.[level] ??
    (localName(element) === 'ordered-list' ? 'ordered' : parent?.kind ?? 'bullet');

  return {
    kind,
    // Un sous-niveau partage l'identifiant de son parent : c'est une seule
    // liste hiérarchique, pas deux listes indépendantes.
    id: parent ? parent.id : explicitId ?? newId('list'),
    level,
  };
}

/**
 * Lit la nature de chaque niveau des styles de liste du document.
 *
 * ODF décrit un style de liste par un `<text:list-style>` contenant un élément
 * par niveau : `text:list-level-style-number` pour une numérotation,
 * `-bullet` pour une puce. C'est la seule source qui distingue les deux — la
 * balise `<text:list>` elle-même est identique dans les deux cas.
 */
function readListStyles(root: Document | Element): Map<string, ListKind[]> {
  const out = new Map<string, ListKind[]>();
  const all = root.getElementsByTagName('*');

  for (let i = 0; i < all.length; i += 1) {
    const element = all[i]!;
    if (localName(element) !== 'list-style') continue;
    const name = attr(element, NS.style, 'name') ?? attr(element, NS.text, 'name');
    if (!name) continue;

    const levels: ListKind[] = [];
    for (let j = 0; j < element.children.length; j += 1) {
      const levelEl = element.children[j]!;
      const levelName = localName(levelEl);
      const raw = Number(attr(levelEl, NS.text, 'level') ?? String(j + 1));
      const index = Math.max(0, (Number.isFinite(raw) ? raw : j + 1) - 1);

      if (levelName === 'list-level-style-number') levels[index] = 'ordered';
      else if (levelName === 'list-level-style-bullet') levels[index] = 'bullet';
      else if (levelName === 'list-level-style-image') levels[index] = 'bullet';
    }

    if (levels.length > 0) out.set(name, levels);
  }

  return out;
}

/**
 * Lit une table des matières. Transposition d'`XMLIndexTOCContext`
 * (`xmloff/source/text/XMLIndexTOCContext.cxx`).
 *
 * Seule la **définition** est lue : profondeur, titre, présence des numéros de
 * page. Le corps rendu (`<text:index-body>`) est délibérément ignoré, le
 * sommaire étant régénéré à la pagination — le lire figerait des numéros de
 * page qui ne correspondent plus dès la première frappe.
 */
function readToc(element: Element): TocNode {
  const source = firstChildNamed(element, 'table-of-content-source');

  const rawLevel = Number(
    (source && attr(source, NS.text, 'outline-level')) ?? String(DEFAULT_TOC_MAX_LEVEL),
  );
  const maxLevel = Math.min(6, Math.max(1, Number.isFinite(rawLevel) ? rawLevel : 3)) as HeadingLevel;

  const titleTemplate = source ? firstChildNamed(source, 'index-title-template') : null;
  const title = titleTemplate?.textContent?.trim() || DEFAULT_TOC_TITLE;

  // La présence des numéros de page se lit dans le modèle de ligne : c'est
  // `text:index-entry-page-number` qui en décide, pas un attribut dédié.
  const template = source ? firstChildNamed(source, 'table-of-content-entry-template') : null;
  const showPageNumbers = template
    ? firstChildNamed(template, 'index-entry-page-number') !== null
    : true;
  const tabStop = template ? firstChildNamed(template, 'index-entry-tab-stop') : null;
  const useDotLeader = tabStop ? attr(tabStop, NS.style, 'leader-char') === '.' : true;

  return {
    id: attr(element, NS.text, 'name') ?? newId('toc'),
    type: 'toc',
    title,
    maxLevel,
    showPageNumbers,
    useDotLeader,
  };
}

const EMPTY_PICTURES: ReadonlyMap<string, string> = new Map();

/** Points par millimètre — `svg:width` est donné en unité XSL-FO (cm, mm, in…). */
const PT_PER_MM = 72 / 25.4;

/**
 * Transcrit un `<draw:frame>` portant une image.
 *
 * Seul l'ancrage « comme caractère » est porté par le modèle : un cadre ancré
 * à la page ou au paragraphe est **tout de même** lu, et devient une image dans
 * le flux, à sa position d'ancrage. Le rendu diffère de Writer — pas
 * d'habillage — mais l'image ne disparaît pas du document, ce qui serait la
 * pire des deux issues.
 */
function readImageFrame(
  frame: Element,
  pictures: ReadonlyMap<string, string>,
  styles: StyleTable,
): TextRun | null {
  const image = firstChildNamed(frame, 'image');
  if (!image) return null;

  const href = attr(image, NS.xlink, 'href');
  if (!href) return null;

  // Un chemin interne (`Pictures/…`) n'a de sens que dans l'archive : il est
  // résolu par la table extraite du ZIP. Une adresse externe passe telle quelle.
  const src = pictures.get(href.replace(/^\.?\//, '')) ?? pictures.get(href) ?? href;
  if (!isSafeImageSrc(src)) return null;

  const widthMm = parseLengthMm(attr(frame, NS.svg, 'width'));
  const heightMm = parseLengthMm(attr(frame, NS.svg, 'height'));

  // Cadre sans dimensions : ODF l'autorise (le lecteur prend la taille
  // naturelle), le moteur non — il calcule la ligne avant de charger l'image.
  // Une taille par défaut vaut mieux qu'une image invisible ; l'usager la
  // corrigera dans l'atelier.
  const widthPt = clampSize((widthMm ?? 40) * PT_PER_MM);
  const heightPt = clampSize((heightMm ?? 30) * PT_PER_MM);

  const alt =
    firstChildNamed(frame, 'title')?.textContent?.trim() ||
    firstChildNamed(frame, 'desc')?.textContent?.trim() ||
    '';

  // `fo:clip` est porté par le **style** du cadre, pas par le cadre lui-même :
  // c'est là qu'ODF range les propriétés graphiques.
  const styleName = attr(frame, NS.draw, 'style-name');
  const graphic = styleName ? resolveStyle(styles, styleName).graphic : undefined;
  const clip = graphic?.clip;
  const crop = clip ? cropFromClip(clip, widthPt, heightPt) : null;

  // Ancrage : `text:anchor-type` distingue le cadre qui coule dans la ligne de
  // celui qui flotte. Un `char` d'ODF n'est pas `as-char` — il ancre le cadre
  // *au* caractère mais hors du flux — et se ramène donc à un ancrage au
  // paragraphe, le plus proche que porte le modèle.
  const anchorType = attr(frame, NS.text, 'anchor-type');
  const anchor: FlyAnchor =
    anchorType === 'page' ? 'to-page' : anchorType === 'as-char' || anchorType === null ? 'as-char' : 'to-para';

  const flyFormatting =
    anchor === 'as-char'
      ? {}
      : {
          imageAnchor: anchor,
          imageSurround: graphic?.surround ?? ('parallel' as FlySurround),
          imageXPt: parseLengthMm(attr(frame, NS.svg, 'x')) !== null
            ? parseLengthMm(attr(frame, NS.svg, 'x'))! * PT_PER_MM
            : 0,
          imageYPt: parseLengthMm(attr(frame, NS.svg, 'y')) !== null
            ? parseLengthMm(attr(frame, NS.svg, 'y'))! * PT_PER_MM
            : 0,
          ...(graphic?.wrapMarginPt !== undefined
            ? { imageWrapMarginPt: graphic.wrapMarginPt }
            : {}),
        };

  return makeRun(IMAGE_PLACEHOLDER, {
    imageSrc: src,
    imageWidthPt: widthPt,
    imageHeightPt: heightPt,
    ...(alt ? { imageAlt: alt } : {}),
    ...(crop ? cropFormatting(crop) : {}),
    ...flyFormatting,
  });
}

/**
 * Décode `fo:clip="rect(haut droite bas gauche)"`.
 *
 * ODF donne des longueurs retranchées de l'**original**, le modèle veut des
 * fractions. On ne connaît pas la taille de l'original — seulement celle du
 * cadre, qui montre déjà la partie conservée — mais les deux se déduisent l'une
 * de l'autre : `original = cadre + retraits`.
 *
 * Un `rect(auto auto auto auto)`, ou toute valeur illisible, rend `null` : mieux
 * vaut une image entière qu'un cadrage inventé.
 */
function cropFromClip(
  clip: string,
  widthPt: number,
  heightPt: number,
): { topPct: number; rightPct: number; bottomPct: number; leftPct: number } | null {
  const dedans = /^\s*rect\s*\(([^)]*)\)\s*$/i.exec(clip);
  if (!dedans) return null;

  // Les quatre valeurs se séparent par des espaces ou des virgules selon le
  // producteur : les deux formes existent dans la nature.
  const parts = dedans[1]!.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 4) return null;

  const mm = parts.map((part) => parseLengthMm(part));
  if (mm.some((value) => value === null)) return null;

  const [hautMm, droiteMm, basMm, gaucheMm] = mm as number[];
  const hautPt = hautMm! * PT_PER_MM;
  const droitePt = droiteMm! * PT_PER_MM;
  const basPt = basMm! * PT_PER_MM;
  const gauchePt = gaucheMm! * PT_PER_MM;

  const originalWidthPt = widthPt + gauchePt + droitePt;
  const originalHeightPt = heightPt + hautPt + basPt;
  if (originalWidthPt <= 0 || originalHeightPt <= 0) return null;

  return {
    topPct: hautPt / originalHeightPt,
    rightPct: droitePt / originalWidthPt,
    bottomPct: basPt / originalHeightPt,
    leftPct: gauchePt / originalWidthPt,
  };
}

function firstChildNamed(parent: Element, name: string): Element | null {
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i]!;
    if (localName(child) === name) return child;
  }
  return null;
}

function readParagraph(
  element: Element,
  ctx: ImportContext,
  headingLevel: HeadingLevel | null,
  list: ListScope | null,
): ParagraphNode {
  const styleName = attr(element, NS.text, 'style-name');
  const resolved = resolveStyle(ctx.styles, styleName);

  const runs: TextRun[] = [];
  collectRuns(element, ctx, resolved.text, runs);

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

  // Attributs de liste : c'est ici que la structure imbriquée d'ODF devient un
  // attribut de paragraphe, comme `SwTxtNode::SetAttr(RES_PARATR_LIST_*)`.
  // Le retrait n'est **plus** fabriqué à la main : `effectiveIndentLeftPt` le
  // dérive du niveau, et l'écrire en dur ici le doublerait.
  if (list) {
    paragraph.listKind = list.kind;
    paragraph.listId = list.id;
    paragraph.listLevel = list.level;
    if (list.startValue !== undefined) {
      paragraph.listRestart = true;
      paragraph.listStartValue = list.startValue;
    }
    if (resolved.paragraph.indentLeftPt !== undefined) {
      paragraph.indentLeftPt = resolved.paragraph.indentLeftPt;
    }
  } else if (resolved.paragraph.indentLeftPt !== undefined) {
    paragraph.indentLeftPt = resolved.paragraph.indentLeftPt;
  }

  if (resolved.paragraph.indentRightPt !== undefined) {
    paragraph.indentRightPt = resolved.paragraph.indentRightPt;
  }

  return paragraph;
}

/**
 * Parcourt le contenu d'un paragraphe et produit ses runs.
 *
 * Les **jalons** d'ODF — signets, commentaires, révisions — sont des éléments
 * vides qui n'encadrent rien : ils marquent une position entre deux frères.
 * L'état qu'ils ouvrent vaut donc pour la **suite de la fratrie** et non pour
 * des enfants. C'est pourquoi `active` est mutable au fil de la boucle, là où
 * `currentFormatting` reste fixe pour la descente dans un `<text:span>`.
 */
function collectRuns(
  node: Node,
  ctx: ImportContext,
  currentFormatting: RunFormatting,
  runs: TextRun[],
): void {
  // Formatage courant, jalons compris. Repart de `currentFormatting` : un
  // signet ouvert hors de ce nœud reste actif dedans.
  let active: RunFormatting = { ...currentFormatting };

  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes[i]!;

    if (child.nodeType === 3) {
      // TEXT_NODE
      const text = child.textContent ?? '';
      if (text.length > 0) runs.push(makeRun(text, active));
      continue;
    }

    if (child.nodeType !== 1) continue; // ELEMENT_NODE

    const element = child as Element;
    const kind = localName(element);

    switch (kind) {
      case 'span': {
        const spanStyle = attr(element, NS.text, 'style-name');
        const resolved = resolveStyle(ctx.styles, spanStyle);
        const merged: RunFormatting = { ...active, ...resolved.text };
        collectRuns(element, ctx, merged, runs);
        break;
      }
      case 'a': {
        // Le `.odt` vient d'un fichier fourni par l'usager, donc d'une source
        // non fiable : son `xlink:href` passe par la même normalisation que
        // les liens saisis dans l'éditeur. Sans elle, un `javascript:` importé
        // ressortait tel quel dans le `<a href>` du rendu — et se rediffusait
        // à tous les collaborateurs par le CRDT.
        const raw = attr(element, NS.xlink, 'href') ?? '';
        // Un renvoi interne `#nom` n'est pas une adresse à normaliser : il ne
        // sort jamais du document, et `normalizeUrl` le rejetterait.
        const href = raw.startsWith('#') ? raw : normalizeUrl(raw);
        const linkFormatting: RunFormatting = href ? { ...active, linkHref: href } : { ...active };
        collectRuns(element, ctx, linkFormatting, runs);
        break;
      }
      case 's': {
        const countRaw = Number(attr(element, NS.text, 'c') ?? '1');
        const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 1;
        runs.push(makeRun(' '.repeat(count), active));
        break;
      }
      case 'tab':
        runs.push(makeRun('\t', active));
        break;
      case 'line-break':
        runs.push(makeRun('\n', active));
        break;
      case 'page-number':
      case 'page-count':
      case 'title':
      case 'date':
      case 'time':
      case 'author-name':
      case 'initial-creator':
        // Substitutions directes pour le texte dans le corps
        runs.push(makeRun(element.textContent ?? '', active));
        break;
      case 'note': {
        const noteClass = attr(element, NS.text, 'note-class') ?? 'footnote';
        if (noteClass === 'footnote' || noteClass === 'endnote') {
          const citation = firstChildNamed(element, 'note-citation')?.textContent?.trim() || '¹';
          const bodyEl = firstChildNamed(element, 'note-body');
          const noteText = bodyEl ? extractOdfTextTokens(bodyEl).trim() : '';
          runs.push(
            makeRun(citation, {
              ...active,
              footnoteText: noteText,
              footnoteId: newId('fn'),
            }),
          );
        }
        break;
      }
      case 'frame': {
        const cadre = readImageFrame(element, ctx.pictures, ctx.styles);
        if (cadre) runs.push(cadre);
        // Un cadre non transcrit ne descend **pas** : son `<svg:desc>` deviendrait
        // du texte au fil du paragraphe, ce qui n'a jamais été voulu.
        break;
      }

      /* -- jalons de plage --------------------------------------------- */

      case 'bookmark-start': {
        const name = attr(element, NS.text, 'name');
        if (name) active = { ...active, bookmarkName: normalizeBookmarkName(name) };
        break;
      }
      case 'bookmark-end': {
        const next = { ...active };
        delete next.bookmarkName;
        active = next;
        break;
      }
      case 'bookmark': {
        // Signet **ponctuel** : il n'a pas de plage à couvrir. On le pose sur
        // un run vide plutôt que de l'ignorer — c'est la seule façon de lui
        // survivre à l'aller-retour, et `normalizeRuns` gardera l'attribut si
        // du texte le rejoint. Les ancres de titre, elles, sont régénérées à
        // l'export et n'ont pas à être conservées.
        const name = attr(element, NS.text, 'name');
        if (name && !blockIdFromHeadingAnchor(name)) {
          runs.push(makeRun('', { ...active, bookmarkName: normalizeBookmarkName(name) }));
        }
        break;
      }
      case 'annotation': {
        const comment = readAnnotation(element);
        if (comment) {
          ctx.comments.push(comment);
          // Seule la racine ouvre une plage : une réponse partage l'ancre du
          // fil, et l'ouvrir une seconde fois dupliquerait le surlignage.
          if (comment.id === comment.threadId) {
            const ids = active.commentIds ? active.commentIds.split(',') : [];
            const joined = joinCommentIds([...ids, comment.threadId]);
            if (joined) active = { ...active, commentIds: joined };
          }
        }
        break;
      }
      case 'annotation-end': {
        const name = attr(element, NS.office, 'name');
        const ids = (active.commentIds ?? '').split(',').filter((id) => id && id !== name);
        const next = { ...active };
        const joined = joinCommentIds(ids);
        if (joined) next.commentIds = joined;
        else delete next.commentIds;
        active = next;
        break;
      }
      case 'change-start': {
        const id = attr(element, NS.text, 'change-id');
        const redline = id ? ctx.redlines.get(id) : undefined;
        if (id && redline) active = { ...active, redlineId: id, redlineType: redline.type };
        break;
      }
      case 'change-end': {
        const next = { ...active };
        delete next.redlineId;
        delete next.redlineType;
        active = next;
        break;
      }
      case 'change': {
        // Jalon d'une suppression : ODF range le texte supprimé dans l'en-tête
        // `<text:tracked-changes>`, le corps ne porte que ce repère. On
        // réinjecte le texte ici, marqué supprimé — sans quoi rejeter la
        // révision n'aurait rien à restaurer.
        const id = attr(element, NS.text, 'change-id');
        const text = id ? ctx.deletedText.get(id) : undefined;
        if (id && text) {
          runs.push(makeRun(text, { ...active, redlineId: id, redlineType: 'delete' }));
        }
        break;
      }

      default:
        collectRuns(element, ctx, active, runs);
        break;
    }
  }
}

/**
 * Lit une annotation. Transposition d'`XMLAnnotationImportContext`
 * (`xmloff/source/text/XMLTextFrameContext.cxx` pour l'ancrage,
 * `txtfldi.cxx` pour le champ).
 *
 * Le nom `id~rN` marque une réponse au fil `id` : c'est la convention posée à
 * l'export, ODF 1.2 n'ayant pas de fils de discussion.
 */
function readAnnotation(element: Element): DocumentComment | null {
  const name = attr(element, NS.office, 'name');
  if (!name) return null;

  const separator = name.indexOf('~r');
  const threadId = separator > 0 ? name.slice(0, separator) : name;

  const author = firstChildNamed(element, 'creator')?.textContent?.trim() ?? 'Anonyme';
  const date = firstChildNamed(element, 'date')?.textContent?.trim() ?? new Date().toISOString();

  const paragraphs: string[] = [];
  for (let i = 0; i < element.children.length; i += 1) {
    const child = element.children[i]!;
    if (localName(child) === 'p') paragraphs.push(child.textContent ?? '');
  }

  const text = paragraphs.join('\n').trim();
  if (!text) return null;

  // Fil clos : porté par l'extension LibreOffice, absente d'ODF 1.2.
  const resolu = attr(element, NS.loext, 'resolved') === 'true';

  return {
    id: name,
    threadId,
    author,
    createdAt: date,
    text,
    ...(resolu ? { resolved: true } : {}),
  };
}

/**
 * Lit `<text:tracked-changes>`. Transposition d'`XMLChangedRegionImportContext`
 * (`xmloff/source/text/XMLChangedRegionImportContext.cxx`).
 *
 * Renvoie les métadonnées **et** le texte supprimé, que le corps ne porte pas :
 * les deux sont nécessaires avant de parcourir le corps, puisqu'un jalon
 * `<text:change>` rencontré en chemin doit pouvoir restituer son texte.
 */
function readTrackedChanges(body: Element): {
  redlines: Map<string, Redline>;
  deletedText: Map<string, string>;
} {
  const redlines = new Map<string, Redline>();
  const deletedText = new Map<string, string>();

  const container = firstChildNamed(body, 'tracked-changes');
  if (!container) return { redlines, deletedText };

  for (let i = 0; i < container.children.length; i += 1) {
    const region = container.children[i]!;
    if (localName(region) !== 'changed-region') continue;

    const id = attr(region, NS.text, 'id') ?? attr(region, NS.xml, 'id');
    if (!id) continue;

    for (let j = 0; j < region.children.length; j += 1) {
      const kindEl = region.children[j]!;
      const kindName = localName(kindEl);

      const type: RedlineType | null =
        kindName === 'insertion'
          ? 'insert'
          : kindName === 'deletion'
            ? 'delete'
            : kindName === 'format-change'
              ? 'format'
              : null;
      if (!type) continue;

      const info = firstChildNamed(kindEl, 'change-info');
      const author = info ? firstChildNamed(info, 'creator')?.textContent?.trim() : undefined;
      const date = info ? firstChildNamed(info, 'date')?.textContent?.trim() : undefined;

      redlines.set(id, {
        id,
        type,
        author: author || 'Anonyme',
        date: date || new Date().toISOString(),
      });

      if (type === 'delete') {
        const parts: string[] = [];
        for (let k = 0; k < kindEl.children.length; k += 1) {
          const child = kindEl.children[k]!;
          if (localName(child) === 'change-info') continue;
          parts.push(child.textContent ?? '');
        }
        deletedText.set(id, parts.join('\n'));
      }
    }
  }

  return { redlines, deletedText };
}

function readTable(element: Element, ctx: ImportContext): TableNode {
  const styles = ctx.styles;
  const rows: TableRowNode[] = [];
  let headerRows = 0;

  // Lecture des largeurs de colonnes depuis les balises <table:table-column>
  const columnWidths: number[] = [];
  for (let i = 0; i < element.children.length; i += 1) {
    const child = element.children[i]!;
    if (localName(child) === 'table-column') {
      const colStyleName = attr(child, NS.table, 'style-name');
      const resolved = resolveStyle(styles, colStyleName);
      const width = resolved.column.widthPt ?? resolved.column.relWidth ?? 0;
      const repeat = Number(attr(child, NS.table, 'number-columns-repeated') ?? '1');
      const count = Number.isFinite(repeat) && repeat > 0 ? repeat : 1;
      for (let r = 0; r < count; r += 1) {
        columnWidths.push(width);
      }
    }
  }

  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
  const columnPercentages: number[] = columnWidths.map((w) =>
    totalWidth > 0 ? (w / totalWidth) * 100 : 0,
  );

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
      let cellColIndex = 0;
      for (let j = 0; j < child.children.length; j += 1) {
        const cellElement = child.children[j]!;
        if (localName(cellElement) !== 'table-cell') continue;

        const cellStyleName = attr(cellElement, NS.table, 'style-name');
        const cellStyle = resolveStyle(styles, cellStyleName);

        const colSpan = Number(attr(cellElement, NS.table, 'number-columns-spanned') ?? '1');
        const rowSpan = Number(attr(cellElement, NS.table, 'number-rows-spanned') ?? '1');

        // Une cellule accepte les mêmes blocs que le corps ; seuls les nœuds
        // de texte y sont retenus, le modèle n'imbriquant pas les tableaux.
        const cellBlocks: ParagraphNode[] = [];
        for (const inner of readBlocks(cellElement, ctx)) {
          if (isParagraph(inner)) cellBlocks.push(inner);
        }
        if (cellBlocks.length === 0) cellBlocks.push(createParagraph(''));

        let widthPercent = columnPercentages[cellColIndex];
        if (colSpan > 1) {
          widthPercent = 0;
          for (let s = 0; s < colSpan; s += 1) {
            widthPercent += columnPercentages[cellColIndex + s] ?? 0;
          }
        }
        cellColIndex += colSpan > 0 ? colSpan : 1;

        cells.push({
          id: newId('cell'),
          blocks: cellBlocks,
          ...(widthPercent && widthPercent > 0 ? { widthPercent } : {}),
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

  return {
    id: newId('table'),
    type: 'table',
    rows: rows.length > 0 ? rows : [{ id: newId('row'), cells: [{ id: newId('cell'), blocks: [createParagraph('')] }] }],
  };
}
