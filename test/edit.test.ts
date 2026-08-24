/**
 * Édition atomique (§4.2 du CLAUDE.md) et historique (`SwUndo`).
 */
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
  paragraphIndex,
  paragraphText,
} from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import type { WriterDocumentState } from '../src/domain/document/types';
import {
  activeFormatting,
  applyParagraphFormat,
  createEditorState,
  deleteBackward,
  deleteSelection,
  extractFragment,
  insertBlockPageBreak,
  insertFragment,
  insertText,
  selectAll,
  selectionText,
  setHeading,
  setSelection,
  splitParagraph,
  toggleRunFormat,
  type EditorState,
} from '../src/domain/engine/edit';
import { makeSelection } from '../src/domain/engine/cursor';
import {
  canUndo,
  commit,
  createSession,
  redo,
  typingGroup,
  undo,
} from '../src/domain/engine/history';

function stateOf(blocks: WriterDocumentState['blocks']): EditorState {
  return createEditorState({ ...createEmptyDocument('Essai'), blocks });
}

function textOf(state: EditorState, index = 0): string {
  const id = paragraphIndex(state.doc).order[index]!;
  return paragraphText(paragraphIndex(state.doc).byId.get(id)!.paragraph);
}

/** Sélectionne `[from, to)` dans le paragraphe de rang `index`. */
function select(state: EditorState, from: number, to: number, index = 0): EditorState {
  const id = paragraphIndex(state.doc).order[index]!;
  return setSelection(state, makeSelection({ blockId: id, offset: from }, { blockId: id, offset: to }));
}

describe('insertion de texte', () => {
  it('insère au curseur et l’avance d’autant', () => {
    let state = stateOf([createParagraph('bonjour')]);
    state = setSelection(state, makeSelection(
      { blockId: state.selection.focus.blockId, offset: 7 },
      { blockId: state.selection.focus.blockId, offset: 7 },
    ));
    state = insertText(state, ' !');
    expect(textOf(state)).toBe('bonjour !');
    expect(state.selection.focus.offset).toBe(9);
  });

  it('remplace la sélection', () => {
    let state = stateOf([createParagraph('abcdef')]);
    state = select(state, 1, 4);
    state = insertText(state, 'X');
    expect(textOf(state)).toBe('aXef');
    expect(state.selection.isCollapsed).toBe(true);
  });

  it('applique le formatage armé sur un curseur replié', () => {
    let state = stateOf([createParagraph('')]);
    const before = state.doc;
    state = toggleRunFormat(state, 'bold');
    // Rien n'est encore écrit dans le document : le gras est seulement armé.
    expect(state.doc).toBe(before);
    expect(state.pendingFormat).toEqual({ bold: true });

    state = insertText(state, 'gras');
    const paragraph = paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)!.paragraph;
    expect(paragraph.runs[0]?.bold).toBe(true);
  });
});

describe('suppression', () => {
  it('efface le caractère précédent', () => {
    let state = stateOf([createParagraph('abc')]);
    state = select(state, 3, 3);
    state = deleteBackward(state);
    expect(textOf(state)).toBe('ab');
  });

  it('ne coupe pas une grappe de graphèmes en deux', () => {
    let state = stateOf([createParagraph('a👨‍👩‍👧b')]);
    const length = textOf(state).length;
    state = select(state, length - 1, length - 1);
    state = deleteBackward(state);
    // L'emoji entier disparaît, pas une moitié de paire de substitution.
    expect(textOf(state)).toBe('ab');
  });

  it('fusionne avec le paragraphe précédent en début de nœud', () => {
    let state = stateOf([createParagraph('abc'), createParagraph('def')]);
    const secondId = paragraphIndex(state.doc).order[1]!;
    state = setSelection(state, makeSelection(
      { blockId: secondId, offset: 0 },
      { blockId: secondId, offset: 0 },
    ));
    state = deleteBackward(state);
    expect(paragraphIndex(state.doc).order).toHaveLength(1);
    expect(textOf(state)).toBe('abcdef');
    expect(state.selection.focus.offset).toBe(3);
  });

  it('supprime une sélection couvrant plusieurs paragraphes', () => {
    let state = stateOf([
      createParagraph('abc'),
      createParagraph('milieu'),
      createParagraph('def'),
    ]);
    const order = paragraphIndex(state.doc).order;
    state = setSelection(state, makeSelection(
      { blockId: order[0]!, offset: 1 },
      { blockId: order[2]!, offset: 2 },
    ));
    state = deleteSelection(state);
    expect(paragraphIndex(state.doc).order).toHaveLength(1);
    expect(textOf(state)).toBe('af');
  });

  it('emporte le tableau qu’une sélection enjambe entièrement', () => {
    let state = stateOf([createParagraph('avant'), createTable(1, 1), createParagraph('après')]);
    const order = paragraphIndex(state.doc).order;
    state = setSelection(state, makeSelection(
      { blockId: order[0]!, offset: 1 },
      { blockId: order[2]!, offset: 1 },
    ));
    const after = deleteSelection(state);
    // Comportement de Writer : ce qui est couvert par la sélection disparaît,
    // tableau compris. Laisser une grille vidée de son texte n'aurait aucun sens.
    expect(after.doc.blocks.some((block) => block.type === 'table')).toBe(false);
    expect(paragraphIndex(after.doc).order).toHaveLength(1);
    expect(paragraphText(paragraphIndex(after.doc).byId.get(order[0]!)!.paragraph)).toBe('après');
  });

  it('ne soude pas deux paragraphes de cellules différentes', () => {
    let state = stateOf([createTable(1, 2)]);
    const order = paragraphIndex(state.doc).order;
    state = setSelection(state, makeSelection(
      { blockId: order[0]!, offset: 0 },
      { blockId: order[1]!, offset: 0 },
    ));
    const after = deleteSelection(state);
    // Chaque cellule garde son nœud de texte : `SwNodes::_MoveNodes` refuse de
    // traverser la frontière d'une cellule.
    expect(paragraphIndex(after.doc).order).toHaveLength(2);
  });
});

