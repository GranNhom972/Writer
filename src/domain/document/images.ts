/**
 * Images ancrées « comme caractère ». Transposition de `SwFlyCntFrm`
 * (`sw/source/core/layout/flycnt.cxx`) et de `SwGrfNode` (`sw/source/core/graphic/`).
 *
 * Writer distingue le **nœud graphique**, qui porte les octets, et le **cadre**,
 * qui porte la géométrie. Le partage se fait de la même façon ici : le run porte
 * une adresse (`imageSrc`) et une taille (`imageWidthPt` × `imageHeightPt`), et
 * les octets vivent ailleurs — dans une `data:` en local, dans le dépôt du
 * serveur une fois le document partagé.
 *
 * Le texte du run est un unique **caractère de substitution d'objet**
 * (U+FFFC OBJECT REPLACEMENT CHARACTER), celui-là même qu'insère
 * `SwTxtNode::InsertItem` pour un `SwTxtFlyCnt` (`CH_TXTATR_BREAKWORD`,
 * `sw/inc/txatbase.hxx`). Ce choix n'est pas cosmétique : il donne à l'image
 * **une** position dans la chaîne du paragraphe, donc un offset de curseur
 * unique. Une image occupant plusieurs unités de code laisserait le curseur se
 * poser en son milieu.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

import { pxToPt } from './units';
import { makeRun, runFormatting } from './runs';
import type { RunFormatting, TextRun } from './types';

/** `CH_TXTATR_BREAKWORD` — la place que l'objet occupe dans le texte. */
export const IMAGE_PLACEHOLDER = '￼';

/** Formats que le serveur accepte, reconnus à leurs octets (`assets.rs`). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Plafond du dépôt côté serveur — annoncé ici pour ne pas téléverser pour rien. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Bornes de redimensionnement, en points. Sous 4 pt une image n'est plus visible. */
export const MIN_IMAGE_SIZE_PT = 4;
export const MAX_IMAGE_SIZE_PT = 2000;

/**
 * Rognage : ce qui est retranché de chaque bord de l'image **d'origine**,
 * en fraction de 0 à 1. Transposition de `SvxGrfCrop`.
 */
export interface ImageCrop {
  topPct: number;
  rightPct: number;
  bottomPct: number;
  leftPct: number;
}

export const NO_CROP: ImageCrop = { topPct: 0, rightPct: 0, bottomPct: 0, leftPct: 0 };

/**
 * Part de l'image qui doit rester visible après rognage.
 *
 * Rogner la totalité d'un bord ferait disparaître l'image et diviserait par
 * zéro au rendu ; on garde toujours de quoi voir ce qu'on manipule.
 */
export const MIN_VISIBLE_FRACTION = 0.05;

export interface ImageAttributes {
  src: string;
  widthPt: number;
  heightPt: number;
  alt?: string;
  crop?: ImageCrop;
}

/** Un run porte-t-il une image ? */
export function isImageRun(run: Pick<TextRun, 'imageSrc'>): boolean {
  return typeof run.imageSrc === 'string' && run.imageSrc.length > 0;
}

export function isImageFormatting(formatting: RunFormatting): boolean {
  return typeof formatting.imageSrc === 'string' && formatting.imageSrc.length > 0;
}

/** Lit la géométrie d'un run image, bornes appliquées. */
export function imageAttributes(run: TextRun): ImageAttributes | null {
  if (!isImageRun(run)) return null;
  const crop = imageCrop(run);
  return {
    src: run.imageSrc!,
    widthPt: clampSize(run.imageWidthPt ?? 0),
    heightPt: clampSize(run.imageHeightPt ?? 0),
    ...(run.imageAlt !== undefined ? { alt: run.imageAlt } : {}),
    ...(hasCrop(crop) ? { crop } : {}),
  };
}

/** Rognage porté par un run, normalisé. */
export function imageCrop(run: Pick<TextRun, 'imageCropTopPct' | 'imageCropRightPct' | 'imageCropBottomPct' | 'imageCropLeftPct'>): ImageCrop {
  return normalizeCrop({
    topPct: run.imageCropTopPct ?? 0,
    rightPct: run.imageCropRightPct ?? 0,
    bottomPct: run.imageCropBottomPct ?? 0,
    leftPct: run.imageCropLeftPct ?? 0,
  });
}

export function hasCrop(crop: ImageCrop | undefined): crop is ImageCrop {
  if (!crop) return false;
  return crop.topPct > 0 || crop.rightPct > 0 || crop.bottomPct > 0 || crop.leftPct > 0;
}

/**
 * Ramène un rognage dans le domaine du sens.
 *
 * Deux bords opposés qui totalisent plus que l'image entière n'ont pas de
 * résultat : on les réduit **proportionnellement** plutôt que d'en écrêter un
 * seul, ce qui déplacerait le centre de la partie visible.
 */
