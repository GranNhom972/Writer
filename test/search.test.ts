/**
 * Rechercher et remplacer — `SwCursor::Find` / `findtxt.cxx`.
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
import { createEditorState, type EditorState } from '../src/domain/engine/edit';
import {
  DEFAULT_SEARCH_OPTIONS,
  escapeRegExp,
  findMatches,
  matchNearest,
  replaceAll,
  replaceMatch,
  selectMatch,
  type SearchOptions,
} from '../src/domain/engine/search';

function documentOf(blocks: WriterDocumentState['blocks']): WriterDocumentState {
  return { ...createEmptyDocument('Essai'), blocks };
}

/** Texte trouvé pour chaque occurrence, dans l'ordre. */
function found(doc: WriterDocumentState, query: string, options?: Partial<SearchOptions>): string[] {
  return findMatches(doc, query, { ...DEFAULT_SEARCH_OPTIONS, ...options }).map((match) => {
    const paragraph = paragraphIndex(doc).byId.get(match.blockId)!.paragraph;
    return paragraphText(paragraph).slice(match.start, match.end);
  });
}

describe('recherche', () => {
  it('trouve toutes les occurrences, dans l’ordre de lecture', () => {
    const doc = documentOf([createParagraph('un chat, un chien'), createParagraph('un cheval')]);
    expect(found(doc, 'un')).toEqual(['un', 'un', 'un']);
  });

  it('ignore la casse par défaut, la respecte sur demande', () => {
    const doc = documentOf([createParagraph('Chat chat CHAT')]);
    expect(found(doc, 'chat')).toHaveLength(3);
    expect(found(doc, 'chat', { matchCase: true })).toEqual(['chat']);
  });

  it('traverse un changement de formatage', () => {
    // « bon » et « jour » sont deux runs : l'occurrence les enjambe, parce que
    // les runs ne sont qu'une découpe de la même chaîne.
    const doc = documentOf([
      createParagraph('', { runs: [makeRun('bon'), makeRun('jour', { bold: true })] }),
    ]);
    expect(found(doc, 'bonjour')).toEqual(['bonjour']);
  });

  it('ne traverse jamais une frontière de paragraphe', () => {
    const doc = documentOf([createParagraph('bon'), createParagraph('jour')]);
    expect(found(doc, 'bonjour')).toEqual([]);
  });

  it('délimite le mot entier, accents compris', () => {
    const doc = documentOf([createParagraph('été, étérnel, l’été')]);
    // Sans l'option, « été » se trouve aussi dans « étérnel ».
    expect(found(doc, 'été')).toHaveLength(3);
    // Avec, « étérnel » est exclu : `\b` d'ASCII aurait coupé sur le « é ».
    expect(found(doc, 'été', { wholeWord: true })).toHaveLength(2);
  });

  it('traite la saisie comme du texte, pas comme un motif', () => {
    const doc = documentOf([createParagraph('a.b et axb')]);
    expect(found(doc, 'a.b')).toEqual(['a.b']);
    expect(escapeRegExp('a.b')).toBe('a\\.b');
  });

  it('cherche aussi dans les cellules de tableau', () => {
    const table = createTable(1, 2);
    table.rows[0]!.cells[0]!.blocks = [createParagraph('cible')];
    table.rows[0]!.cells[1]!.blocks = [createParagraph('cible aussi')];
    expect(found(documentOf([table]), 'cible')).toHaveLength(2);
  });

  it('ne renvoie rien pour une requête vide', () => {
    expect(found(documentOf([createParagraph('texte')]), '')).toEqual([]);
  });

  it('ne boucle pas sur une occurrence de longueur nulle', () => {
    // Un motif qui ne consomme rien ferait tourner `exec` sur place.
    const doc = documentOf([createParagraph('abc')]);
    expect(found(doc, '').length).toBe(0);
  });
});

