// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Lecture seule — un partage sans droit d'écriture ne doit pas laisser écrire.
 *
 * Le refus du serveur ne suffisait pas : la frappe était acceptée localement,
 * s'affichait, puis disparaissait à la fermeture de l'onglet. On croyait avoir
 * écrit. La garde vit désormais dans l'éditeur, à l'entonnoir des transactions.
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
    // Le document est inchangé : seule la sélection bouge. Bloquer cela
    // empêcherait de lire — et de copier, ce qu'un lecteur a le droit de faire.
    const avant = etatAvecTexte('Bonjour');
    const apres = { ...avant, selection: { ...avant.selection } };

    expect(apres.doc).toBe(avant.doc);
    expect(transactionAutorisee(true, avant, apres)).toBe(true);
  });

  it('juge sur le document, pas sur l’intention', () => {
    // Une commande qui ne change rien — mettre en gras un texte déjà gras,
    // supprimer dans un document vide — passe même en lecture seule : elle
    // n'écrit rien. C'est la conséquence directe de comparer les documents
    // plutôt que d'énumérer les commandes interdites.
    const avant = etatAvecTexte('Bonjour');
    const apres = { ...avant };

    expect(transactionAutorisee(true, avant, apres)).toBe(true);
  });
});