export function normalizeCrop(crop: ImageCrop): ImageCrop {
  const borne = (value: number): number =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

  let top = borne(crop.topPct);
  let right = borne(crop.rightPct);
  let bottom = borne(crop.bottomPct);
  let left = borne(crop.leftPct);

  const horizontal = left + right;
  if (horizontal > 1 - MIN_VISIBLE_FRACTION) {
    const facteur = (1 - MIN_VISIBLE_FRACTION) / horizontal;
    left *= facteur;
    right *= facteur;
  }
  const vertical = top + bottom;
  if (vertical > 1 - MIN_VISIBLE_FRACTION) {
    const facteur = (1 - MIN_VISIBLE_FRACTION) / vertical;
    top *= facteur;
    bottom *= facteur;
  }

  return { topPct: top, rightPct: right, bottomPct: bottom, leftPct: left };
}

/** Fractions de l'original encore visibles, en largeur et en hauteur. */
export function visibleFraction(crop: ImageCrop): { width: number; height: number } {
  const normalise = normalizeCrop(crop);
  return {
    width: Math.max(MIN_VISIBLE_FRACTION, 1 - normalise.leftPct - normalise.rightPct),
    height: Math.max(MIN_VISIBLE_FRACTION, 1 - normalise.topPct - normalise.bottomPct),
  };
}

/**
 * Compose un second rognage sur un premier.
 *
 * `inner` est exprimé dans le repère de ce qui est **actuellement visible** —
 * c'est ce que l'usager désigne en traçant un cadre sur l'aperçu, lequel montre
 * déjà l'image rognée. Le résultat, lui, est exprimé dans le repère de
 * l'**original**, seul repère stable.
 *
 * Sans cette conversion, rogner une seconde fois retrancherait des fractions de
 * l'original alors qu'on croit désigner des fractions du visible : le second
 * geste couperait bien plus que ce qui a été montré.
 */
export function composeCrop(existing: ImageCrop, inner: ImageCrop): ImageCrop {
  const base = normalizeCrop(existing);
  const dedans = normalizeCrop(inner);
  const visible = visibleFraction(base);

  return normalizeCrop({
    topPct: base.topPct + dedans.topPct * visible.height,
    rightPct: base.rightPct + dedans.rightPct * visible.width,
    bottomPct: base.bottomPct + dedans.bottomPct * visible.height,
    leftPct: base.leftPct + dedans.leftPct * visible.width,
  });
}

/**
 * Géométrie de rendu d'une image rognée.
 *
 * Le cadre fait `frameWidthPx × frameHeightPx` et masque ce qui déborde ;
 * l'image y est agrandie de façon que la part visible remplisse exactement le
 * cadre, puis décalée pour amener le bon coin en haut à gauche.
 */
export function cropGeometry(
  crop: ImageCrop,
  frameWidthPx: number,
  frameHeightPx: number,
): { widthPx: number; heightPx: number; offsetXPx: number; offsetYPx: number } {
  const normalise = normalizeCrop(crop);
  const visible = visibleFraction(normalise);

  const widthPx = frameWidthPx / visible.width;
  const heightPx = frameHeightPx / visible.height;

  return {
    widthPx,
    heightPx,
    offsetXPx: -normalise.leftPct * widthPx,
    offsetYPx: -normalise.topPct * heightPx,
  };
}

/**
 * Les clés de rognage prêtes à poser sur un run ; vides si pas de rognage.
 *
 * Un bord non rogné est **absent**, jamais posé à zéro. C'est la même forme
 * canonique que pour les booléens de formatage (`patchFormatting`), et pour la
 * même raison : `sameFormatting` compare clé à clé, et `0` ne serait pas égal à
 * « clé absente ». Deux images rognées identiquement mais construites par des
 * chemins différents cesseraient alors de partager leur formatage.
 */
export function cropFormatting(crop: ImageCrop | undefined): Partial<TextRun> {
  if (!hasCrop(crop)) return {};
  const normalise = normalizeCrop(crop);
  return {
    ...(normalise.topPct > 0 ? { imageCropTopPct: normalise.topPct } : {}),
    ...(normalise.rightPct > 0 ? { imageCropRightPct: normalise.rightPct } : {}),
    ...(normalise.bottomPct > 0 ? { imageCropBottomPct: normalise.bottomPct } : {}),
    ...(normalise.leftPct > 0 ? { imageCropLeftPct: normalise.leftPct } : {}),
  };
}

export function clampSize(pt: number): number {
  if (!Number.isFinite(pt) || pt <= 0) return MIN_IMAGE_SIZE_PT;
  return Math.min(MAX_IMAGE_SIZE_PT, Math.max(MIN_IMAGE_SIZE_PT, pt));
}

