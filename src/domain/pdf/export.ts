// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Native PDF export engine. (OpenOffice: `vcl::PDFWriter`
 * (`aoo-4.1.16/main/vcl/source/gdi/pdfwriter_impl.cxx`) and `PDFExport`
 * (`aoo-4.1.16/main/filter/source/pdf/pdfexport.cxx`).)
 *
 * Produces a standalone, compliant binary PDF 1.4 document, with no external dependency.
 */

import { isParagraph, type WriterDocumentState } from '../document/types';
import { MM_PER_INCH, PT_PER_INCH, PX_PER_INCH } from '../document/units';
import type { DocumentLayout, LaidOutFly, PlacedParagraph, PlacedTable } from '../engine/paginate';
import { cellFrameHeightPx } from '../engine/paginate';
import type { LayoutSegment } from '../engine/lineBreak';
import { hasCrop, imageCrop, visibleFraction } from '../document/images';
import {
  showsOn,
  resolveGeometry,
  renderFurniture,
  getThreeZones,
  blocksOf,
} from '../document/pageFurniture';

/**
 * Conversion ratios to the PDF point (72 DPI).
 *
 * Derived from the units foundation and not rewritten: the export and the screen must share exactly the same
 * definitions, otherwise a geometry that is right on screen can drift on paper.
 */
const PX_TO_PT = PT_PER_INCH / PX_PER_INCH; // 0.75
const MM_TO_PT = PT_PER_INCH / MM_PER_INCH; // ~2.83464567

/** Mapping table from fonts to the 14 base PDF fonts (Base 14). */
type PdfFontKey =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique'
  | 'Symbol'
  | 'ZapfDingbats';

function resolveBase14Font(family: string | undefined, bold = false, italic = false): PdfFontKey {
  const f = (family || '').toLowerCase();

  if (f.includes('courier') || f.includes('mono') || f.includes('consolas')) {
    if (bold && italic) return 'Courier-BoldOblique';
    if (bold) return 'Courier-Bold';
    if (italic) return 'Courier-Oblique';
    return 'Courier';
  }

  if (
    f.includes('times') ||
    f.includes('serif') ||
    f.includes('georgia') ||
    f.includes('garamond') ||
    f.includes('cambria')
  ) {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }

  // Default sans-serif font (Helvetica / Arial / Liberation Sans)
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/**
 * WinAnsi encoding for PDF text strings.
 * Escapes the reserved characters `\`, `(` and `)` and converts accented and special characters into octal
 * sequences `\ooo` that follow the WinAnsiEncoding table.
 */
function encodeWinAnsiText(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    // Direct PDF escape characters
    if (code === 0x5c) {
      // '\'
      result += '\\\\';
    } else if (code === 0x28) {
      // '('
      result += '\\(';
    } else if (code === 0x29) {
      // ')'
      result += '\\)';
    } else if (code >= 32 && code <= 126) {
      // Standard printable ASCII
      result += str[i];
    } else {
      // Extended WinAnsi mapping table
      let ansiCode = code;
      if (code === 0x20ac) ansiCode = 0x80; // €
      else if (code === 0x201a) ansiCode = 0x82; // ‚
      else if (code === 0x0192) ansiCode = 0x83; // ƒ
      else if (code === 0x201e) ansiCode = 0x84; // „
      else if (code === 0x2026) ansiCode = 0x85; // …
      else if (code === 0x2020) ansiCode = 0x86; // †
      else if (code === 0x2021) ansiCode = 0x87; // ‡
      else if (code === 0x02c6) ansiCode = 0x88; // ˆ
      else if (code === 0x2030) ansiCode = 0x89; // ‰
      else if (code === 0x0160) ansiCode = 0x8a; // Š
      else if (code === 0x2039) ansiCode = 0x8b; // ‹
      else if (code === 0x0152) ansiCode = 0x8c; // Œ
      else if (code === 0x017d) ansiCode = 0x8e; // Ž
      else if (code === 0x2018) ansiCode = 0x91; // ‘
      else if (code === 0x2019) ansiCode = 0x92; // ’
      else if (code === 0x201c) ansiCode = 0x93; // “
      else if (code === 0x201d) ansiCode = 0x94; // ”
      else if (code === 0x2022) ansiCode = 0x95; // •
      else if (code === 0x2013) ansiCode = 0x96; // –
      else if (code === 0x2014) ansiCode = 0x97; // —
      else if (code === 0x02dc) ansiCode = 0x98; // ˜
      else if (code === 0x2122) ansiCode = 0x99; // ™
      else if (code === 0x0161) ansiCode = 0x9a; // š
      else if (code === 0x203a) ansiCode = 0x9b; // ›
      else if (code === 0x0153) ansiCode = 0x9c; // œ
      else if (code === 0x017e) ansiCode = 0x9e; // ž
      else if (code === 0x0178) ansiCode = 0x9f; // Ÿ
      else if (code === 0x00a0) ansiCode = 0xa0; // non-breaking space
      else if (code > 255) {
        // Character outside the table: fall back to a question mark
        ansiCode = 0x3f;
      }

      const octal = ansiCode.toString(8).padStart(3, '0');
      result += `\\${octal}`;
    }
  }
  return `(${result})`;
}

