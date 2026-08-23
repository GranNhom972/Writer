/**
 * Export Word (.docx) — OOXML WordprocessingML.
 *
 * Un `.docx` est une archive ZIP de fichiers XML. On l'écrit à la main plutôt que
 * d'ajouter une bibliothèque : JSZip est déjà présent pour l'ODF, et la structure
 * minimale d'un document Word tient en cinq fichiers. Le coût du bundle importe —
 * budget de 300 Kio (00_DIRECTIVE_ARCHITECTURE.md §7).
 *
 * Couvert : paragraphes (alignement, retrait, interligne), titres 1 à 6, gras,
 * italique, souligné, barré, couleur, surlignage, police, taille, liens, listes à
 * puces et numérotées, listes à cocher, tableaux avec bordures, sauts de page.
 * Non couvert : images (remplacées par leur texte alternatif) et formules
 * (remplacées par leur source LaTeX) — signalé à l'usager, jamais silencieux.
 */

import JSZip from 'jszip';
import type { Node as PMNode } from 'prosemirror-model';

/** Ce que l'export n'a pas su transcrire fidèlement. */
export interface DocxExportReport {
  blob: Blob;
  /** Éléments dégradés, décrits en langage clair. */
  degradations: string[];
}

/** Même résultat, en octets : la frontière testable, sans dépendre du `Blob`. */
export interface DocxExportBytes {
  bytes: Uint8Array;
  degradations: string[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Demi-points : l'unité de taille de police d'OOXML. */
function halfPoints(size: number): number {
  return Math.round(size * 2);
}

/** Vingtièmes de point (twips) : l'unité de longueur d'OOXML. */
function twips(centimeters: number): number {
  return Math.round(centimeters * 567);
}

function hexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? match[1]!.toUpperCase() : null;
}

const ALIGNMENT: Record<string, string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'both',
};

interface Contexte {
  /** Relations du document (liens hypertexte). */
  relations: { id: string; target: string }[];
  degradations: Set<string>;
}

function nouvelleRelation(ctx: Contexte, target: string): string {
  const id = `rId${100 + ctx.relations.length}`;
  ctx.relations.push({ id, target });
  return id;
}

/** Un nœud texte et ses marques → une suite de `<w:r>`. */
function serialiseTexte(node: PMNode, ctx: Contexte): string {
  const proprietes: string[] = [];
  let lien: string | null = null;

  for (const mark of node.marks) {
    switch (mark.type.name) {
      case 'strong':
        proprietes.push('<w:b/>');
        break;
      case 'em':
        proprietes.push('<w:i/>');
        break;
      case 'underline':
        proprietes.push('<w:u w:val="single"/>');
        break;
      case 'strike':
        proprietes.push('<w:strike/>');
        break;
      case 'textColor': {
        const couleur = hexColor(mark.attrs['color'] as string);
        if (couleur) proprietes.push(`<w:color w:val="${couleur}"/>`);
        break;
      }
      case 'highlight': {
        const couleur = hexColor(mark.attrs['color'] as string);
        // Word accepte une couleur de trame arbitraire via `w:shd`.
        if (couleur) proprietes.push(`<w:shd w:val="clear" w:color="auto" w:fill="${couleur}"/>`);
        break;
      }
      case 'fontFamily': {
        const police = escapeXml(String(mark.attrs['family'] ?? ''));
        if (police) proprietes.push(`<w:rFonts w:ascii="${police}" w:hAnsi="${police}"/>`);
        break;
      }
      case 'fontSize': {
        const taille = Number(mark.attrs['size']);
        if (Number.isFinite(taille)) proprietes.push(`<w:sz w:val="${halfPoints(taille)}"/>`);
        break;
      }
      case 'link':
        lien = String(mark.attrs['href'] ?? '');
        if (lien) proprietes.push('<w:rStyle w:val="Hyperlink"/>');
        break;
      default:
    }
  }

  const rPr = proprietes.length > 0 ? `<w:rPr>${proprietes.join('')}</w:rPr>` : '';
  // `xml:space="preserve"` : sans lui, Word mange les espaces de début et de fin.
  const run = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(node.text ?? '')}</w:t></w:r>`;

  if (lien) {
    const id = nouvelleRelation(ctx, lien);
    return `<w:hyperlink r:id="${id}">${run}</w:hyperlink>`;
  }
  return run;
}

function serialiseInline(node: PMNode, ctx: Contexte): string {
  let sortie = '';
  node.forEach((enfant) => {
    if (enfant.isText) {
      sortie += serialiseTexte(enfant, ctx);
      return;
    }
    switch (enfant.type.name) {
      case 'hard_break':
        sortie += '<w:r><w:br/></w:r>';
        break;
      case 'math_inline': {
        // OMML demanderait une transcription complète de LaTeX : on préserve la
        // source, lisible et corrigeable, plutôt que de perdre la formule.
        ctx.degradations.add('les formules sont exportées sous forme de code LaTeX');
        const source = escapeXml(String(enfant.attrs['latex'] ?? ''));
        sortie += `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">$${source}$</w:t></w:r>`;
        break;
      }
      case 'image':
        ctx.degradations.add('les images sont remplacées par leur texte alternatif');
        sortie += `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">[Image : ${escapeXml(String(enfant.attrs['alt'] ?? 'sans description'))}]</w:t></w:r>`;
        break;
      case 'footnote':
        sortie += `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${escapeXml(String(enfant.attrs['index'] ?? ''))}</w:t></w:r>`;
        break;
      default:
        sortie += serialiseInline(enfant, ctx);
    }
  });
  return sortie;
}

