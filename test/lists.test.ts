// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * List numbering: `SwNumRule` / `SwNodeNum`.
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  paragraphIndex,
} from '../src/domain/document/document';
import {
  computeListMarkers,
  effectiveIndentLeftPt,
  formatOrdered,
  LIST_INDENT_PT,
} from '../src/domain/document/lists';
import type { ListKind, ParagraphNode, WriterDocumentState } from '../src/domain/document/types';
import {
  changeListLevel,
  createEditorState,
  splitParagraph,
  toggleList,
  toggleListChecked,
  setSelection,
  type EditorState,
} from '../src/domain/engine/edit';
import { makeSelection } from '../src/domain/engine/cursor';

/** A ready-to-use list item. */
function item(
  text: string,
  kind: ListKind,
  listId: string,
  level = 0,
  extra: Partial<ParagraphNode> = {},
): ParagraphNode {
  return { ...createParagraph(text), listKind: kind, listId, listLevel: level, ...extra };
}

function documentOf(blocks: WriterDocumentState['blocks']): WriterDocumentState {
  return { ...createEmptyDocument('Essai'), blocks };
}

/** Markers of the document, in reading order. */
function markersOf(doc: WriterDocumentState): string[] {
  const markers = computeListMarkers(doc);
  return paragraphIndex(doc)
    .order.map((id) => markers.get(id)?.text)
    .filter((text): text is string => text !== undefined);
}

describe('numérotation', () => {
  it('numérote une liste ordonnée de un à n', () => {
    const doc = documentOf([
      item('un', 'ordered', 'L1'),
      item('deux', 'ordered', 'L1'),
      item('trois', 'ordered', 'L1'),
    ]);
    expect(markersOf(doc)).toEqual(['1.', '2.', '3.']);
  });

  it('change de format à chaque niveau, comme Writer', () => {
    expect(formatOrdered(0, 3)).toBe('3.');
    expect(formatOrdered(1, 3)).toBe('c)');
    expect(formatOrdered(2, 4)).toBe('iv.');
    // The cycle starts again at the fourth level.
    expect(formatOrdered(3, 2)).toBe('2.');
  });

  it('remet à zéro les niveaux plus profonds quand on remonte', () => {
    const doc = documentOf([
      item('un', 'ordered', 'L1', 0),
      item('un.a', 'ordered', 'L1', 1),
      item('un.b', 'ordered', 'L1', 1),
      item('deux', 'ordered', 'L1', 0),
      item('deux.a', 'ordered', 'L1', 1),
    ]);
    // "deux.a" starts again at "a)": coming back out of a level closes its counter.
    expect(markersOf(doc)).toEqual(['1.', 'a)', 'b)', '2.', 'a)']);
  });

  it('sépare deux listes d’identifiants différents', () => {
    const doc = documentOf([
      item('un', 'ordered', 'L1'),
      item('deux', 'ordered', 'L1'),
      item('autre liste', 'ordered', 'L2'),
    ]);
    expect(markersOf(doc)).toEqual(['1.', '2.', '1.']);
  });

  it('ferme le compteur dès qu’un paragraphe de texte s’intercale', () => {
    const doc = documentOf([
      item('un', 'ordered', 'L1'),
      createParagraph('texte courant'),
      item('reprise', 'ordered', 'L1'),
    ]);
    expect(markersOf(doc)).toEqual(['1.', '1.']);
  });

  it('honore une reprise de numérotation explicite', () => {
    const doc = documentOf([
      item('un', 'ordered', 'L1'),
      item('sept', 'ordered', 'L1', 0, { listRestart: true, listStartValue: 7 }),
      item('huit', 'ordered', 'L1'),
    ]);
    expect(markersOf(doc)).toEqual(['1.', '7.', '8.']);
  });

  it('alterne les puces selon le niveau', () => {
    const doc = documentOf([
      item('a', 'bullet', 'L1', 0),
      item('b', 'bullet', 'L1', 1),
      item('c', 'bullet', 'L1', 2),
    ]);
    expect(markersOf(doc)).toEqual(['•', '◦', '▪']);
  });

  it('donne à chaque cellule son propre compteur', () => {
    const table = createTable(1, 2);
    table.rows[0]!.cells[0]!.blocks = [item('a', 'ordered', 'L1'), item('b', 'ordered', 'L1')];
    table.rows[0]!.cells[1]!.blocks = [item('c', 'ordered', 'L1')];
    // The second cell starts again at 1: two cells do not share a list.
    expect(markersOf(documentOf([table]))).toEqual(['1.', '2.', '1.']);
  });
});

describe('retrait', () => {
  it('ajoute un cran par niveau, en plus du retrait propre', () => {
    const node = item('x', 'bullet', 'L1', 2, { indentLeftPt: 10 });
    expect(effectiveIndentLeftPt(node)).toBe(10 + 3 * LIST_INDENT_PT);
  });

  it('laisse intact le retrait d’un paragraphe hors liste', () => {
    expect(effectiveIndentLeftPt({ ...createParagraph('x'), indentLeftPt: 10 })).toBe(10);
  });
});

