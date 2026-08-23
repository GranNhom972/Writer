/**
 * Recherche et remplacement (couche 2 — domaine pur, sans React ni DOM).
 *
 * La recherche s'effectue **bloc par bloc** : une occurrence peut traverser des
 * marques (« bon**jour** » reste trouvable) mais jamais une frontière de
 * paragraphe, où le texte n'est pas contigu pour le lecteur.
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { matchCase: false, wholeWord: false };

/** Neutralise les caractères spéciaux : la saisie est du texte, pas une expression. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegExp(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;

  let pattern = escapeRegExp(query);
  if (options.wholeWord) {
    // `\b` échoue sur les lettres accentuées (« é » n'est pas un caractère de mot
    // au sens ASCII). On délimite donc explicitement par « ni lettre ni chiffre ».
    pattern = `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;
  }

  try {
    return new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

/** Texte d'un bloc + correspondance entre index de texte et positions du document. */
interface BlockText {
  text: string;
  /** Pour chaque segment : index dans `text`, position dans le document, longueur. */
  segments: { textIndex: number; docPos: number; length: number }[];
}

function readBlock(node: PMNode, blockPos: number): BlockText {
  let text = '';
  const segments: BlockText['segments'] = [];

  node.forEach((child, offset) => {
    const docPos = blockPos + 1 + offset;
    if (child.isText && child.text) {
      segments.push({ textIndex: text.length, docPos, length: child.text.length });
      text += child.text;
    } else {
      // Nœud non textuel (image, formule) : un caractère de substitution garde
      // les index alignés et empêche une occurrence de le traverser.
      segments.push({ textIndex: text.length, docPos, length: 1 });
      text += '￼';
    }
  });

  return { text, segments };
}

function toDocPos(block: BlockText, textIndex: number): number | null {
  for (const segment of block.segments) {
    if (textIndex >= segment.textIndex && textIndex <= segment.textIndex + segment.length) {
      return segment.docPos + (textIndex - segment.textIndex);
    }
  }
  return null;
}

/** Toutes les occurrences, dans l'ordre du document. */
export function findMatches(doc: PMNode, query: string, options: SearchOptions): SearchMatch[] {
  const regex = buildRegExp(query, options);
  if (!regex) return [];

  const matches: SearchMatch[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;

    const block = readBlock(node, pos);
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(block.text)) !== null) {
      // `match[0].length` — et non `match.length`, qui compte les groupes de
      // capture. Cette confusion faisait remplacer un seul caractère par occurrence.
      const from = toDocPos(block, match.index);
      const to = toDocPos(block, match.index + match[0].length);
      if (from !== null && to !== null) matches.push({ from, to });

      // Une occurrence vide ne peut pas exister ici (requête non vide), mais on
      // garantit la progression plutôt que de risquer une boucle infinie.
      if (match[0].length === 0) regex.lastIndex += 1;
    }

    return false; // pas de bloc dans un bloc de texte
  });

  return matches;
}

/** Index de l'occurrence à activer depuis la position du curseur. */
export function nextMatchIndex(
  matches: readonly SearchMatch[],
  cursor: number,
  direction: 'next' | 'previous',
): number {
  if (matches.length === 0) return -1;

  if (direction === 'next') {
    const index = matches.findIndex((match) => match.from >= cursor);
    return index === -1 ? 0 : index; // bouclage en fin de document
  }

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index]!.to <= cursor) return index;
  }
  return matches.length - 1;
}

/**
 * Remplace toutes les occurrences en une seule transaction.
 *
 * Le parcours part de la **fin** du document : remplacer d'abord le début
 * décalerait toutes les positions suivantes. Une seule transaction, donc une
 * seule entrée d'historique — `Ctrl+Z` défait le remplacement complet.
 */
export function replaceAll(
  tr: Transaction,
  matches: readonly SearchMatch[],
  replacement: string,
): { transaction: Transaction; count: number } {
  let count = 0;

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    if (replacement.length > 0) {
      tr.insertText(replacement, match.from, match.to);
    } else {
      tr.delete(match.from, match.to);
    }
    count += 1;
  }

  return { transaction: tr, count };
}

/** Vrai si la sélection courante correspond exactement à une occurrence. */
export function selectionMatches(
  matches: readonly SearchMatch[],
  from: number,
  to: number,
): boolean {
  return matches.some((match) => match.from === from && match.to === to);
}