describe('coupure de paragraphe', () => {
  it('scinde le nœud et place le curseur au début du second', () => {
    let state = stateOf([createParagraph('abcdef')]);
    state = select(state, 3, 3);
    state = splitParagraph(state);
    const order = paragraphIndex(state.doc).order;
    expect(order).toHaveLength(2);
    expect(textOf(state, 0)).toBe('abc');
    expect(textOf(state, 1)).toBe('def');
    expect(state.selection.focus.blockId).toBe(order[1]);
    expect(state.selection.focus.offset).toBe(0);
  });

  it('ne prolonge pas un titre : la suite est du texte courant', () => {
    let state = stateOf([createParagraph('Titre', { headingLevel: 1 })]);
    state = select(state, 5, 5);
    state = splitParagraph(state);
    const second = paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)!.paragraph;
    expect(second.type).toBe('paragraph');
    expect(second.headingLevel).toBeUndefined();
  });

  it('conserve le formatage de part et d’autre de la coupure', () => {
    let state = stateOf([
      createParagraph('', { runs: [makeRun('grasnormal', { bold: true })] }),
    ]);
    state = select(state, 4, 4);
    state = splitParagraph(state);
    const order = paragraphIndex(state.doc).order;
    const first = paragraphIndex(state.doc).byId.get(order[0]!)!.paragraph;
    const second = paragraphIndex(state.doc).byId.get(order[1]!)!.paragraph;
    expect(first.runs[0]?.bold).toBe(true);
    expect(second.runs[0]?.bold).toBe(true);
  });
});

describe('formatage', () => {
  it('bascule le gras sur la sélection puis le retire', () => {
    let state = stateOf([createParagraph('abcdef')]);
    state = select(state, 0, 3);
    state = toggleRunFormat(state, 'bold');
    let paragraph = paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)!.paragraph;
    expect(paragraph.runs.map((run) => run.text)).toEqual(['abc', 'def']);
    expect(paragraph.runs[0]?.bold).toBe(true);

    state = toggleRunFormat(state, 'bold');
    paragraph = paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)!.paragraph;
    // Le retrait refusionne : on revient à un seul run, sans trace du passage.
    expect(paragraph.runs).toHaveLength(1);
  });

  it('reflète l’état réel dans activeFormatting', () => {
    let state = stateOf([createParagraph('abcdef')]);
    state = select(state, 0, 3);
    state = toggleRunFormat(state, 'italic');
    expect(activeFormatting(state).italic).toBe(true);
  });

  it('change le niveau de titre de tous les paragraphes sélectionnés', () => {
    let state = stateOf([createParagraph('un'), createParagraph('deux')]);
    state = selectAll(state);
    state = setHeading(state, 2);
    for (const id of paragraphIndex(state.doc).order) {
      const node = paragraphIndex(state.doc).byId.get(id)!.paragraph;
      expect(node.type).toBe('heading');
      expect(node.headingLevel).toBe(2);
    }
  });

  it('efface le niveau quand on repasse en paragraphe courant', () => {
    let state = stateOf([createParagraph('t', { headingLevel: 3 })]);
    state = selectAll(state);
    state = setHeading(state, 0);
    const node = paragraphIndex(state.doc).byId.get(paragraphIndex(state.doc).order[0]!)!.paragraph;
    expect(node.headingLevel).toBeUndefined();
  });

  it('pose un saut de page comme attribut, pas comme caractère', () => {
    let state = stateOf([createParagraph('abc')]);
    state = select(state, 3, 3);
    state = insertBlockPageBreak(state);
    const node = paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)!.paragraph;
    expect(node.pageBreakBefore).toBe(true);
    expect(textOf(state, 0)).toBe('abc');
  });

  it('applique l’alignement au paragraphe', () => {
    let state = stateOf([createParagraph('abc')]);
    state = applyParagraphFormat(state, { alignment: 'center' });
    const node = paragraphIndex(state.doc).byId.get(paragraphIndex(state.doc).order[0]!)!.paragraph;
    expect(node.alignment).toBe('center');
  });
});