interface OptionsParagraphe {
  style?: string;
  /** Identifiant de numérotation (listes). */
  numId?: number;
  niveau?: number;
}

function proprietesParagraphe(node: PMNode, options: OptionsParagraphe): string {
  const parties: string[] = [];
  if (options.style) parties.push(`<w:pStyle w:val="${options.style}"/>`);

  if (options.numId !== undefined) {
    parties.push(`<w:numPr><w:ilvl w:val="${options.niveau ?? 0}"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  }

  const align = ALIGNMENT[String(node.attrs['align'] ?? '')];
  if (align) parties.push(`<w:jc w:val="${align}"/>`);

  const retrait = Number(node.attrs['indent'] ?? 0);
  if (retrait > 0) parties.push(`<w:ind w:left="${twips(retrait)}"/>`);

  const interligne = Number(node.attrs['lineHeight'] ?? 0);
  if (interligne > 0) {
    parties.push(`<w:spacing w:line="${Math.round(interligne * 240)}" w:lineRule="auto"/>`);
  }

  return parties.length > 0 ? `<w:pPr>${parties.join('')}</w:pPr>` : '';
}

function serialiseBloc(node: PMNode, ctx: Contexte, options: OptionsParagraphe = {}): string {
  switch (node.type.name) {
    case 'paragraph':
      return `<w:p>${proprietesParagraphe(node, options)}${serialiseInline(node, ctx)}</w:p>`;

    case 'heading': {
      const niveau = Math.min(6, Math.max(1, Number(node.attrs['level'] ?? 1)));
      return `<w:p>${proprietesParagraphe(node, { ...options, style: `Heading${niveau}` })}${serialiseInline(node, ctx)}</w:p>`;
    }

    case 'bullet_list':
    case 'ordered_list':
    case 'task_list': {
      const numId = node.type.name === 'ordered_list' ? 2 : 1;
      let sortie = '';
      node.forEach((item) => {
        const prefixe = node.type.name === 'task_list' ? (item.attrs['checked'] ? '☑ ' : '☐ ') : '';
        item.forEach((bloc, _offset, index) => {
          if (index === 0 && bloc.type.name === 'paragraph') {
            const contenu = serialiseInline(bloc, ctx);
            const marque = prefixe
              ? `<w:r><w:t xml:space="preserve">${prefixe}</w:t></w:r>`
              : '';
            sortie += `<w:p>${proprietesParagraphe(bloc, { numId, niveau: 0 })}${marque}${contenu}</w:p>`;
          } else {
            sortie += serialiseBloc(bloc, ctx, { numId, niveau: 1 });
          }
        });
      });
      return sortie;
    }

    case 'table': {
      const largeurTrait = Number(node.attrs['borderWidth'] ?? 1);
      const couleur = hexColor(node.attrs['borderColor'] as string) ?? 'AAAAAA';
      // OOXML compte les bordures en huitièmes de point.
      const taille = Math.max(0, Math.round(largeurTrait * 8));
      const bord = (cote: string): string =>
        taille === 0
          ? `<w:${cote} w:val="none" w:sz="0" w:space="0"/>`
          : `<w:${cote} w:val="single" w:sz="${taille}" w:space="0" w:color="${couleur}"/>`;
      const bordures = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(bord).join('')}</w:tblBorders>`;

      let lignes = '';
      node.forEach((row) => {
        let cellules = '';
        row.forEach((cell) => {
          let contenu = '';
          cell.forEach((bloc) => {
            contenu += serialiseBloc(bloc, ctx);
          });
          const entete = cell.type.name === 'table_header' ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '';
          cellules += `<w:tc><w:tcPr>${entete}</w:tcPr>${contenu || '<w:p/>'}</w:tc>`;
        });
        lignes += `<w:tr>${cellules}</w:tr>`;
      });

      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${bordures}</w:tblPr>${lignes}</w:tbl><w:p/>`;
    }

    case 'page_break':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

    case 'math_block': {
      ctx.degradations.add('les formules sont exportées sous forme de code LaTeX');
      const source = escapeXml(String(node.attrs['latex'] ?? ''));
      return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">$$${source}$$</w:t></w:r></w:p>`;
    }

    case 'image':
      ctx.degradations.add('les images sont remplacées par leur texte alternatif');
      return `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">[Image : ${escapeXml(String(node.attrs['alt'] ?? 'sans description'))}]</w:t></w:r></w:p>`;

    default: {
      let sortie = '';
      node.forEach((enfant) => {
        sortie += serialiseBloc(enfant, ctx, options);
      });
      return sortie;
    }
  }
}

