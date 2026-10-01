// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Images anchored "as a character" (OpenOffice: `SwFlyCntFrm`,
 * `sw/source/core/layout/flycnt.cxx`, and `SwGrfNode`, `sw/source/core/graphic/`).
 *
 * Writer distinguishes the **graphic node**, which carries the bytes, from the
 * **frame**, which carries the geometry. The split is the same here: the run carries
 * an address (`imageSrc`) and a size (`imageWidthPt` × `imageHeightPt`), and the bytes
 * live elsewhere: in a `data:` URL while local, in the server's store once the
 * document is shared.
 *
 * The run's text is a single **object replacement character** (U+FFFC OBJECT
 * REPLACEMENT CHARACTER), the very one `SwTxtNode::InsertItem` inserts for a
 * `SwTxtFlyCnt` (`CH_TXTATR_BREAKWORD`, `sw/inc/txatbase.hxx`). The choice is not
 * cosmetic: it gives the image **one** position in the paragraph's string, so a
 * single cursor offset. An image that took several code units would let the cursor
 * land in the middle of it.
 *
 * Pure module: no React import, no DOM access.
 */

import { pxToPt } from './units';
import { makeRun, runFormatting } from './runs';
import type {
  FlyAnchor,
  FlyHoriOrient,
  FlyHoriRelation,
  RunFormatting,
  TextRun,
} from './types';

/** `CH_TXTATR_BREAKWORD`: the place the object takes in the text. */
export const IMAGE_PLACEHOLDER = '￼';

/** Formats the server accepts, recognized from their bytes (`assets.rs`). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Upload limit on the server side, repeated here to avoid uploading for nothing. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Resize limits, in points. Below 4 pt an image is no longer visible. */
export const MIN_IMAGE_SIZE_PT = 4;
export const MAX_IMAGE_SIZE_PT = 2000;

/**
 * Cropping: what is cut from each edge of the **original** image, as a fraction from
 * 0 to 1. (OpenOffice: `SvxGrfCrop`.)
 */
export interface ImageCrop {
  topPct: number;
  rightPct: number;
  bottomPct: number;
  leftPct: number;
}

export const NO_CROP: ImageCrop = { topPct: 0, rightPct: 0, bottomPct: 0, leftPct: 0 };

/**
 * The part of the image that must stay visible after cropping.
 *
 * Cropping an edge completely would make the image disappear and divide by zero when
 * rendering; we always keep enough to see what is being handled.
 */
export const MIN_VISIBLE_FRACTION = 0.05;

export interface ImageAttributes {
  src: string;
  widthPt: number;
  heightPt: number;
  alt?: string;
  crop?: ImageCrop;
  /** Caption settings. Absent = no caption at all. */
  caption?: ImageCaption;
  /** Margin around the frame, in points. `0` is a legitimate value. */
  marginPt?: number;
  /** Space between the image and its caption, in points. `0` is legitimate. */
  captionGapPt?: number;
  /** How the image fits into the text. Absent = in the flow (`FLY_AS_CHAR`). */
  wrap?: ImageWrapPlacement;
}

/**
 * Position of a floating frame: OpenOffice's placement items, gathered together.
 *
 * `mode` carries the wrapping and the layer; the five other fields carry
 * `SwFmtHoriOrient`, `SwFmtVertOrient` and the wrapping margin. A single object for
 * everything that only makes sense **outside the text flow**: `mode: 'inline'` makes
 * them all useless at once, which no combination of flat fields would express as
 * clearly.
 */
export interface ImageWrapPlacement {
  mode: ImageWrapMode;
  horiOrient?: FlyHoriOrient;
  horiRelation?: FlyHoriRelation;
  /** Horizontal offset, in points. Only read for `from-left`. */
  xPt?: number;
  /** Vertical offset from the top of the anchor, in points. */
  yPt?: number;
  /** White space the text leaves around the frame, in points. */
  wrapMarginPt?: number;
}

/**
 * Run fields for spacing: margin and caption gap.
 *
 * `0` is a **value**, not an absence: testing it for truthiness (`x ? … : …`) would
 * make it vanish, and the run would fall back on the default gap. That was exactly
 * the symptom "the margins are not quite at zero".
 */
export function spacingFormatting(
  marginPt: number | undefined,
  captionGapPt: number | undefined,
): Partial<TextRun> {
  return {
    ...(marginPt !== undefined
      ? { imageMarginPt: Math.min(MAX_IMAGE_MARGIN_PT, Math.max(0, marginPt)) }
      : {}),
    ...(captionGapPt !== undefined
      ? { imageCaptionGapPt: Math.min(MAX_IMAGE_MARGIN_PT, Math.max(0, captionGapPt)) }
      : {}),
  };
}

