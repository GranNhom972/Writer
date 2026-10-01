// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Cadres flottants et habillage du texte. Transposition de `SwFlyFreeFrm`
 * (`sw/source/core/layout/fly.cxx`, `flylay.cxx`), de `SwFmtSurround`
 * (`sw/inc/fmtsrndenum.hxx`) et du calcul de bande utile de `SwTxtFly`
 * (`sw/source/core/text/txtfly.cxx`).
 *
 * ## Le problème que résout `SwTxtFly`
 *
 * Une image ancrée « comme caractère » est simple : elle occupe une largeur
 * dans la ligne, et le formateur n'a rien de plus à savoir. Un cadre **flottant**
 * est d'une autre nature — il sort du flux, se pose à une coordonnée, et c'est
 * au texte de s'écarter. Chaque ligne traversée voit donc sa largeur utile
 * amputée, et de façon différente selon sa hauteur dans le cadre.
 *
 * `SwTxtFly::GetFrm` répond à exactement une question, et ce module aussi :
 * *pour une ligne allant de `top` à `bottom`, quel intervalle horizontal reste
 * disponible ?* Le reste — remplir la ligne, la justifier — ne change pas.
 *
 * ## Formulation retenue : soustraction d'intervalles
 *
 * Plutôt que de traiter séparément « du texte à gauche » et « du texte à
 * droite », chaque cadre déclare l'intervalle horizontal qu'il **interdit**,
 * dérivé de son mode d'habillage :
 *
 *   through  → rien (le texte passe dessous)
 *   parallel → la largeur du cadre, marges comprises
 *   left     → du bord gauche du cadre jusqu'au bout de la colonne
 *   right    → du début de la colonne jusqu'au bord droit du cadre
 *   none     → toute la colonne
 *   ideal    → l'un des quatre précédents, choisi d'après la place restante
 *
 * La bande utile est alors le plus large intervalle survivant à toutes les
 * soustractions. Cette formulation a un avantage concret sur une analyse au cas
 * par cas : **deux cadres qui se chevauchent ne demandent aucun code de plus**,
 * là où un traitement séparé gauche/droite devrait arbitrer entre eux.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

import { ptToPx } from '../document/units';
import { paragraphIndex } from '../document/document';
import { DEFAULT_WRAP_MARGIN_PT } from '../document/images';
import type { PageGeometry } from '../document/pageSetup';
import type {
  FlyHoriOrient,
  FlyHoriRelation,
  FlySurround,
  ParagraphNode,
  TextRun,
  WriterDocumentState,
} from '../document/types';

// Réexport de commodité : la marge d'habillage est un défaut du modèle, mais
// c'est ici qu'on la lit, et c'est ici que les appelants la cherchent.
export { DEFAULT_WRAP_MARGIN_PT };

/**
 * Largeur minimale d'une bande pour qu'on daigne y écrire.
 *
 * `SwTxtFly` retient un seuil comparable : sous quelques caractères, une
 * colonne résiduelle produit une bouillie verticale d'une lettre par ligne,
 * moins lisible que de pousser le texte sous le cadre.
 */
export const MIN_BAND_WIDTH_PX = 24;

/** Un cadre flottant résolu à sa géométrie en pixels. */
export interface FlyFrame {
  /** Part de la hauteur revenant à la légende. Zéro s'il n'y en a pas. */
  captionHeightPx?: number;
  /** Paragraphe portant le caractère d'ancrage. */
  anchorBlockId: string;
  /** Offset du caractère d'ancrage dans ce paragraphe. */
  anchorOffset: number;
  surround: FlySurround;
  /** Ancrage au paragraphe ou à la page — jamais `as-char` ici. */
  anchor: 'to-para' | 'to-page';
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  /** Marge d'habillage, déjà en pixels. */
  marginPx: number;
  run: TextRun;
}

/** Un intervalle horizontal interdit, sur une tranche verticale. */
export interface FlyExclusion {
  topPx: number;
  bottomPx: number;
  /** Bornes de l'intervalle **interdit**, marges comprises. */
  leftPx: number;
  rightPx: number;
}

/* ------------------------------------------------- habillage « optimal » */

