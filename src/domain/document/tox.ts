// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Table des matières — modèle. Transposition de `SwTOXBase` / `SwTOXMark`
 * (`sw/source/core/tox/tox.cxx`, `sw/inc/tox.hxx`).
 *
 * Writer ne stocke jamais les *entrées* d'un sommaire : `SwTOXBase` ne retient
 * que sa **définition** — quels niveaux de titre retenir, avec ou sans numéro de
 * page — et `SwDoc::UpdateTOX` régénère le contenu à la demande. On transpose ce
 * choix, et pour la même raison : des entrées figées se désynchroniseraient du
 * corps du document dès la première frappe, et un sommaire faux est pire que
 * pas de sommaire.
 *
 * Ce module tient la partie **indépendante de la mise en page** : quels titres
 * entrent dans la table, dans quel ordre, à quel niveau. Les numéros de page
 * n'y figurent pas — ils n'existent qu'une fois la pagination faite, et c'est
 * `engine/tox.ts` qui les résout.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

import { newId } from './document';
import { headingAnchorName } from './bookmarks';
import { isParagraph, type HeadingLevel, type TocNode, type WriterDocumentState } from './types';

/** Titre par défaut, celui du style « Contents Heading » de Writer. */
export const DEFAULT_TOC_TITLE = 'Table des matières';

/** Profondeur par défaut : `SwTOXBase` retient les niveaux 1 à 3. */
export const DEFAULT_TOC_MAX_LEVEL: HeadingLevel = 3;

export interface TocOptions {
  id?: string;
  title?: string;
  maxLevel?: HeadingLevel;
  showPageNumbers?: boolean;
  useDotLeader?: boolean;
}

/** Crée un bloc de table des matières (`SwTOXBase` de type `TOX_CONTENT`). */
export function createToc(options: TocOptions = {}): TocNode {
  return {
    id: options.id ?? newId('toc'),
    type: 'toc',
    title: options.title ?? DEFAULT_TOC_TITLE,
    maxLevel: options.maxLevel ?? DEFAULT_TOC_MAX_LEVEL,
    showPageNumbers: options.showPageNumbers ?? true,
    useDotLeader: options.useDotLeader ?? true,
  };
}

/** Une ligne du sommaire, avant résolution du numéro de page. */
export interface TocEntry {
  /** Paragraphe titre dont l'entrée est dérivée. */
  blockId: string;
  /** Niveau de titre, de 1 à `maxLevel`. */
  level: HeadingLevel;
  /** Texte du titre, espaces normalisées. */
  text: string;
  /** Ancre de renvoi (`__RefHeading__…`), pour rendre l'entrée cliquable. */
  anchorName: string;
}

/**
 * Collecte les entrées du sommaire.
 *
 * Seuls les titres du **flux principal** sont retenus : un titre placé dans une
 * cellule de tableau n'entre pas dans le sommaire de Writer non plus, sa
 * position n'ayant pas de sens dans une hiérarchie de document.
 *
 * Un titre vide est ignoré — il occuperait une ligne de sommaire renvoyant à
 * rien de lisible.
 */
export function tocEntries(doc: WriterDocumentState, toc: TocNode): TocEntry[] {
  const out: TocEntry[] = [];

  for (const block of doc.blocks) {
    if (!isParagraph(block) || block.type !== 'heading') continue;

    const level = block.headingLevel ?? 1;
    if (level > toc.maxLevel) continue;

    const text = headingText(block.runs);
    if (!text) continue;

    out.push({
      blockId: block.id,
      level,
      text,
      anchorName: headingAnchorName(block.id),
    });
  }

  return out;
}

/**
 * Texte imprimable d'un titre.
 *
 * Les runs porteurs d'un objet (image, formule) apportent un caractère de
 * remplacement U+FFFC qui n'a rien à faire dans un sommaire : il est retiré,
 * comme `SwTOXPara::GetText` ignore les portions non textuelles.
 */
function headingText(runs: readonly { text: string; imageSrc?: string; mathLatex?: string }[]): string {
  let out = '';
  for (const run of runs) {
    if (run.imageSrc !== undefined || run.mathLatex !== undefined) continue;
    out += run.text;
  }
  return out.replace(/￼/g, '').replace(/\s+/g, ' ').trim();
}

/** Tous les blocs de sommaire du document, dans l'ordre. */
export function tocNodes(doc: WriterDocumentState): TocNode[] {
  return doc.blocks.filter((block): block is TocNode => block.type === 'toc');
}

/** Le document contient-il au moins une table des matières ? */
export function hasToc(doc: WriterDocumentState): boolean {
  return doc.blocks.some((block) => block.type === 'toc');
}

/** Modifie la définition d'un sommaire (`SwTOXBase::SetLevel`, `SetCreate`). */
export function updateToc(
  doc: WriterDocumentState,
  tocId: string,
  patch: Partial<Omit<TocNode, 'id' | 'type'>>,
): WriterDocumentState {
  let changed = false;
  const blocks = doc.blocks.map((block) => {
    if (block.type !== 'toc' || block.id !== tocId) return block;
    changed = true;
    return { ...block, ...patch };
  });
  return changed ? { ...doc, blocks } : doc;
}

/**
 * Identifiant du paragraphe engendré pour une ligne de sommaire.
 *
 * Dérivé et non tiré au sort : la pagination tourne à chaque frappe, et un
 * identifiant neuf à chaque passe ferait re-rendre toutes les lignes du
 * sommaire sans qu'aucune ait changé.
 */
export function tocLineId(tocId: string, index: number): string {
  return `${tocId}__line${index}`;
}

/** Identifiant du paragraphe portant le titre du sommaire. */
export function tocTitleId(tocId: string): string {
  return `${tocId}__title`;
}

/** Ce paragraphe est-il une ligne engendrée par un sommaire ? */
export function isGeneratedTocParagraph(blockId: string): boolean {
  return blockId.includes('__line') || blockId.endsWith('__title');
}