/**
 * Construit le run d'une image.
 *
 * Le formatage hérité est **vidé de ses attributs de texte** : gras, souligné ou
 * lien n'ont aucun sens sur un cadre, et les laisser ferait diverger l'image de
 * ce qu'affiche la barre d'outils lorsqu'on la sélectionne.
 */
export function makeImageRun(attributes: ImageAttributes): TextRun {
  return makeRun(IMAGE_PLACEHOLDER, {
    imageSrc: attributes.src,
    imageWidthPt: clampSize(attributes.widthPt),
    imageHeightPt: clampSize(attributes.heightPt),
    ...(attributes.alt ? { imageAlt: attributes.alt } : {}),
    ...cropFormatting(attributes.crop),
  });
}

/**
 * Réécrit la géométrie d'un run image en conservant son identité.
 *
 * `makeImageRun` repartirait de zéro et perdrait un attribut ajouté ailleurs ;
 * ici on ne touche qu'à ce qui change.
 */
export function resizeImageRun(run: TextRun, widthPt: number, heightPt: number): TextRun {
  return makeRun(run.text, {
    ...runFormatting(run),
    imageWidthPt: clampSize(widthPt),
    imageHeightPt: clampSize(heightPt),
  });
}

/**
 * Taille d'insertion d'une image de `naturalWidthPx` × `naturalHeightPx`.
 *
 * Writer insère à la taille naturelle puis réduit si le cadre déborde de la zone
 * imprimable (`SwFEShell::Insert`, `frmmgr.cxx`). Même règle ici : on ne réduit
 * **que** ce qui dépasse, et toujours à rapport conservé — une image élargie de
 * force annoncerait une résolution qu'elle n'a pas.
 */
export function fitToContentWidth(
  naturalWidthPx: number,
  naturalHeightPx: number,
  contentWidthPt: number,
): { widthPt: number; heightPt: number } {
  const width = Number.isFinite(naturalWidthPx) && naturalWidthPx > 0 ? naturalWidthPx : 1;
  const height = Number.isFinite(naturalHeightPx) && naturalHeightPx > 0 ? naturalHeightPx : 1;

  // Les pixels d'une image sont des pixels CSS : 96 par pouce, comme le reste du
  // moteur. La conversion en points est donc exacte, sans hypothèse de DPI.
  let widthPt = pxToPt(width);
  let heightPt = pxToPt(height);

  const limit = Math.max(MIN_IMAGE_SIZE_PT, contentWidthPt);
  if (widthPt > limit) {
    heightPt = (heightPt * limit) / widthPt;
    widthPt = limit;
  }

  return { widthPt: clampSize(widthPt), heightPt: clampSize(heightPt) };
}

/** Hauteur qui conserve le rapport d'origine quand la largeur change. */
export function heightForWidth(
  widthPt: number,
  ratio: { widthPt: number; heightPt: number },
): number {
  if (ratio.widthPt <= 0) return clampSize(widthPt);
  return clampSize((widthPt * ratio.heightPt) / ratio.widthPt);
}

/** Largeur qui conserve le rapport d'origine quand la hauteur change. */
export function widthForHeight(
  heightPt: number,
  ratio: { widthPt: number; heightPt: number },
): number {
  if (ratio.heightPt <= 0) return clampSize(heightPt);
  return clampSize((heightPt * ratio.widthPt) / ratio.heightPt);
}

/**
 * Adresses acceptées pour une image.
 *
 * `javascript:` et `data:text/html` sont des vecteurs d'exécution ; une balise
 * `<img src>` ne les honore pas, mais l'adresse voyage aussi dans l'export ODF
 * et dans le document partagé, où d'autres lecteurs la reprendront. On tranche
 * donc ici, une fois, plutôt qu'à chaque point de sortie.
 */
export function isSafeImageSrc(src: string): boolean {
  const value = src.trim();
  if (value.length === 0) return false;

  if (/^data:/i.test(value)) {
    return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(value);
  }
  // Relative : c'est la forme que renvoie le dépôt d'images du serveur.
  if (value.startsWith('/') && !value.startsWith('//')) return true;

  try {
    const url = new URL(value, 'https://exemple.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Toutes les images d'une suite de runs, avec l'offset qu'elles occupent.
 *
 * Sert au dépôt des images sur le serveur au partage, et à la collecte des
 * `Pictures/` à l'écriture d'un `.odt`.
 */
export function collectImageRuns(
  runs: readonly TextRun[],
): { run: TextRun; offset: number; index: number }[] {
  const out: { run: TextRun; offset: number; index: number }[] = [];
  let offset = 0;
  runs.forEach((run, index) => {
    if (isImageRun(run)) out.push({ run, offset, index });
    offset += run.text.length;
  });
  return out;
}