describe('occurrence courante', () => {
  const doc = documentOf([createParagraph('un deux un deux un')]);
  const matches = findMatches(doc, 'un', DEFAULT_SEARCH_OPTIONS);
  const blockId = paragraphIndex(doc).order[0]!;

  it('désigne la première occurrence à partir du début', () => {
    expect(matchNearest(doc, matches, { blockId, offset: 0 })).toBe(0);
  });

  it('désigne l’occurrence qui commence exactement au curseur', () => {
    expect(matchNearest(doc, matches, { blockId, offset: matches[1]!.start })).toBe(1);
  });

  it('boucle sur la première quand le curseur est après la dernière', () => {
    // Une recherche qui s'arrêterait à la fin obligerait à revenir en haut à la
    // main : elle reprend au début, comme partout ailleurs.
    expect(matchNearest(doc, matches, { blockId, offset: 999 })).toBe(0);
  });

  it('sélectionne l’occurrence de bout en bout', () => {
    const state = selectMatch(createEditorState(doc), matches[1]!);
    expect(state.selection.anchor.offset).toBe(matches[1]!.start);
    expect(state.selection.focus.offset).toBe(matches[1]!.end);
    expect(state.selection.isCollapsed).toBe(false);
  });
});

describe('remplacement', () => {
  function textOf(state: EditorState): string {
    const { order, byId } = paragraphIndex(state.doc);
    return order.map((id) => paragraphText(byId.get(id)!.paragraph)).join('\n');
  }

  it('remplace une seule occurrence', () => {
    const doc = documentOf([createParagraph('un deux un')]);
    const matches = findMatches(doc, 'un', DEFAULT_SEARCH_OPTIONS);
    const state = replaceMatch(createEditorState(doc), matches[0]!, 'UN');
    expect(textOf(state)).toBe('UN deux un');
  });

  it('conserve le formatage du début de l’occurrence', () => {
    const doc = documentOf([
      createParagraph('', { runs: [makeRun('avant '), makeRun('cible', { bold: true })] }),
    ]);
    const matches = findMatches(doc, 'cible', DEFAULT_SEARCH_OPTIONS);
    const state = replaceMatch(createEditorState(doc), matches[0]!, 'remplacé');
    const runs = paragraphIndex(state.doc).byId.get(matches[0]!.blockId)!.paragraph.runs;
    expect(runs.find((run) => run.text === 'remplacé')?.bold).toBe(true);
  });

  it('supprime l’occurrence quand le remplacement est vide', () => {
    const doc = documentOf([createParagraph('gardez ceci')]);
    const matches = findMatches(doc, ' ceci', DEFAULT_SEARCH_OPTIONS);
    expect(textOf(replaceMatch(createEditorState(doc), matches[0]!, ''))).toBe('gardez');
  });

  it('remplace tout d’un coup et compte les occurrences', () => {
    const doc = documentOf([createParagraph('a a a'), createParagraph('a')]);
    const { state, count } = replaceAll(
      createEditorState(doc),
      'a',
      DEFAULT_SEARCH_OPTIONS,
      'zz',
    );
    expect(count).toBe(4);
    expect(textOf(state)).toBe('zz zz zz\nzz');
  });

  it('remplace de la fin vers le début sans décaler les suivantes', () => {
    // Un remplacement plus long que l'occurrence décalerait les positions
    // calculées si l'on procédait de gauche à droite.
    const doc = documentOf([createParagraph('x-x-x')]);
    const { state } = replaceAll(createEditorState(doc), 'x', DEFAULT_SEARCH_OPTIONS, 'LONG');
    expect(textOf(state)).toBe('LONG-LONG-LONG');
  });

  it('ne touche à rien quand il n’y a rien à remplacer', () => {
    const state = createEditorState(documentOf([createParagraph('texte')]));
    const résultat = replaceAll(state, 'absent', DEFAULT_SEARCH_OPTIONS, 'x');
    expect(résultat.count).toBe(0);
    // L'état est rendu tel quel : une transaction vide n'entre pas dans
    // l'historique.
    expect(résultat.state).toBe(state);
  });

  it('remplace dans les cellules de tableau', () => {
    const table = createTable(1, 2);
    table.rows[0]!.cells[0]!.blocks = [createParagraph('cible')];
    table.rows[0]!.cells[1]!.blocks = [createParagraph('cible')];
    const { count, state } = replaceAll(
      createEditorState(documentOf([table])),
      'cible',
      DEFAULT_SEARCH_OPTIONS,
      'ok',
    );
    expect(count).toBe(2);
    expect(textOf(state)).toContain('ok');
  });
});
