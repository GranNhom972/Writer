// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

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

import { figureNumbering, paragraphText } from '../document/document';
import { runFormatting } from '../document/runs';
import { sheetSizeMm } from '../document/pageSetup';
import type { PageFurniture, FurnitureBand } from '../document/pageFurniture';
import {
  isParagraph,
  isTable,
  isToc,
  type DocumentBlock,
  type ParagraphNode,
  type TableNode,
  type TextRun,
  type TocNode,
  type WriterDocumentState,
} from '../document/types';
import { commentIdsOf, type DocumentComment } from '../document/comments';
import { isFloatingFly } from '../engine/flyLayout';
import { tocEntries } from '../document/tox';
import { headingAnchorName } from '../document/bookmarks';
import { escapeXml, NS_DECLARATIONS } from './namespaces';
import { collectPictures, type OdfPicture } from './pictures';
import {
  captionText,
  hasCaption,
  hasCrop,
  imageKey,
  imageAttributes,
  imageCrop,
  isImageRun,
  visibleFraction,
} from '../document/images';
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

/**
 * Cadre d'une image ancrée « comme caractère ».
 *
 * `text:anchor-type="as-char"` est la traduction ODF de `FLY_AS_CHAR` : c'est
 * l'attribut qui dit au lecteur de faire couler le cadre dans la ligne plutôt
 * que de le poser en flottant. Sans lui, Writer rouvre le document avec toutes
 * les images ancrées au paragraphe, décalées dans la marge.
 *
 * `svg:width`/`svg:height` sont obligatoires : un cadre sans dimensions est
 * dessiné à zéro par Writer, l'image devient invisible.
 */
function serializeImage(
  run: TextRun,
  hrefBySrc: ReadonlyMap<string, string>,
  styles: AutomaticStyles,
  figureNumber: number | null = null,
): string {
  const attributs = imageAttributes(run);
  if (!attributs) return '';

  const href = hrefBySrc.get(attributs.src) ?? attributs.src;
  const clip = clipDe(attributs.widthPt, attributs.heightPt, run);

  // Cadre flottant : l'ancrage et l'habillage se déclarent, et la position
  // devient absolue dans son ancre. `text:anchor-type` porte l'ancrage,
  // `style:wrap` du style porte l'habillage — ODF les sépare, contrairement au
  // modèle où les deux voyagent sur le même run.
  const floating = isFloatingFly(run);
  const anchorType = !floating
    ? 'as-char'
    : run.imageAnchor === 'to-page'
      ? 'page'
      : 'paragraph';

  const frameStyle = floating
    ? styles.frame(clip, {
        anchor: run.imageAnchor === 'to-page' ? 'to-page' : 'to-para',
        surround: run.imageSurround ?? 'parallel',
        ...(run.imageWrapMarginPt !== undefined ? { marginPt: run.imageWrapMarginPt } : {}),
        ...(run.imageHoriOrient !== undefined ? { horiOrient: run.imageHoriOrient } : {}),
        ...(run.imageHoriRelation !== undefined ? { horiRelation: run.imageHoriRelation } : {}),
        ...(run.imageInFront ? { inFront: true } : {}),
      })
    : styles.frame(clip);

  const position = floating
    ? ` svg:x="${formatPt(run.imageXPt ?? 0)}" svg:y="${formatPt(run.imageYPt ?? 0)}"`
    : '';

  const alt = attributs.alt
    ? `<svg:title>${escapeXml(attributs.alt)}</svg:title><svg:desc>${escapeXml(attributs.alt)}</svg:desc>`
    : '';

  const cadre =
    `<draw:frame draw:style-name="${frameStyle}" text:anchor-type="${anchorType}"${position} ` +
    `svg:width="${formatPt(attributs.widthPt)}" svg:height="${formatPt(attributs.heightPt)}">` +
    `<draw:image xlink:href="${escapeXml(href)}" xlink:type="simple" ` +
    `xlink:show="embed" xlink:actuate="onLoad"/>` +
    alt +
    `</draw:frame>`;

  const legende = attributs.caption;
  if (!legende || !hasCaption(run)) return cadre;

  /*
   * Image légendée : la structure d'ODF est un cadre **englobant** qui porte un
   * `draw:text-box`, lequel contient un paragraphe où voisinent l'image et son
   * texte. C'est ce que produit Writer, et c'est ce que tout lecteur sait
   * afficher.
   *
   * Le numéro y est écrit **en clair**, résolu au moment de l'export : ODF le
   * porterait par un `text:sequence`, que nous ne savons pas relire. Nos
   * propres attributs, à côté, gardent le mode et l'alignement pour que la
   * relecture ici soit sans perte — un lecteur tiers les ignore.
   */
  const texte = escapeXml(captionText(legende, figureNumber));
  const reglages =
    ` writer:caption="${escapeXml(legende.text)}"` +
    ` writer:caption-position="${legende.position}"` +
    ` writer:caption-align="${legende.align}"` +
    ` writer:caption-manual="${legende.manual ? 'true' : 'false'}"`;

  const paragraphe =
    legende.position === 'above'
      ? `<text:p text:style-name="Illustration">${texte}</text:p>` +
        `<text:p text:style-name="Illustration">${cadre}</text:p>`
      : `<text:p text:style-name="Illustration">${cadre}</text:p>` +
        `<text:p text:style-name="Illustration">${texte}</text:p>`;

  return (
    `<draw:frame draw:style-name="${frameStyle}" text:anchor-type="${anchorType}" ` +
    `svg:width="${formatPt(attributs.widthPt)}"${reglages}>` +
    `<draw:text-box fo:min-height="${formatPt(attributs.heightPt)}">${paragraphe}</draw:text-box>` +
    `</draw:frame>`
  );
}

