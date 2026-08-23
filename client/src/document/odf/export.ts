/**
 * Export ODT (couche 1) — portage de `XMLTextParagraphExport`
 * (integration_write.md §1.6 : `xmloff/source/text/txtexp.cxx`).
 *
 * Génère une archive ZIP .odt valide contenant `mimetype`, `META-INF/manifest.xml`,
 * `content.xml`, `styles.xml` et `meta.xml`.
 */

import JSZip from 'jszip';
import type { Node as PMNode } from 'prosemirror-model';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function serializeNode(node: PMNode): string {
  if (node.isText) {
    let text = escapeXml(node.text ?? '');
    for (const mark of node.marks) {
      if (mark.type.name === 'strong') {
        text = `<text:span text:style-name="Bold">${text}</text:span>`;
      } else if (mark.type.name === 'em') {
        text = `<text:span text:style-name="Italic">${text}</text:span>`;
      } else if (mark.type.name === 'underline') {
        text = `<text:span text:style-name="Underline">${text}</text:span>`;
      } else if (mark.type.name === 'strike') {
        text = `<text:span text:style-name="Strike">${text}</text:span>`;
      } else if (mark.type.name === 'link') {
        const href = escapeXml(String(mark.attrs['href'] ?? ''));
        text = `<text:a xlink:href="${href}">${text}</text:a>`;
      }
    }
    return text;
  }

  const innerXml = node.content ? Array.from({ length: node.childCount }, (_, i) => serializeNode(node.child(i))).join('') : '';

  switch (node.type.name) {
    case 'paragraph': {
      const align = node.attrs['align'] ? ` text:style-name="Align_${node.attrs['align']}"` : '';
      return `<text:p${align}>${innerXml}</text:p>`;
    }
    case 'heading': {
      const level = node.attrs['level'] ?? 1;
      return `<text:h text:outline-level="${level}">${innerXml}</text:h>`;
    }
    case 'bullet_list': {
      return `<text:list text:style-name="BulletList">${innerXml}</text:list>`;
    }
    case 'ordered_list': {
      return `<text:list text:style-name="OrderedList">${innerXml}</text:list>`;
    }
    case 'list_item':
    case 'task_item': {
      return `<text:list-item>${innerXml}</text:list-item>`;
    }
    case 'table': {
      return `<table:table>${innerXml}</table:table>`;
    }
    case 'table_row': {
      return `<table:table-row>${innerXml}</table:table-row>`;
    }
    case 'table_cell':
    case 'table_header': {
      return `<table:table-cell>${innerXml}</table:table-cell>`;
    }
    case 'footnote': {
      const idx = node.attrs['index'] ?? 1;
      const text = escapeXml(String(node.attrs['text'] ?? ''));
      return `<text:note text:id="ftn${idx}" text:note-class="footnote"><text:note-citation>${idx}</text:note-citation><text:note-body><text:p>${text}</text:p></text:note-body></text:note>`;
    }
    case 'hard_break': {
      return '<text:line-break/>';
    }
    case 'page_break': {
      return '<text:p text:style-name="PageBreak"/>';
    }
    default:
      return innerXml;
  }
}

export async function exportToOdtBlob(doc: PMNode, title = 'Document'): Promise<Blob> {
  const zip = new JSZip();

  // 1. mimetype (doit être la 1ère entrée et non compressée)
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });

  // 2. META-INF/manifest.xml
  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;
  zip.file('META-INF/manifest.xml', manifestXml);

  // 3. meta.xml
  const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:date>${new Date().toISOString()}</dc:date>
    <meta:generator>CloudAntille Write Web 1.0</meta:generator>
  </office:meta>
</office:document-meta>`;
  zip.file('meta.xml', metaXml);

  // 4. styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
  <office:styles>
    <style:default-style style:family="paragraph">
      <style:paragraph-properties fo:line-height="150%" fo:margin-bottom="0.3cm"/>
      <style:text-properties style:font-name="Arial" fo:font-size="12pt"/>
    </style:default-style>
    <style:style style:name="Bold" style:family="text">
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Italic" style:family="text">
      <style:text-properties fo:font-style="italic"/>
    </style:style>
    <style:style style:name="Underline" style:family="text">
      <style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/>
    </style:style>
    <style:style style:name="Strike" style:family="text">
      <style:text-properties style:text-line-through-style="solid"/>
    </style:style>
  </office:styles>
</office:document-styles>`;
  zip.file('styles.xml', stylesXml);

  // 5. content.xml
  const bodyContent = serializeNode(doc);
  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
  <office:body>
    <office:text>
      ${bodyContent}
    </office:text>
  </office:body>
</office:document-content>`;
  zip.file('content.xml', contentXml);

  return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.oasis.opendocument.text' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