/**
 * Largeur minimale d'une colonne de texte pour qu'elle mérite d'exister, en
 * points. `TEXT_MIN` de `txtfly.cxx:2337` — 1134 twips, soit 2 cm.
 */
export const IDEAL_TEXT_MIN_PT = 1134 / 20;

/**
 * Largeur au-delà de laquelle un cadre ne se laisse plus habiller des deux
 * côtés. `FRAME_MAX` de `txtfly.cxx:2339` — 850 twips, soit 1,5 cm.
 */
export const IDEAL_FRAME_MAX_PT = 850 / 20;

/**
 * Résout `SURROUND_IDEAL` en un mode concret.
 *
 * Port direct de `SwTxtFly::GetSurroundForTextWrap` (`txtfly.cxx:2372-2402`).
 * L'habillage « optimal » n'est pas une géométrie mais un **arbitrage** : on
 * mesure ce qui reste de colonne de chaque côté du cadre, on écarte les bandes
 * trop étroites pour qu'on y écrive (`TEXT_MIN`), et le mode se déduit de ce
 * qui survit — les deux côtés donnent `parallel`, un seul donne `left` ou
 * `right`, aucun donne `none`.
 *
 * La règle de `FRAME_MAX` mérite un mot : passé 1,5 cm de large, un cadre ne
 * garde **que son côté le plus large**, même si l'autre dépasse le minimum.
 * Deux colonnes étroites de part et d'autre d'une image sont lisibles en
 * théorie et illisibles en pratique ; Writer tranche pour une seule.
 */
export function resolveIdealSurround(
  /** Bord gauche du cadre, marges comprises, dans le repère de la colonne. */
  leftPx: number,
  /** Bord droit du cadre, marges comprises. */
  rightPx: number,
  contentWidthPx: number,
): 'none' | 'parallel' | 'left' | 'right' {
  // Cadre entièrement hors de la colonne : il ne la coupe pas, le texte
  // l'ignore de part et d'autre.
  if (rightPx < 0 || leftPx > contentWidthPx) return 'parallel';

  let left = leftPx;
  let right = contentWidthPx - rightPx;

  if (rightPx - leftPx > ptToPx(IDEAL_FRAME_MAX_PT)) {
    if (left < right) left = 0;
    else right = 0;
  }

  const minPx = ptToPx(IDEAL_TEXT_MIN_PT);
  if (left < minPx) left = 0;
  if (right < minPx) right = 0;

  if (left > 0) return right > 0 ? 'parallel' : 'left';
  return right > 0 ? 'right' : 'none';
}

/* --------------------------------------------------- position horizontale */

/**
 * Abscisse d'un cadre, dans le repère de la colonne de texte.
 *
 * Transposition de `SwAnchoredObjectPosition::CalcRelPosX`
 * (`sw/source/core/layout/anchoreddrawobject.cxx`, `objectpositioning/`) :
 * l'alignement et son repère se combinent en une abscisse, une fois la page
 * connue. `from-left` — `HoriOrientation::NONE` — est le seul mode qui lise le
 * décalage tel quel ; les autres le recalculent, et c'est précisément ce qu'on
 * attend d'eux quand la marge de page change.
 *
 * Le résultat est toujours ramené au repère de la **colonne** : c'est celui où
 * `lineBreak` retranche les bandes, et mélanger deux origines déplacerait le
 * texte sans déplacer l'image.
 */
export function resolveFlyLeft(
  orient: FlyHoriOrient,
  relation: FlyHoriRelation,
  offsetPx: number,
  widthPx: number,
  geometry: Pick<PageGeometry, 'pageWidthPx' | 'contentLeftPx' | 'contentWidthPx'>,
): number {
  // Bornes du repère demandé, exprimées dans celui de la colonne. La feuille
  // commence donc à une abscisse **négative** : c'est la marge de gauche, que
  // la colonne ne couvre pas et où un cadre a le droit de déborder.
  const { leftPx, widthPx: frameWidthPx } =
    relation === 'page'
      ? { leftPx: -geometry.contentLeftPx, widthPx: geometry.pageWidthPx }
      : { leftPx: 0, widthPx: geometry.contentWidthPx };

  switch (orient) {
    case 'center':
      return leftPx + (frameWidthPx - widthPx) / 2;
    case 'right':
      return leftPx + frameWidthPx - widthPx;
    case 'left':
      return leftPx;
    case 'from-left':
    default:
      return leftPx + offsetPx;
  }
}

