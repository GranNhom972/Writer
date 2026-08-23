import { describe, expect, it } from 'vitest';
import { exportToOdtBlob } from '../src/document/odf/export';
import { writeSchema } from '../src/document/schema';
import { EditorState } from 'prosemirror-state';
import JSZip from 'jszip';

describe('export ODT — packaging ZIP et XML', () => {
  it('génère un blob ODT valide contenant mimetype, manifest.xml et content.xml', async () => {
    const state = EditorState.create({
      schema: writeSchema,
      doc: writeSchema.node('doc', null, [
        writeSchema.node('heading', { level: 1 }, [writeSchema.text('Titre Document')]),
        writeSchema.node('paragraph', null, [writeSchema.text('Paragraphe de test.')]),
      ]),
    });

    const blob = await exportToOdtBlob(state.doc, 'Mon Document');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/vnd.oasis.opendocument.text');

    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('mimetype')).not.toBeNull();
    expect(zip.file('META-INF/manifest.xml')).not.toBeNull();
    expect(zip.file('content.xml')).not.toBeNull();
    expect(zip.file('styles.xml')).not.toBeNull();
    expect(zip.file('meta.xml')).not.toBeNull();

    const mimetypeContent = await zip.file('mimetype')?.async('string');
    expect(mimetypeContent).toBe('application/vnd.oasis.opendocument.text');

    const contentXml = await zip.file('content.xml')?.async('string');
    expect(contentXml).toContain('Titre Document');
    expect(contentXml).toContain('Paragraphe de test.');
  });
});
