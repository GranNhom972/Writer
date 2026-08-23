import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { writeSchema } from '../src/document/schema';
import {
  DEFAULT_SEARCH_OPTIONS,
  escapeRegExp,
  findMatches,
  nextMatchIndex,
  replaceAll,
  selectionMatches,
} from '../src/editor/search';

function docWith(...paragraphs: string[]) {
  return writeSchema.node(
    'doc',
    null,
    paragraphs.map((text) =>
      writeSchema.node('paragraph', null, text ? [writeSchema.text(text)] : []),
    ),
  );
}

const texteDe = (doc: ReturnType<typeof docWith>, match: { from: number; to: number }): string =>
  doc.textBetween(match.from, match.to);

describe('recherche', () => {
  it('trouve toutes les occurrences dans l’ordre du document', () => {
    const doc = docWith('Le chat dort', 'Le chat mange');
    const matches = findMatches(doc, 'chat', DEFAULT_SEARCH_OPTIONS);

    expect(matches).toHaveLength(2);
    expect(texteDe(doc, matches[0]!)).toBe('chat');
    expect(matches[0]!.from).toBeLessThan(matches[1]!.from);
  });

  it('ignore la casse par défaut, la respecte sur demande', () => {
    const doc = docWith('Chat chat CHAT');
    expect(findMatches(doc, 'chat', { matchCase: false, wholeWord: false })).toHaveLength(3);
    expect(findMatches(doc, 'chat', { matchCase: true, wholeWord: false })).toHaveLength(1);
  });

  it('limite aux mots entiers, accents compris', () => {
    const doc = docWith('un état des états et une étatisation');
    const partiel = findMatches(doc, 'état', { matchCase: false, wholeWord: false });
    const entier = findMatches(doc, 'état', { matchCase: false, wholeWord: true });

    expect(partiel).toHaveLength(3);
    // `\b` d'ECMAScript couperait avant « é » ; seul « état » isolé doit sortir.
    expect(entier).toHaveLength(1);
  });

  it('traite la saisie comme du texte, pas comme une expression régulière', () => {
    const doc = docWith('coût : 3 € (net)');
    expect(findMatches(doc, '(net)', DEFAULT_SEARCH_OPTIONS)).toHaveLength(1);
    expect(findMatches(doc, '.', DEFAULT_SEARCH_OPTIONS)).toHaveLength(0);
    expect(escapeRegExp('a+b')).toBe('a\\+b');
  });

  it('trouve un mot coupé par une mise en forme', () => {
    // « bon » + « jour » en gras : deux nœuds de texte, un seul mot à l’écran.
    const doc = writeSchema.node('doc', null, [
      writeSchema.node('paragraph', null, [
        writeSchema.text('bon'),
        writeSchema.text('jour', [writeSchema.marks['strong']!.create()]),
      ]),
    ]);
    expect(findMatches(doc, 'bonjour', DEFAULT_SEARCH_OPTIONS)).toHaveLength(1);
  });

  it('ne traverse jamais une frontière de paragraphe', () => {
    const doc = docWith('bon', 'jour');
    expect(findMatches(doc, 'bonjour', DEFAULT_SEARCH_OPTIONS)).toHaveLength(0);
  });

  it('renvoie une liste vide pour une requête vide', () => {
    expect(findMatches(docWith('texte'), '', DEFAULT_SEARCH_OPTIONS)).toEqual([]);
  });

  it('cherche les espaces si on le lui demande (double espace, indentation)', () => {
    // La requête n'est pas rognée : chercher « deux espaces » est un usage réel.
    expect(findMatches(docWith('un  deux  trois'), '  ', DEFAULT_SEARCH_OPTIONS)).toHaveLength(2);
  });
});

describe('navigation entre occurrences', () => {
  const doc = docWith('a chat b chat c chat');
  const matches = findMatches(doc, 'chat', DEFAULT_SEARCH_OPTIONS);

  it('va à la première occurrence après le curseur', () => {
    expect(nextMatchIndex(matches, 0, 'next')).toBe(0);
    expect(nextMatchIndex(matches, matches[0]!.to, 'next')).toBe(1);
  });

  it('boucle en fin de document', () => {
    expect(nextMatchIndex(matches, matches[2]!.to + 1, 'next')).toBe(0);
  });

  it('remonte vers l’occurrence précédente et boucle au début', () => {
    expect(nextMatchIndex(matches, matches[2]!.from, 'previous')).toBe(1);
    expect(nextMatchIndex(matches, 0, 'previous')).toBe(2);
  });

  it('renvoie -1 sans occurrence', () => {
    expect(nextMatchIndex([], 5, 'next')).toBe(-1);
  });
});

describe('remplacement', () => {
  function remplaceTout(texte: string, requete: string, par: string): string {
    const state = EditorState.create({ schema: writeSchema, doc: docWith(texte) });
    const matches = findMatches(state.doc, requete, DEFAULT_SEARCH_OPTIONS);
    const { transaction, count } = replaceAll(state.tr, matches, par);
    const next = state.apply(transaction);
    expect(count).toBe(matches.length);
    return next.doc.textBetween(0, next.doc.content.size, ' ');
  }

  it('remplace le mot ENTIER, pas son premier caractère', () => {
    // Régression : `match.length` (nombre de groupes) était utilisé à la place de
    // `match[0].length`, ce qui ne remplaçait qu'un caractère par occurrence.
    expect(remplaceTout('Le chat et le chat', 'chat', 'chien')).toBe('Le chien et le chien');
  });

  it('gère un remplacement plus long comme plus court', () => {
    expect(remplaceTout('a chat b', 'chat', 'félidé domestique')).toBe('a félidé domestique b');
    expect(remplaceTout('a chat b', 'chat', 'x')).toBe('a x b');
  });

  it('supprime les occurrences quand le remplacement est vide', () => {
    expect(remplaceTout('un joli chat joli', 'joli ', '')).toBe('un chat joli');
  });

  it('n’oublie aucune occurrence sur des positions rapprochées', () => {
    expect(remplaceTout('aaaa', 'a', 'b')).toBe('bbbb');
  });

  it('reconnaît qu’une sélection porte exactement sur une occurrence', () => {
    const doc = docWith('le chat');
    const matches = findMatches(doc, 'chat', DEFAULT_SEARCH_OPTIONS);
    const match = matches[0]!;

    expect(selectionMatches(matches, match.from, match.to)).toBe(true);
    expect(selectionMatches(matches, match.from, match.to - 1)).toBe(false);
  });
});
