// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Read-only: a share without write permission must not let anyone write.
 *
 * The server's refusal was not enough: the keystroke was accepted locally, displayed, then disappeared when the tab was closed. People believed they had written. The guard now lives in the editor, at the funnel of
 * transactions.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { createEditorState, insertText } from '../src/domain/engine/edit';
import { transactionAutorisee } from '../src/ui/editor/useWriterInput';

function etatAvecTexte(texte: string) {
  const doc = createEmptyDocument();
  doc.blocks = [createParagraph(texte)];
  return createEditorState(doc);
}

describe('transactionAutorisee', () => {
  it('laisse passer une modification quand on a le droit d’écrire', () => {
    const avant = etatAvecTexte('Bonjour');
    const apres = insertText(avant, ' tout le monde');

    expect(apres.doc).not.toBe(avant.doc);
    expect(transactionAutorisee(false, avant, apres)).toBe(true);
  });

  it('refuse une modification en lecture seule', () => {
    const avant = etatAvecTexte('Bonjour');
    const apres = insertText(avant, ' TENTATIVE');

    expect(apres.doc).not.toBe(avant.doc);
    expect(transactionAutorisee(true, avant, apres)).toBe(false);
  });

  it('laisse naviguer et sélectionner en lecture seule', () => {
    // The document is unchanged: only the selection moves. Blocking that would prevent reading, and copying, which a reader has the right to do.
    const avant = etatAvecTexte('Bonjour');
    const apres = { ...avant, selection: { ...avant.selection } };

    expect(apres.doc).toBe(avant.doc);
    expect(transactionAutorisee(true, avant, apres)).toBe(true);
  });

  it('juge sur le document, pas sur l’intention', () => {
    // A command that changes nothing (making already bold text bold, deleting in an empty document) goes through even in read-only mode: it writes nothing. This is the direct consequence of comparing documents rather than
    // listing the forbidden commands.
    const avant = etatAvecTexte('Bonjour');
    const apres = { ...avant };

    expect(transactionAutorisee(true, avant, apres)).toBe(true);
  });
});
