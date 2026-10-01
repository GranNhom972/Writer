// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Table des matières — génération. Transposition de `SwDoc::UpdateTOX`
 * (`sw/source/core/tox/tox.cxx`) et du modèle de ligne `SwForm`
 * (`sw/inc/tox.hxx`, jetons `TOKEN_ENTRY_TEXT`, `TOKEN_TAB_STOP`,
 * `TOKEN_PAGE_NUMS`).
 *
 * Une ligne de sommaire de Writer se lit comme une suite de jetons :
 *
 *     [numéro de chapitre] [texte de l'entrée] [tabulation à points] [page]
 *
 * La tabulation est un **taquet aligné à droite avec caractère de remplissage**
 * (`SvxTabStop` de type `SVX_TAB_ADJUST_RIGHT`, fill char `.`). Le formateur de
 * texte de Writer résout ce taquet à la mise en page, quand il connaît enfin la
 * largeur restante.
 *
 * On fait la même chose, au même moment : la génération reçoit le mesureur de
 * texte et compose le remplissage au caractère près. C'est pour cela que ce
 * module vit dans `engine/` et non dans `document/` — il lui faut une largeur
 * de colonne et une fonte, deux choses que la couche 1 ignore.
 *
 * ## Pourquoi deux passes de pagination
 *
 * Le numéro de page d'un titre n'est connu qu'une fois le document paginé, et
 * le document ne peut être paginé qu'une fois le sommaire écrit. Writer tranche
 * en régénérant puis en re-disposant (`UpdateTOX` suivi de `SwLayAction`).
 *
 * La boucle converge ici en exactement deux passes, et par construction : le
 * **nombre de lignes** du sommaire ne dépend pas des numéros affichés — une
 * entrée occupe une ligne, que sa page soit 3 ou 137. La géométrie est donc
 * identique entre les deux passes, seuls les chiffres changent. C'est ce qui
 * permet à `paginateDocument` de s'arrêter après la seconde sans test de
 * convergence.
 */

import { ptToPx } from '../document/units';
import { createParagraph } from '../document/document';
import { tocEntries, tocLineId, tocTitleId } from '../document/tox';
import { makeRun } from '../document/runs';
import type {
  HeadingLevel,
  ParagraphNode,
  TocNode,
  WriterDocumentState,
} from '../document/types';
import { resolveFont } from './style';
import type { TextMeasurer } from './measure';
import type { LayoutContext } from './lineBreak';

/** Retrait par niveau de titre, en points. `SwForm` en pose 0,5 cm par cran. */
const TOC_LEVEL_INDENT_PT = 14;

/** Caractère de remplissage du taquet, celui de `SwForm::SetPattern`. */
const LEADER_CHAR = '.';

/** Espace réservée entre le texte et les points, et entre les points et le numéro. */
const LEADER_GAP_PT = 4;

export interface TocExpansion {
  /** Paragraphes engendrés, titre du sommaire compris. */
  paragraphs: ParagraphNode[];
  /** Ligne → identifiant du titre visé, pour rendre l'entrée cliquable. */
  targets: Map<string, string>;
}

/**
 * Développe un bloc de sommaire en paragraphes concrets.
 *
 * `pageNumbers` associe l'identifiant d'un titre à sa page **1-indexée**. Une
 * entrée absente de la table est rendue sans numéro : c'est le cas de la
 * première passe, où la pagination n'a pas encore eu lieu.
 */
export function expandToc(
  doc: WriterDocumentState,
  toc: TocNode,
  pageNumbers: ReadonlyMap<string, number>,
  ctx: LayoutContext,
): TocExpansion {
  const entries = tocEntries(doc, toc);
  const paragraphs: ParagraphNode[] = [];
  const targets = new Map<string, string>();

  if (toc.title.trim()) {
    paragraphs.push(
      createParagraph(toc.title, {
        id: tocTitleId(toc.id),
        headingLevel: 1,
      }),
    );
  }

  entries.forEach((entry, index) => {
    const id = tocLineId(toc.id, index);
    const indentPt = (entry.level - 1) * TOC_LEVEL_INDENT_PT;
    const pageNumber = pageNumbers.get(entry.blockId);

    const paragraph: ParagraphNode = {
      id,
      type: 'paragraph',
      runs: buildEntryRuns(entry.text, entry.level, pageNumber, toc, ctx, indentPt),
      marginTopPt: 0,
      marginBottomPt: 0,
    };
    if (indentPt > 0) paragraph.indentLeftPt = indentPt;

    paragraphs.push(paragraph);
    targets.set(id, entry.blockId);
  });

  // Un sommaire sans aucun titre reste visible, avec une ligne d'explication :
  // une table vide et muette laisserait croire à une panne.
  if (entries.length === 0) {
    const id = tocLineId(toc.id, 0);
    paragraphs.push({
      id,
      type: 'paragraph',
      runs: [makeRun('(Aucun titre — appliquez un style Titre 1 à 6 pour peupler la table.)', { italic: true })],
      marginTopPt: 0,
      marginBottomPt: 0,
    });
  }

  return { paragraphs, targets };
}

/**
 * Compose les runs d'une ligne : texte, points de suite, numéro de page.
 *
 * Le remplissage est calculé au caractère près plutôt que posé en CSS : c'est
 * la seule façon d'obtenir le même résultat à l'écran, à l'impression et dans
 * le PDF binaire, qui ne partagent aucun moteur de rendu.
 */
function buildEntryRuns(
  text: string,
  level: HeadingLevel,
  pageNumber: number | undefined,
  toc: TocNode,
  ctx: LayoutContext,
  indentPt: number,
): ReturnType<typeof makeRun>[] {
  const label = makeRun(text);

  if (!toc.showPageNumbers || pageNumber === undefined) {
    return [label];
  }

  const numberText = String(pageNumber);
  const numberRun = makeRun(numberText);

  if (!toc.useDotLeader) {
    return [label, makeRun('\t'), numberRun];
  }

  const font = resolveFont({}, { type: 'paragraph' }, { defaults: ctx.defaults });
  const available =
    ctx.contentWidthPx -
    ptToPx(indentPt) -
    ctx.measurer.measure(text, font) -
    ctx.measurer.measure(numberText, font) -
    ptToPx(LEADER_GAP_PT) * 2;

  const dots = leaderDots(available, font, ctx.measurer);

  // Plus de place pour un seul point : la ligne se contente d'une espace. Sans
  // cette garde, un titre plus large que la colonne produirait un remplissage
  // négatif, donc une chaîne vide collant le numéro au texte.
  if (dots.length === 0) return [label, makeRun(' '), numberRun];

  void level;
  return [label, makeRun(` ${dots} `, { color: '#888888' }), numberRun];
}

/** Nombre de points de remplissage tenant dans `availablePx`. */
function leaderDots(
  availablePx: number,
  font: { fontFamily: string; fontSizePx: number; bold: boolean; italic: boolean },
  measurer: TextMeasurer,
): string {
  if (availablePx <= 0) return '';
  const dotWidth = measurer.measure(LEADER_CHAR, font);
  if (!Number.isFinite(dotWidth) || dotWidth <= 0) return '';
  const count = Math.floor(availablePx / dotWidth);
  return count > 0 ? LEADER_CHAR.repeat(Math.min(count, 400)) : '';
}
