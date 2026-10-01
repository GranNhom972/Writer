// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Change tracking: `SwRangeRedline` / `SwRedlineTbl` (`sw/source/core/doc/docredln.cxx`) and the `REDLINE_ON` mode.
 *
 * The central invariant: **in review mode, nothing is destroyed**. These tests check the four outcomes of `AcceptRedline`/`RejectRedline`, which are what sets a revision apart from a simple coloring of the text.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph, paragraphText } from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import {
  acceptAllRedlines,
  applyRedline,
  hasRedlines,
  listRedlineRanges,
  markDeleted,
  markFormatted,
  markInserted,
  pruneOrphanRedlines,
  redlineAuthorColor,
  redlineAuthors,
  rejectAllRedlines,
  visibleText,
  REDLINE_AUTHOR_COLORS,
} from '../src/domain/document/redline';
import {
  createEditorState,
  deleteSelection,
  insertText,
  isReviewing,
  setReviewMode,
} from '../src/domain/engine/edit';
import type { DocumentBlock } from '../src/domain/document/types';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

const ALICE = { author: 'Alice', now: '2026-02-01T09:00:00.000Z' };
const BOB = { author: 'Bob', now: '2026-02-01T10:00:00.000Z' };

function texteDu(doc: ReturnType<typeof docOf>): string {
  const block = doc.blocks[0];
  if (block?.type !== 'paragraph') throw new Error('paragraphe attendu');
  return paragraphText(block);
}

describe('Pose des marques de révision', () => {
  it('marque une plage comme insérée sans toucher au texte', () => {
    const p = createParagraph('abcdef');
    const doc = markInserted(docOf([p]), p.id, 2, 4, ALICE);

    expect(texteDu(doc)).toBe('abcdef');
    const ranges = listRedlineRanges(doc);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.redline.type).toBe('insert');
    expect(ranges[0]?.redline.author).toBe('Alice');
    expect(ranges[0]?.text).toBe('cd');
  });

  it('marque une suppression SANS retirer le texte', () => {
    const p = createParagraph('abcdef');
    const { doc } = markDeleted(docOf([p]), p.id, 1, 3, ALICE);

    // The text is still there: that is the whole point of review mode.
    expect(texteDu(doc)).toBe('abcdef');
    expect(listRedlineRanges(doc)[0]?.redline.type).toBe('delete');
    expect(listRedlineRanges(doc)[0]?.text).toBe('bc');
  });

  it('retire réellement le texte que le même auteur venait d\'insérer', () => {
    // Correcting your own typing must not leave a struck-through trail.
    const p = createParagraph('abcdef');
    const inserted = markInserted(docOf([p]), p.id, 2, 4, ALICE);
    const { doc, removedRanges } = markDeleted(inserted, p.id, 2, 4, ALICE);

    expect(texteDu(doc)).toBe('abef');
    expect(removedRanges).toHaveLength(1);
    expect(listRedlineRanges(doc)).toHaveLength(0);
  });

  it('conserve le texte inséré par un AUTRE auteur et le marque supprimé', () => {
    const p = createParagraph('abcdef');
    const inserted = markInserted(docOf([p]), p.id, 2, 4, ALICE);
    const { doc } = markDeleted(inserted, p.id, 2, 4, BOB);

    expect(texteDu(doc)).toBe('abcdef');
    expect(listRedlineRanges(doc)[0]?.redline.type).toBe('delete');
    expect(listRedlineRanges(doc)[0]?.redline.author).toBe('Bob');
  });

  it('ne marque pas deux fois une suppression déjà posée', () => {
    const p = createParagraph('abcdef');
    const first = markDeleted(docOf([p]), p.id, 1, 4, ALICE).doc;
    const second = markDeleted(first, p.id, 1, 4, BOB).doc;
    expect(listRedlineRanges(second)).toHaveLength(1);
    expect(listRedlineRanges(second)[0]?.redline.author).toBe('Alice');
  });

  it('une marque de format ne s\'applique pas sur du texte déjà supprimé', () => {
    const p = createParagraph('abcdef');
    const supprime = markDeleted(docOf([p]), p.id, 0, 6, ALICE).doc;
    const apres = markFormatted(supprime, p.id, 0, 6, BOB);
    expect(apres).toBe(supprime);
  });

  it('refuse une plage vide', () => {
    const p = createParagraph('abcdef');
    const base = docOf([p]);
    expect(markInserted(base, p.id, 3, 3, ALICE)).toBe(base);
  });
});

