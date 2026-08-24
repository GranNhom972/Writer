/**
 * Moteur XML OpenDocument — `XMLTextImportHelper` / `XMLTextParagraphExport`.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  paragraphText,
} from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import { isTable, type ParagraphNode, type WriterDocumentState } from '../src/domain/document/types';
import { buildContentXml, buildStylesXml, documentPlainText } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';
import { crc32, exportOdt, openOdt, readOdtEntries } from '../src/domain/odf/package';
import { parseLengthPt, parsePercent } from '../src/domain/odf/units';

const CONTENT_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<office:document-content ' +
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink">';

function content(body: string, automaticStyles = ''): string {
  return (
    `${CONTENT_HEAD}<office:automatic-styles>${automaticStyles}</office:automatic-styles>` +
    `<office:body><office:text>${body}</office:text></office:body></office:document-content>`
  );
}

function paragraphs(doc: WriterDocumentState): ParagraphNode[] {
  return doc.blocks.filter((block): block is ParagraphNode => !isTable(block));
}

describe('longueurs XSL-FO', () => {
  it('convertit chaque unité vers le point', () => {
    expect(parseLengthPt('12pt')).toBe(12);
    expect(parseLengthPt('1in')).toBe(72);
    expect(parseLengthPt('2.54cm')).toBeCloseTo(72, 6);
    expect(parseLengthPt('25.4mm')).toBeCloseTo(72, 6);
    expect(parseLengthPt('1440twip')).toBeCloseTo(72, 6);
  });

  it('refuse une valeur illisible plutôt que de deviner', () => {
    expect(parseLengthPt('énorme')).toBeNull();
    expect(parseLengthPt('')).toBeNull();
    expect(parseLengthPt(null)).toBeNull();
  });

  it('lit un pourcentage comme facteur', () => {
    expect(parsePercent('150%')).toBe(1.5);
    expect(parsePercent('12pt')).toBeNull();
  });
});

describe('import — structure', () => {
  it('lit un paragraphe et un titre', () => {
    const { document } = importOdfContent(
      content('<text:p>Un texte</text:p><text:h text:outline-level="2">Un titre</text:h>'),
    );
    const nodes = paragraphs(document);
    expect(nodes).toHaveLength(2);
    expect(paragraphText(nodes[0]!)).toBe('Un texte');
    expect(nodes[1]!.type).toBe('heading');
    expect(nodes[1]!.headingLevel).toBe(2);
  });

  it('borne un niveau de titre hors plage', () => {
    const { document } = importOdfContent(
      content('<text:h text:outline-level="9">Trop profond</text:h>'),
    );
    expect(paragraphs(document)[0]!.headingLevel).toBe(6);
  });

  it('restitue les espaces comptées, tabulations et sauts de ligne', () => {
    const { document } = importOdfContent(
      content('<text:p>a<text:s text:c="3"/>b<text:tab/>c<text:line-break/>d</text:p>'),
    );
    expect(paragraphText(paragraphs(document)[0]!)).toBe('a   b\tc\nd');
  });

  it('accepte un fichier illisible sans lever, en le signalant', () => {
    const { document, warnings } = importOdfContent('<pas du xml');
    expect(warnings.length).toBeGreaterThan(0);
    expect(paragraphs(document)).toHaveLength(1);
  });

  it('lit un tableau avec ses cellules', () => {
    const { document } = importOdfContent(
      content(
        '<table:table table:name="T1">' +
          '<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>' +
          '<table:table-cell><text:p>B</text:p></table:table-cell></table:table-row>' +
          '</table:table>',
      ),
    );
    const table = document.blocks.find(isTable)!;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.cells).toHaveLength(2);
    expect(paragraphText(table.rows[0]!.cells[1]!.blocks[0]!)).toBe('B');
  });

  it('marque comme en-tête les lignes de table-header-rows', () => {
    const { document } = importOdfContent(
      content(
        '<table:table table:name="T1">' +
          '<table:table-header-rows><table:table-row><table:table-cell>' +
          '<text:p>Titre</text:p></table:table-cell></table:table-row></table:table-header-rows>' +
          '<table:table-row><table:table-cell><text:p>Valeur</text:p></table:table-cell></table:table-row>' +
          '</table:table>',
      ),
    );
    const table = document.blocks.find(isTable)!;
    expect(table.rows[0]!.isHeader).toBe(true);
    expect(table.rows[1]!.isHeader).toBeUndefined();
  });
});

describe('import — styles', () => {
  const styles =
    '<style:style style:name="T1" style:family="text">' +
    '<style:text-properties fo:font-weight="bold" fo:font-size="18pt" fo:color="#ff0000"/>' +
    '</style:style>' +
    '<style:style style:name="T2" style:family="text" style:parent-style-name="T1">' +
    '<style:text-properties fo:font-style="italic"/>' +
    '</style:style>' +
    '<style:style style:name="P1" style:family="paragraph">' +
    '<style:paragraph-properties fo:text-align="center" fo:line-height="150%" ' +
    'fo:margin-left="1cm" fo:break-before="page"/>' +
    '</style:style>';

  it('aplatit un style de texte sur le run', () => {
    const { document } = importOdfContent(
      content('<text:p><text:span text:style-name="T1">gras</text:span></text:p>', styles),
    );
    const run = paragraphs(document)[0]!.runs[0]!;
    expect(run.bold).toBe(true);
    expect(run.fontSizePt).toBe(18);
    expect(run.color).toBe('#ff0000');
  });

  it('hérite du style parent, l enfant l emportant', () => {
    const { document } = importOdfContent(
      content('<text:p><text:span text:style-name="T2">les deux</text:span></text:p>', styles),
    );
    const run = paragraphs(document)[0]!.runs[0]!;
    expect(run.bold).toBe(true);
    expect(run.italic).toBe(true);
  });

  it('cumule les spans imbriques', () => {
    const { document } = importOdfContent(
      content(
        '<text:p><text:span text:style-name="T1">a' +
          '<text:span text:style-name="T2">b</text:span></text:span></text:p>',
        styles,
      ),
    );
    const runs = paragraphs(document)[0]!.runs;
    expect(runs[runs.length - 1]!.italic).toBe(true);
    expect(runs[runs.length - 1]!.bold).toBe(true);
  });

  it('lit les attributs de paragraphe', () => {
    const { document } = importOdfContent(
      content('<text:p text:style-name="P1">centre</text:p>', styles),
    );
    const node = paragraphs(document)[0]!;
    expect(node.alignment).toBe('center');
    expect(node.lineSpacing).toBe(1.5);
    expect(node.indentLeftPt).toBeCloseTo(28.3465, 3);
    expect(node.pageBreakBefore).toBe(true);
  });

  it('lit un lien hypertexte', () => {
    const { document } = importOdfContent(
      content('<text:p><text:a xlink:href="https://exemple.fr">lien</text:a></text:p>'),
    );
    expect(paragraphs(document)[0]!.runs[0]!.linkHref).toBe('https://exemple.fr');
  });

  it('ne boucle pas sur une chaine de styles cyclique', () => {
    const cyclic =
      '<style:style style:name="A" style:family="text" style:parent-style-name="B"/>' +
      '<style:style style:name="B" style:family="text" style:parent-style-name="A"/>';
    const { document } = importOdfContent(
      content('<text:p><text:span text:style-name="A">x</text:span></text:p>', cyclic),
    );
    expect(paragraphText(paragraphs(document)[0]!)).toBe('x');
  });
});

describe('export', () => {
  function documentOf(blocks: WriterDocumentState['blocks']): WriterDocumentState {
    return { ...createEmptyDocument('Essai'), blocks };
  }

  it('engendre un style automatique par formatage distinct, reutilise', () => {
    const doc = documentOf([
      createParagraph('', { runs: [makeRun('a', { bold: true }), makeRun('b')] }),
      createParagraph('', { runs: [makeRun('c', { bold: true })] }),
    ]);
    const xml = buildContentXml(doc);
    // Un seul style de texte pour les deux passages en gras.
    expect(xml.match(/style:family="text"/g)).toHaveLength(1);
    expect(xml.match(/text:style-name="T1"/g)).toHaveLength(2);
  });

  it('ecrit les espaces multiples en text:s', () => {
    const xml = buildContentXml(documentOf([createParagraph('a   b')]));
    expect(xml).toContain('<text:s text:c="2"/>');
  });

  it('ecrit une espace de tete en element, jamais en litteral', () => {
    const xml = buildContentXml(documentOf([createParagraph(' a')]));
    expect(xml).toContain('<text:s/>');
  });

  it('echappe les caracteres reserves', () => {
    const xml = buildContentXml(documentOf([createParagraph('a < b & c')]));
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('a < b');
  });

  it('ecrit la geometrie de page dans styles.xml', () => {
    const xml = buildStylesXml(createEmptyDocument('Essai'));
    expect(xml).toContain('fo:page-width="21cm"');
    expect(xml).toContain('fo:page-height="29.7cm"');
  });
});

describe('aller-retour', () => {
  function roundTrip(doc: WriterDocumentState): WriterDocumentState {
    return importOdfContent(buildContentXml(doc), { stylesXml: buildStylesXml(doc) }).document;
  }

  it('conserve le texte, les titres et le formatage', () => {
    const original: WriterDocumentState = {
      ...createEmptyDocument('Essai'),
      blocks: [
        createParagraph('Chapitre', { headingLevel: 1 }),
        createParagraph('', {
          runs: [
            makeRun('normal '),
            makeRun('gras', { bold: true }),
            makeRun(' et '),
            makeRun('italique', { italic: true, fontSizePt: 14 }),
          ],
          alignment: 'justify',
        }),
        createParagraph('a\tb  c'),
      ],
    };

    const restored = roundTrip(original);
    expect(documentPlainText(restored)).toBe(documentPlainText(original));

    const nodes = paragraphs(restored);
    expect(nodes[0]!.type).toBe('heading');
    expect(nodes[1]!.alignment).toBe('justify');
    const runs = nodes[1]!.runs;
    expect(runs.find((run) => run.text === 'gras')?.bold).toBe(true);
    expect(runs.find((run) => run.text === 'italique')?.fontSizePt).toBe(14);
  });

  it('conserve la geometrie de la page', () => {
    const original = createEmptyDocument('Essai');
    original.pageSetup = { ...original.pageSetup, marginLeftMm: 30, orientation: 'landscape' };
    const restored = roundTrip(original);
    expect(restored.pageSetup.marginLeftMm).toBeCloseTo(30, 2);
    expect(restored.pageSetup.orientation).toBe('landscape');
    expect(restored.pageSetup.widthMm).toBeCloseTo(210, 1);
  });

  it('conserve un tableau', () => {
    const table = createTable(2, 3);
    table.rows[0]!.isHeader = true;
    const restored = roundTrip({ ...createEmptyDocument('Essai'), blocks: [table] });
    const result = restored.blocks.find(isTable)!;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.cells).toHaveLength(3);
    expect(result.rows[0]!.isHeader).toBe(true);
  });

  it('conserve les en-têtes et pieds de page avec 3 zones et styles', () => {
    const original = createEmptyDocument('Rapport');
    original.furniture = {
      header: 'En-tête gauche\tEn-tête centre\tEn-tête droite',
      headerLeft: 'En-tête gauche',
      headerCenter: 'En-tête centre',
      headerRight: 'En-tête droite',
      footer: 'Pied gauche\t\tPage {page}',
      footerLeft: 'Pied gauche',
      footerCenter: '',
      footerRight: 'Page {page}',
      differentEvenOdd: true,
      headerEven: 'Pair gauche\t\tPair droite',
      headerEvenLeft: 'Pair gauche',
      headerEvenRight: 'Pair droite',
      footerEven: 'Pied pair',
      pageNumber: true,
      pageNumberFormat: 'page',
      onFirstPage: false,
      headerMm: 14,
      footerMm: 14,
      fontSizePt: 9,
      headerAlign: 'left',
      footerAlign: 'right',
      blocks: [],
      marginTopMm: 20,
      marginBottomMm: 20,
      marginLeftMm: 25,
      marginRightMm: 25,
      headerSeparator: true,
      footerSeparator: true,
    };

    const restored = roundTrip(original);
    expect(restored.furniture).toBeDefined();
    expect(restored.furniture?.header).toContain('En-tête');
    expect(restored.furniture?.footer).toContain('{page}');
    expect(restored.furniture?.differentEvenOdd).toBe(true);
    expect(restored.furniture?.headerSeparator).toBe(true);
    expect(restored.furniture?.footerSeparator).toBe(true);
  });
});

describe('conteneur .odt', () => {
  it('calcule un CRC-32 conforme', () => {
    // Vecteur de reference du format ZIP pour la chaine 123456789.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('ecrit une archive dont mimetype est la premiere entree, non compressee', async () => {
    const archive = await exportOdt(createEmptyDocument('Essai'));
    const header = new TextDecoder().decode(archive.subarray(0, 128));
    expect(header.startsWith('PK')).toBe(true);
    expect(header).toContain('mimetype');
    expect(header).toContain('application/vnd.oasis.opendocument.text');
  });

  it('relit une archive qu il vient d ecrire', async () => {
    const original: WriterDocumentState = {
      ...createEmptyDocument('Mon document'),
      blocks: [createParagraph('Titre', { headingLevel: 1 }), createParagraph('Corps du texte.')],
    };
    const archive = await exportOdt(original);

    const entries = await readOdtEntries(archive);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining(['mimetype', 'content.xml', 'styles.xml', 'meta.xml']),
    );

    const { document } = await openOdt(archive);
    expect(documentPlainText(document)).toBe(documentPlainText(original));
    expect(document.meta.title).toBe('Mon document');
  });
});