/**
 * `fo:clip="rect(haut droite bas gauche)"` — le rognage au format ODF.
 *
 * ODF exprime les quatre retraits en **longueurs**, retranchées de l'image
 * d'origine, alors que le modèle les porte en fractions. La conversion passe par
 * la taille qu'aurait l'image **non rognée** au facteur d'échelle courant : le
 * cadre montre la fraction visible, donc l'original mesurerait
 * `largeur / fractionVisible`.
 *
 * L'ordre des quatre valeurs est celui de CSS — haut, droite, bas, gauche — et
 * l'inverser ferait pivoter le cadrage d'un quart de tour à la relecture.
 */
function clipDe(widthPt: number, heightPt: number, run: TextRun): string | undefined {
  const crop = imageCrop(run);
  if (!hasCrop(crop)) return undefined;

  const visible = visibleFraction(crop);
  const originalWidthPt = widthPt / visible.width;
  const originalHeightPt = heightPt / visible.height;

  return (
    `rect(${formatPt(crop.topPct * originalHeightPt)} ` +
    `${formatPt(crop.rightPct * originalWidthPt)} ` +
    `${formatPt(crop.bottomPct * originalHeightPt)} ` +
    `${formatPt(crop.leftPct * originalWidthPt)})`
  );
}

/**
 * Contexte d'export des repères ancrés dans le texte.
 *
 * Trois sous-systèmes déposent des **jalons** (« milestones ») autour de leurs
 * plages : signets, commentaires et révisions. ODF les représente tous les trois
 * par des éléments vides appariés — `text:bookmark-start`/`-end`,
 * `office:annotation`/`office:annotation-end`, `text:change-start`/`-end` — et
 * non par des conteneurs. C'est ce qui les autorise à se chevaucher librement,
 * là où un balisage imbriqué l'interdirait.
 */
interface MarkerContext {
  comments: ReadonlyMap<string, DocumentComment[]>;
  /** Révisions de suppression : leur texte part dans l'en-tête, pas dans le corps. */
  deletions: ReadonlySet<string>;
  /** Révisions déjà jalonnées, pour n'émettre qu'un `text:change` par coupure. */
  emittedDeletions: Set<string>;
  /**
   * Numéros de figure du document, par `blockId:offset`.
   *
   * Résolus à l'export : ODF les porterait par un `text:sequence`, mais un
   * numéro écrit en clair est lisible par tout le monde, y compris par les
   * lecteurs qui ne recalculent pas les champs.
   */
  figureNumbers?: ReadonlyMap<string, number> | undefined;
}