/** Corps du document Word, exporté séparément pour être testable. */
export function buildDocumentXml(doc: PMNode): { xml: string; ctx: Contexte } {
  const ctx: Contexte = { relations: [], degradations: new Set() };
  let corps = '';
  doc.forEach((bloc) => {
    corps += serialiseBloc(bloc, ctx);
  });

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${corps}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return { xml, ctx };
}

export async function exportToDocxBytes(doc: PMNode, titre: string): Promise<DocxExportBytes> {
  const { xml, ctx } = buildDocumentXml(doc);
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
  );

  const relationsLiens = ctx.relations
    .map(
      (relation) =>
        `<Relationship Id="${relation.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(relation.target)}" TargetMode="External"/>`,
    )
    .join('');

  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  ${relationsLiens}
</Relationships>`,
  );

  const stylesTitres = [1, 2, 3, 4, 5, 6]
    .map(
      (niveau) => `<w:style w:type="paragraph" w:styleId="Heading${niveau}">
    <w:name w:val="heading ${niveau}"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="${niveau - 1}"/><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="${halfPoints(28 - niveau * 2)}"/></w:rPr>
  </w:style>`,
    )
    .join('');

  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/>
    <w:rPr><w:color w:val="1A56DB"/><w:u w:val="single"/></w:rPr>
  </w:style>
  ${stylesTitres}
</w:styles>`,
  );

  zip.file(
    'word/numbering.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`,
  );

  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>${escapeXml(titre)}</dc:title>
  <dc:creator>CloudAntille Write</dc:creator>
  <dcterms:modified xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  );

  zip.file('word/document.xml', xml);

  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return { bytes, degradations: [...ctx.degradations] };
}

export async function exportToDocxBlob(doc: PMNode, titre: string): Promise<DocxExportReport> {
  const { bytes, degradations } = await exportToDocxBytes(doc, titre);
  return {
    blob: new Blob([bytes as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    degradations,
  };
}
