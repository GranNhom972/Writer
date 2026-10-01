// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * OpenDocument export. (OpenOffice: `XMLTextParagraphExport`, `xmloff/source/text/txtparae.cxx`,
 * called from `txtexp.cxx`.)
 *
 * The export is exactly the inverse of the import: the formatting carried by the runs is **factored** into
 * automatic styles, and the characters that XML cannot carry as they are (consecutive spaces, tabs, line
 * breaks) go back to their ODF element form.
 *
 * It faithfully supports the export of OpenOffice headers and footers (`<style:header>`, `<style:footer>`,
 * `<style:header-left>`, `<style:footer-left>`) and their styles.
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
/** ODF version produced: the one that Writer 4.1 reads as well as modern suites. */
const ODF_VERSION = '1.2';

/**
 * Serializes the text of a run.
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
 * Frame of an image anchored "as a character".
 *
 * `text:anchor-type="as-char"` is the ODF translation of `FLY_AS_CHAR`: it is the attribute that tells the
 * reader to make the frame flow in the line rather than place it as a floating one. Without it, Writer
 * reopens the document with every image anchored to the paragraph and pushed into the margin.
 *
 * `svg:width`/`svg:height` are mandatory: a frame with no dimensions is drawn at zero size by Writer, and the
 * image becomes invisible.
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

  // Floating frame: the anchoring and the wrapping are declared, and the position becomes absolute within its
  // anchor. `text:anchor-type` carries the anchoring, `style:wrap` of the style carries the wrapping: ODF
  // separates them, unlike the model where both travel on the same run.
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
   * Captioned image: the ODF structure is an **enclosing** frame that carries a `draw:text-box`, which contains a
   * paragraph where the image and its text sit side by side. This is what Writer produces, and what every reader
   * knows how to display.
   *
   * The number is written **in plain text**, resolved at export time: ODF would carry it as a `text:sequence`,
   * which we cannot read back. Our own attributes, alongside, keep the mode and the alignment so that reading it
   * back here loses nothing, and a third-party reader ignores them.
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
 * `fo:clip="rect(top right bottom left)"`: the crop in ODF format.
 *
 * ODF expresses the four insets as **lengths**, cut from the original image, whereas the model carries them as
 * fractions. The conversion goes through the size the **uncropped** image would have at the current scale
 * factor: the frame shows the visible fraction, so the original would measure `width / visibleFraction`.
 *
 * The order of the four values is the CSS one (top, right, bottom, left), and reversing it would rotate the
 * framing by a quarter turn when read back.
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
 * Export context for the markers anchored in the text.
 *
 * Three subsystems drop **milestones** around their ranges: bookmarks, comments and revisions. ODF represents
 * all three as paired empty elements (`text:bookmark-start`/`-end`, `office:annotation`/`office:annotation-end`,
 * `text:change-start`/`-end`) and not as containers. That is what lets them overlap freely, where nested markup
 * would forbid it.
 */
interface MarkerContext {
  comments: ReadonlyMap<string, DocumentComment[]>;
  /** Deletion revisions: their text goes into the header, not into the body. */
  deletions: ReadonlySet<string>;
  /** Revisions already marked with milestones, to emit only one `text:change` per cut. */
  emittedDeletions: Set<string>;
  /**
   * Figure numbers of the document, by `blockId:offset`.
   *
   * Resolved at export: ODF would carry them as a `text:sequence`, but a number written in plain text is readable
   * by everyone, including readers that do not recompute fields.
   */
  figureNumbers?: ReadonlyMap<string, number> | undefined;
}