/** Parses a CSS color (#rrggbb, #rgb, rgb(r,g,b)) and returns [r, g, b] in [0, 1]. */
function parseColorToRgb(colorStr: string | undefined): [number, number, number] {
  if (!colorStr) return [0, 0, 0];
  const s = colorStr.trim().toLowerCase();

  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16) / 255;
      const g = parseInt(hex[1]! + hex[1]!, 16) / 255;
      const b = parseInt(hex[2]! + hex[2]!, 16) / 255;
      return [r, g, b];
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      return [r, g, b];
    }
  }

  const rgbMatch = s.match(/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (rgbMatch) {
    const r = Math.min(255, Math.max(0, parseFloat(rgbMatch[1]!))) / 255;
    const g = Math.min(255, Math.max(0, parseFloat(rgbMatch[2]!))) / 255;
    const b = Math.min(255, Math.max(0, parseFloat(rgbMatch[3]!))) / 255;
    return [r, g, b];
  }

  return [0, 0, 0];
}

const latin1 = (text: string): Uint8Array => {
  // A PDF is a sequence of bytes, not UTF-8: everything we write has already been reduced to ASCII by
  // `encodeWinAnsiText`, and the few high bytes (the binary header) must go through **as they are**.
  // `TextEncoder` would re-encode them on two bytes and shift the whole `xref` table.
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};

/** Low-level PDF document builder. */
class PdfDocumentBuilder {
  /**
   * Indirect objects, as **bytes**.
   *
   * An image stream is binary: keeping it as a string would force re-encoding it at assembly time, and the length
   * announced in `/Length` would no longer match the file: a PDF that readers refuse to open.
   */
  private objects: Uint8Array[] = [];
  private offsets: number[] = [];
  private fontMap = new Map<PdfFontKey, number>();
  private imageMap = new Map<string, number>();

  constructor() {}

  /** Allocates a new indirect object id. */
  newObject(): number {
    this.objects.push(new Uint8Array(0));
    return this.objects.length;
  }

  /** Defines the content of an indirect object. */
  setObject(id: number, content: string): void {
    this.objects[id - 1] = latin1(content);
  }

  /**
   * Defines a stream object whose payload is binary.
   *
   * `/Length` is computed here, on the real bytes: it is the only value a reader uses to find the end of the stream.
   */
  setStreamObject(id: number, dictionary: string, payload: Uint8Array): void {
    const head = latin1(`<< ${dictionary} /Length ${payload.length} >>\nstream\n`);
    const tail = latin1('\nendstream');
    const bytes = new Uint8Array(head.length + payload.length + tail.length);
    bytes.set(head, 0);
    bytes.set(payload, head.length);
    bytes.set(tail, head.length + payload.length);
    this.objects[id - 1] = bytes;
  }