/**
 * Run fields that correspond to caption settings.
 *
 * Returns `{}` when there is no caption, the same convention as `cropFormatting`: the
 * caller clears the existing keys before spreading this result, otherwise removing a
 * caption would never erase it.
 */
export function captionFormatting(caption: ImageCaption | undefined): Partial<TextRun> {
  if (!caption) return {};
  return {
    imageCaption: caption.text,
    imageCaptionPosition: caption.position,
    imageCaptionAlign: caption.align,
    // Automatic mode being the default, only the exception is stored.
    ...(caption.manual ? { imageCaptionManual: true } : {}),
  };
}

/** Does a run carry an image? */
export function isImageRun(run: Pick<TextRun, 'imageSrc'>): boolean {
  return typeof run.imageSrc === 'string' && run.imageSrc.length > 0;
}

export function isImageFormatting(formatting: RunFormatting): boolean {
  return typeof formatting.imageSrc === 'string' && formatting.imageSrc.length > 0;
}

/** Reads the geometry of an image run, with the limits applied. */
export function imageAttributes(run: TextRun): ImageAttributes | null {
  if (!isImageRun(run)) return null;
  const crop = imageCrop(run);
  return {
    src: run.imageSrc!,
    widthPt: clampSize(run.imageWidthPt ?? 0),
    heightPt: clampSize(run.imageHeightPt ?? 0),
    ...(run.imageAlt !== undefined ? { alt: run.imageAlt } : {}),
    ...(hasCrop(crop) ? { crop } : {}),
    ...(hasCaption(run) ? { caption: imageCaptionOf(run) } : {}),
    ...(run.imageMarginPt !== undefined ? { marginPt: run.imageMarginPt } : {}),
    ...(run.imageCaptionGapPt !== undefined ? { captionGapPt: run.imageCaptionGapPt } : {}),
    wrap: imageWrapPlacement(run),
  };
}

/** Placement of a frame, with default values resolved. */
export function imageWrapPlacement(run: RunFormatting): ImageWrapPlacement {
  const mode = imageWrapMode(run);
  if (mode === 'inline') return { mode };
  return {
    mode,
    horiOrient: run.imageHoriOrient ?? 'from-left',
    horiRelation: run.imageHoriRelation ?? 'text',
    xPt: run.imageXPt ?? 0,
    yPt: run.imageYPt ?? 0,
    wrapMarginPt: run.imageWrapMarginPt ?? DEFAULT_WRAP_MARGIN_PT,
  };
}

/** Cropping carried by a run, normalized. */
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
 * Brings a crop back into the domain of sense.
 *
 * Two opposite edges that add up to more than the whole image have no result: we
 * reduce them **proportionally** rather than clamp just one, which would shift the
 * center of the visible part.
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

/** Fractions of the original that are still visible, in width and in height. */
export function visibleFraction(crop: ImageCrop): { width: number; height: number } {
  const normalise = normalizeCrop(crop);
  return {
    width: Math.max(MIN_VISIBLE_FRACTION, 1 - normalise.leftPct - normalise.rightPct),
    height: Math.max(MIN_VISIBLE_FRACTION, 1 - normalise.topPct - normalise.bottomPct),
  };
}

/**
 * Applies a second crop on top of a first one.
 *
 * `inner` is expressed in the frame of reference of what is **currently visible**,
 * which is what the user designates by drawing a box on the preview, since the
 * preview already shows the cropped image. The result is expressed in the frame of
 * reference of the **original**, the only stable one.
 *
 * Without this conversion, cropping a second time would remove fractions of the
 * original while the user believes they are designating fractions of what is visible:
 * the second gesture would cut far more than what was shown.
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
 * Rendering geometry of a cropped image.
 *
 * The frame is `frameWidthPx × frameHeightPx` and hides what overflows; the image is
 * enlarged inside it so that the visible part fills the frame exactly, then shifted to
 * bring the right corner to the top left.
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
 * The crop keys, ready to put on a run; empty when there is no crop.
 *
 * An uncropped edge is **absent**, never set to zero. This is the same canonical form
 * as for the formatting booleans (`patchFormatting`), for the same reason:
 * `sameFormatting` compares key by key, and `0` would not equal "key absent". Two
 * images cropped identically but built by different paths would then stop sharing
 * their formatting.
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
 * Builds the run of an image.
 *
 * The inherited formatting is **stripped of its text attributes**: bold, underline or
 * a link mean nothing on a frame, and keeping them would make the image differ from
 * what the toolbar shows when it is selected.
 */