/** Serializes the annotation of a comment thread and its replies. */
function serializeAnnotation(threadId: string, thread: readonly DocumentComment[]): string {
  let out = '';
  thread.forEach((comment, index) => {
    // Replies are point annotations named `id~rN`: ODF 1.2 has no threads, and a derived id ties them to the
    // original thread when reading back, without extending the format.
    const name = index === 0 ? threadId : `${threadId}~r${index}`;
    // `loext:resolved`: ODF 1.2 ignores the notion of a closed thread, which only arrives in 1.3. We write
    // LibreOffice's extension attribute: a reader that does not know it simply ignores it, and the thread stays
    // readable.
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

/** Opening and closing milestones between two neighboring runs. */
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

  // Closings first: a range that closes and a range that opens at the same point are read in that order, and the
  // reverse would produce a fictitious overlap.
  if (wasBookmark && wasBookmark !== isBookmark) {
    out += `<text:bookmark-end text:name="${escapeXml(wasBookmark)}"/>`;
  }
  for (const id of wasComments) {
    if (!isComments.includes(id)) out += `<office:annotation-end office:name="${escapeXml(id)}"/>`;
  }
  if (wasChange && wasChange !== isChange && !ctx.deletions.has(wasChange)) {
    out += `<text:change-end text:change-id="${escapeXml(wasChange)}"/>`;
  }

  // Openings next.
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

  // Cross-reference anchor of a heading: it is what a line of a table of contents points to, and it must exist in
  // the file for the link to survive the round trip.
  const headingAnchor =
    node.type === 'heading' && paragraphText(node).trim().length > 0
      ? `<text:bookmark text:name="${escapeXml(headingAnchorName(node.id))}"/>`
      : '';

  // The emptiness test looks at the **text**: a paragraph that only carries an image has nothing but the
  // replacement character as text, yet it is not empty.
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

    // Text marked as deleted: its content goes into the header's `<text:deletion>`, as ODF 1.2 requires (§5.5.4).
    // The body only keeps a milestone, otherwise a third-party reader would show the deleted text as present, the
    // exact opposite of what a revision means.
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
 * Serializes a table of contents. (OpenOffice: `XMLTextSectionExport` for `TOX_CONTENT`,
 * `xmloff/source/text/txtparae.cxx`.)
 *
 * ODF separates the **definition** (`text:table-of-content-source`) from the **rendering** (`text:index-body`),
 * and requires both: the definition lets Writer regenerate the table, the rendering lets a reader that cannot do
 * so still display something. So we write both, with the entries as they are known without pagination: a
 * third-party reader will see the headings, and Writer will recompute the numbers when it opens the file.
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
 * Header `<text:tracked-changes>`. (OpenOffice: `XMLRedlineExport`, `xmloff/source/text/XMLRedlineExport.cxx`.)
 *
 * ODF requires **all** the deleted text to live here and not in the body: the body only keeps a `text:change`
 * milestone. That is what lets a reader that ignores revisions show the document *as it would be accepted*,
 * without wrongly displaying text that somebody asked to remove.
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

/** Text covered by each deletion revision, in flow order. */
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
 * Serializes a sequence of list paragraphs into the ODF structure.
 *
 * Counterpart of `XMLTextParagraphExport::exportListChange` (`xmloff/source/text/txtparae.cxx`).
 *
 * ## The shape problem
 *
 * The model carries the list as a **paragraph attribute**: that is the choice of `SwTxtNode`, where changing an
 * item's level moves no node. ODF, on the other hand, requires a **nested structure**: a `<text:list>` containing
 * `<text:list-item>`s, which can themselves contain one more `<text:list>`.
 *
 * The conversion is therefore a rebuild of a tree from a flat sequence. The algorithm fits in a stack of open
 * levels: close what goes beyond, open what is missing, and only emit the paragraph once the depth is reached.
 *
 * Without this step, a list was exported as indented paragraphs: visually close, but definitively lost as a list
 * when read back.
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
  /** Levels of `<text:list>` currently open. */
  let profondeur = 0;

  for (const paragraph of paragraphs) {
    const niveau = Math.max(0, paragraph.listLevel ?? 0);

    // Close the levels that have become too deep.
    while (profondeur > niveau + 1) {
      out += '</text:list-item></text:list>';
      profondeur -= 1;
    }

    if (profondeur === niveau + 1) {
      // Same level: close the current item and open a new one.
      out += '</text:list-item>';
      out += ouvrirElement(paragraph);
    } else {
      // Going down: each step opens a list **inside** the current item.
      while (profondeur < niveau + 1) {
        // The style is only set on the root list: ODF makes it inherited, and repeating it would restart the numbering at
        // every sub-level.
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
 * Opens a `<text:list-item>`, with its counter restart if it carries one.
 *
 * `text:start-value` is what tells "continue" from "start over": without it, an item marked `listRestart` would
 * simply carry on the current numbering.
 */
function ouvrirElement(paragraph: ParagraphNode): string {
  const reprise =
    paragraph.listRestart && paragraph.listStartValue !== undefined
      ? ` text:start-value="${paragraph.listStartValue}"`
      : '';
  return `<text:list-item${reprise}>`;
}

/**
 * Splits the flow into homogeneous slices: runs of lists and isolated blocks.
 *
 * Two paragraphs belong to the same list if they share their `listId`: this is `RES_PARATR_LIST_ID`, and it is what
 * decides that a list separated by text starts again at 1 rather than continuing at 4.
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

    // List change: we close the previous one. Two neighboring lists with no id are two distinct lists, as in Writer.
    if (courant.length > 0 && (listId === undefined || listId !== listIdCourant)) {
      clore();
    }

    if (courant.length === 0) listIdCourant = listId;
    courant.push(paragraph);
  }

  clore();
  return out;
}

/** Produces the complete `content.xml`. */
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
  // Root first, then replies in the order they were posted: this is the order in which `serializeAnnotation` derives
  // the `~rN` ids.
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
        // A slice of list: it becomes a `<text:list>` tree.
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

/** Produces `styles.xml`: named styles, page geometry, and headers/footers. */
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
 * Manifest of the archive.
 *
 * Every ZIP entry must be listed in it with its type, images included. An image that is missing from the manifest is
 * ignored by Writer, which then opens the document with empty frames: the file is there, but nothing tells the reader
 * what it contains.
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

/** The text files of an `.odt` archive. */
export interface OdfPackageFiles {
  mimetype: string;
  'META-INF/manifest.xml': string;
  'content.xml': string;
  'styles.xml': string;
  'meta.xml': string;
}

/** A complete archive: its XML files and its binary images. */
export interface OdfPackage {
  files: OdfPackageFiles;
  pictures: OdfPicture[];
}

export const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';

/** Produces the complete file tree of an `.odt` archive. */
export function buildOdfPackage(doc: WriterDocumentState): OdfPackage {
  // Images are collected **before** the content is written: this pass gives each source its `Pictures/…` path, and the
  // XML has to refer to it.
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
 * Plain text of the document, tables included.
 *
 * Used by round-trip tests and by the preview: two documents whose plain text differs did not survive going through the
 * format.
 */
export function documentPlainText(doc: WriterDocumentState): string {
  const lignes: string[] = [];
  for (const block of doc.blocks) {
    if (isParagraph(block)) {
      lignes.push(paragraphText(block));
      continue;
    }
    // A table of contents has no text of its own: its lines are derived from the headings, which are already counted
    // elsewhere. Including them would double every heading.
    if (!isTable(block)) continue;
    for (const row of block.rows) {
      lignes.push(row.cells.map((cell) => cell.blocks.map(paragraphText).join(' ')).join('\t'));
    }
  }
  return lignes.join('\n');
}
