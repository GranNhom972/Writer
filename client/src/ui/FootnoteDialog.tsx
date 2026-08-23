import { useState, type FormEvent } from 'react';
import { Button } from '../design/components/Button';
import { Modal } from '../design/components/Modal';

interface FootnoteDialogProps {
  open: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
}

export function FootnoteDialog({ open, onClose, onInsert }: FootnoteDialogProps) {
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
    <Modal title="Insérer une note de bas de page" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Contenu de la note</span>
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ex : Référence ou explication complémentaire..."
            autoFocus
            style={{
              padding: 'var(--space-2) var(--space-3)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-app)',
              color: 'var(--fg-primary)',
              fontFamily: 'inherit',
              resize: 'vertical',
            }}
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <Button variant="ghost" onClick={onClose} type="button">
            Annuler
          </Button>
          <Button variant="primary" type="submit" disabled={!text.trim()}>
            Insérer
          </Button>
        </div>
      </form>
    </Modal>
  );
}
