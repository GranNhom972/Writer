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
import type {
  FlySurround,
  ParagraphNode,
  TextRun,
  WriterDocumentState,
} from '../document/types';

/** Marge d'habillage par défaut autour d'un cadre, en points (`SvxLRSpaceItem`). */
export const DEFAULT_WRAP_MARGIN_PT = 4;

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
export function collectFlyFrames(doc: WriterDocumentState): FlyFrame[] {
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
      const heightPx = ptToPx(run.imageHeightPt ?? 0);
      if (widthPx > 0 && heightPx > 0) {
        out.push({
          anchorBlockId: blockId,
          anchorOffset: offset,
          surround: run.imageSurround ?? 'parallel',
          anchor: run.imageAnchor === 'to-page' ? 'to-page' : 'to-para',
          leftPx: ptToPx(run.imageXPt ?? 0),
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

  switch (fly.surround) {
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
 * c'est donc la pagination qui les injecte (cf. `pageAnchoredExclusions`).
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

/**
 * Exclusions dues aux cadres ancrés **à la page**, ramenées au repère d'un
 * paragraphe posé à `paragraphTopPx` du haut de la zone de contenu.
 *
 * La translation est la seule différence avec le cas précédent : un cadre de
 * page est fixe sur la feuille, c'est le paragraphe qui se déplace sous lui.
 */
export function pageAnchoredExclusions(
  flies: readonly FlyFrame[],
  pageIndex: number,
  anchorPages: ReadonlyMap<string, number>,
  paragraphTopPx: number,
  contentWidthPx: number,
): FlyExclusion[] {
  const out: FlyExclusion[] = [];
  for (const fly of flies) {
    if (fly.anchor !== 'to-page') continue;
    if (anchorPages.get(fly.anchorBlockId) !== pageIndex) continue;
    const exclusion = exclusionOf(fly, contentWidthPx);
    if (!exclusion) continue;
    out.push({
      ...exclusion,
      topPx: exclusion.topPx - paragraphTopPx,
      bottomPx: exclusion.bottomPx - paragraphTopPx,
    });
  }
  return out;
}
