// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useState, useEffect, useRef, type JSX } from 'react';
import { Modal } from '../../design/components/Modal';

export interface PaletteCommand {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  perform: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredCommands = commands.filter(
    (c) =>
      c.title.toLowerCase().includes(query.toLowerCase()) ||
      c.category.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1) % Math.max(1, filteredCommands.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(
        (idx) => (idx - 1 + filteredCommands.length) % Math.max(1, filteredCommands.length),
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].perform();
        onClose();
      }
    }
  };

  return (
    <Modal title="Palette de commandes" onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }} onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          placeholder="Rechercher une commande, raccourci ou action…"
          autoFocus
          style={{
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-app)',
            color: 'var(--fg-primary)',
            fontSize: 'var(--text-base)',
            outline: 'none',
          }}
        />

        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {filteredCommands.length === 0 ? (
            <div
              style={{
                padding: 'var(--space-4)',
                color: 'var(--fg-secondary)',
                fontSize: 'var(--text-sm)',
                textAlign: 'center',
              }}
            >
              Aucune commande trouvée
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {filteredCommands.map((c, idx) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      c.perform();
                      onClose();
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: 'var(--space-2) var(--space-3)',
                      border: 'none',
                      borderRadius: 'var(--radius-xs)',
                      backgroundColor: idx === selectedIndex ? 'var(--accent-subtle)' : 'transparent',
                      color: 'var(--fg-primary)',
                      fontSize: 'var(--text-sm)',
                      cursor: 'pointer',
                    }}
                  >
                    <div>
                      <span
                        style={{
                          color: 'var(--fg-secondary)',
                          fontSize: 'var(--text-xs)',
                          marginRight: 'var(--space-2)',
                        }}
                      >
                        [{c.category}]
                      </span>
                      <span style={{ fontWeight: 500 }}>{c.title}</span>
                    </div>
                    {c.shortcut && (
                      <kbd
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--fg-secondary)',
                          background: 'var(--bg-sunken)',
                          padding: '2px 6px',
                          borderRadius: 'var(--radius-xs)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {c.shortcut}
                      </kbd>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