export function makeImageRun(attributes: ImageAttributes): TextRun {
  return makeRun(IMAGE_PLACEHOLDER, {
    imageSrc: attributes.src,
    imageWidthPt: clampSize(attributes.widthPt),
    imageHeightPt: clampSize(attributes.heightPt),
    ...(attributes.alt ? { imageAlt: attributes.alt } : {}),
    ...cropFormatting(attributes.crop),
    ...captionFormatting(attributes.caption),
    ...spacingFormatting(attributes.marginPt, attributes.captionGapPt),
    ...placementFormatting(attributes.wrap),
  });
}

/**
 * Run fields that correspond to a placement.
 *
 * Same convention as `cropFormatting`: absent keys mean erasure, and the caller must
 * clear `WRAP_FORMAT_KEYS` before spreading this result. A frame brought back into the
 * text flow returns `{}` here, so it would leave intact any floating geometry that
 * someone forgot to erase.
 */
export function placementFormatting(
  placement: ImageWrapPlacement | undefined,
): Partial<TextRun> {
  if (!placement || placement.mode === 'inline') return {};
  return {
    ...wrapFormatting(placement.mode),
    ...(placement.horiOrient !== undefined ? { imageHoriOrient: placement.horiOrient } : {}),
    ...(placement.horiRelation !== undefined
      ? { imageHoriRelation: placement.horiRelation }
      : {}),
    ...(placement.xPt !== undefined ? { imageXPt: placement.xPt } : {}),
    ...(placement.yPt !== undefined ? { imageYPt: placement.yPt } : {}),
    ...(placement.wrapMarginPt !== undefined
      ? {
          imageWrapMarginPt: Math.min(
            MAX_IMAGE_MARGIN_PT,
            Math.max(0, placement.wrapMarginPt),
          ),
        }
      : {}),
  };
}

/**
 * Rewrites the geometry of an image run while keeping its identity.
 *
 * `makeImageRun` would start from scratch and lose an attribute added elsewhere; here
 * we only touch what changes.
 */
export function resizeImageRun(run: TextRun, widthPt: number, heightPt: number): TextRun {
  return makeRun(run.text, {
    ...runFormatting(run),
    imageWidthPt: clampSize(widthPt),
    imageHeightPt: clampSize(heightPt),
  });
}

/**
 * Insertion size of an image of `naturalWidthPx` × `naturalHeightPx`.
 *
 * Writer inserts at natural size and then shrinks it if the frame overflows the
 * printable area (`SwFEShell::Insert`, `frmmgr.cxx`). Same rule here: we only shrink
 * what exceeds, and always keeping the aspect ratio. An image stretched by force would
 * announce a resolution it does not have.
 */
export function fitToContentWidth(
  naturalWidthPx: number,
  naturalHeightPx: number,
  contentWidthPt: number,
): { widthPt: number; heightPt: number } {
  const width = Number.isFinite(naturalWidthPx) && naturalWidthPx > 0 ? naturalWidthPx : 1;
  const height = Number.isFinite(naturalHeightPx) && naturalHeightPx > 0 ? naturalHeightPx : 1;

  // The pixels of an image are CSS pixels: 96 per inch, like the rest of the engine. The
  // conversion to points is therefore exact, with no DPI assumption.
  let widthPt = pxToPt(width);
  let heightPt = pxToPt(height);

  const limit = Math.max(MIN_IMAGE_SIZE_PT, contentWidthPt);
  if (widthPt > limit) {
    heightPt = (heightPt * limit) / widthPt;
    widthPt = limit;
  }

  return { widthPt: clampSize(widthPt), heightPt: clampSize(heightPt) };
}

/** Height that keeps the original aspect ratio when the width changes. */
export function heightForWidth(
  widthPt: number,
  ratio: { widthPt: number; heightPt: number },
): number {
  if (ratio.widthPt <= 0) return clampSize(widthPt);
  return clampSize((widthPt * ratio.heightPt) / ratio.widthPt);
}

/** Width that keeps the original aspect ratio when the height changes. */
export function widthForHeight(
  heightPt: number,
  ratio: { widthPt: number; heightPt: number },
): number {
  if (ratio.heightPt <= 0) return clampSize(heightPt);
  return clampSize((heightPt * ratio.widthPt) / ratio.heightPt);
}