describe('Acceptation et rejet (SwDoc::AcceptRedline / RejectRedline)', () => {
  it('accepter un ajout garde le texte et retire la marque', () => {
    const p = createParagraph('abcdef');
    const doc = markInserted(docOf([p]), p.id, 2, 4, ALICE);
    const id = listRedlineRanges(doc)[0]!.redline.id;

    const after = applyRedline(doc, id, 'accept');
    expect(texteDu(after)).toBe('abcdef');
    expect(hasRedlines(after)).toBe(false);
  });

  it('rejeter un ajout retire le texte', () => {
    const p = createParagraph('abcdef');
    const doc = markInserted(docOf([p]), p.id, 2, 4, ALICE);
    const id = listRedlineRanges(doc)[0]!.redline.id;

    const after = applyRedline(doc, id, 'reject');
    expect(texteDu(after)).toBe('abef');
    expect(hasRedlines(after)).toBe(false);
  });

  it('accepter une coupe retire le texte', () => {
    const p = createParagraph('abcdef');
    const { doc } = markDeleted(docOf([p]), p.id, 1, 3, ALICE);
    const id = listRedlineRanges(doc)[0]!.redline.id;

    const after = applyRedline(doc, id, 'accept');
    expect(texteDu(after)).toBe('adef');
  });

  it('rejeter une coupe garde le texte et retire la marque', () => {
    const p = createParagraph('abcdef');
    const { doc } = markDeleted(docOf([p]), p.id, 1, 3, ALICE);
    const id = listRedlineRanges(doc)[0]!.redline.id;

    const after = applyRedline(doc, id, 'reject');
    expect(texteDu(after)).toBe('abcdef');
    expect(hasRedlines(after)).toBe(false);
  });

  it('accepte toutes les marques, ou seulement celles d\'un auteur', () => {
    const p = createParagraph('abcdefghij');
    let doc = markInserted(docOf([p]), p.id, 0, 2, ALICE);
    doc = markDeleted(doc, p.id, 5, 7, BOB).doc;

    const seulementBob = acceptAllRedlines(doc, 'Bob');
    expect(texteDu(seulementBob)).toBe('abcdehij');
    expect(listRedlineRanges(seulementBob)).toHaveLength(1);

    expect(hasRedlines(acceptAllRedlines(doc))).toBe(false);
  });

  it('rejette toutes les marques d\'un coup', () => {
    const p = createParagraph('abcdefghij');
    let doc = markInserted(docOf([p]), p.id, 0, 2, ALICE);
    doc = markDeleted(doc, p.id, 5, 7, BOB).doc;

    const after = rejectAllRedlines(doc);
    // The insertion goes away, the deletion is cancelled: we are back to the original text minus what was not in it.
    expect(texteDu(after)).toBe('cdefghij');
    expect(hasRedlines(after)).toBe(false);
  });

  it('ignore un identifiant inconnu', () => {
    const p = createParagraph('abcdef');
    const doc = markInserted(docOf([p]), p.id, 0, 2, ALICE);
    expect(applyRedline(doc, 'inexistant', 'accept')).toBe(doc);
  });
});

