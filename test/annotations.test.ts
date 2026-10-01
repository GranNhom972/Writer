// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Commentaires marginaux (`SwPostItField` / `SwPostItMgr`) et signets
 * (`SwBookmark` / `IDocumentMarkAccess`).
 *
 * Les deux sous-systèmes partagent le même choix d'ancrage : le repère est un
 * **attribut de run**, il suit donc son texte par construction. Ces tests
 * vérifient surtout cette propriété-là — qu'une édition du texte commenté ou
 * marqué déplace le repère sans qu'aucun code de maintenance n'intervienne.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { makeRun, normalizeRuns, runFormatting } from '../src/domain/document/runs';
import {
  addComment,
  commentAnchors,
  commentIdsOf,
  commentThreads,
  deleteCommentReply,
  deleteCommentThread,
  editComment,
  joinCommentIds,
  pruneOrphanComments,
  replyToComment,
  resolveCommentThread,
} from '../src/domain/document/comments';
import {
  brokenInternalLinks,
  findBookmark,
  headingAnchorName,
  linkTargets,
  listBookmarks,
  normalizeBookmarkName,
  removeBookmark,
  renameBookmark,
  resolveInternalLink,
  setBookmark,
} from '../src/domain/document/bookmarks';
import { createEditorState, deleteSelection, insertText } from '../src/domain/engine/edit';
import type { DocumentBlock } from '../src/domain/document/types';

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

const QUAND = '2026-01-15T10:00:00.000Z';