/** Sérialise l'annotation d'un fil de commentaires et ses réponses. */
function serializeAnnotation(threadId: string, thread: readonly DocumentComment[]): string {
  let out = '';
  thread.forEach((comment, index) => {
    // Les réponses sont des annotations ponctuelles nommées `id~rN` : ODF 1.2
    // ne connaît pas les fils, et un identifiant dérivé les rattache au fil
    // d'origine à la relecture sans étendre le format.
    const name = index === 0 ? threadId : `${threadId}~r${index}`;
    // `loext:resolved` : ODF 1.2 ignore la notion de fil clos, elle n'arrive
    // qu'en 1.3. On écrit l'attribut d'extension de LibreOffice — un lecteur
    // qui ne le connaît pas l'ignore simplement, et le fil reste lisible.
    const clos = comment.resolved ? ' loext:resolved="true"' : '';
    out +=
      `<office:annotation office:name="${escapeXml(name)}"${clos}>` +
      `<dc:creator>${escapeXml(comment.author)}</dc:creator>` +
      `<dc:date>${escapeXml(comment.createdAt)}</dc:date>` +
      `<text:p>${escapeXml(comment.text)}</text:p>` +
      `</office:annotation>`;
  });
  return out;
}

/** Jalons ouvrants et fermants entre deux runs voisins. */
function serializeMarkers(
  previous: TextRun | null,
  current: TextRun | null,
  ctx: MarkerContext,
): string {
  const wasBookmark = previous?.bookmarkName;
  const isBookmark = current?.bookmarkName;
  const wasComments = previous ? commentIdsOf(previous) : [];
  const isComments = current ? commentIdsOf(current) : [];
  const wasChange = previous?.redlineId;
  const isChange = current?.redlineId;

  let out = '';

  // Fermetures d'abord : une plage close puis une plage ouverte au même point
  // se lisent dans cet ordre, et l'inverse produirait un chevauchement fictif.
  if (wasBookmark && wasBookmark !== isBookmark) {
    out += `<text:bookmark-end text:name="${escapeXml(wasBookmark)}"/>`;
  }
  for (const id of wasComments) {
    if (!isComments.includes(id)) out += `<office:annotation-end office:name="${escapeXml(id)}"/>`;
  }
  if (wasChange && wasChange !== isChange && !ctx.deletions.has(wasChange)) {
    out += `<text:change-end text:change-id="${escapeXml(wasChange)}"/>`;
  }

  // Ouvertures ensuite.
  if (isChange && isChange !== wasChange && !ctx.deletions.has(isChange)) {
    out += `<text:change-start text:change-id="${escapeXml(isChange)}"/>`;
  }
  for (const id of isComments) {
    if (wasComments.includes(id)) continue;
    out += serializeAnnotation(id, ctx.comments.get(id) ?? []);
  }
  if (isBookmark && isBookmark !== wasBookmark) {
    out += `<text:bookmark-start text:name="${escapeXml(isBookmark)}"/>`;
  }

  return out;
}