/** Un cadre est-il flottant, par opposition à « comme caractère » ? */
export function isFloatingFly(run: TextRun): boolean {
  return (
    run.imageSrc !== undefined &&
    run.imageAnchor !== undefined &&
    run.imageAnchor !== 'as-char'
  );
}

/**
 * Collecte les cadres flottants du document.
 *
 * Un cadre sans dimensions n'est pas retenu : sans largeur ni hauteur, il
 * n'exclut rien, et le laisser passer obligerait chaque appelant à revérifier.
 */
export function collectFlyFrames(
  doc: WriterDocumentState,
  /**
   * Géométrie de la page, nécessaire à la résolution des alignements.
   *
   * `SwFlyFrm::MakeAll` fait de même : l'orientation devient une coordonnée
   * **une fois**, avant que `SwTxtFly` n'en retranche quoi que ce soit. Résoudre
   * plus tard obligerait chaque ligne à refaire le calcul, et les deux repères
   * — celui du cadre et celui du texte — finiraient par diverger.
   */
  geometry: Pick<PageGeometry, 'pageWidthPx' | 'contentLeftPx' | 'contentWidthPx'>,
  /**
   * Hauteur de la légende d'un cadre, fournie par l'appelant.
   *
   * Elle entre dans la hauteur du cadre, donc dans la bande que le texte doit
   * contourner : sans elle, les lignes se refermaient sur la légende et
   * passaient par-dessus.
   *
   * C'est un **rappel** et non un calcul direct : mesurer une légende demande
   * `lineBreak`, qui dépend déjà de ce module. Le paramètre renverse la
   * dépendance au lieu de la boucler, et les appelants qui ne peignent pas —
   * géométrie pure — n'ont rien à fournir.
   */
  captionHeightOf?: (run: TextRun, blockId: string, offset: number, widthPx: number) => number,
): FlyFrame[] {
  const out: FlyFrame[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    for (const run of paragraph.runs) {
      if (!isFloatingFly(run)) {
        offset += run.text.length;
        continue;
      }

      const widthPx = ptToPx(run.imageWidthPt ?? 0);
      const imageHeightPx = ptToPx(run.imageHeightPt ?? 0);

      // La légende s'ajoute au cadre, et le texte la contourne comme l'image.
      const captionPx = captionHeightOf ? captionHeightOf(run, blockId, offset, widthPx) : 0;
      const heightPx = imageHeightPx + captionPx;

      if (widthPx > 0 && heightPx > 0) {
        out.push({
          anchorBlockId: blockId,
          anchorOffset: offset,
          captionHeightPx: captionPx,
          surround: run.imageSurround ?? 'parallel',
          anchor: run.imageAnchor === 'to-page' ? 'to-page' : 'to-para',
          leftPx: resolveFlyLeft(
            // Sans alignement déclaré, l'abscisse est celle du modèle : c'est
            // `HoriOrientation::NONE`, et c'est aussi ce que valaient les cadres
            // écrits avant que l'alignement n'existe.
            run.imageHoriOrient ?? 'from-left',
            run.imageHoriRelation ?? 'text',
            ptToPx(run.imageXPt ?? 0),
            widthPx,
            geometry,
          ),
          topPx: ptToPx(run.imageYPt ?? 0),
          widthPx,
          heightPx,
          marginPx: ptToPx(run.imageWrapMarginPt ?? DEFAULT_WRAP_MARGIN_PT),
          run,
        });
      }
      offset += run.text.length;
    }
  }

  return out;
}

/**
 * Traduit un cadre en intervalle interdit, dans le repère d'une colonne de
 * largeur `contentWidthPx`.
 *
 * Renvoie `null` pour un cadre qui n'interdit rien (`through`).
 */
