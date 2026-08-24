/**
 * Rechercher et remplacer.
 *
 * Panneau **non modal**, ancré au-dessus du document : une fenêtre modale
 * masquerait le texte qu'on cherche et interdirait de continuer à écrire. On
 * peut lire les occurrences surlignées pendant que le panneau reste ouvert.
 *
 * Le compteur « 3 / 12 » est indispensable : sans lui, on ne sait pas si l'on
 * tourne en rond dans un document long.
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
  /** Nombre total d'occurrences. */
  total: number;
  /** Rang de l'occurrence courante, à partir de 1. Zéro si aucune. */
  current: number;
  onNavigate: (direction: 1 | -1) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  /** En lecture seule, la partie remplacement disparaît au lieu d'être grisée. */
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

  // Le champ prend le focus à l'ouverture : on vient d'appuyer sur Ctrl+F pour
  // taper quelque chose, pas pour cliquer dans un champ.
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

      {/* Le remplacement est replié par défaut : on cherche dix fois plus
          souvent qu'on ne remplace, et un champ inutile ajoute du bruit. */}
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
