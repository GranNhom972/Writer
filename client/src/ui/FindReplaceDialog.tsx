/**
 * Panneau « Rechercher et remplacer ».
 *
 * Parti pris d'ergonomie, à rebours de la version précédente qui était un
 * dialogue modal centré :
 *
 *  - **non modal, ancré en haut à droite** : une recherche masquée par sa propre
 *    fenêtre est inutilisable, on ne voit pas ce qu'on trouve ;
 *  - **recherche en direct** pendant la frappe, avec **toutes les occurrences
 *    surlignées** et la courante distinguée ;
 *  - **compteur « 3 / 12 »** plutôt que « 12 occurrences » : savoir combien ne dit
 *    pas où l'on en est ;
 *  - **remplacement replié par défaut** : neuf recherches sur dix ne remplacent
 *    rien (loi de Hick) ;
 *  - `Entrée` suivant, `Maj+Entrée` précédent, `Échap` ferme et rend le focus au
 *    document — les conventions, pas des boutons à découvrir.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Icon } from '../design/icons/Icon';
import {
  DEFAULT_SEARCH_OPTIONS,
  findMatches,
  nextMatchIndex,
  replaceAll,
  selectionMatches,
  type SearchMatch,
  type SearchOptions,
} from '../editor/search';
import { searchHighlightKey } from '../editor/searchHighlight';

/**
 * Une vue détruite (rechargement à chaud, changement de document) reste
 * référencée le temps d'un rendu. Y envoyer une transaction lève une erreur qui
 * démonte tout le sous-arbre React — c'est ainsi que le calque du tableau
 * disparaissait avec la barre de recherche.
 */
function isUsable(view: EditorView | null): view is EditorView {
  return view !== null && !view.isDestroyed;
}

interface FindReplaceDialogProps {
  open: boolean;
  onClose: () => void;
  editorView: EditorView | null;
  /** En lecture seule, la partie remplacement est retirée, pas seulement grisée. */
  canReplace?: boolean;
}