export function exclusionOf(fly: FlyFrame, contentWidthPx: number): FlyExclusion | null {
  if (fly.surround === 'through') return null;

  const top = fly.topPx - fly.marginPx;
  const bottom = fly.topPx + fly.heightPx + fly.marginPx;
  const left = fly.leftPx - fly.marginPx;
  const right = fly.leftPx + fly.widthPx + fly.marginPx;

  // `ideal` n'a pas de géométrie propre : il désigne celui des quatre autres
  // modes que la place restante rend praticable. On le résout ici, une fois
  // les bords connus, marges comprises — ce sont eux que mesure `TEXT_MIN`.
  const surround =
    fly.surround === 'ideal'
      ? resolveIdealSurround(left, right, contentWidthPx)
      : fly.surround;

  switch (surround) {
    case 'none':
      return { topPx: top, bottomPx: bottom, leftPx: 0, rightPx: contentWidthPx };
    case 'left':
      // Texte à gauche seulement : tout ce qui est à droite du bord gauche du
      // cadre est interdit, cadre compris.
      return { topPx: top, bottomPx: bottom, leftPx: left, rightPx: contentWidthPx };
    case 'right':
      return { topPx: top, bottomPx: bottom, leftPx: 0, rightPx: right };
    case 'parallel':
    default:
      return { topPx: top, bottomPx: bottom, leftPx: left, rightPx: right };
  }
}

/** Bande horizontale utilisable par une ligne. */
export interface UsableBand {
  leftPx: number;
  rightPx: number;
  get widthPx(): number;
}

/**
 * Intervalle libre le plus large pour une ligne occupant `[topPx, bottomPx)`.
 *
 * Renvoie `null` quand aucun intervalle exploitable ne subsiste : l'appelant
 * doit alors descendre la ligne sous le cadre bloquant (`nextClearY`).
 */
export function usableBand(
  exclusions: readonly FlyExclusion[],
  topPx: number,
  bottomPx: number,
  contentWidthPx: number,
  minWidthPx: number = MIN_BAND_WIDTH_PX,
): { leftPx: number; rightPx: number } | null {
  if (exclusions.length === 0) return { leftPx: 0, rightPx: contentWidthPx };

  // Intervalles libres, initialement toute la colonne. Chaque cadre qui croise
  // verticalement la ligne en retire sa part.
  let free: { left: number; right: number }[] = [{ left: 0, right: contentWidthPx }];

  for (const exclusion of exclusions) {
    // Chevauchement vertical strict : un cadre qui s'arrête exactement au haut
    // de la ligne ne la gêne pas.
    if (exclusion.bottomPx <= topPx || exclusion.topPx >= bottomPx) continue;

    const next: { left: number; right: number }[] = [];
    for (const span of free) {
      // Aucune intersection horizontale : l'intervalle survit tel quel.
      if (exclusion.rightPx <= span.left || exclusion.leftPx >= span.right) {
        next.push(span);
        continue;
      }
      if (exclusion.leftPx > span.left) next.push({ left: span.left, right: exclusion.leftPx });
      if (exclusion.rightPx < span.right) next.push({ left: exclusion.rightPx, right: span.right });
    }
    free = next;
    if (free.length === 0) return null;
  }

  let best: { left: number; right: number } | null = null;
  for (const span of free) {
    const width = span.right - span.left;
    if (width < minWidthPx) continue;
    if (!best || width > best.right - best.left) best = span;
  }

  return best ? { leftPx: best.left, rightPx: best.right } : null;
}

/**
 * Première ordonnée, à partir de `topPx`, où la ligne cesse d'être bloquée.
 *
 * C'est le bas du cadre le plus haut parmi ceux qui bloquent — descendre plus
 * bas d'un coup sauterait inutilement de l'espace blanc.
 */
export function nextClearY(
  exclusions: readonly FlyExclusion[],
  topPx: number,
  bottomPx: number,
): number | null {
  let candidate: number | null = null;
  for (const exclusion of exclusions) {
    if (exclusion.bottomPx <= topPx || exclusion.topPx >= bottomPx) continue;
    if (candidate === null || exclusion.bottomPx < candidate) candidate = exclusion.bottomPx;
  }
  // Toujours progresser : un cadre de hauteur nulle renverrait sinon la même
  // ordonnée et ferait tourner la boucle du formateur indéfiniment.
  return candidate === null ? null : Math.max(candidate, topPx + 1);
}

