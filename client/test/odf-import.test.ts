import { describe, expect, it } from 'vitest';
import { OdfImportError, parseContentXml } from '../src/document/odf/import';

const CONTENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:h text:outline-level="2">Chapitre premier</text:h>
      <text:p>Bonjour <text:span>le monde</text:span>.</text:p>
      <text:p>Tabulation :<text:tab/>fin.</text:p>
      <text:list>
        <text:list-item><text:p>Premier point</text:p></text:list-item>
        <text:list-item><text:p>Second point</text:p></text:list-item>
      </text:list>
    </office:text>
  </office:body>
</office:document-content>`;

function textOf(block: unknown): string {
  const content = (block as { content?: { text?: string }[] }).content ?? [];
  return content.map((run) => run.text ?? '').join('');
}

describe('import ODT — content.xml', () => {
  it('convertit <text:h> en titre au bon niveau', () => {
    const doc = parseContentXml(CONTENT_XML);
    const heading = doc.content[0];
    expect(heading?.type).toBe('heading');
    expect(heading?.attrs?.level).toBe(2);
    expect(textOf(heading)).toBe('Chapitre premier');
  });

  it('aplatit <text:span> en plages de texte', () => {
    const doc = parseContentXml(CONTENT_XML);
    expect(textOf(doc.content[1])).toBe('Bonjour le monde.');
  });

  it('traduit <text:tab> en tabulation', () => {
    const doc = parseContentXml(CONTENT_XML);
    expect(textOf(doc.content[2])).toBe('Tabulation :\tfin.');
  });

  it('convertit <text:list> en liste à deux éléments', () => {
    const doc = parseContentXml(CONTENT_XML);
    const list = doc.content[3];
    expect(list?.type).toBe('bullet_list');
    expect(list?.content).toHaveLength(2);
  });

  it('rejette un XML malformé au lieu de produire un document vide silencieux', () => {
    expect(() => parseContentXml('<office:text><text:p>oups')).toThrow(OdfImportError);
  });

  it('produit un paragraphe vide pour un corps vide (document valide)', () => {
    const doc = parseContentXml(
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text/></office:body></office:document-content>',
    );
    expect(doc.content).toEqual([{ type: 'paragraph', content: [] }]);
  });
});