export function FindReplaceDialog({
  open,
  onClose,
  editorView,
  canReplace = true,
}: FindReplaceDialogProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [showReplace, setShowReplace] = useState(false);
  const [matches, setMatches] = useState<readonly SearchMatch[]>([]);
  const [current, setCurrent] = useState(-1);
  const [feedback, setFeedback] = useState('');
  const queryRef = useRef<HTMLInputElement | null>(null);

  /** Publie l'état de recherche vers l'éditeur, qui dessine le surlignage. */
  const publish = useCallback(
    (found: readonly SearchMatch[], activeIndex: number) => {
      if (!isUsable(editorView)) return;
      editorView.dispatch(
        editorView.state.tr.setMeta(searchHighlightKey, { matches: found, current: activeIndex }),
      );
    },
    [editorView],
  );

  // Recherche en direct, différée : relancer à chaque touche sur un document long
  // ferait clignoter le surlignage sans rien apporter.
  useEffect(() => {
    if (!open || !isUsable(editorView)) return;

    const timer = window.setTimeout(() => {
      const found = findMatches(editorView.state.doc, query, options);
      setMatches(found);

      const cursor = editorView.state.selection.from;
      const activeIndex = found.length > 0 ? nextMatchIndex(found, cursor, 'next') : -1;
      setCurrent(activeIndex);
      publish(found, activeIndex);
    }, 140);

    return () => window.clearTimeout(timer);
  }, [query, options, open, editorView, publish]);

  // Fermeture : le surlignage disparaît et le focus revient au document.
  useEffect(() => {
    if (open) {
      queryRef.current?.focus();
      queryRef.current?.select();
      return;
    }
    if (isUsable(editorView)) {
      editorView.dispatch(
        editorView.state.tr.setMeta(searchHighlightKey, { matches: [], current: -1 }),
      );
    }
  }, [open, editorView]);

  const goTo = useCallback(
    (index: number) => {
      if (!isUsable(editorView) || matches.length === 0) return;
      const bounded = (index + matches.length) % matches.length;
      const match = matches[bounded]!;

      setCurrent(bounded);
      editorView.dispatch(
        editorView.state.tr
          .setSelection(TextSelection.create(editorView.state.doc, match.from, match.to))
          .setMeta(searchHighlightKey, { matches, current: bounded })
          .scrollIntoView(),
      );
      // Le focus reste dans le champ : on enchaîne les occurrences sans le reprendre.
      queryRef.current?.focus();
    },
    [editorView, matches],
  );

  const handleReplace = useCallback(() => {
    if (!isUsable(editorView) || matches.length === 0 || current < 0) return;

    const { from, to } = editorView.state.selection;
    // On ne remplace que si la sélection est bien sur une occurrence : sinon
    // « Remplacer » écraserait un texte que l'usager n'a pas ciblé.
    if (!selectionMatches(matches, from, to)) {
      goTo(current);
      return;
    }

    editorView.dispatch(editorView.state.tr.insertText(replacement, from, to));

    const found = findMatches(editorView.state.doc, query, options);
    setMatches(found);
    const activeIndex = found.length > 0 ? nextMatchIndex(found, from + replacement.length, 'next') : -1;
    setCurrent(activeIndex);
    publish(found, activeIndex);
    setFeedback('1 occurrence remplacée.');
  }, [current, editorView, goTo, matches, options, publish, query, replacement]);

  const handleReplaceAll = useCallback(() => {
    if (!isUsable(editorView) || matches.length === 0) return;

    const { transaction, count } = replaceAll(editorView.state.tr, matches, replacement);
    editorView.dispatch(transaction.scrollIntoView());

    // Le panneau reste ouvert : on enchaîne souvent plusieurs remplacements.
    const found = findMatches(editorView.state.doc, query, options);
    setMatches(found);
    setCurrent(found.length > 0 ? 0 : -1);
    publish(found, found.length > 0 ? 0 : -1);
    setFeedback(`${count} occurrence${count > 1 ? 's' : ''} remplacée${count > 1 ? 's' : ''}.`);
  }, [editorView, matches, options, publish, query, replacement]);

  const compteur = useMemo(() => {
    if (!query) return '';
    if (matches.length === 0) return 'Aucun résultat';
    return `${current + 1} / ${matches.length}`;
  }, [current, matches.length, query]);

  if (!open) return null;

  const onQueryKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      goTo(event.shiftKey ? current - 1 : current + 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      editorView?.focus();
    }
  };

  return (
    <aside
      className="findbar"
      role="dialog"
      aria-label="Rechercher et remplacer"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose();
          editorView?.focus();
        }
      }}
    >
      <div className="findbar__row">
        <div className="findbar__field">
          <Icon name="search" size={16} className="findbar__icon" />
          <input
            ref={queryRef}
            className="findbar__input"
            type="text"
            value={query}
            placeholder="Rechercher dans le document"
            aria-label="Rechercher"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setFeedback('');
            }}
            onKeyDown={onQueryKeyDown}
          />
          <span
            className={`findbar__count${matches.length === 0 && query ? ' findbar__count--empty' : ''}`}
          >
            {compteur}
          </span>
        </div>

        <button
          type="button"
          className="btn btn--icon"
          aria-label="Occurrence précédente"
          title="Occurrence précédente (Maj+Entrée)"
          disabled={matches.length === 0}
          onClick={() => goTo(current - 1)}
        >
          <Icon name="chevron-up" size={18} />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Occurrence suivante"
          title="Occurrence suivante (Entrée)"
          disabled={matches.length === 0}
          onClick={() => goTo(current + 1)}
        >
          <Icon name="chevron-down" size={18} />
        </button>

        {canReplace && (
          <button
            type="button"
            className="btn btn--icon"
            aria-expanded={showReplace}
            aria-controls="findbar-replace"
            aria-label={showReplace ? 'Masquer le remplacement' : 'Afficher le remplacement'}
            title="Remplacer"
            onClick={() => setShowReplace((previous) => !previous)}
          >
            <Icon name="replace" size={18} />
          </button>
        )}

        <button
          type="button"
          className="btn btn--icon"
          aria-label="Fermer la recherche"
          title="Fermer (Échap)"
          onClick={() => {
            onClose();
            editorView?.focus();
          }}
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="findbar__options">
        <label className="findbar__option">
          <input
            type="checkbox"
            checked={options.matchCase}
            onChange={(event) => setOptions((o) => ({ ...o, matchCase: event.target.checked }))}
          />
          Respecter la casse
        </label>
        <label className="findbar__option">
          <input
            type="checkbox"
            checked={options.wholeWord}
            onChange={(event) => setOptions((o) => ({ ...o, wholeWord: event.target.checked }))}
          />
          Mot entier
        </label>
      </div>

      {canReplace && showReplace && (
        <div className="findbar__row findbar__row--replace" id="findbar-replace">
          <div className="findbar__field">
            <input
              className="findbar__input"
              type="text"
              value={replacement}
              placeholder="Remplacer par"
              aria-label="Remplacer par"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleReplace();
                }
              }}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={matches.length === 0}
            onClick={handleReplace}
          >
            Remplacer
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={matches.length === 0}
            onClick={handleReplaceAll}
          >
            Tout remplacer
          </button>
        </div>
      )}

      {/* Annonces vocales : le compteur change sans que le focus bouge. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {feedback || (query ? (matches.length === 0 ? 'Aucun résultat' : `Occurrence ${current + 1} sur ${matches.length}`) : '')}
      </p>
    </aside>
  );
}
