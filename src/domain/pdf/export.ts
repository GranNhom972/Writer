/**
 * Moteur d'exportation PDF natif — Transposition de `vcl::PDFWriter`
 * (`aoo-4.1.16/main/vcl/source/gdi/pdfwriter_impl.cxx`) et `PDFExport`
 * (`aoo-4.1.16/main/filter/source/pdf/pdfexport.cxx`).
 *
 * Produit un document binaire PDF 1.4 conforme et autonome, sans aucune
 * dépendance externe.
 */

import type { WriterDocumentState } from '../document/types';
import type { DocumentLayout, PlacedParagraph, PlacedTable } from '../engine/paginate';
import {
  showsOn,
  resolveGeometry,
  renderFurniture,
  getThreeZones,
  blocksOf,
} from '../document/pageFurniture';

/** Ratio standard de conversion des pixels CSS (96 DPI) vers les points PDF (72 DPI). */
const PX_TO_PT = 72 / 96; // 0.75
const MM_TO_PT = 72 / 25.4; // ~2.83464567

/** Table de correspondance des polices vers les 14 polices PDF de base (Base 14). */
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

  // Police sans-empattement par défaut (Helvetica / Arial / Liberation Sans)
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/**
 * Encodage WinAnsi pour les chaînes de texte PDF.
 * Échappe les caractères réservés `\`, `(`, `)` et convertit les caractères accentués
 * et spéciaux en séquences octales `\ooo` conformes à la table WinAnsiEncoding.
 */
function encodeWinAnsiText(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    // Caractères d'échappement PDF directs
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
      // ASCII imprimable standard
      result += str[i];
    } else {
      // Table de correspondance étendue WinAnsi
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
      else if (code === 0x00a0) ansiCode = 0xa0; // espace insécable
      else if (code > 255) {
        // Caractère hors table : repli vers un point d'interrogation
        ansiCode = 0x3f;
      }

      const octal = ansiCode.toString(8).padStart(3, '0');
      result += `\\${octal}`;
    }
  }
  return `(${result})`;
}

/** Analyse une couleur CSS (#rrggbb, #rgb, rgb(r,g,b)) et renvoie [r, g, b] dans [0, 1]. */
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

/** Constructeur de document PDF bas niveau. */
class PdfDocumentBuilder {
  private objects: string[] = [];
  private offsets: number[] = [];
  private fontMap = new Map<PdfFontKey, number>();

  constructor() {}

  /** Alloue un nouvel identifiant d'objet indirect. */
  newObject(): number {
    this.objects.push('');
    return this.objects.length;
  }

  /** Définit le contenu d'un objet indirect. */
  setObject(id: number, content: string): void {
    this.objects[id - 1] = content;
  }

  /** Enregistre ou récupère l'identifiant d'objet d'une police Base 14. */
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

  /** Renvoie la liste de toutes les polices enregistrées pour le dictionnaire `/Resources`. */
  getAllFonts(): Map<PdfFontKey, number> {
    return this.fontMap;
  }

  /** Assemble l'ensemble des objets et génère le fichier PDF final en `Uint8Array`. */
  build(): Uint8Array {
    let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    this.offsets = [];

    for (let i = 0; i < this.objects.length; i++) {
      const objId = i + 1;
      const content = this.objects[i];
      const offset = output.length;
      this.offsets.push(offset);
      output += `${objId} 0 obj\n${content}\nendobj\n`;
    }

    const startXref = output.length;
    output += `xref\n0 ${this.objects.length + 1}\n`;
    output += '0000000000 65535 f \r\n';

    for (const offset of this.offsets) {
      const offsetStr = offset.toString().padStart(10, '0');
      output += `${offsetStr} 00000 n \r\n`;
    }

    output += `trailer\n<< /Size ${this.objects.length + 1}\n   /Root 1 0 R\n   /Info 2 0 R\n>>\n`;
    output += `startxref\n${startXref}\n%%EOF\n`;

    const encoder = new TextEncoder();
    return encoder.encode(output);
  }
}

