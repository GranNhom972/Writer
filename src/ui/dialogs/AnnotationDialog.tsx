// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Dialogues d'annotation : commentaire et signet.
 *
 * Les deux posent un **repère sur une plage de texte** et partagent donc la
 * même contrainte : sans sélection, il n'y a rien à ancrer. C'est ce que les
 * deux dialogues disent explicitement plutôt que de laisser l'utilisateur
 * valider un formulaire qui ne fera rien — le reproche exact qu'on peut faire
 * à un bouton qui accepte le clic et n'agit pas.
 */

import { useState, type FormEvent, type JSX } from 'react';
import { Button } from '../../design/components/Button';
import { Modal } from '../../design/components/Modal';

const fieldStyle = {
  padding: 'var(--space-2) var(--space-3)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-app)',
  color: 'var(--fg-primary)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
} as const;

const labelStyle = {
  fontSize: 'var(--text-sm)',
  fontWeight: 500,
  color: 'var(--fg-primary)',
} as const;

interface CommentDialogProps {
  open: boolean;
  /** Texte actuellement sélectionné — vide si le curseur est replié. */
  quotedText: string;
  author: string;
  onClose: () => void;
  onInsert: (text: string) => void;
}

/** Dépose un commentaire sur la sélection (`SwEditShell::InsertPostIt`). */
export function CommentDialog({
  open,
  quotedText,
  author,
  onClose,
  onInsert,
}: CommentDialogProps): JSX.Element | null {
  const [text, setText] = useState('');

  if (!open) return null;

  const hasRange = quotedText.length > 0;

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!hasRange || !text.trim()) return;
    onInsert(text.trim());
    setText('');
    onClose();
  };

  return (
    <Modal title="Ajouter un commentaire" onClose={onClose} width={480}>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {hasRange ? (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-2) var(--space-3)',
              background: 'var(--bg-subtle, rgba(0,0,0,0.04))',
              borderRadius: 'var(--radius-sm)',
              fontStyle: 'italic',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-secondary, #5f6368)',
            }}
          >
            « {quotedText.length > 160 ? `${quotedText.slice(0, 160)}…` : quotedText} »
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--fg-secondary, #5f6368)' }}>
            Sélectionnez d'abord le texte à commenter : un commentaire s'ancre sur une plage, il
            n'a nulle part où se poser sans elle.
          </p>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={labelStyle}>Commentaire de {author}</span>
          <textarea
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Ex : Cette formulation gagnerait à être précisée."
            autoFocus
            disabled={!hasRange}
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button variant="ghost" onClick={onClose} type="button">
            Annuler
          </Button>
          <Button variant="primary" type="submit" disabled={!hasRange || !text.trim()}>
            Commenter
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface BookmarkDialogProps {
  open: boolean;
  quotedText: string;
  /** Signets déjà posés, pour refuser un doublon avant validation. */
  existingNames: readonly string[];
  onClose: () => void;
  onInsert: (name: string) => void;
}

/** Pose un signet nommé sur la sélection (`IDocumentMarkAccess::makeMark`). */
export function BookmarkDialog({
  open,
  quotedText,
  existingNames,
  onClose,
  onInsert,
}: BookmarkDialogProps): JSX.Element | null {
  const [name, setName] = useState('');

  if (!open) return null;

  const trimmed = name.trim();
  const duplicate = existingNames.includes(trimmed);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!trimmed || duplicate) return;
    onInsert(trimmed);
    setName('');
    onClose();
  };

  return (
    <Modal title="Poser un signet" onClose={onClose} width={440}>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {quotedText && (
          <p
            style={{
              margin: 0,
              fontStyle: 'italic',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-secondary, #5f6368)',
            }}
          >
            « {quotedText.length > 120 ? `${quotedText.slice(0, 120)}…` : quotedText} »
          </p>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={labelStyle}>Nom du signet</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex : introduction"
            autoFocus
            style={fieldStyle}
          />
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-secondary, #5f6368)' }}>
            {duplicate
              ? 'Ce nom est déjà pris : deux signets homonymes rendraient tout renvoi ambigu.'
              : 'Ce nom sert de cible aux renvois internes, sous la forme #nom.'}
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button variant="ghost" onClick={onClose} type="button">
            Annuler
          </Button>
          <Button variant="primary" type="submit" disabled={!trimmed || duplicate}>
            Poser le signet
          </Button>
        </div>
      </form>
    </Modal>
  );
}