function serializeParagraph(
  node: ParagraphNode,
  styles: AutomaticStyles,
  hrefBySrc: ReadonlyMap<string, string> = new Map(),
  ctx: MarkerContext = EMPTY_MARKER_CONTEXT,
): string {
  const tag = node.type === 'heading' ? 'text:h' : 'text:p';
  const levelAttr = node.headingLevel ? ` text:outline-level="${node.headingLevel}"` : '';
  const styleName = styles.paragraph(node);
  const styleAttr = styleName ? ` text:style-name="${styleName}"` : '';

  // Ancre de renvoi d'un titre : c'est elle que vise une ligne de sommaire, et
  // elle doit exister dans le fichier pour que le lien survive à l'aller-retour.
  const headingAnchor =
    node.type === 'heading' && paragraphText(node).trim().length > 0
      ? `<text:bookmark text:name="${escapeXml(headingAnchorName(node.id))}"/>`
      : '';

  // Le test de vacuité regarde le **texte** : un paragraphe ne portant qu'une
  // image n'a pour texte que le caractère de substitution, mais il n'est pas vide.
  const porteUneImage = node.runs.some(isImageRun);
  if (!porteUneImage && (node.runs.length === 0 || paragraphText(node).length === 0)) {
    const marqueurs = serializeMarkers(null, node.runs[0] ?? null, ctx) + serializeMarkers(node.runs[0] ?? null, null, ctx);
    return marqueurs || headingAnchor
      ? `<${tag}${styleAttr}${levelAttr}>${headingAnchor}${marqueurs}</${tag}>`
      : `<${tag}${styleAttr}${levelAttr}/>`;
  }

  let body = headingAnchor;
  let atStart = true;
  let previous: TextRun | null = null;
  let offset = 0;

  for (const run of node.runs) {
    const runOffset = offset;
    offset += run.text.length;
    if (run.text.length === 0) continue;

    body += serializeMarkers(previous, run, ctx);
    previous = run;

    // Texte marqué supprimé : son contenu part dans `<text:deletion>` de
    // l'en-tête, comme l'exige ODF 1.2 (§5.5.4). Le corps ne garde qu'un jalon,
    // faute de quoi un lecteur tiers afficherait le texte supprimé comme
    // présent — l'inverse exact de ce qu'une révision veut dire.
    if (run.redlineId && ctx.deletions.has(run.redlineId)) {
      if (!ctx.emittedDeletions.has(run.redlineId)) {
        ctx.emittedDeletions.add(run.redlineId);
        body += `<text:change text:change-id="${escapeXml(run.redlineId)}"/>`;
      }
      continue;
    }

    if (isImageRun(run)) {
      body += serializeImage(
        run,
        hrefBySrc,
        styles,
        ctx.figureNumbers?.get(imageKey(node.id, runOffset)) ?? null,
      );
      atStart = false;
      continue;
    }

    if (run.footnoteText) {
      body += `<text:note text:note-class="footnote"><text:note-citation>${escapeXml(run.text)}</text:note-citation><text:note-body><text:p>${escapeXml(run.footnoteText)}</text:p></text:note-body></text:note>`;
      atStart = false;
      continue;
    }

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

  body += serializeMarkers(previous, null, ctx);

  return `<${tag}${styleAttr}${levelAttr}>${body}</${tag}>`;
}

const EMPTY_MARKER_CONTEXT: MarkerContext = {
  comments: new Map(),
  deletions: new Set(),
  emittedDeletions: new Set(),
};

function serializeTable(
  table: TableNode,
  styles: AutomaticStyles,
  hrefBySrc: ReadonlyMap<string, string> = new Map(),
): string {
  const tableStyle = styles.table(table);

  const firstRow = table.rows[0];
  const colCount = Math.max(1, firstRow ? firstRow.cells.length : 1);
  const defaultColWidth = 100 / colCount;

  const columnsXml = (firstRow ? firstRow.cells : [{ widthPercent: 100 }])
    .map((cell) => {
      const colStyle = styles.column(cell.widthPercent ?? defaultColWidth);
      return `<table:table-column table:style-name="${colStyle}"/>`;
    })
    .join('');

  const rowsXml = table.rows.map((row) => {
    const cellsXml = row.cells.map((cell) => {
      const cellStyle = styles.cell(cell);
      const colSpanAttr = (cell.colSpan ?? 1) > 1 ? ` table:number-columns-spanned="${cell.colSpan}"` : '';
      const rowSpanAttr = (cell.rowSpan ?? 1) > 1 ? ` table:number-rows-spanned="${cell.rowSpan}"` : '';

      const contentXml = cell.blocks
        .map((p) => serializeParagraph(p, styles, hrefBySrc))
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
    columnsXml +
    rowsSection +
    `</table:table>`
  );
}

/**
 * Sérialise une table des matières. Transposition d'`XMLTextSectionExport`
 * pour `TOX_CONTENT` (`xmloff/source/text/txtparae.cxx`).
 *
 * ODF sépare la **définition** (`text:table-of-content-source`) du **rendu**
 * (`text:index-body`), et impose les deux : la définition permet à Writer de
 * régénérer la table, le rendu permet à un lecteur qui n'en est pas capable
 * d'afficher tout de même quelque chose. On écrit donc les deux, avec les
 * entrées telles qu'elles sont connues sans pagination — un lecteur tiers
 * verra les titres, et Writer recalculera les numéros à l'ouverture.
 */
function serializeToc(doc: WriterDocumentState, toc: TocNode): string {
  const entries = tocEntries(doc, toc)
    .map(
      (entry) =>
        `<text:p text:style-name="Contents_20_${entry.level}">` +
        `<text:a xlink:type="simple" xlink:href="#${escapeXml(entry.anchorName)}">` +
        `${escapeXml(entry.text)}</text:a></text:p>`,
    )
    .join('');

  const levelStyles = Array.from({ length: toc.maxLevel }, (_, i) => {
    const level = i + 1;
    return (
      `<text:table-of-content-entry-template text:outline-level="${level}" ` +
      `text:style-name="Contents_20_${level}">` +
      `<text:index-entry-link-start/>` +
      `<text:index-entry-chapter/>` +
      `<text:index-entry-text/>` +
      (toc.showPageNumbers
        ? `<text:index-entry-tab-stop style:type="right"${toc.useDotLeader ? ' style:leader-char="."' : ''}/>` +
          `<text:index-entry-page-number/>`
        : '') +
      `<text:index-entry-link-end/>` +
      `</text:table-of-content-entry-template>`
    );
  }).join('');

  return (
    `<text:table-of-content text:name="${escapeXml(toc.id)}" text:protected="true">` +
    `<text:table-of-content-source text:outline-level="${toc.maxLevel}" ` +
    `text:use-outline-level="true" text:use-index-marks="false">` +
    `<text:index-title-template>${escapeXml(toc.title)}</text:index-title-template>` +
    levelStyles +
    `</text:table-of-content-source>` +
    `<text:index-body>` +
    (toc.title.trim()
      ? `<text:index-title text:name="${escapeXml(toc.id)}_Head">` +
        `<text:p text:style-name="Contents_20_Heading">${escapeXml(toc.title)}</text:p>` +
        `</text:index-title>`
      : '') +
    entries +
    `</text:index-body>` +
    `</text:table-of-content>`
  );
}

/**
 * En-tête `<text:tracked-changes>`. Transposition de `XMLRedlineExport`
 * (`xmloff/source/text/XMLRedlineExport.cxx`).
 *
 * ODF exige que **tout** le texte supprimé vive ici et non dans le corps : le
 * corps ne garde qu'un jalon `text:change`. C'est ce qui permet à un lecteur
 * qui ignore les révisions d'afficher le document *tel qu'il serait accepté*,
 * sans montrer par erreur du texte que quelqu'un a demandé de retirer.
 */
function serializeTrackedChanges(
  doc: WriterDocumentState,
  deletedText: ReadonlyMap<string, string>,
): string {
  const redlines = doc.redlines ?? [];
  if (redlines.length === 0) return '';

  const regions = redlines
    .map((redline) => {
      const info =
        `<office:change-info>` +
        `<dc:creator>${escapeXml(redline.author)}</dc:creator>` +
        `<dc:date>${escapeXml(redline.date)}</dc:date>` +
        (redline.comment ? `<text:p>${escapeXml(redline.comment)}</text:p>` : '') +
        `</office:change-info>`;

      if (redline.type === 'delete') {
        const text = deletedText.get(redline.id) ?? '';
        return (
          `<text:changed-region text:id="${escapeXml(redline.id)}">` +
          `<text:deletion>${info}<text:p>${escapeXml(text)}</text:p></text:deletion>` +
          `</text:changed-region>`
        );
      }

      const kind = redline.type === 'format' ? 'text:format-change' : 'text:insertion';
      return (
        `<text:changed-region text:id="${escapeXml(redline.id)}">` +
        `<${kind}>${info}</${kind}>` +
        `</text:changed-region>`
      );
    })
    .join('');

  return `<text:tracked-changes>${regions}</text:tracked-changes>`;
}

/** Texte couvert par chaque révision de suppression, dans l'ordre du flux. */
function collectDeletedText(doc: WriterDocumentState): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (paragraphs: readonly ParagraphNode[]): void => {
    for (const paragraph of paragraphs) {
      for (const run of paragraph.runs) {
        if (run.redlineType !== 'delete' || !run.redlineId) continue;
        out.set(run.redlineId, (out.get(run.redlineId) ?? '') + run.text);
      }
    }
  };

  for (const block of doc.blocks) {
    if (isTable(block)) {
      for (const row of block.rows) for (const cell of row.cells) visit(cell.blocks);
    } else if (isParagraph(block)) {
      visit([block]);
    }
  }
  return out;
}

/**
 * Sérialise une suite de paragraphes de liste en structure ODF.
 *
 * Transposition d'`XMLTextParagraphExport::exportListChange`
 * (`xmloff/source/text/txtparae.cxx`).
 *
 * ## Le problème de forme
 *
 * Le modèle porte la liste comme un **attribut de paragraphe** — c'est le choix
 * de `SwTxtNode`, où changer le niveau d'un élément ne déplace aucun nœud. ODF,
 * lui, exige une **structure imbriquée** : `<text:list>` contenant des
 * `<text:list-item>`, eux-mêmes pouvant contenir un `<text:list>` de plus.
 *
 * La conversion est donc une reconstruction d'arbre à partir d'une suite plate.
 * L'algorithme tient dans une pile de niveaux ouverts : on ferme ce qui dépasse,
 * on ouvre ce qui manque, et on n'émet le paragraphe qu'une fois la profondeur
 * atteinte.
 *
 * Sans cette étape, une liste s'exportait en paragraphes indentés — visuellement
 * proches, mais définitivement perdus comme liste à la relecture.
 */
function serializeList(
  paragraphs: readonly ParagraphNode[],
  styles: AutomaticStyles,
  hrefBySrc: ReadonlyMap<string, string>,
  ctx: MarkerContext,
): string {
  const premier = paragraphs[0];
  if (!premier?.listKind) return '';

  const styleName = styles.list(premier.listKind);
  let out = '';
  /** Niveaux de `<text:list>` actuellement ouverts. */
  let profondeur = 0;

  for (const paragraph of paragraphs) {
    const niveau = Math.max(0, paragraph.listLevel ?? 0);

    // Fermer les niveaux devenus trop profonds.
    while (profondeur > niveau + 1) {
      out += '</text:list-item></text:list>';
      profondeur -= 1;
    }

    if (profondeur === niveau + 1) {
      // Même niveau : on clôt l'élément courant et on en ouvre un neuf.
      out += '</text:list-item>';
      out += ouvrirElement(paragraph);
    } else {
      // Descendre : chaque cran ouvre une liste **dans** l'élément courant.
      while (profondeur < niveau + 1) {
        // Le style ne se pose que sur la liste racine : ODF le fait hériter,
        // et le répéter ferait redémarrer la numérotation à chaque sous-niveau.
        out += profondeur === 0 ? `<text:list text:style-name="${styleName}">` : '<text:list>';
        out += ouvrirElement(paragraph);
        profondeur += 1;
      }
    }

    out += serializeParagraph(paragraph, styles, hrefBySrc, ctx);
  }

  while (profondeur > 0) {
    out += '</text:list-item></text:list>';
    profondeur -= 1;
  }

  return out;
}

/**
 * Ouvre un `<text:list-item>`, avec sa reprise de compteur s'il en porte une.
 *
 * `text:start-value` est ce qui distingue « continuer » de « repartir » : sans
 * lui, un élément marqué `listRestart` reprendrait simplement la numérotation
 * en cours.
 */
function ouvrirElement(paragraph: ParagraphNode): string {
  const reprise =
    paragraph.listRestart && paragraph.listStartValue !== undefined
      ? ` text:start-value="${paragraph.listStartValue}"`
      : '';
  return `<text:list-item${reprise}>`;
}

/**
 * Découpe le flux en tranches homogènes : suites de listes et blocs isolés.
 *
 * Deux paragraphes appartiennent à la même liste s'ils partagent leur
 * `listId` — c'est `RES_PARATR_LIST_ID`, et c'est lui qui décide qu'une liste
 * séparée par du texte repart à 1 plutôt que de continuer à 4.
 */
function groupBlocks(blocks: readonly DocumentBlock[]): (DocumentBlock | ParagraphNode[])[] {
  const out: (DocumentBlock | ParagraphNode[])[] = [];
  let courant: ParagraphNode[] = [];
  let listIdCourant: string | undefined;

  const clore = (): void => {
    if (courant.length > 0) out.push(courant);
    courant = [];
    listIdCourant = undefined;
  };

  for (const block of blocks) {
    const estListe = isParagraph(block) && block.listKind !== undefined;

    if (!estListe) {
      clore();
      out.push(block);
      continue;
    }

    const paragraph = block as ParagraphNode;
    const listId = paragraph.listId;

    // Changement de liste : on ferme la précédente. Deux listes voisines sans
    // identifiant sont deux listes distinctes, comme dans Writer.
    if (courant.length > 0 && (listId === undefined || listId !== listIdCourant)) {
      clore();
    }

    if (courant.length === 0) listIdCourant = listId;
    courant.push(paragraph);
  }

  clore();
  return out;
}

/** Produit le `content.xml` complet. */
export function buildContentXml(
  doc: WriterDocumentState,
  hrefBySrc: ReadonlyMap<string, string> = new Map(),
): string {
  const styles = new AutomaticStyles();

  const commentsByThread = new Map<string, DocumentComment[]>();
  for (const comment of doc.comments ?? []) {
    const list = commentsByThread.get(comment.threadId) ?? [];
    list.push(comment);
    commentsByThread.set(comment.threadId, list);
  }
  // Racine d'abord, puis réponses par ordre de dépôt : c'est l'ordre dans
  // lequel `serializeAnnotation` dérive les identifiants `~rN`.
  for (const list of commentsByThread.values()) {
    list.sort((a, b) => {
      if (a.id === a.threadId) return -1;
      if (b.id === b.threadId) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  const deletedText = collectDeletedText(doc);
  const ctx: MarkerContext = {
    comments: commentsByThread,
    deletions: new Set(
      (doc.redlines ?? []).filter((r) => r.type === 'delete').map((r) => r.id),
    ),
    emittedDeletions: new Set(),
    figureNumbers: figureNumbering(doc),
  };

  const body =
    serializeTrackedChanges(doc, deletedText) +
    groupBlocks(doc.blocks)
      .map((entree) => {
        // Une tranche de liste : elle devient un arbre `<text:list>`.
        if (Array.isArray(entree)) return serializeList(entree, styles, hrefBySrc, ctx);
        if (isTable(entree)) return serializeTable(entree, styles, hrefBySrc);
        if (isToc(entree)) return serializeToc(doc, entree);
        return serializeParagraph(entree, styles, hrefBySrc, ctx);
      })
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

/**
 * Manifeste de l'archive.
 *
 * Chaque entrée du ZIP doit y figurer avec son type — images comprises. Une
 * image absente du manifeste est ignorée par Writer, qui ouvre alors le
 * document avec des cadres vides : le fichier est bien là, mais rien ne dit au
 * lecteur ce qu'il contient.
 */
export function buildManifestXml(pictures: readonly OdfPicture[] = []): string {
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
    pictures.map((picture) => entry(picture.path, picture.mediaType)).join('') +
    `</manifest:manifest>`
  );
}

/** Les fichiers texte d'une archive `.odt`. */
export interface OdfPackageFiles {
  mimetype: string;
  'META-INF/manifest.xml': string;
  'content.xml': string;
  'styles.xml': string;
  'meta.xml': string;
}

/** Une archive complète : ses fichiers XML et ses images binaires. */
export interface OdfPackage {
  files: OdfPackageFiles;
  pictures: OdfPicture[];
}

export const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';

/** Produit l'arborescence complète des fichiers d'une archive `.odt`. */
export function buildOdfPackage(doc: WriterDocumentState): OdfPackage {
  // Les images sont collectées **avant** l'écriture du contenu : c'est cette
  // passe qui attribue à chaque source son chemin `Pictures/…`, et le XML doit
  // s'y référer.
  const { pictures, hrefBySrc } = collectPictures(doc);

  return {
    files: {
      mimetype: ODT_MIMETYPE,
      'META-INF/manifest.xml': buildManifestXml(pictures),
      'content.xml': buildContentXml(doc, hrefBySrc),
      'styles.xml': buildStylesXml(doc),
      'meta.xml': buildMetaXml(doc),
    },
    pictures,
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
    if (isParagraph(block)) {
      lignes.push(paragraphText(block));
      continue;
    }
    // Un sommaire n'a pas de texte propre : ses lignes sont dérivées des titres,
    // qui sont déjà comptés par ailleurs. Les inclure doublerait chaque titre.
    if (!isTable(block)) continue;
    for (const row of block.rows) {
      lignes.push(row.cells.map((cell) => cell.blocks.map(paragraphText).join(' ')).join('\t'));
    }
  }
  return lignes.join('\n');
}
