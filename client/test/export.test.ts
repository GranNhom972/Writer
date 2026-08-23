import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { writeSchema } from '../src/document/schema';
import { buildDocumentXml, exportToDocxBytes } from '../src/document/docx/export';
import { nomDeFichier } from '../src/App';

const t = (texte: string, marques: string[] = []) =>
  writeSchema.text(
    texte,
    marques.map((nom) => writeSchema.marks[nom]!.create(nom === 'link' ? { href: 'https://exemple.org/' } : {})),
  );

function documentExemple() {
  return writeSchema.node('doc', null, [
    writeSchema.node('heading', { level: 1 }, [t('Compte rendu')]),
    writeSchema.node('paragraph', null, [t('Texte '), t('en gras', ['strong']), t(' et lien', ['link'])]),
    writeSchema.node('bullet_list', null, [
      writeSchema.node('list_item', null, [writeSchema.node('paragraph', null, [t('Premier point')])]),
      writeSchema.node('list_item', null, [writeSchema.node('paragraph', null, [t('Second point')])]),
    ]),
    writeSchema.node('table', null, [
      writeSchema.node('table_row', null, [
        writeSchema.node('table_header', null, [writeSchema.node('paragraph', null, [t('Poste')])]),
        writeSchema.node('table_header', null, [writeSchema.node('paragraph', null, [t('Montant')])]),
      ]),
      writeSchema.node('table_row', null, [
        writeSchema.node('table_cell', null, [writeSchema.node('paragraph', null, [t('Location')])]),
        writeSchema.node('table_cell', null, [writeSchema.node('paragraph', null, [t('1 200 €')])]),
      ]),
    ]),
  ]);
}

describe('nom de fichier', () => {
  it('dérive un nom sûr du titre', () => {
    expect(nomDeFichier('Réunion du 21 août', 'pdf')).toBe('Reunion-du-21-aout.pdf');
    expect(nomDeFichier('Rapport / Q3 : final', 'docx')).toBe('Rapport-Q3-final.docx');
  });

  it('ne laisse jamais un titre devenir un chemin', () => {
    // Un titre est du texte libre : il ne doit contenir ni séparateur ni remontée.
    const nom = nomDeFichier('../../etc/passwd', 'odt');
    expect(nom).not.toContain('/');
    expect(nom).not.toContain('..');
  });

  it('retombe sur un nom par défaut si le titre ne donne rien', () => {
    expect(nomDeFichier('***', 'pdf')).toBe('document.pdf');
    expect(nomDeFichier('', 'docx')).toBe('document.docx');
  });
});

describe('export Word (.docx)', () => {
  it('produit une archive contenant les pièces exigées par Word', async () => {
    const { bytes } = await exportToDocxBytes(documentExemple(), 'Compte rendu');
    const zip = await JSZip.loadAsync(bytes);

    for (const piece of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/_rels/document.xml.rels',
    ]) {
      expect(zip.file(piece), piece).not.toBeNull();
    }
  });

  it('transcrit titres, gras, listes et tableaux', () => {
    const { xml } = buildDocumentXml(documentExemple());

    expect(xml).toContain('w:pStyle w:val="Heading1"');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Montant');
  });

  it('déclare une relation par lien hypertexte', () => {
    const { xml, ctx } = buildDocumentXml(documentExemple());
    expect(ctx.relations).toHaveLength(1);
    expect(ctx.relations[0]!.target).toBe('https://exemple.org/');
    expect(xml).toContain('<w:hyperlink r:id=');
  });

  it('échappe le XML plutôt que de produire un fichier corrompu', () => {
    const doc = writeSchema.node('doc', null, [
      writeSchema.node('paragraph', null, [t('5 < 6 & "sept" > six')]),
    ]);
    const { xml } = buildDocumentXml(doc);

    expect(xml).toContain('5 &lt; 6 &amp; &quot;sept&quot; &gt; six');
  });

  it('préserve les espaces de bord (sinon Word les mange)', () => {
    const doc = writeSchema.node('doc', null, [writeSchema.node('paragraph', null, [t('  marge  ')])]);
    expect(buildDocumentXml(doc).xml).toContain('xml:space="preserve"');
  });

  it('signale les éléments dégradés au lieu de les perdre en silence', async () => {
    const doc = writeSchema.node('doc', null, [
      writeSchema.node('paragraph', null, [
        writeSchema.node('math_inline', { latex: 'x^2' }),
      ]),
    ]);
    const { degradations } = await exportToDocxBytes(doc, 'Formules');
    expect(degradations.join(' ')).toContain('LaTeX');
  });
});