describe('Mode révision dans l\'éditeur (REDLINE_ON)', () => {
  it('signe la frappe au lieu de l\'insérer nue', () => {
    const p = createParagraph('abcdef');
    const state = setReviewMode(createEditorState(docOf([p])), ALICE);
    expect(isReviewing(state)).toBe(true);

    const after = insertText(
      { ...state, selection: collapsedAt(p.id, 3) },
      'XY',
    );

    expect(texteDu(after.doc)).toBe('abcXYdef');
    const ranges = listRedlineRanges(after.doc);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.redline.type).toBe('insert');
    expect(ranges[0]?.text).toBe('XY');
  });

  it('marque la suppression au lieu de détruire', () => {
    const p = createParagraph('abcdef');
    const state = setReviewMode(createEditorState(docOf([p])), ALICE);

    const after = deleteSelection({
      ...state,
      selection: {
        anchor: { blockId: p.id, offset: 1 },
        focus: { blockId: p.id, offset: 4 },
        isCollapsed: false,
      },
    });

    expect(texteDu(after.doc)).toBe('abcdef');
    expect(listRedlineRanges(after.doc)[0]?.text).toBe('bcd');
    // The cursor stays at the end of the range: the text is still visible.
    expect(after.selection.focus.offset).toBe(4);
  });

  it('marque chaque paragraphe d\'une sélection multiple sans les fusionner', () => {
    const p1 = createParagraph('premier');
    const p2 = createParagraph('deuxieme');
    const state = setReviewMode(createEditorState(docOf([p1, p2])), ALICE);

    const after = deleteSelection({
      ...state,
      selection: {
        anchor: { blockId: p1.id, offset: 3 },
        focus: { blockId: p2.id, offset: 4 },
        isCollapsed: false,
      },
    });

    // Both paragraphs still exist: the break survives until acceptance, the only way for a rejection to restore everything.
    expect(after.doc.blocks).toHaveLength(2);
    const ranges = listRedlineRanges(after.doc);
    expect(ranges).toHaveLength(2);
    expect(ranges.map((r) => r.text)).toEqual(['mier', 'deux']);
  });

  it('mode coupé : l\'édition redevient destructive', () => {
    const p = createParagraph('abcdef');
    const state = setReviewMode(createEditorState(docOf([p])), null);
    expect(isReviewing(state)).toBe(false);

    const after = deleteSelection({
      ...state,
      selection: {
        anchor: { blockId: p.id, offset: 1 },
        focus: { blockId: p.id, offset: 4 },
        isCollapsed: false,
      },
    });

    expect(texteDu(after.doc)).toBe('aef');
    expect(hasRedlines(after.doc)).toBe(false);
  });
});

describe('Auteurs, couleurs et nettoyage', () => {
  it('attribue une couleur par rang d\'apparition, pas par hachage du nom', () => {
    const p = createParagraph('abcdefghij');
    let doc = markInserted(docOf([p]), p.id, 0, 2, ALICE);
    doc = markInserted(doc, p.id, 5, 7, BOB);

    expect(redlineAuthors(doc)).toEqual(['Alice', 'Bob']);
    expect(redlineAuthorColor(doc, 'Alice')).toBe(REDLINE_AUTHOR_COLORS[0]);
    expect(redlineAuthorColor(doc, 'Bob')).toBe(REDLINE_AUTHOR_COLORS[1]);
    // Unknown author: first color, never `undefined`.
    expect(redlineAuthorColor(doc, 'Carol')).toBe(REDLINE_AUTHOR_COLORS[0]);
  });

  it('exclut le texte supprimé du texte visible', () => {
    const p = createParagraph('', {
      runs: [
        makeRun('garde'),
        makeRun('coupe', { redlineId: 'r1', redlineType: 'delete' }),
        makeRun('garde2'),
      ],
    });
    expect(visibleText(p)).toBe('gardegarde2');
  });

  it('nettoie les marques dont plus aucun run ne porte l\'ancre', () => {
    const p = createParagraph('abcdef');
    const doc = markInserted(docOf([p]), p.id, 0, 2, ALICE);
    const orphelin = { ...doc, blocks: [createParagraph('sans marque')] };
    expect(pruneOrphanRedlines(orphelin).redlines ?? []).toHaveLength(0);
  });
});

function collapsedAt(blockId: string, offset: number) {
  return {
    anchor: { blockId, offset },
    focus: { blockId, offset },
    isCollapsed: true,
  };
}
