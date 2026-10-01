// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Find and replace.
 *
 * A **non-modal** panel, anchored above the document: a modal window would hide the text being searched for and forbid carrying on writing. You can read the highlighted matches
 * while the panel stays open.
 *
 * The "3 / 12" counter is indispensable: without it, you cannot tell whether you are going round in circles in a long document.
 */

import { useEffect, useRef, type JSX } from 'react';
import { Icon } from '../../design/icons/Icon';
import type { SearchOptions } from '../../domain/engine/search';

export interface FindReplaceState {
  query: string;
  replacement: string;
  options: SearchOptions;
  showReplace: boolean;
}

export interface FindReplacePanelProps {
  state: FindReplaceState;
  onChange: (next: FindReplaceState) => void;
  /** Total number of matches. */
  total: number;
  /** Rank of the current match, starting at 1. Zero if there is none. */
  current: number;
  onNavigate: (direction: 1 | -1) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  /** In read-only mode, the replace part disappears instead of being greyed out. */
  readOnly: boolean;
}

export function FindReplacePanel({
  state,
  onChange,
  total,
  current,
  onNavigate,
  onReplace,
  onReplaceAll,
  onClose,
  readOnly,
}: FindReplacePanelProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The field takes focus on opening: the user has just pressed Ctrl+F to type something, not to click in a field.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const set = (patch: Partial<FindReplaceState>): void => onChange({ ...state, ...patch });

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onNavigate(event.shiftKey ? -1 : 1);
    }
  };

  const introuvable = state.query.length > 0 && total === 0;

  return (
    <div className="findbar" role="search" aria-label="Rechercher et remplacer" onKeyDown={onKeyDown}>
      <div className="findbar__row">
        <input
          ref={inputRef}
          type="search"
          className="findbar__input"
          placeholder="Rechercher"
          aria-label="Texte à rechercher"
          value={state.query}
          onChange={(event) => set({ query: event.target.value })}
        />

        <span
          className="findbar__count"
          role="status"
          aria-live="polite"
          data-empty={introuvable ? 'true' : undefined}
        >
          {state.query.length === 0
            ? ''
            : total === 0
              ? 'Aucun résultat'
              : `${current} / ${total}`}
        </span>

        <button
          type="button"
          className="btn btn--icon"
          aria-label="Occurrence précédente (Maj+Entrée)"
          title="Occurrence précédente (Maj+Entrée)"
          disabled={total === 0}
          onClick={() => onNavigate(-1)}
        >
          <Icon name="chevron-up" />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Occurrence suivante (Entrée)"
          title="Occurrence suivante (Entrée)"
          disabled={total === 0}
          onClick={() => onNavigate(1)}
        >
          <Icon name="chevron-down" />
        </button>

        <label className="findbar__option">
          <input
            type="checkbox"
            checked={state.options.matchCase}
            onChange={(event) =>
              set({ options: { ...state.options, matchCase: event.target.checked } })
            }
          />
          Respecter la casse
        </label>
        <label className="findbar__option">
          <input
            type="checkbox"
            checked={state.options.wholeWord}
            onChange={(event) =>
              set({ options: { ...state.options, wholeWord: event.target.checked } })
            }
          />
          Mot entier
        </label>

        {!readOnly && (
          <button
            type="button"
            className="btn btn--ghost findbar__toggle"
            aria-expanded={state.showReplace}
            onClick={() => set({ showReplace: !state.showReplace })}
          >
            {state.showReplace ? 'Masquer le remplacement' : 'Remplacer…'}
          </button>
        )}

        <button
          type="button"
          className="btn btn--icon"
          aria-label="Fermer la recherche (Échap)"
          title="Fermer (Échap)"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>

      {/* Replace is collapsed by default: people search ten times more often than they replace, and a useless field adds noise. */}
      {state.showReplace && !readOnly && (
        <div className="findbar__row">
          <input
            type="text"
            className="findbar__input"
            placeholder="Remplacer par"
            aria-label="Texte de remplacement"
            value={state.replacement}
            onChange={(event) => set({ replacement: event.target.value })}
          />
          <button type="button" className="btn" disabled={total === 0} onClick={onReplace}>
            Remplacer
          </button>
          <button type="button" className="btn" disabled={total === 0} onClick={onReplaceAll}>
            Tout remplacer
          </button>
        </div>
      )}
    </div>
  );
}
