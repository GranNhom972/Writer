// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph, DEFAULT_DEFAULTS } from '../src/domain/document/document';
import type { DocumentDefaults, WriterDocumentState } from '../src/domain/document/types';
import {
  resolveAlignment,
  resolveBlockSpacing,
  resolveColor,
  resolveFont,
  resolveHeadingStyle,
} from '../src/domain/engine/style';
import { ptToPx } from '../src/domain/document/units';
import { setCustomHeadingStyle, setHeading } from '../src/domain/engine/edit';
import { buildContentXml, buildStylesXml } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';
import { tocEntryLook } from '../src/domain/engine/tox';

const defaults: DocumentDefaults = {
  ...DEFAULT_DEFAULTS,
  headingStyles: { 1: { fontSizePt: 24, color: '#aa0000', alignment: 'center' } },
  customHeadingStyles: [{ id: 'hsChap', name: 'Chapitre', level: 1, italic: true, spaceBeforePt: 30 }],
};

describe('heading styles', () => {
  it('applies the changes made to a built-in level', () => {
    const p = createParagraph('Intro', { headingLevel: 1 });
    expect(resolveFont({}, p, { defaults }).fontSizePx).toBeCloseTo(ptToPx(24));
    expect(resolveColor({}, { defaults }, p)).toBe('#aa0000');
    expect(resolveAlignment(p, { defaults })).toBe('center');
  });

  it('lets a run and a paragraph override their heading style', () => {
    const p = { ...createParagraph('Intro', { headingLevel: 1 }), alignment: 'right' as const };
    expect(resolveFont({ fontSizePt: 10 }, p, { defaults }).fontSizePx).toBeCloseTo(ptToPx(10));
    expect(resolveColor({ color: '#000001' }, { defaults }, p)).toBe('#000001');
    expect(resolveAlignment(p, { defaults })).toBe('right');
  });

  it('makes a custom style inherit from its level', () => {
    const p = { ...createParagraph('Un', { headingLevel: 1 }), styleName: 'hsChap' };
    const style = resolveHeadingStyle(p, defaults)!;
    expect(style.fontSizePt).toBe(24);
    expect(style.italic).toBe(true);
    expect(resolveBlockSpacing(p, { defaults }).topPt).toBe(30);
  });

  it('falls back to the level when the custom style was deleted', () => {
    const p = { ...createParagraph('Un', { headingLevel: 2 }), styleName: 'gone' };
    expect(resolveHeadingStyle(p, defaults)!.fontSizePt).toBeCloseTo(DEFAULT_DEFAULTS.fontSizePt * 1.15, 1);
  });

  it('leaves body text alone', () => {
    const p = createParagraph('Texte');
    expect(resolveHeadingStyle(p, defaults)).toBeNull();
    expect(resolveFont({}, p, { defaults }).bold).toBe(false);
  });

  it('applies and removes a custom style on the selection', () => {
    const doc: WriterDocumentState = { ...createEmptyDocument(), defaults };
    const block = doc.blocks[0]!;
    const pos = { blockId: block.id, offset: 0 };
    const state = { doc, selection: { anchor: pos, focus: pos, isCollapsed: true }, pendingFormat: null };
    const styled = setCustomHeadingStyle(state, { id: 'hsChap', level: 1 });
    const node = styled.doc.blocks[0] as { type: string; headingLevel?: number; styleName?: string };
    expect(node).toMatchObject({ type: 'heading', headingLevel: 1, styleName: 'hsChap' });
    const plain = setHeading(styled, 2).doc.blocks[0] as { styleName?: string; headingLevel?: number };
    expect(plain.styleName).toBeUndefined();
    expect(plain.headingLevel).toBe(2);
  });

  it('survives an ODF round trip', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument(),
      defaults,
      blocks: [
        createParagraph('Titre', { headingLevel: 1 }),
        { ...createParagraph('Chapitre', { headingLevel: 1 }), styleName: 'hsChap' },
        createParagraph('Corps'),
      ],
    };
    const { document } = importOdfContent(buildContentXml(doc), { stylesXml: buildStylesXml(doc) });
    expect(document.defaults.headingStyles?.[1]).toMatchObject({ fontSizePt: 24, color: '#aa0000', alignment: 'center' });
    expect(document.defaults.customHeadingStyles).toEqual([
      expect.objectContaining({ id: 'hsChap', name: 'Chapitre', level: 1, italic: true, spaceBeforePt: 30 }),
    ]);
    const [h1, chap] = document.blocks as { styleName?: string; runs: { fontSizePt?: number; bold?: boolean }[] }[];
    // The look stays in the style: it is not frozen into the runs.
    expect(h1!.runs[0]!.fontSizePt).toBeUndefined();
    expect(chap!.styleName).toBe('hsChap');
  });

  it('tells titles, subtitles and deeper levels apart in the table of contents', () => {
    expect(tocEntryLook(1, 12).formatting.bold).toBe(true);
    expect(tocEntryLook(2, 12).formatting.bold).toBeUndefined();
    expect(tocEntryLook(3, 12).formatting.fontSizePt).toBeLessThan(12);
  });
});