/**
 * Exclusions applicables à un paragraphe, dans son repère local.
 *
 * Seuls les cadres **ancrés à ce paragraphe** sont résolus ici : un cadre ancré
 * à la page ne connaît sa position relative qu'une fois le paragraphe posé,
 * c'est donc la pagination qui les injecte (cf. `projectedExclusions`).
 */
export function paragraphExclusions(
  flies: readonly FlyFrame[],
  paragraph: ParagraphNode,
  contentWidthPx: number,
): FlyExclusion[] {
  const out: FlyExclusion[] = [];
  for (const fly of flies) {
    if (fly.anchor !== 'to-para' || fly.anchorBlockId !== paragraph.id) continue;
    const exclusion = exclusionOf(fly, contentWidthPx);
    if (exclusion) out.push(exclusion);
  }
  return out;
}

/** Où un cadre s'est réellement posé, une fois la page connue. */
export interface FlyPlacement {
  /** Page 0-indexée portant le cadre. */
  pageIndex: number;
  /** Ordonnée du cadre depuis le haut de la zone de contenu de cette page. */
  topPx: number;
}

/**
 * Exclusions dues aux cadres posés **ailleurs** que dans ce paragraphe,
 * ramenées à son repère.
 *
 * ## Pourquoi il en faut deux sortes
 *
 * `paragraphExclusions` ne connaît qu'une chose : les cadres ancrés au
 * paragraphe qu'on est en train de composer. C'est suffisant tant qu'un cadre
 * ne dépasse pas de son ancre — et faux dès qu'il la dépasse, ce qui est le cas
 * courant : une image de huit centimètres ancrée à un paragraphe de deux lignes
 * déborde forcément sur ce qui suit, et le texte suivant lui passait au travers.
 *
 * `SwTxtFly` n'a pas ce problème parce qu'il interroge la liste des cadres de
 * la **page**, non celle de l'ancre. C'est ce que fait cette fonction : elle
 * projette tout cadre dont la page coïncide, quel que soit son ancrage.
 *
 * ## Ce qu'elle demande en échange
 *
 * Une position **absolue**, que seul un placement déjà fait peut donner : la
 * page d'un cadre ancré au paragraphe dépend de l'endroit où ce paragraphe est
 * tombé. D'où le paramètre `placements`, que la pagination remplit à partir de
 * sa passe précédente — le même mécanisme, et la même raison, que pour la table
 * des matières.
 */
export function projectedExclusions(
  flies: readonly FlyFrame[],
  pageIndex: number,
  placements: ReadonlyMap<string, FlyPlacement>,
  paragraphTopPx: number,
  contentWidthPx: number,
  /**
   * Paragraphe en cours de composition. Ses propres cadres sont écartés :
   * `paragraphExclusions` les a déjà donnés, et les compter deux fois n'aurait
   * pas d'effet visible mais ferait grossir la liste à chaque ligne.
   */
  currentBlockId?: string,
): FlyExclusion[] {
  const out: FlyExclusion[] = [];
  for (const fly of flies) {
    if (fly.anchorBlockId === currentBlockId) continue;

    const place = placements.get(fly.anchorBlockId);
    if (!place || place.pageIndex !== pageIndex) continue;

    const exclusion = exclusionOf(fly, contentWidthPx);
    if (!exclusion) continue;

    // Un cadre de page est fixe sur la feuille ; un cadre de paragraphe suit
    // son ancre. Dans les deux cas on aboutit à une ordonnée comptée depuis le
    // haut de la zone de contenu, puis ramenée au repère du paragraphe.
    const originePx = fly.anchor === 'to-page' ? 0 : place.topPx;
    const decalagePx = originePx - paragraphTopPx;

    out.push({
      ...exclusion,
      topPx: exclusion.topPx + decalagePx,
      bottomPx: exclusion.bottomPx + decalagePx,
    });
  }
  return out;
}