/**
 * Addresses accepted for an image.
 *
 * `javascript:` and `data:text/html` are ways to run code; an `<img src>` tag does not
 * honor them, but the address also travels in the ODF export and in the shared
 * document, where other readers will use it. We therefore decide here, once, rather
 * than at every exit point.
 */
export function isSafeImageSrc(src: string): boolean {
  const value = src.trim();
  if (value.length === 0) return false;

  if (/^data:/i.test(value)) {
    return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(value);
  }
  // Relative: this is the form returned by the server's image store.
  if (value.startsWith('/') && !value.startsWith('//')) return true;

  try {
    const url = new URL(value, 'https://exemple.invalid');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * All the images of a sequence of runs, with the offset each one occupies.
 *
 * Used to upload the images to the server when sharing, and to collect the
 * `Pictures/` entries when writing an `.odt`.
 */
/* -------------------------------------------------------------- captions */

/** Caption settings of an image, with default values resolved. */
export interface ImageCaption {
  text: string;
  position: 'above' | 'below';
  align: 'left' | 'center' | 'right';
  /** `false` = automatic numbering (the default). */
  manual: boolean;
}

/** Default space between the image and its caption, in points. */
export const DEFAULT_CAPTION_GAP_PT = 3;

/**
 * Default space the text leaves around a floating frame, in points. This is the
 * frame's `SvxLRSpaceItem` in Writer.
 */
export const DEFAULT_WRAP_MARGIN_PT = 4;
/** Upper bound of the adjustable margins, in points (≈ 50 mm). */
export const MAX_IMAGE_MARGIN_PT = 142;

/** Margin around the frame, clamped. */
export function imageMarginPt(run: Pick<TextRun, 'imageMarginPt'>): number {
  return Math.min(MAX_IMAGE_MARGIN_PT, Math.max(0, run.imageMarginPt ?? 0));
}

/** Space between the image and its caption, clamped. */
export function imageCaptionGapPt(run: Pick<TextRun, 'imageCaptionGapPt'>): number {
  return Math.min(MAX_IMAGE_MARGIN_PT, Math.max(0, run.imageCaptionGapPt ?? DEFAULT_CAPTION_GAP_PT));
}

/** Prefix generated by automatic numbering. */
export const FIGURE_LABEL = 'Figure';

export function imageCaptionOf(run: Pick<TextRun, 'imageCaption' | 'imageCaptionPosition' | 'imageCaptionAlign' | 'imageCaptionManual'>): ImageCaption {
  return {
    text: run.imageCaption ?? '',
    position: run.imageCaptionPosition ?? 'below',
    align: run.imageCaptionAlign ?? 'center',
    manual: run.imageCaptionManual === true,
  };
}

/** Does an image carry a caption to paint? */
export function hasCaption(run: Pick<TextRun, 'imageCaption' | 'imageCaptionManual'>): boolean {
  // In automatic mode, "Figure n°3" is enough on its own: a numbered image with no text
  // still has a caption. In manual mode, with no text there is nothing to write.
  if (run.imageCaptionManual === true) return (run.imageCaption ?? '').trim().length > 0;
  return run.imageCaption !== undefined;
}

/**
 * Full text of a caption, number included.
 *
 * `number` is `null` outside automatic numbering. The separator only appears if there
 * is something to separate: "Figure n°2" with no text must not drag an orphan ":"
 * along.
 */
export function captionText(caption: ImageCaption, number: number | null): string {
  if (caption.manual || number === null) return caption.text;
  const prefix = `${FIGURE_LABEL} n°${number}`;
  return caption.text.trim().length > 0 ? `${prefix} : ${caption.text}` : prefix;
}

/** Key of an image in the numbering table: paragraph and offset. */
export function imageKey(blockId: string, offset: number): string {
  return `${blockId}:${offset}`;
}

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

/* --------------------------------------------- fitting into the text (wrapping) */

/**
 * The five ways an image fits into the text.
 *
 * Writer does not have this type: it keeps **three** independent attributes: the
 * anchor (`SwFmtAnchor`, `RndStdIds`), the wrapping (`SwFmtSurround`, `SwSurround`)
 * and the layer (`RES_OPAQUE`, `SvxOpaqueItem`), and the "Format ▸ Wrap" menu only
 * shows the useful combinations.
 *
 * This type **is** that list of useful combinations, named once and for all. It does
 * not replace the three attributes, it indexes them: the model keeps carrying
 * OpenOffice's items, and only those travel in ODF. Without this detour, every button
 * of the interface would have to decide three values at once by itself, and "in front
 * of the text", which is `through` wrapping **plus** a layer, would sooner or later end
 * up half written.
 *
 *  - `inline`: `FLY_AS_CHAR`, the image flows in the line like a character;
 *  - `wrap`: `SURROUND_IDEAL`, the text goes around on the wider side;
 *  - `break`: `SURROUND_NONE`, the text stops above and resumes below;
 *  - `behind`: `SURROUND_THROUGHT`, layer `hell`: the text passes over the image;
 *  - `front`: `SURROUND_THROUGHT`, layer `heaven`: the image covers the text.
 */
export type ImageWrapMode = 'inline' | 'wrap' | 'break' | 'behind' | 'front';

/** Menu labels, in the order they appear there. */
export const IMAGE_WRAP_MODES: readonly {
  mode: ImageWrapMode;
  label: string;
  hint: string;
}[] = [
  { mode: 'inline', label: 'Aligner', hint: "L'image suit le texte, comme un caractère" },
  { mode: 'wrap', label: 'Retour à la ligne', hint: 'Le texte contourne l’image' },
  { mode: 'break', label: 'Intercaler le texte', hint: 'Le texte s’arrête au-dessus et reprend dessous' },
  { mode: 'behind', label: 'Derrière le texte', hint: 'L’image passe sous le texte' },
  { mode: 'front', label: 'Devant le texte', hint: 'L’image recouvre le texte' },
];

/** Fitting mode of a frame, deduced from its three attributes. */
export function imageWrapMode(
  run: Pick<TextRun, 'imageAnchor' | 'imageSurround' | 'imageInFront'>,
): ImageWrapMode {
  if (!run.imageAnchor || run.imageAnchor === 'as-char') return 'inline';
  switch (run.imageSurround) {
    case 'through':
      return run.imageInFront ? 'front' : 'behind';
    case 'none':
      return 'break';
    default:
      return 'wrap';
  }
}

/**
 * Frame attributes that correspond to a mode, anchor included.
 *
 * `anchor` is only looked at for the floating modes, where it serves to **keep** a
 * page anchor that was already chosen: switching from "behind" to "in front" must not
 * bring back to the paragraph a frame that was placed on the sheet.
 *
 * Absent keys mean erasure: `wrapFormatting('inline')` does not return
 * `imageAnchor: undefined` but nothing at all, and the caller must remove the existing
 * keys before spreading this result. Same convention as `cropFormatting` and
 * `captionFormatting` above.
 */
export function wrapFormatting(
  mode: ImageWrapMode,
  anchor: FlyAnchor = 'to-para',
): Partial<TextRun> {
  if (mode === 'inline') return {};

  const flottant: FlyAnchor = anchor === 'as-char' ? 'to-para' : anchor;
  switch (mode) {
    case 'break':
      return { imageAnchor: flottant, imageSurround: 'none' };
    case 'behind':
      return { imageAnchor: flottant, imageSurround: 'through' };
    case 'front':
      return { imageAnchor: flottant, imageSurround: 'through', imageInFront: true };
    case 'wrap':
    default:
      // `SURROUND_IDEAL` rather than `PARALLEL`: this is what Writer picks for ordinary
      // wrapping, and it falls back by itself to `left` or `right` when the frame is too
      // close to an edge for anything to be written there.
      return { imageAnchor: flottant, imageSurround: 'ideal' };
  }
}

/** The keys that `wrapFormatting` governs: to be cleared before spreading it. */
export const WRAP_FORMAT_KEYS = [
  'imageAnchor',
  'imageSurround',
  'imageInFront',
  'imageHoriOrient',
  'imageHoriRelation',
  'imageXPt',
  'imageYPt',
  'imageWrapMarginPt',
] as const satisfies readonly (keyof RunFormatting)[];

/** Default position of a frame that has just left the text flow. */
export function defaultFlyPlacement(mode: ImageWrapMode): Partial<TextRun> {
  // A frame that covers the text is placed where it is; a wrapped frame is put against
  // an edge, otherwise it would fall at the top-left corner of the paragraph and cut the
  // first line in two.
  const orient: FlyHoriOrient = mode === 'wrap' ? 'right' : 'left';
  return {
    imageHoriOrient: orient,
    imageHoriRelation: 'text',
    imageXPt: 0,
    imageYPt: 0,
  };
}