describe('Commentaires — ancrage et fils (SwPostItMgr)', () => {
  it('pose un commentaire sur une plage et le retrouve à sa position', () => {
    const p = createParagraph('Le renard brun saute.');
    const { doc, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 3, endOffset: 14 },
      'Alice',
      'Formulation à revoir',
      { now: QUAND },
    );

    expect(threadId).not.toBe('');

    const anchors = commentAnchors(doc);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.text).toBe('renard brun');
    expect(anchors[0]?.startOffset).toBe(3);
    expect(anchors[0]?.endOffset).toBe(14);

    const [thread] = commentThreads(doc);
    expect(thread?.root.author).toBe('Alice');
    expect(thread?.root.text).toBe('Formulation à revoir');
    expect(thread?.quotedText).toBe('renard brun');
    expect(thread?.resolved).toBe(false);
  });

  it('refuse un commentaire sans plage : il n\'aurait rien à ancrer', () => {
    const p = createParagraph('Texte');
    const base = docOf([p]);
    const { doc, threadId } = addComment(
      base,
      { blockId: p.id, startOffset: 2, endOffset: 2 },
      'Alice',
      'Vide',
    );
    expect(threadId).toBe('');
    expect(doc).toBe(base);
  });

  it('refuse un commentaire au corps vide', () => {
    const p = createParagraph('Texte');
    const base = docOf([p]);
    const { doc } = addComment(base, { blockId: p.id, startOffset: 0, endOffset: 5 }, 'A', '   ');
    expect(doc).toBe(base);
  });

  it('empile les réponses dans le fil sans créer de second fil', () => {
    const p = createParagraph('Une phrase à discuter.');
    let { doc, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 0, endOffset: 3 },
      'Alice',
      'Question',
      { now: QUAND },
    );
    doc = replyToComment(doc, threadId, 'Bob', 'Réponse', { now: QUAND });
    doc = replyToComment(doc, threadId, 'Alice', 'Merci', { now: QUAND });

    const threads = commentThreads(doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.replies).toHaveLength(2);
    expect(threads[0]?.replies.map((r) => r.author)).toEqual(['Bob', 'Alice']);
  });

  it('résout puis rouvre un fil sans toucher à son ancre', () => {
    const p = createParagraph('Un texte commenté.');
    const { doc: withComment, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 0, endOffset: 2 },
      'Alice',
      'À vérifier',
    );

    const resolved = resolveCommentThread(withComment, threadId, true);
    expect(commentThreads(resolved)[0]?.resolved).toBe(true);
    expect(commentAnchors(resolved)).toHaveLength(1);

    const reopened = resolveCommentThread(resolved, threadId, false);
    expect(commentThreads(reopened)[0]?.resolved).toBe(false);
  });

  it('modifie le corps d\'une réponse sans toucher au reste', () => {
    const p = createParagraph('Texte.');
    let { doc, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 0, endOffset: 5 },
      'Alice',
      'Premier jet',
    );
    doc = editComment(doc, threadId, 'Version corrigée');
    expect(commentThreads(doc)[0]?.root.text).toBe('Version corrigée');
  });

  it('supprime le fil ET ses ancres ensemble', () => {
    const p = createParagraph('Le texte commenté.');
    const { doc: withComment, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 3, endOffset: 8 },
      'Alice',
      'À supprimer',
    );

    const after = deleteCommentThread(withComment, threadId);
    expect(after.comments ?? []).toHaveLength(0);
    expect(commentAnchors(after)).toHaveLength(0);

    // L'ancre retirée, les runs voisins redeviennent fusionnables.
    const paragraph = after.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(normalizeRuns(paragraph.runs)).toHaveLength(1);
  });

  it('ne supprime pas la racine par deleteCommentReply', () => {
    const p = createParagraph('Texte.');
    const { doc, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 0, endOffset: 5 },
      'Alice',
      'Racine',
    );
    expect(deleteCommentReply(doc, threadId)).toBe(doc);
  });

  it('l\'ancre suit le texte quand on insère avant elle', () => {
    const p = createParagraph('abcdef');
    const { doc, threadId } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 3, endOffset: 6 },
      'Alice',
      'sur def',
    );

    const state = insertText(
      { ...createEditorState(doc), selection: collapsedAt(p.id, 0) },
      'XX',
    );

    const anchors = commentAnchors(state.doc);
    expect(anchors[0]?.threadId).toBe(threadId);
    // La plage a glissé de deux caractères, sans code de maintenance.
    expect(anchors[0]?.startOffset).toBe(5);
    expect(anchors[0]?.text).toBe('def');
  });

  it('le fil devient orphelin quand tout son texte disparaît, et se nettoie', () => {
    const p = createParagraph('abcdef');
    const { doc } = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 2, endOffset: 4 },
      'Alice',
      'sur cd',
    );

    const state = deleteSelection({
      ...createEditorState(doc),
      selection: {
        anchor: { blockId: p.id, offset: 2 },
        focus: { blockId: p.id, offset: 4 },
        isCollapsed: false,
      },
    });

    expect(commentAnchors(state.doc)).toHaveLength(0);
    // Le contenu survit tant qu'on n'a pas nettoyé — c'est le comportement de
    // `SwPostItMgr`, qui laisse une chance de récupération.
    expect(state.doc.comments ?? []).toHaveLength(1);
    expect(pruneOrphanComments(state.doc).comments ?? []).toHaveLength(0);
  });

  it('trie les identifiants d\'ancre pour que deux runs voisins restent fusionnables', () => {
    // C'est l'invariant `sameFormatting` : la clé est scalaire et doit être
    // canonique, faute de quoi « a,b » et « b,a » ne seraient jamais égaux.
    expect(joinCommentIds(['b', 'a'])).toBe('a,b');
    expect(joinCommentIds(['a', 'b'])).toBe('a,b');
    expect(joinCommentIds([])).toBeUndefined();
    expect(commentIdsOf({ commentIds: 'a,b' })).toEqual(['a', 'b']);
    expect(commentIdsOf({})).toEqual([]);
  });

  it('supporte deux fils qui se chevauchent sur le même run', () => {
    const p = createParagraph('abcdefgh');
    const first = addComment(
      docOf([p]),
      { blockId: p.id, startOffset: 0, endOffset: 5 },
      'Alice',
      'un',
    );
    const second = addComment(
      first.doc,
      { blockId: p.id, startOffset: 3, endOffset: 8 },
      'Bob',
      'deux',
    );

    const anchors = commentAnchors(second.doc);
    expect(anchors).toHaveLength(2);
    expect(commentThreads(second.doc)).toHaveLength(2);

    // Le run central porte bien les deux identifiants.
    const paragraph = second.doc.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('paragraphe attendu');
    const central = paragraph.runs.find((run) => run.text === 'de');
    expect(commentIdsOf(central ?? {})).toHaveLength(2);
  });
});