export interface PdfExportOptions {
  author?: string;
  creator?: string;
}

/**
 * Exporte un document Writer et son `DocumentLayout` au format PDF binaire.
 *
 * Implémente l'équivalent de `PDFExport::Export` d'Apache OpenOffice.
 */
export function exportToPdfBytes(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  options?: PdfExportOptions,
): Uint8Array {
  const pdf = new PdfDocumentBuilder();

  // 1. Objet 1 : Catalogue racine
  const rootId = pdf.newObject(); // 1
  // 2. Objet 2 : Métadonnées Info
  const infoId = pdf.newObject(); // 2
  // 3. Objet 3 : Arbre des pages (/Pages)
  const pagesTreeId = pdf.newObject(); // 3

  const pageObjectIds: number[] = [];
  const pageCount = layout.pages.length;
  const geometry = layout.geometry;

  const pageHeightPt = geometry.pageHeightPx * PX_TO_PT;
  const pageWidthPt = geometry.pageWidthPx * PX_TO_PT;
  const contentLeftPt = geometry.contentLeftPx * PX_TO_PT;
  const contentTopPt = geometry.contentTopPx * PX_TO_PT;

  // Création des objets de police nécessaires
  const defaultFontKey = resolveBase14Font(doc.defaults.fontFamily, false, false);
  pdf.getFontObject(defaultFontKey);

  // Mobilier (en-tête & pied de page)
  const furniture = doc.furniture;

  // 4. Construction de chaque page
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const page = layout.pages[pageIdx]!;
    const pageNum = pageIdx + 1;
    const pageObjId = pdf.newObject();
    const contentObjId = pdf.newObject();
    pageObjectIds.push(pageObjId);

    let stream = '';

    // A. Rendu du mobilier (En-tête et Pied de page)
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

      // --- En-tête ---
      const headerZones = getThreeZones(furniture, 'header', pageNum);
      const headerBlocks = blocksOf(furniture, 'header', pageNum);

      if (headerZones.hasContent || headerBlocks.length > 0) {
        const headerTopPt = (furniture.headerMm ?? 12) * MM_TO_PT;
        const headerY = pageHeightPt - headerTopPt - fontSizePt;

        // Fond de l'en-tête
        if (furniture.headerBackground) {
          const [bgr, bgg, bgb] = parseColorToRgb(furniture.headerBackground);
          const bandHeightPt = Math.max(pageGeom.headerContentMm, 10) * MM_TO_PT;
          const bandBottomPt = pageHeightPt - (headerTopPt + bandHeightPt);
          stream += `q\n${bgr.toFixed(3)} ${bgg.toFixed(3)} ${bgb.toFixed(3)} rg\n`;
          stream += `0 ${bandBottomPt.toFixed(2)} ${pageWidthPt.toFixed(2)} ${bandHeightPt.toFixed(2)} re f\nQ\n`;
        }

        // Zone gauche
        if (headerZones.left) {
          const text = renderFurniture(headerZones.left, contexte);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${contentLeftPt.toFixed(2)} ${headerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Zone centre
        if (headerZones.center) {
          const text = renderFurniture(headerZones.center, contexte);
          // Estimation de centrage
          const textWidthPt = text.length * fontSizePt * 0.5;
          const centerX = Math.max(contentLeftPt, (pageWidthPt - textWidthPt) / 2);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${centerX.toFixed(2)} ${headerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Zone droite
        if (headerZones.right) {
          const text = renderFurniture(headerZones.right, contexte);
          const textWidthPt = text.length * fontSizePt * 0.52;
          const rightX = Math.max(contentLeftPt, pageWidthPt - contentLeftPt - textWidthPt);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${rightX.toFixed(2)} ${headerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Blocs libres de l'en-tête (texte)
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

        // Filet séparateur sous l'en-tête
        if (furniture.headerSeparator) {
          const sepWidthPt = furniture.headerSeparatorWidthPt ?? 0.75;
          const [sr, sg, sb] = parseColorToRgb(furniture.headerSeparatorColor ?? '#d0d5dd');
          const lineY = pageHeightPt - (headerTopPt + (pageGeom.headerContentMm ?? 5) * MM_TO_PT);
          const dash = furniture.headerSeparatorStyle === 'dashed' ? '[4 2] 0 d\n' : furniture.headerSeparatorStyle === 'dotted' ? '[1 2] 0 d\n' : '';
          stream += `q\n${sr.toFixed(3)} ${sg.toFixed(3)} ${sb.toFixed(3)} RG ${sepWidthPt.toFixed(2)} w\n${dash}`;
          stream += `${contentLeftPt.toFixed(2)} ${lineY.toFixed(2)} m ${(pageWidthPt - contentLeftPt).toFixed(2)} ${lineY.toFixed(2)} l S\nQ\n`;
        }
      }

      // --- Pied de page ---
      const footerZones = getThreeZones(furniture, 'footer', pageNum);
      const footerBlocks = blocksOf(furniture, 'footer', pageNum);

      if (footerZones.hasContent || footerBlocks.length > 0) {
        const footerBottomPt = (furniture.footerMm ?? 12) * MM_TO_PT;
        const footerY = footerBottomPt;

        // Fond du pied de page
        if (furniture.footerBackground) {
          const [bgr, bgg, bgb] = parseColorToRgb(furniture.footerBackground);
          const bandHeightPt = Math.max(pageGeom.footerContentMm, 10) * MM_TO_PT;
          stream += `q\n${bgr.toFixed(3)} ${bgg.toFixed(3)} ${bgb.toFixed(3)} rg\n`;
          stream += `0 0 ${pageWidthPt.toFixed(2)} ${bandHeightPt.toFixed(2)} re f\nQ\n`;
        }

        // Zone gauche
        if (footerZones.left) {
          const text = renderFurniture(footerZones.left, contexte);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${contentLeftPt.toFixed(2)} ${footerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Zone centre
        if (footerZones.center) {
          const text = renderFurniture(footerZones.center, contexte);
          const textWidthPt = text.length * fontSizePt * 0.5;
          const centerX = Math.max(contentLeftPt, (pageWidthPt - textWidthPt) / 2);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${centerX.toFixed(2)} ${footerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Zone droite
        if (footerZones.right) {
          const text = renderFurniture(footerZones.right, contexte);
          const textWidthPt = text.length * fontSizePt * 0.52;
          const rightX = Math.max(contentLeftPt, pageWidthPt - contentLeftPt - textWidthPt);
          stream += `q\n${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg\nBT\n/F${fontObjId} ${fontSizePt} Tf\n`;
          stream += `1 0 0 1 ${rightX.toFixed(2)} ${footerY.toFixed(2)} Tm\n`;
          stream += `${encodeWinAnsiText(text)} Tj\nET\nQ\n`;
        }

        // Blocs libres du pied (texte)
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

        // Filet séparateur au-dessus du pied de page
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

    // B. Rendu des blocs placés sur la page
    for (const block of page.blocks) {
      if (block.kind === 'paragraph') {
        const placed = block as PlacedParagraph;
        const layout = placed.layout;
        const lines = layout.lines;

        for (let lIdx = placed.fromLine; lIdx < placed.toLine; lIdx++) {
          const line = lines[lIdx];
          if (!line) continue;

          // Position Y de la ligne de base dans le repère PDF
          const lineTopPt = (contentTopPt + (placed.topPx + line.topPx) * PX_TO_PT);
          const baselineYPt = pageHeightPt - lineTopPt - (line.ascentPx * PX_TO_PT);

          // Puce / Numéro de liste éventuel
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

          // Segments de texte de la ligne
          for (const seg of line.segments) {
            if (seg.isTab || !seg.text) continue;

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

            // Souligné
            if (seg.formatting.underline) {
              const uY = baselineYPt - 1.5;
              stream += `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG 0.75 w\n`;
              stream += `${segXPt.toFixed(2)} ${uY.toFixed(2)} m ${(segXPt + segWidthPt).toFixed(2)} ${uY.toFixed(2)} l S\n`;
            }

            // Barré
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

        // Tracé des cellules du tableau
        for (const row of tableBlock.rows) {
          for (const cell of row.cells) {
            const cellLeftPt = contentLeftPt + cell.leftPx * PX_TO_PT;
            const cellTopPt = contentTopPt + (tableBlock.topPx + row.topPx) * PX_TO_PT;
            const cellWidthPt = cell.widthPx * PX_TO_PT;
            const cellHeightPt = row.heightPx * PX_TO_PT;
            const cellBottomPt = pageHeightPt - cellTopPt - cellHeightPt;

            // Fond de cellule (si ligne d'en-tête ou couleur spécifique)
            if (row.isHeader) {
              stream += `q\n0.93 0.93 0.93 rg\n`;
              stream += `${cellLeftPt.toFixed(2)} ${cellBottomPt.toFixed(2)} ${cellWidthPt.toFixed(2)} ${cellHeightPt.toFixed(2)} re f\nQ\n`;
            }

            // Bordure de cellule
            stream += `q\n`;
            stream += `${br.toFixed(3)} ${bg.toFixed(3)} ${bb.toFixed(3)} RG ${borderWidthPt.toFixed(2)} w\n`;
            stream += `${cellLeftPt.toFixed(2)} ${cellBottomPt.toFixed(2)} ${cellWidthPt.toFixed(2)} ${cellHeightPt.toFixed(2)} re S\n`;
            stream += `Q\n`;

            // Contenu textuel des paragraphes de la cellule
            for (let pIdx = 0; pIdx < cell.layouts.length; pIdx++) {
              const cellLayout = cell.layouts[pIdx];
              if (!cellLayout) continue;

              for (const line of cellLayout.lines) {
                const lineTopPt = cellTopPt + cell.paddingPx * PX_TO_PT + line.topPx * PX_TO_PT;
                const baselineYPt = pageHeightPt - lineTopPt - (line.ascentPx * PX_TO_PT);

                for (const seg of line.segments) {
                  if (seg.isTab || !seg.text) continue;

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

    // Définition de l'objet contenu de la page
    const streamBytesLength = new TextEncoder().encode(stream).length;
    pdf.setObject(contentObjId, `<< /Length ${streamBytesLength} >>\nstream\n${stream}\nendstream`);

    // Dictionnaire de ressources de polices
    let fontResources = '';
    for (const [, id] of pdf.getAllFonts().entries()) {
      fontResources += `      /F${id} ${id} 0 R\n`;
    }

    // Définition de l'objet Page
    pdf.setObject(
      pageObjId,
      `<< /Type /Page\n` +
        `   /Parent ${pagesTreeId} 0 R\n` +
        `   /MediaBox [0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}]\n` +
        `   /Contents ${contentObjId} 0 R\n` +
        `   /Resources <<\n` +
        `      /Font <<\n${fontResources}      >>\n` +
        `   >>\n` +
        `>>`,
    );
  }

  // 5. Finalisation de l'arbre des pages (/Pages)
  const kidsStr = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
  pdf.setObject(
    pagesTreeId,
    `<< /Type /Pages\n   /Kids [${kidsStr}]\n   /Count ${pageObjectIds.length}\n>>`,
  );

  // 6. Finalisation du Catalogue (/Catalog)
  pdf.setObject(rootId, `<< /Type /Catalog\n   /Pages ${pagesTreeId} 0 R\n>>`);

  // 7. Finalisation des métadonnées Info
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

/** Exporte le document au format Blob PDF. */
export function exportToPdfBlob(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  options?: PdfExportOptions,
): Blob {
  const bytes = exportToPdfBytes(doc, layout, options);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** Déclenche le téléchargement du document sous forme de fichier `.pdf`. */
export function downloadPdf(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  filename?: string,
): void {
  const blob = exportToPdfBlob(doc, layout);
  const targetName = filename || `${doc.meta.title || 'document'}.pdf`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = targetName.endsWith('.pdf') ? targetName : `${targetName}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}
