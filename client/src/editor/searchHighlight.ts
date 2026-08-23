/**
 * Surlignage des occurrences dans le document (couche 3).
 *
 * Sans repères visuels, une recherche oblige à faire défiler pour comprendre ce
 * qu'elle a trouvé. Toutes les occurrences sont donc marquées, et **l'occurrence
 * courante se distingue des autres** — une seule couleur ne dirait pas où l'on
 * se trouve dans la série.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { SearchMatch } from './search';

export interface SearchHighlightState {
  matches: readonly SearchMatch[];
  /** Index de l'occurrence active, ou -1. */
  current: number;
}

export const searchHighlightKey = new PluginKey<SearchHighlightState>('write:search-highlight');

const EMPTY: SearchHighlightState = { matches: [], current: -1 };

export function searchHighlightPlugin(): Plugin<SearchHighlightState> {
  return new Plugin<SearchHighlightState>({
    key: searchHighlightKey,

    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const next = tr.getMeta(searchHighlightKey) as SearchHighlightState | undefined;
        if (next) return next;

        // Le document a changé sans nouvelle recherche : les positions mémorisées
        // seraient fausses. On les projette plutôt que d'afficher un surlignage
        // décalé, moins lisible qu'aucun surlignage.
        if (tr.docChanged && value.matches.length > 0) {
          return {
            matches: value.matches.map((match) => ({
              from: tr.mapping.map(match.from),
              to: tr.mapping.map(match.to),
            })),
            current: value.current,
          };
        }

        return value;
      },
    },

    props: {
      decorations(state) {
        const value = searchHighlightKey.getState(state) ?? EMPTY;
        if (value.matches.length === 0) return DecorationSet.empty;

        const decorations = value.matches.map((match, index) =>
          Decoration.inline(match.from, match.to, {
            class: index === value.current ? 'search-hit search-hit--current' : 'search-hit',
          }),
        );

        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
