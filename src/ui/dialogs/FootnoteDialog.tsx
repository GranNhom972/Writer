// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { useState, type FormEvent, type JSX } from 'react';
import { Button } from '../../design/components/Button';
import { Modal } from '../../design/components/Modal';

interface FootnoteDialogProps {
  open: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
}

export function FootnoteDialog({ open, onClose, onInsert }: FootnoteDialogProps): JSX.Element | null {
  const [text, setText] = useState('');

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onInsert(text.trim());
      setText('');
      onClose();
    }
  };

  return (
    <Modal title="Insérer une note de bas de page" onClose={onClose} width={480}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--fg-primary)' }}>
            Contenu de la note
          </span>
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ex : Référence bibliographique ou précision complémentaire…"
            autoFocus
            style={{
              padding: 'var(--space-2) var(--space-3)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-app)',
              color: 'var(--fg-primary)',
              fontFamily: 'inherit',
              resize: 'vertical',
              fontSize: 'var(--text-sm)',
            }}
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button variant="ghost" onClick={onClose} type="button">
            Annuler
          </Button>
          <Button variant="primary" type="submit" disabled={!text.trim()}>
            Insérer la note
          </Button>
        </div>
      </form>
    </Modal>
  );
}