describe('commandes', () => {
  function stateOf(blocks: WriterDocumentState['blocks']): EditorState {
    return createEditorState(documentOf(blocks));
  }

  function selectAllParagraphs(state: EditorState): EditorState {
    const { order } = paragraphIndex(state.doc);
    return setSelection(
      state,
      makeSelection(
        { blockId: order[0]!, offset: 0 },
        { blockId: order[order.length - 1]!, offset: 0 },
      ),
    );
  }

  function nodeAt(state: EditorState, index: number): ParagraphNode {
    const { order, byId } = paragraphIndex(state.doc);
    return byId.get(order[index]!)!.paragraph;
  }

  it('pose une seule liste sur toute la sélection', () => {
    let state = stateOf([createParagraph('un'), createParagraph('deux')]);
    state = toggleList(selectAllParagraphs(state), 'bullet');

    const premier = nodeAt(state, 0);
    const second = nodeAt(state, 1);
    expect(premier.listKind).toBe('bullet');
    // Same id: it is one list, not two isolated items.
    expect(second.listId).toBe(premier.listId);
  });

  it('sort de la liste quand tout y est déjà', () => {
    let state = stateOf([createParagraph('un'), createParagraph('deux')]);
    state = toggleList(selectAllParagraphs(state), 'bullet');
    state = toggleList(selectAllParagraphs(state), 'bullet');
    expect(nodeAt(state, 0).listKind).toBeUndefined();
    expect(nodeAt(state, 0).listId).toBeUndefined();
  });

  it('rejoint la liste voisine plutôt que d’en ouvrir une nouvelle', () => {
    let state = stateOf([
      item('déjà', 'bullet', 'L1'),
      createParagraph('à joindre'),
    ]);
    const { order } = paragraphIndex(state.doc);
    state = setSelection(
      state,
      makeSelection({ blockId: order[1]!, offset: 0 }, { blockId: order[1]!, offset: 0 }),
    );
    state = toggleList(state, 'bullet');
    expect(nodeAt(state, 1).listId).toBe('L1');
  });

  it('convertit un titre en paragraphe : un titre ne se numérote pas', () => {
    let state = stateOf([createParagraph('Titre', { headingLevel: 2 })]);
    state = toggleList(selectAllParagraphs(state), 'ordered');
    expect(nodeAt(state, 0).type).toBe('paragraph');
    expect(nodeAt(state, 0).headingLevel).toBeUndefined();
  });

  it('borne le niveau d’imbrication', () => {
    let state = stateOf([item('x', 'bullet', 'L1', 0)]);
    for (let i = 0; i < 20; i += 1) state = changeListLevel(selectAllParagraphs(state), 1);
    expect(nodeAt(state, 0).listLevel).toBe(9);

    for (let i = 0; i < 20; i += 1) state = changeListLevel(selectAllParagraphs(state), -1);
    expect(nodeAt(state, 0).listLevel).toBe(0);
  });

  it('ne touche pas au niveau hors liste', () => {
    // The command returns the state **unchanged**, down to identity: nothing to recompute, so nothing to re-render.
    const state = selectAllParagraphs(stateOf([createParagraph('texte')]));
    expect(changeListLevel(state, 1)).toBe(state);
  });

  it('bascule la case d’un élément à cocher', () => {
    let state = stateOf([item('tâche', 'task', 'L1')]);
    const id = paragraphIndex(state.doc).order[0]!;
    state = toggleListChecked(state, id);
    expect(nodeAt(state, 0).listChecked).toBe(true);
    state = toggleListChecked(state, id);
    expect(nodeAt(state, 0).listChecked).toBe(false);
  });

  it('ne coche pas un élément qui n’est pas une case', () => {
    const state = stateOf([item('puce', 'bullet', 'L1')]);
    const id = paragraphIndex(state.doc).order[0]!;
    expect(toggleListChecked(state, id)).toBe(state);
  });
});

describe('Entrée dans une liste', () => {
  function stateAt(node: ParagraphNode, offset: number): EditorState {
    const state = createEditorState(documentOf([node]));
    return setSelection(
      state,
      makeSelection({ blockId: node.id, offset }, { blockId: node.id, offset }),
    );
  }

  it('poursuit la liste sur un élément non vide', () => {
    const node = item('texte', 'bullet', 'L1', 1);
    const state = splitParagraph(stateAt(node, 5));
    const { order, byId } = paragraphIndex(state.doc);
    const suivant = byId.get(order[1]!)!.paragraph;
    expect(suivant.listKind).toBe('bullet');
    expect(suivant.listId).toBe('L1');
    expect(suivant.listLevel).toBe(1);
  });

  it('n’hérite ni de la case cochée ni d’une reprise de numérotation', () => {
    const node = item('fait', 'task', 'L1', 0, { listChecked: true, listRestart: true });
    const state = splitParagraph(stateAt(node, 4));
    const { order, byId } = paragraphIndex(state.doc);
    const suivant = byId.get(order[1]!)!.paragraph;
    expect(suivant.listChecked).toBeUndefined();
    expect(suivant.listRestart).toBeUndefined();
  });

  it('remonte d’un niveau sur un élément vide imbriqué', () => {
    const node = item('', 'bullet', 'L1', 2);
    const state = splitParagraph(stateAt(node, 0));
    // No node created: it is the level that changes.
    expect(paragraphIndex(state.doc).order).toHaveLength(1);
    expect(paragraphIndex(state.doc).byId.get(node.id)!.paragraph.listLevel).toBe(1);
  });

  it('sort de la liste sur un élément vide de premier niveau', () => {
    const node = item('', 'bullet', 'L1', 0);
    const state = splitParagraph(stateAt(node, 0));
    expect(paragraphIndex(state.doc).order).toHaveLength(1);
    expect(paragraphIndex(state.doc).byId.get(node.id)!.paragraph.listKind).toBeUndefined();
  });
});