describe('Signets et renvois internes (SwBookmark)', () => {
  it('normalise un nom : espaces en tirets bas, délimiteurs XML retirés', () => {
    expect(normalizeBookmarkName('  Mon Signet ')).toBe('Mon_Signet');
    expect(normalizeBookmarkName('a<b>&"c\'')).toBe('abc');
    expect(normalizeBookmarkName('')).toBe('');
  });

  it('pose un signet sur une plage et le relit', () => {
    const p = createParagraph('Chapitre premier');
    const doc = setBookmark(docOf([p]), { blockId: p.id, startOffset: 0, endOffset: 8 }, 'intro');

    const marks = listBookmarks(doc);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.name).toBe('intro');
    expect(marks[0]?.text).toBe('Chapitre');
    expect(findBookmark(doc, 'intro')?.startOffset).toBe(0);
  });

  it('attache un signet ponctuel au caractère qui suit', () => {
    const p = createParagraph('abcdef');
    const doc = setBookmark(docOf([p]), { blockId: p.id, startOffset: 2, endOffset: 2 }, 'point');
    const mark = findBookmark(doc, 'point');
    expect(mark?.startOffset).toBe(2);
    expect(mark?.text).toBe('c');
  });

  it('refuse deux signets homonymes : le second remplace le premier', () => {
    const p = createParagraph('abcdefghij');
    let doc = setBookmark(docOf([p]), { blockId: p.id, startOffset: 0, endOffset: 3 }, 'x');
    doc = setBookmark(doc, { blockId: p.id, startOffset: 5, endOffset: 8 }, 'x');

    const marks = listBookmarks(doc);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.startOffset).toBe(5);
  });

  it('refuse un nom réservé aux ancres de titre', () => {
    const p = createParagraph('abcdef');
    const base = docOf([p]);
    const doc = setBookmark(
      base,
      { blockId: p.id, startOffset: 0, endOffset: 3 },
      headingAnchorName('p1'),
    );
    expect(doc).toBe(base);
  });

  it('retire un signet et rend les runs fusionnables', () => {
    const p = createParagraph('abcdef');
    const withMark = setBookmark(docOf([p]), { blockId: p.id, startOffset: 1, endOffset: 3 }, 'm');
    const after = removeBookmark(withMark, 'm');

    expect(listBookmarks(after)).toHaveLength(0);
    const paragraph = after.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(normalizeRuns(paragraph.runs)).toHaveLength(1);
  });

  it('renomme un signet en reportant les renvois qui le visaient', () => {
    const cible = createParagraph('Section visée');
    const lien = createParagraph('', { runs: [makeRun('voir ici', { linkHref: '#ancien' })] });
    let doc = docOf([cible, lien]);
    doc = setBookmark(doc, { blockId: cible.id, startOffset: 0, endOffset: 7 }, 'ancien');

    doc = renameBookmark(doc, 'ancien', 'nouveau');

    expect(findBookmark(doc, 'nouveau')).not.toBeNull();
    expect(findBookmark(doc, 'ancien')).toBeNull();

    const paragraphe = doc.blocks[1];
    if (paragraphe?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(paragraphe.runs[0]?.linkHref).toBe('#nouveau');
  });

  it('résout un renvoi vers un signet et vers un titre', () => {
    const titre = createParagraph('Mon titre', { headingLevel: 2 });
    const corps = createParagraph('abcdefgh');
    let doc = docOf([titre, corps]);
    doc = setBookmark(doc, { blockId: corps.id, startOffset: 2, endOffset: 5 }, 'repere');

    expect(resolveInternalLink(doc, '#repere')).toEqual({ blockId: corps.id, offset: 2 });
    expect(resolveInternalLink(doc, `#${headingAnchorName(titre.id)}`)).toEqual({
      blockId: titre.id,
      offset: 0,
    });
    // Adresse externe : ce n'est pas au résolveur interne de s'en occuper.
    expect(resolveInternalLink(doc, 'https://exemple.fr')).toBeNull();
    expect(resolveInternalLink(doc, '#inexistant')).toBeNull();
  });

  it('ne tombe pas sur une séquence % mal formée', () => {
    const doc = docOf([createParagraph('texte')]);
    expect(() => resolveInternalLink(doc, '#%E0%A4%A')).not.toThrow();
    expect(resolveInternalLink(doc, '#%E0%A4%A')).toBeNull();
  });

  it('recense les cibles de renvoi : signets et titres', () => {
    const titre = createParagraph('Introduction', { headingLevel: 1 });
    const corps = createParagraph('abcdefgh');
    let doc = docOf([titre, corps]);
    doc = setBookmark(doc, { blockId: corps.id, startOffset: 0, endOffset: 3 }, 'sig');

    const cibles = linkTargets(doc);
    expect(cibles.map((c) => c.kind).sort()).toEqual(['bookmark', 'heading']);
    expect(cibles.find((c) => c.kind === 'heading')?.label).toBe('Introduction');
  });

  it('signale les renvois cassés', () => {
    const lien = createParagraph('', { runs: [makeRun('lien', { linkHref: '#nulle_part' })] });
    expect(brokenInternalLinks(docOf([lien]))).toEqual(['#nulle_part']);
  });

  it('le signet suit son texte lors d\'une insertion en amont', () => {
    const p = createParagraph('abcdef');
    const doc = setBookmark(docOf([p]), { blockId: p.id, startOffset: 3, endOffset: 6 }, 'fin');

    const state = insertText({ ...createEditorState(doc), selection: collapsedAt(p.id, 0) }, 'ZZZ');
    expect(findBookmark(state.doc, 'fin')?.startOffset).toBe(6);
    expect(findBookmark(state.doc, 'fin')?.text).toBe('def');
  });

  it('le formatage d\'un run est préservé quand on y pose un signet', () => {
    const p = createParagraph('', { runs: [makeRun('gras', { bold: true })] });
    const doc = setBookmark(docOf([p]), { blockId: p.id, startOffset: 0, endOffset: 4 }, 'g');
    const paragraph = doc.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(runFormatting(paragraph.runs[0]!).bold).toBe(true);
    expect(paragraph.runs[0]?.bookmarkName).toBe('g');
  });
});

function collapsedAt(blockId: string, offset: number) {
  return {
    anchor: { blockId, offset },
    focus: { blockId, offset },
    isCollapsed: true,
  };
}