describe('presse-papiers', () => {
  it('extrait puis recolle un fragment sans perdre le formatage', () => {
    let state = stateOf([createParagraph('', { runs: [makeRun('gras', { bold: true })] })]);
    state = selectAll(state);
    const fragment = extractFragment(state);
    expect(fragment.paragraphs[0]?.runs[0]?.bold).toBe(true);

    let target = stateOf([createParagraph('XY')]);
    target = select(target, 1, 1);
    target = insertFragment(target, fragment);
    expect(textOf(target)).toBe('XgrasY');
  });

  it('sépare les paragraphes par un saut de ligne dans le texte brut', () => {
    let state = stateOf([createParagraph('un'), createParagraph('deux')]);
    state = selectAll(state);
    expect(selectionText(state)).toBe('un\ndeux');
  });

  it('colle un fragment multi-paragraphes en créant les nœuds voulus', () => {
    let source = stateOf([createParagraph('un'), createParagraph('deux')]);
    source = selectAll(source);
    const fragment = extractFragment(source);

    let target = stateOf([createParagraph('AB')]);
    target = select(target, 1, 1);
    target = insertFragment(target, fragment);
    expect(paragraphIndex(target.doc).order).toHaveLength(2);
    expect(textOf(target, 0)).toBe('Aun');
    expect(textOf(target, 1)).toBe('deuxB');
  });
});

describe('historique — SwUndoManager', () => {
  it('annule puis refait une insertion', () => {
    let session = createSession(stateOf([createParagraph('abc')]));
    session = { ...session, state: select(session.state, 3, 3) };

    const next = insertText(session.state, 'def');
    session = commit(session, 'Saisie', next);
    expect(textOf(session.state)).toBe('abcdef');

    session = undo(session);
    expect(textOf(session.state)).toBe('abc');

    session = redo(session);
    expect(textOf(session.state)).toBe('abcdef');
  });

  it('regroupe les lettres d’un même mot en une entrée', () => {
    let session = createSession(stateOf([createParagraph('')]));
    for (const char of 'mot') {
      const before = session.state.selection.focus;
      const next = insertText(session.state, char);
      session = commit(
        session,
        'Saisie',
        next,
        typingGroup(before.blockId, before.offset, next.selection.focus.offset, char),
      );
    }
    expect(session.history.past).toHaveLength(1);
    session = undo(session);
    expect(textOf(session.state)).toBe('');
  });

  it('ferme le groupe au changement de classe de caractère', () => {
    let session = createSession(stateOf([createParagraph('')]));
    for (const char of 'ab c') {
      const before = session.state.selection.focus;
      const next = insertText(session.state, char);
      session = commit(
        session,
        'Saisie',
        next,
        typingGroup(before.blockId, before.offset, next.selection.focus.offset, char),
      );
    }
    // « ab », puis l'espace, puis « c » : trois entrées.
    expect(session.history.past).toHaveLength(3);
  });

  it('purge le refaire dès qu’une nouvelle action survient', () => {
    let session = createSession(stateOf([createParagraph('abc')]));
    session = { ...session, state: select(session.state, 3, 3) };
    session = commit(session, 'A', insertText(session.state, 'X'));
    session = undo(session);
    expect(session.history.future).toHaveLength(1);
    session = commit(session, 'B', insertText(session.state, 'Y'));
    expect(session.history.future).toHaveLength(0);
  });

  it('n’enregistre pas un simple déplacement de curseur', () => {
    let session = createSession(stateOf([createParagraph('abc')]));
    session = commit(session, 'Curseur', select(session.state, 1, 1));
    expect(canUndo(session)).toBe(false);
  });
});
