// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Rechercher et remplacer. Transposition de `SwCursor::Find` et de
 * `sw/source/core/crsr/findtxt.cxx`.
 *
 * La recherche se fait **paragraphe par paragraphe**. Une occurrence peut donc
 * traverser un changement de formatage — « bon**jour** » reste trouvable, parce
 * que les runs ne sont qu'une découpe de la même chaîne — mais jamais une
 * frontière de nœud, où le texte n'est pas contigu pour le lecteur.
 *
 * Module pur : aucun React, aucun DOM.
 */

import { paragraphIndex, paragraphText, replaceParagraph } from '../document/document';
import {
  deleteRangeInRuns,
  formattingAt,
  insertTextInRuns,
  runFormatting,
  runsLength,
  sliceRuns,
} from '../document/runs';
import type {
  DocumentPosition,
  RunFormatting,
  TextRun,
  WriterDocumentState,
} from '../document/types';
import { collapsedSelection, makeSelection } from './cursor';
import type { EditorState } from './edit';

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { matchCase: false, wholeWord: false };

export interface SearchMatch {
  blockId: string;
  start: number;
  end: number;
}

/** Neutralise les caractères spéciaux : la saisie est du texte, pas un motif. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegExp(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;

  let pattern = escapeRegExp(query);
  if (options.wholeWord) {
    // `\b` échoue sur les lettres accentuées : « é » n'est pas un caractère de
    // mot au sens ASCII, si bien que « été » se découperait en trois. On
    // délimite donc explicitement par « ni lettre, ni chiffre ».
    pattern = `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;
  }

  try {
    return new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
  } catch {
    // Motif impossible à compiler : on ne trouve rien plutôt que de lever.
    return null;
  }
}

/** Toutes les occurrences du document, dans l'ordre de lecture. */
export function findMatches(
  doc: WriterDocumentState,
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): SearchMatch[] {
  const regexp = buildRegExp(query, options);
  if (!regexp) return [];

  const matches: SearchMatch[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    const text = paragraphText(paragraph);
    regexp.lastIndex = 0;

    for (;;) {
      const found = regexp.exec(text);
      if (!found) break;
      matches.push({ blockId, start: found.index, end: found.index + found[0].length });
      // Une occurrence vide ferait boucler `exec` sur place : on avance d'un cran.
      if (found[0].length === 0) regexp.lastIndex += 1;
    }
  }

  return matches;
}

/** Position documentaire du début et de la fin d'une occurrence. */
export function matchRange(match: SearchMatch): { start: DocumentPosition; end: DocumentPosition } {
  return {
    start: { blockId: match.blockId, offset: match.start },
    end: { blockId: match.blockId, offset: match.end },
  };
}

/**
 * Index de l'occurrence à considérer comme courante après un déplacement.
 *
 * On repart de la position du curseur plutôt que d'un compteur : après une
 * frappe, le nombre d'occurrences a pu changer, et un indice conservé
 * désignerait une autre occurrence que celle sous les yeux de l'usager.
 */
export function matchNearest(
  doc: WriterDocumentState,
  matches: readonly SearchMatch[],
  from: DocumentPosition,
): number {
  if (matches.length === 0) return -1;
  const { order } = paragraphIndex(doc);
  const rangDepart = order.indexOf(from.blockId);

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const rang = order.indexOf(match.blockId);
    if (rang > rangDepart || (rang === rangDepart && match.start >= from.offset)) return i;
  }
  // Aucune occurrence après le curseur : la recherche boucle sur la première.
  return 0;
}

/**
 * Formatage à donner au texte de remplacement.
 *
 * Celui du **premier caractère de l'occurrence**, et non celui de la position
 * qui la précède : `formattingAt` hérite de la gauche, ce qui est la bonne
 * règle pour une frappe mais la mauvaise ici. Remplacer un mot en gras placé
 * juste après du texte normal lui aurait fait perdre son gras.
 */
function formattingOfMatch(runs: readonly TextRun[], start: number, end: number): RunFormatting {
  const first = sliceRuns(runs, start, end)[0];
  return first && first.text.length > 0 ? runFormatting(first) : formattingAt(runs, start);
}

/** Sélectionne une occurrence — c'est ainsi qu'on la met en évidence. */
export function selectMatch(state: EditorState, match: SearchMatch): EditorState {
  const { start, end } = matchRange(match);
  return { ...state, selection: makeSelection(start, end) };
}

/**
 * Remplace une occurrence.
 *
 * Le texte inséré prend le formatage du **début** de l'occurrence : remplacer
 * un mot en gras par un autre le laisse en gras, ce qu'attend l'usager.
 */
export function replaceMatch(
  state: EditorState,
  match: SearchMatch,
  replacement: string,
): EditorState {
  const paragraph = paragraphIndex(state.doc).byId.get(match.blockId)?.paragraph;
  if (!paragraph) return state;

  const formatting = formattingOfMatch(paragraph.runs, match.start, match.end);
  const vide = deleteRangeInRuns(paragraph.runs, match.start, match.end);
  const runs = replacement
    ? insertTextInRuns(vide, match.start, replacement, formatting)
    : vide;

  return {
    doc: replaceParagraph(state.doc, match.blockId, { ...paragraph, runs }),
    selection: collapsedSelection({
      blockId: match.blockId,
      offset: Math.min(match.start + replacement.length, runsLength(runs)),
    }),
    pendingFormat: null,
  };
}

/**
 * Remplace toutes les occurrences, en **une** transformation.
 *
 * Le remplacement s'effectue de la fin vers le début de chaque paragraphe :
 * dans l'autre sens, chaque substitution décalerait les occurrences suivantes
 * et il faudrait recalculer leurs positions à chaque tour.
 */
export function replaceAll(
  state: EditorState,
  query: string,
  options: SearchOptions,
  replacement: string,
): { state: EditorState; count: number } {
  const matches = findMatches(state.doc, query, options);
  if (matches.length === 0) return { state, count: 0 };

  let doc = state.doc;

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]!;
    const paragraph = paragraphIndex(doc).byId.get(match.blockId)?.paragraph;
    if (!paragraph) continue;

    const formatting = formattingOfMatch(paragraph.runs, match.start, match.end);
    const vide = deleteRangeInRuns(paragraph.runs, match.start, match.end);
    const runs = replacement
      ? insertTextInRuns(vide, match.start, replacement, formatting)
      : vide;
    doc = replaceParagraph(doc, match.blockId, { ...paragraph, runs });
  }

  return {
    state: { doc, selection: state.selection, pendingFormat: null },
    count: matches.length,
  };
}