  /**
   * Registers a JPEG image as an XObject, or returns the one already placed.
   *
   * `/DCTDecode` carries the JPEG bytes **without touching them**: it is the same codec on both sides, so there is
   * no decoding and no loss at export. A repeated image (a logo at the top of every section) is written only once,
   * and referenced by every page that carries it.
   */
  getImageObject(src: string, jpegBytes: Uint8Array, widthPx: number, heightPx: number): number {
    const existing = this.imageMap.get(src);
    if (existing !== undefined) return existing;

    const id = this.newObject();
    this.setStreamObject(
      id,
      `/Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpegBytes,
    );
    this.imageMap.set(src, id);
    return id;
  }

  /** The declared image XObjects, for the `/Resources` dictionary. */
  getAllImages(): Map<string, number> {
    return this.imageMap;
  }

  /** Registers or retrieves the object id of a Base 14 font. */
  getFontObject(fontKey: PdfFontKey): number {
    const existing = this.fontMap.get(fontKey);
    if (existing !== undefined) return existing;

    const fontId = this.newObject();
    this.setObject(
      fontId,
      `<< /Type /Font\n   /Subtype /Type1\n   /BaseFont /${fontKey}\n   /Encoding /WinAnsiEncoding\n>>`,
    );
    this.fontMap.set(fontKey, fontId);
    return fontId;
  }

  /** Returns the list of all the registered fonts, for the `/Resources` dictionary. */
  getAllFonts(): Map<PdfFontKey, number> {
    return this.fontMap;
  }

  /**
   * Assembles all the objects and produces the final PDF file.
   *
   * The offsets of the `xref` table are counted in **bytes written**, never in characters: the two differ as soon as a
   * byte goes above 0x7F, and a wrong `startxref` makes the file unreadable for strict readers.
   */
  build(): Uint8Array {
    const parts: Uint8Array[] = [];
    let written = 0;
    const push = (bytes: Uint8Array): void => {
      parts.push(bytes);
      written += bytes.length;
    };

    push(latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    this.offsets = [];

    for (let i = 0; i < this.objects.length; i++) {
      this.offsets.push(written);
      push(latin1(`${i + 1} 0 obj\n`));
      push(this.objects[i]!);
      push(latin1('\nendobj\n'));
    }

    const startXref = written;
    let trailer = `xref\n0 ${this.objects.length + 1}\n`;
    trailer += '0000000000 65535 f \r\n';
    for (const offset of this.offsets) {
      trailer += `${offset.toString().padStart(10, '0')} 00000 n \r\n`;
    }
    trailer += `trailer\n<< /Size ${this.objects.length + 1}\n   /Root 1 0 R\n   /Info 2 0 R\n>>\n`;
    trailer += `startxref\n${startXref}\n%%EOF\n`;
    push(latin1(trailer));

    const out = new Uint8Array(written);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export interface PdfExportOptions {
  author?: string;
  creator?: string;
  /**
   * Images of the document, already decoded to JPEG and indexed by `imageSrc`.
   *
   * Decoding is left to the caller (`domain/image/raster.ts`): it is the one that has the browser at hand. This module
   * stays pure: it places bytes, it does not manufacture them. An image that is missing from the table leaves an empty
   * frame, and the export carries on.
   */
  images?: ReadonlyMap<string, { jpegBytes: Uint8Array; widthPx: number; heightPx: number }>;
}

/**
 * Paints an image frame in a page's content stream.
 *
 * The `cm` matrix of an image XObject maps the unit square onto the wanted rectangle: `width 0 0 height x y cm`
 * followed by `/Ixx Do`. The y coordinate is that of the **bottom** of the frame, the PDF coordinate system having its
 * origin at the bottom of the page.
 *
 * The frame sits on the baseline and rises by its whole height, the same rule as on screen (`SwFlyCntFrm`), so the PDF
 * and the editor show the same page.
 */
function paintImage(
  pdf: PdfDocumentBuilder,
  images: PdfExportOptions['images'],
  seg: Pick<LayoutSegment, 'formatting'>,
  xPt: number,
  baselineYPt: number,
  /** Imposed size, for a floating frame whose box includes the caption. */
  taille?: { widthPt: number; heightPt: number },
): string {
  const src = seg.formatting.imageSrc;
  if (!src) return '';

  const raster = images?.get(src);
  const widthPt = taille?.widthPt ?? (seg.formatting.imageWidthPt ?? 0);
  const heightPt = taille?.heightPt ?? (seg.formatting.imageHeightPt ?? 0);
  if (widthPt <= 0 || heightPt <= 0) return '';

  if (!raster) {
    // Image unavailable: a light grey frame, in the exact place the image occupied. Drawing nothing would move the rest of
    // the page, which would be more misleading than a visible hole.
    let out = 'q\n0.85 0.85 0.85 RG 0.5 w\n';
    out += `${xPt.toFixed(2)} ${baselineYPt.toFixed(2)} ${widthPt.toFixed(2)} ${heightPt.toFixed(2)} re S\nQ\n`;
    return out;
  }

  const id = pdf.getImageObject(src, raster.jpegBytes, raster.widthPx, raster.heightPx);
  const crop = imageCrop(seg.formatting);

  let out = 'q\n';

  if (hasCrop(crop)) {
    // Cropping: PDF has no notion of cutting an image, but it has a **clipping path**. We restrict the drawing to the frame
    // (`re W n`), then place the whole image, enlarged and shifted so that the part we keep falls exactly inside that frame.
    // What overflows is discarded by the path.
    const visible = visibleFraction(crop);
    const pleineLargeurPt = widthPt / visible.width;
    const pleineHauteurPt = heightPt / visible.height;

    out += `${xPt.toFixed(2)} ${baselineYPt.toFixed(2)} ${widthPt.toFixed(2)} ${heightPt.toFixed(2)} re W n\n`;

    // The origin of the PDF coordinate system is at the **bottom** left: so it is the **bottom** inset that shifts the image
    // downwards, not the top one.
    const decalageX = xPt - crop.leftPct * pleineLargeurPt;
    const decalageY = baselineYPt - crop.bottomPct * pleineHauteurPt;
    out += `${pleineLargeurPt.toFixed(2)} 0 0 ${pleineHauteurPt.toFixed(2)} ${decalageX.toFixed(2)} ${decalageY.toFixed(2)} cm\n`;
  } else {
    out += `${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} ${xPt.toFixed(2)} ${baselineYPt.toFixed(2)} cm\n`;
  }

  out += `/I${id} Do\nQ\n`;
  return out;
}

/**
 * Paints a floating frame in its place on the sheet.
 *
 * `paginate` has already resolved the geometry (alignment, anchor, margins) and `LaidOutFly` carries it in pixels from the
 * top-left corner of the **content area**. All that remains is to move to the PDF coordinate system, whose origin is at the
 * bottom left of the sheet: hence the flip of the y coordinate.
 *
 * The **caption** is not painted. Its height is included in that of the frame, and it is what we subtract here to get back
 * the box of the image alone: drawing without subtracting would stretch the image over the place of its text.
 */
function paintFly(
  pdf: PdfDocumentBuilder,
  images: PdfExportOptions['images'],
  laid: LaidOutFly,
  contentLeftPt: number,
  contentTopPt: number,
  pageHeightPt: number,
): string {
  const widthPt = laid.widthPx * PX_TO_PT;
  const imageHeightPt = (laid.heightPx - (laid.fly.captionHeightPx ?? 0)) * PX_TO_PT;
  if (widthPt <= 0 || imageHeightPt <= 0) return '';

  const leftPt = contentLeftPt + laid.leftPx * PX_TO_PT;
  const topPt = contentTopPt + laid.topPx * PX_TO_PT;
  // A caption placed **above** shifts the image down by as much.
  const decalagePt =
    laid.fly.run.imageCaptionPosition === 'above'
      ? (laid.fly.captionHeightPx ?? 0) * PX_TO_PT
      : 0;
  const basPt = pageHeightPt - topPt - decalagePt - imageHeightPt;

  return paintImage(pdf, images, { formatting: laid.fly.run }, leftPt, basPt, {
    widthPt,
    heightPt: imageHeightPt,
  });
}

/**
 * Exports a Writer document and its `DocumentLayout` to binary PDF format.
 *
 * Counterpart of Apache OpenOffice's `PDFExport::Export`.
 */
export function exportToPdfBytes(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  options?: PdfExportOptions,
): Uint8Array {
  const pdf = new PdfDocumentBuilder();

  // 1. Object 1: root Catalog
  const rootId = pdf.newObject(); // 1
  // 2. Object 2: Info metadata
  const infoId = pdf.newObject(); // 2
  // 3. Object 3: page tree (/Pages)
  const pagesTreeId = pdf.newObject(); // 3

  const pageObjectIds: number[] = [];
  const pageStreams: { pageObjId: number; contentObjId: number }[] = [];
  const pageCount = layout.pages.length;
  const geometry = layout.geometry;

  const pageHeightPt = geometry.pageHeightPx * PX_TO_PT;
  const pageWidthPt = geometry.pageWidthPx * PX_TO_PT;
  const contentLeftPt = geometry.contentLeftPx * PX_TO_PT;
  const contentTopPt = geometry.contentTopPx * PX_TO_PT;

  // Creating the font objects that are needed
  const defaultFontKey = resolveBase14Font(doc.defaults.fontFamily, false, false);
  pdf.getFontObject(defaultFontKey);

  // Furniture (header & footer)
  const furniture = doc.furniture;

  // 4. Building each page
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const page = layout.pages[pageIdx]!;
    const pageNum = pageIdx + 1;
    const pageObjId = pdf.newObject();
    const contentObjId = pdf.newObject();
    pageObjectIds.push(pageObjId);

    let stream = '';

    // A. Rendering the furniture (Header and Footer)
    if (furniture && showsOn(furniture, pageNum)) {
      const pageGeom = resolveGeometry(furniture, pageNum);
      const contexte = {
        page: pageNum,
        pages: pageCount,
        titre: doc.meta.title || 'Sans titre',
        auteur: doc.meta.author || '',
      };
      const fontSizePt = furniture.fontSizePt ?? 9;
      const fontKey = resolveBase14Font('Helvetica', false, false);
      const fontObjId = pdf.getFontObject(fontKey);
      const [fr, fg, fb] = parseColorToRgb('#444444');

      // --- Header ---
      const headerZones = getThreeZones(furniture, 'header', pageNum);
      const headerBlocks = blocksOf(furniture, 'header', pageNum);

      if (headerZones.hasContent || headerBlocks.length > 0) {
        const headerTopPt = (furniture.headerMm ?? 12) * MM_TO_PT;
        const headerY = pageHeightPt - headerTopPt - fontSizePt;

        // Header background
        if (furniture.headerBackground) {
          const [bgr, bgg, bgb] = parseColorToRgb(furniture.headerBackground);
          const bandHeightPt = Math.max(pageGeom.headerContentMm, 10) * MM_TO_PT;
          const bandBottomPt = pageHeightPt - (headerTopPt + bandHeightPt);
          stream += `q\n${bgr.toFixed(3)} ${bgg.toFixed(3)} ${bgb.toFixed(3)} rg\n`;
          stream += `0 ${bandBottomPt.toFixed(2)} ${pageWidthPt.toFixed(2)} ${bandHeightPt.toFixed(2)} re f\nQ\n`;
        }

        // Left zone
        if (headerZones.left) {
          const text = renderFurniture(headerZones.left, contexte);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${contentLeftPt.toFixed(2)} ${headerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Center zone
        if (headerZones.center) {
          const text = renderFurniture(headerZones.center, contexte);
          // Centering estimate
          const textWidthPt = text.length * fontSizePt * 0.5;
          const centerX = Math.max(contentLeftPt, (pageWidthPt - textWidthPt) / 2);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${centerX.toFixed(2)} ${headerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Right zone
        if (headerZones.right) {
          const text = renderFurniture(headerZones.right, contexte);
          const textWidthPt = text.length * fontSizePt * 0.52;
          const rightX = Math.max(contentLeftPt, pageWidthPt - contentLeftPt - textWidthPt);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${rightX.toFixed(2)} ${headerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Free blocks of the header (text)
        for (const bloc of headerBlocks) {
          if (bloc.kind === 'text' && bloc.text) {
            const bText = renderFurniture(bloc.text, contexte);
            const bX = contentLeftPt + bloc.x * (pageWidthPt - 2 * contentLeftPt);
            const bY = pageHeightPt - (bloc.y * MM_TO_PT) - (bloc.fontSizePt || 10);
            const bFontKey = resolveBase14Font('Helvetica', bloc.bold, bloc.italic);
            const bFontId = pdf.getFontObject(bFontKey);
            const [br, bg, bb] = parseColorToRgb(bloc.color || '#475467');
            stream += `q\n${br.toFixed(3)} ${bg.toFixed(3)} ${bb.toFixed(3)} rg\nBT\n/F${bFontId} ${bloc.fontSizePt || 10} Tf\n`;
            stream += `1 0 0 1 ${bX.toFixed(2)} ${bY.toFixed(2)} Tm\n`;
            stream += `${encodeWinAnsiText(bText)} Tj\nET\nQ\n`;
          }
        }

        // Separator line under the header
        if (furniture.headerSeparator) {
          const sepWidthPt = furniture.headerSeparatorWidthPt ?? 0.75;
          const [sr, sg, sb] = parseColorToRgb(furniture.headerSeparatorColor ?? '#d0d5dd');
          const lineY = pageHeightPt - (headerTopPt + (pageGeom.headerContentMm ?? 5) * MM_TO_PT);
          const dash = furniture.headerSeparatorStyle === 'dashed' ? '[4 2] 0 d\n' : furniture.headerSeparatorStyle === 'dotted' ? '[1 2] 0 d\n' : '';
          stream += `q\n${sr.toFixed(3)} ${sg.toFixed(3)} ${sb.toFixed(3)} RG ${sepWidthPt.toFixed(2)} w\n${dash}`;
          stream += `${contentLeftPt.toFixed(2)} ${lineY.toFixed(2)} m ${(pageWidthPt - contentLeftPt).toFixed(2)} ${lineY.toFixed(2)} l S\nQ\n`;
        }
      }

      // --- Footer ---
      const footerZones = getThreeZones(furniture, 'footer', pageNum);
      const footerBlocks = blocksOf(furniture, 'footer', pageNum);

      if (footerZones.hasContent || footerBlocks.length > 0) {
        const footerBottomPt = (furniture.footerMm ?? 12) * MM_TO_PT;
        const footerY = footerBottomPt;

        // Footer background
        if (furniture.footerBackground) {
          const [bgr, bgg, bgb] = parseColorToRgb(furniture.footerBackground);
          const bandHeightPt = Math.max(pageGeom.footerContentMm, 10) * MM_TO_PT;
          stream += `q\n${bgr.toFixed(3)} ${bgg.toFixed(3)} ${bgb.toFixed(3)} rg\n`;
          stream += `0 0 ${pageWidthPt.toFixed(2)} ${bandHeightPt.toFixed(2)} re f\nQ\n`;
        }

        // Left zone
        if (footerZones.left) {
          const text = renderFurniture(footerZones.left, contexte);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${contentLeftPt.toFixed(2)} ${footerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Center zone
        if (footerZones.center) {
          const text = renderFurniture(footerZones.center, contexte);
          const textWidthPt = text.length * fontSizePt * 0.5;
          const centerX = Math.max(contentLeftPt, (pageWidthPt - textWidthPt) / 2);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${centerX.toFixed(2)} ${footerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Right zone
        if (footerZones.right) {
          const text = renderFurniture(footerZones.right, contexte);
          const textWidthPt = text.length * fontSizePt * 0.52;
          const rightX = Math.max(contentLeftPt, pageWidthPt - contentLeftPt - textWidthPt);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${rightX.toFixed(2)} ${footerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Free blocks of the footer (text)
        for (const bloc of footerBlocks) {
          if (bloc.kind === 'text' && bloc.text) {
            const bText = renderFurniture(bloc.text, contexte);
            const bX = contentLeftPt + bloc.x * (pageWidthPt - 2 * contentLeftPt);
            const bY = footerBottomPt + (bloc.y * MM_TO_PT);
            const bFontKey = resolveBase14Font('Helvetica', bloc.bold, bloc.italic);
            const bFontId = pdf.getFontObject(bFontKey);
            const [br, bg, bb] = parseColorToRgb(bloc.color || '#475467');
            stream += `q\n${br.toFixed(3)} ${bg.toFixed(3)} ${bb.toFixed(3)} rg\nBT\n/F${bFontId} ${bloc.fontSizePt || 10} Tf\n`;
            stream += `1 0 0 1 ${bX.toFixed(2)} ${bY.toFixed(2)} Tm\n`;
            stream += `${encodeWinAnsiText(bText)} Tj\nET\nQ\n`;
          }
        }

        // Separator line above the footer
        if (furniture.footerSeparator) {
          const sepWidthPt = furniture.footerSeparatorWidthPt ?? 0.75;
          const [sr, sg, sb] = parseColorToRgb(furniture.footerSeparatorColor ?? '#d0d5dd');
          const lineY = footerBottomPt + (pageGeom.footerContentMm ?? 5) * MM_TO_PT;
          const dash = furniture.footerSeparatorStyle === 'dashed' ? '[4 2] 0 d\n' : furniture.footerSeparatorStyle === 'dotted' ? '[1 2] 0 d\n' : '';
          stream += `q\n${sr.toFixed(3)} ${sg.toFixed(3)} ${sb.toFixed(3)} RG ${sepWidthPt.toFixed(2)} w\n${dash}`;
          stream += `${contentLeftPt.toFixed(2)} ${lineY.toFixed(2)} m ${(pageWidthPt - contentLeftPt).toFixed(2)} ${lineY.toFixed(2)} l S\nQ\n`;
        }
      }
    }

    /*
     * B0. Floating frames of the `hell` layer (`SwFlyFreeFrm`).
     *
     * Painted **before** the text, as on screen: it is the order of `SwRootFrm::Paint`, and it is what makes an image "behind the
     * text" so on paper too. Leaving them out, as was done, meant that a wrapped image vanished from the export: the PDF only showed
     * the hole it had dug in the text.
     */
    for (const laid of page.flies ?? []) {
      if (laid.fly.run.imageInFront) continue;
      stream += paintFly(pdf, options?.images, laid, contentLeftPt, contentTopPt, pageHeightPt);
    }

    // B. Rendering the blocks placed on the page
    for (const block of page.blocks) {
      if (block.kind === 'paragraph') {
        const placed = block as PlacedParagraph;
        const layout = placed.layout;
        const lines = layout.lines;

        for (let lIdx = placed.fromLine; lIdx < placed.toLine; lIdx++) {
          const line = lines[lIdx];
          if (!line) continue;

          // Y position of the baseline in the PDF coordinate system
          const lineTopPt = (contentTopPt + (placed.topPx + line.topPx) * PX_TO_PT);
          const baselineYPt = pageHeightPt - lineTopPt - (line.ascentPx * PX_TO_PT);

          // Bullet / list number, if any
          if (lIdx === 0 && layout.marker) {
            const marker = layout.marker;
            const markerFontKey = resolveBase14Font(marker.font.fontFamily, marker.font.bold, marker.font.italic);
            const markerFontId = pdf.getFontObject(markerFontKey);
            const markerSizePt = marker.font.fontSizePx * PX_TO_PT;
            const markerXPt = contentLeftPt + (placed.leftPx + marker.leftPx) * PX_TO_PT;
            const [mr, mg, mb] = parseColorToRgb(marker.color);

            stream += `q\n`;
            stream += `${mr.toFixed(3)} ${mg.toFixed(3)} ${mb.toFixed(3)} rg\n`;
            stream += `BT\n`;
            stream += `/F${markerFontId} ${markerSizePt.toFixed(2)} Tf\n`;
            stream += `1 0 0 1 ${markerXPt.toFixed(2)} ${baselineYPt.toFixed(2)} Tm\n`;
            stream += `${encodeWinAnsiText(marker.text)} Tj\n`;
            stream += `ET\n`;
            stream += `Q\n`;
          }

          // Text segments of the line
          for (const seg of line.segments) {
            if (seg.isTab || !seg.text) continue;

            if (seg.formatting.imageSrc) {
              stream += paintImage(
                pdf,
                options?.images,
                seg,
                contentLeftPt + (placed.leftPx + line.leftPx + seg.leftPx) * PX_TO_PT,
                baselineYPt,
              );
              continue;
            }

            const fontKey = resolveBase14Font(seg.font.fontFamily, seg.font.bold, seg.font.italic);
            const fontObjId = pdf.getFontObject(fontKey);
            const fontSizePt = seg.font.fontSizePx * PX_TO_PT;
            const segXPt = contentLeftPt + (placed.leftPx + line.leftPx + seg.leftPx) * PX_TO_PT;
            const segWidthPt = seg.widthPx * PX_TO_PT;
            const [r, g, b] = parseColorToRgb(seg.color);

            stream += `q\n`;
            stream += `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg\n`;
            stream += `BT\n`;
            stream += `/F${fontObjId} ${fontSizePt.toFixed(2)} Tf\n`;
            stream += `1 0 0 1 ${segXPt.toFixed(2)} ${baselineYPt.toFixed(2)} Tm\n`;
            stream += `${encodeWinAnsiText(seg.text)} Tj\n`;
            stream += `ET\n`;

            // Underline
            if (seg.formatting.underline) {
              const uY = baselineYPt - 1.5;
              stream += `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG 0.75 w\n`;
              stream += `${segXPt.toFixed(2)} ${uY.toFixed(2)} m ${(segXPt + segWidthPt).toFixed(2)} ${uY.toFixed(2)} l S\n`;
            }

            // Strikethrough
            if (seg.formatting.strikeThrough) {
              const sY = baselineYPt + fontSizePt * 0.3;
              stream += `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG 0.75 w\n`;
              stream += `${segXPt.toFixed(2)} ${sY.toFixed(2)} m ${(segXPt + segWidthPt).toFixed(2)} ${sY.toFixed(2)} l S\n`;
            }

            stream += `Q\n`;
          }
        }
      } else if (block.kind === 'table') {
        const tableBlock = block as PlacedTable;
        const borderColor = tableBlock.table.borderColor ?? '#333333';
        const borderWidthPt = tableBlock.table.borderWidthPt ?? 0.75;
        const [br, bg, bb] = parseColorToRgb(borderColor);

        // Drawing the table cells
        for (const [rowPos, row] of tableBlock.rows.entries()) {
          for (const cell of row.cells) {
            if (cell.covered || cell.widthPx <= 0) continue;
            const cellLeftPt = contentLeftPt + cell.leftPx * PX_TO_PT;
            const cellTopPt = contentTopPt + (tableBlock.topPx + row.topPx) * PX_TO_PT;
            const cellWidthPt = cell.widthPx * PX_TO_PT;
            // Same function as the screen: a vertical merge must produce the same frame on paper and on display.
            const cellHeightPt = cellFrameHeightPx(tableBlock.rows, rowPos, cell) * PX_TO_PT;
            const cellBottomPt = pageHeightPt - cellTopPt - cellHeightPt;

            // Cell background (if header row or specific color)
            if (row.isHeader) {
              stream += `q\n0.93 0.93 0.93 rg\n`;
              stream += `${cellLeftPt.toFixed(2)} ${cellBottomPt.toFixed(2)} ${cellWidthPt.toFixed(2)} ${cellHeightPt.toFixed(2)} re f\nQ\n`;
            }

            // Cell border
            stream += `q\n`;
            stream += `${br.toFixed(3)} ${bg.toFixed(3)} ${bb.toFixed(3)} RG ${borderWidthPt.toFixed(2)} w\n`;
            stream += `${cellLeftPt.toFixed(2)} ${cellBottomPt.toFixed(2)} ${cellWidthPt.toFixed(2)} ${cellHeightPt.toFixed(2)} re S\n`;
            stream += `Q\n`;

            // Text content of the cell's paragraphs
            for (let pIdx = 0; pIdx < cell.layouts.length; pIdx++) {
              const cellLayout = cell.layouts[pIdx];
              if (!cellLayout) continue;

              for (const line of cellLayout.lines) {
                const lineTopPt = cellTopPt + cell.paddingPx * PX_TO_PT + line.topPx * PX_TO_PT;
                const baselineYPt = pageHeightPt - lineTopPt - (line.ascentPx * PX_TO_PT);

                for (const seg of line.segments) {
                  if (seg.isTab || !seg.text) continue;

                  if (seg.formatting.imageSrc) {
                    stream += paintImage(
                      pdf,
                      options?.images,
                      seg,
                      cellLeftPt + cell.paddingPx * PX_TO_PT + line.leftPx * PX_TO_PT + seg.leftPx * PX_TO_PT,
                      baselineYPt,
                    );
                    continue;
                  }

                  const fontKey = resolveBase14Font(seg.font.fontFamily, seg.font.bold, seg.font.italic);
                  const fontObjId = pdf.getFontObject(fontKey);
                  const fontSizePt = seg.font.fontSizePx * PX_TO_PT;
                  const segXPt = cellLeftPt + cell.paddingPx * PX_TO_PT + line.leftPx * PX_TO_PT + seg.leftPx * PX_TO_PT;
                  const [r, g, b] = parseColorToRgb(seg.color);

                  stream += `q\n`;
                  stream += `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg\n`;
                  stream += `BT\n`;
                  stream += `/F${fontObjId} ${fontSizePt.toFixed(2)} Tf\n`;
                  stream += `1 0 0 1 ${segXPt.toFixed(2)} ${baselineYPt.toFixed(2)} Tm\n`;
                  stream += `${encodeWinAnsiText(seg.text)} Tj\n`;
                  stream += `ET\n`;
                  stream += `Q\n`;
                }
              }
            }
          }
        }
      }
    }

    /*
     * D. The `heaven` layer: the "in front of the text" frames (`RES_OPAQUE`).
     *
     * Painted last, so on top of everything. It is the only thing that tells them apart from the `hell` layer: same `through`
     * wrapping, same geometry, two painting moments.
     */
    for (const laid of page.flies ?? []) {
      if (!laid.fly.run.imageInFront) continue;
      stream += paintFly(pdf, options?.images, laid, contentLeftPt, contentTopPt, pageHeightPt);
    }

    // Definition of the page's content object
    pdf.setStreamObject(contentObjId, '', latin1(stream));
    pageStreams.push({ pageObjId, contentObjId });
  }

  // The resource dictionaries are written **after** all the pages: a font or an image discovered on page 12 must also appear in
  // the resources of page 1 if it appears there. Declaring them all everywhere is allowed by the specification and avoids a second
  // walk over the document.
  let fontResources = '';
  for (const [, id] of pdf.getAllFonts().entries()) {
    fontResources += `      /F${id} ${id} 0 R\n`;
  }
  let imageResources = '';
  for (const [, id] of pdf.getAllImages().entries()) {
    imageResources += `      /I${id} ${id} 0 R\n`;
  }
  const xObjectEntry = imageResources ? `      /XObject <<\n${imageResources}      >>\n` : '';

  for (const { pageObjId, contentObjId } of pageStreams) {
    pdf.setObject(
      pageObjId,
      `<< /Type /Page\n` +
        `   /Parent ${pagesTreeId} 0 R\n` +
        `   /MediaBox [0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}]\n` +
        `   /Contents ${contentObjId} 0 R\n` +
        `   /Resources <<\n` +
        `      /Font <<\n${fontResources}      >>\n` +
        xObjectEntry +
        `   >>\n` +
        `>>`,
    );
  }

  // 5. Finalizing the page tree (/Pages)
  const kidsStr = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
  pdf.setObject(
    pagesTreeId,
    `<< /Type /Pages\n   /Kids [${kidsStr}]\n   /Count ${pageObjectIds.length}\n>>`,
  );

  // 6. Finalizing the Catalog (/Catalog)
  pdf.setObject(rootId, `<< /Type /Catalog\n   /Pages ${pagesTreeId} 0 R\n>>`);

  // 7. Finalizing the Info metadata
  const now = new Date();
  const dateStr = `D:${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(
    now.getUTCMinutes(),
  ).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}Z`;

  const titleEncoded = encodeWinAnsiText(doc.meta.title || 'Document');
  const authorEncoded = encodeWinAnsiText(options?.author || doc.meta.author || 'OpenOffice Writer');

  pdf.setObject(
    infoId,
    `<< /Title ${titleEncoded}\n` +
      `   /Author ${authorEncoded}\n` +
      `   /Creator (Apache OpenOffice Writer Web)\n` +
      `   /Producer (CloudAntille Writer Native PDF Engine)\n` +
      `   /CreationDate (${dateStr})\n` +
      `>>`,
  );

  return pdf.build();
}

/** Exports the document as a PDF Blob. */
export function exportToPdfBlob(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  options?: PdfExportOptions,
): Blob {
  const bytes = exportToPdfBytes(doc, layout, options);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/**
 * All the image addresses of the document, without duplicates.
 *
 * Used by the caller to decode each image only once before the export.
 */
export function collectImageSources(doc: WriterDocumentState): string[] {
  const sources = new Set<string>();
  const visiter = (runs: readonly { imageSrc?: string }[]): void => {
    for (const run of runs) if (run.imageSrc) sources.add(run.imageSrc);
  };

  for (const block of doc.blocks) {
    if (block.type === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          for (const paragraph of cell.blocks) visiter(paragraph.runs);
        }
      }
      continue;
    }
    if (isParagraph(block)) visiter(block.runs);
  }
  return [...sources];
}

/** Triggers the download of the document as a `.pdf` file. */
export function downloadPdf(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  filename?: string,
  options?: PdfExportOptions,
): void {
  const blob = exportToPdfBlob(doc, layout, options);
  const targetName = filename || `${doc.meta.title || 'document'}.pdf`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = targetName.endsWith('.pdf') ? targetName : `${targetName}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}
