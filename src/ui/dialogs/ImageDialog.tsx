// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Workshop to insert and retouch an image.
 *
 * Equivalent of Writer's "Insert ▸ Image" dialog (`sw/source/ui/dialog/`, the Type, Wrap and Options tabs of `SwFrmDlg`): the source, the dimensions, the alternative text, the caption and how
 * the image fits into the text (wrapping, alignment and layer).
 *
 * Four ergonomic decisions:
 *
 *  - **the aspect ratio is locked by default.** Distorting an image is almost always an accident; doing it on purpose is still possible, by unticking;
 *  - **dimensions are in millimeters**, like the margins and the ruler. Points are the model's internal unit, not the paper's;
 *  - **a local file becomes a `data:` URL immediately.** The document stays complete offline; it is sharing, afterwards, that uploads the bytes to the server and replaces the address;
 *  - **the position settings only appear once the image is out of the text flow.** Writer greys them out in the same case: an x coordinate means nothing for a frame whose place the formatter
 *    decides, and showing it anyway invites people to set it for nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Modal } from '../../design/components/Modal';
import {
  ACCEPTED_IMAGE_TYPES,
  captionText as formatCaption,
  clampSize,
  DEFAULT_CAPTION_GAP_PT,
  MAX_IMAGE_MARGIN_PT,
  composeCrop,
  cropGeometry,
  fitToContentWidth,
  hasCrop,
  heightForWidth,
  isSafeImageSrc,
  visibleFraction,
  widthForHeight,
  IMAGE_WRAP_MODES,
  MAX_IMAGE_BYTES,
  NO_CROP,
  type ImageCaption,
  type ImageCrop,
  type ImageWrapMode,
} from '../../domain/document/images';
import type { FlyHoriOrient, FlyHoriRelation } from '../../domain/document/types';
import { DEFAULT_WRAP_MARGIN_PT } from '../../domain/engine/flyLayout';
import { ImageWrapPicker } from '../components/ImageWrapPicker';
import { ImageCropper } from './ImageCropper';
import { probeImageSize, readFileAsDataUrl } from '../../domain/image/raster';
// The two conversions used to live here in duplicate, rebuilt around a local `72 / 25.4`. A single definition now, shared with the engine and the export.
import { mmToPt, ptToMm, pxToPt } from '../../domain/document/units';

/** Display rounding: a tenth of a millimeter, the precision of a ruler. */
function showMm(pt: number): string {
  return (Math.round(ptToMm(pt) * 10) / 10).toString();
}

export interface ImageDraft {
  /** Present when retouching, absent when inserting. */
  blockId?: string;
  /** Offset of the frame in the paragraph, when retouching. */
  offset?: number;
  src: string;
  widthPt: number;
  heightPt: number;
  alt: string;
  /** Crop already applied, in the frame of reference of the original image. */
  crop?: ImageCrop;
  /** Caption settings. Absent = no caption. */
  caption?: ImageCaption;
  /** Number this figure would have: for the preview only, never saved. */
  figureNumber?: number;
  /** Margin around the frame, in points. */
  marginPt?: number;
  /** Space between the image and its caption, in points. */
  captionGapPt?: number;

  /* -- Fitting into the text (`SwFmtSurround`, `SwFmtHoriOrient`) ------- */

  /** How the image fits into the text. Absent = in the flow (`FLY_AS_CHAR`). */
  wrap?: ImageWrapMode;
  /** Horizontal alignment of a floating frame. */
  horiOrient?: FlyHoriOrient;
  /** Reference of that alignment: the text column or the sheet. */
  horiRelation?: FlyHoriRelation;
  /** Horizontal offset, in points: only read for `from-left`. */
  xPt?: number;
  /** Vertical offset from the top of the anchor, in points. */
  yPt?: number;
  /** Wrapping margin: the white space the text leaves around the frame. */
  wrapMarginPt?: number;
}

/**
 * The three pages of the dialog.
 *
 * The split is that of the tabs of `SwFrmDlg`: what the image **is**, where it **sits**, what is **written under** it. Each page answers one question, so one always knows which one to open.
 */
const ONGLETS = [
  { id: 'image', label: 'Image' },
  { id: 'position', label: 'Position' },
  { id: 'legende', label: 'Légende' },
] as const;

type OngletId = (typeof ONGLETS)[number]['id'];

export interface ImageDialogProps {
  draft: ImageDraft;
  /** Width of the printable area, in points: the insertion ceiling. */
  contentWidthPt: number;
  onCancel: () => void;
  onSubmit: (draft: ImageDraft) => void;
  onDelete?: (() => void) | undefined;
}

export function ImageDialog({
  draft,
  contentWidthPt,
  onCancel,
  onSubmit,
  onDelete,
}: ImageDialogProps): JSX.Element {
  const isEdit = draft.blockId !== undefined;

  const [src, setSrc] = useState(draft.src);
  const [urlField, setUrlField] = useState(draft.src.startsWith('data:') ? '' : draft.src);
  const [widthPt, setWidthPt] = useState(draft.widthPt);
  const [heightPt, setHeightPt] = useState(draft.heightPt);
  const [alt, setAlt] = useState(draft.alt);

  /*
   * Caption. Automatic numbering is the default mode: it is the one that produces "Figure n°1: ..." without the user having to set anything.
   */
  const [captionText, setCaptionText] = useState(draft.caption?.text ?? '');
  const [captionPosition, setCaptionPosition] = useState<'above' | 'below'>(
    draft.caption?.position ?? 'below',
  );
  const [captionAlign, setCaptionAlign] = useState<'left' | 'center' | 'right'>(
    draft.caption?.align ?? 'center',
  );
  /*
   * Does an image have a caption at all?
   *
   * This switch was missing, and its absence showed: automatic numbering being the default, every image that went through this window came out captioned "Figure n°1", with no way to refuse
   * it other than guessing that you had to untick the numbering **and** empty the text. An image dropped by drag and drop, on the other hand, had no caption, so the two ways of inserting did not
   * give the same result.
   *
   * The default is now that of the document that was opened (a caption if there was one, none for a new image) and the choice is explicit.
   */
  const [captionOn, setCaptionOn] = useState(draft.caption !== undefined);
  const [captionAuto, setCaptionAuto] = useState(draft.caption ? !draft.caption.manual : true);
  const [marginPt, setMarginPt] = useState(draft.marginPt ?? 0);

  /*
   * Fitting into the text. The four position settings are only used by the floating modes; they nevertheless stay in state, so that a round trip through "Align" does not wipe them out under the
   * user's fingers.
   */
  const [wrap, setWrap] = useState<ImageWrapMode>(draft.wrap ?? 'inline');
  const [horiOrient, setHoriOrient] = useState<FlyHoriOrient>(draft.horiOrient ?? 'from-left');
  const [horiRelation, setHoriRelation] = useState<FlyHoriRelation>(draft.horiRelation ?? 'text');
  const [xPt, setXPt] = useState(draft.xPt ?? 0);
  const [yPt, setYPt] = useState(draft.yPt ?? 0);
  const [wrapMarginPt, setWrapMarginPt] = useState(draft.wrapMarginPt ?? DEFAULT_WRAP_MARGIN_PT);
  const [captionGapPt, setCaptionGapPt] = useState(draft.captionGapPt ?? DEFAULT_CAPTION_GAP_PT);
  const [ongletActif, setOngletActif] = useState<OngletId>('image');
  const [keepRatio, setKeepRatio] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);

  /**
   * Crop **already applied**, in the frame of reference of the original image.
   *
   * Distinct from the frame being drawn: that one is expressed in the frame of reference of what the preview shows, so of the image that is already cropped. Mixing them would make the second
   * gesture cut far more than what was designated.
   */
  const [cropApplique, setCropApplique] = useState<ImageCrop>(draft.crop ?? NO_CROP);
  /** Frame being drawn; `null` outside crop mode. */
  const [cadreEnCours, setCadreEnCours] = useState<ImageCrop | null>(null);

  /**
   * Reference ratio.
   *
   * It is frozen at the last known **source**, never at the current dimensions: without that, every display rounding would carry over into the ratio and the image would drift after enough retouching.
   */
  const ratioRef = useRef({ widthPt: draft.widthPt, heightPt: draft.heightPt });
  const fichierRef = useRef<HTMLInputElement | null>(null);

  const adopterSource = useCallback(
    async (nouvelleSource: string) => {
      setChargement(true);
      setErreur(null);
      try {
        if (!isSafeImageSrc(nouvelleSource)) {
          throw new Error('Adresse refusée : seules les images http(s) et data: sont acceptées.');
        }
        const naturelle = await probeImageSize(nouvelleSource);
        const ajustee = fitToContentWidth(naturelle.widthPx, naturelle.heightPx, contentWidthPt);
        ratioRef.current = {
          widthPt: pxToPt(naturelle.widthPx),
          heightPt: pxToPt(naturelle.heightPx),
        };
        setSrc(nouvelleSource);
        setWidthPt(ajustee.widthPt);
        setHeightPt(ajustee.heightPt);
        // The crop designates a region of **this** image: changing the image would leave it pointing at a region that no longer exists.
        setCropApplique(NO_CROP);
        setCadreEnCours(null);
      } catch (error) {
        setErreur((error as Error).message);
      } finally {
        setChargement(false);
      }
    },
    [contentWidthPt],
  );

  // When retouching, we read the natural size again to know the original ratio: the frame may have been distorted, and "restore the proportions" must start again from the image, not from what the frame
  // was worth.
  useEffect(() => {
    if (!draft.src) return;
    let annule = false;
    void probeImageSize(draft.src)
      .then((naturelle) => {
        if (annule) return;
        ratioRef.current = {
          widthPt: pxToPt(naturelle.widthPx),
          heightPt: pxToPt(naturelle.heightPx),
        };
      })
      .catch(() => {
        /* ratio left at that of the frame: better than nothing */
      });
    return () => {
      annule = true;
    };
  }, [draft.src]);

  const onFichier = useCallback(
    async (fichier: File) => {
      setChargement(true);
      setErreur(null);
      try {
        if (fichier.size > MAX_IMAGE_BYTES) {
          throw new Error(
            `Image trop lourde (${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} Mo maximum).`,
          );
        }
        const dataUrl = await readFileAsDataUrl(fichier);
        setUrlField('');
        await adopterSource(dataUrl);
      } catch (error) {
        setErreur((error as Error).message);
        setChargement(false);
      }
    },
    [adopterSource],
  );

  const changerLargeur = (valeurMm: number): void => {
    const largeur = clampSize(mmToPt(valeurMm));
    setWidthPt(largeur);
    if (keepRatio) setHeightPt(heightForWidth(largeur, ratioRef.current));
  };

  const changerHauteur = (valeurMm: number): void => {
    const hauteur = clampSize(mmToPt(valeurMm));
    setHeightPt(hauteur);
    if (keepRatio) setWidthPt(widthForHeight(hauteur, ratioRef.current));
  };

  const retablirProportions = (): void => {
    setHeightPt(heightForWidth(widthPt, ratioRef.current));
  };

  const ajusterALaLargeur = (): void => {
    setWidthPt(clampSize(contentWidthPt));
    setHeightPt(heightForWidth(contentWidthPt, ratioRef.current));
  };

  /* ------------------------------------------------------------- cropping */

  const entrerDansLeRognage = (): void => {
    if (!src) return;
    // We start again from a full frame: it designates all of what is **currently visible**, which the preview already shows.
    setCadreEnCours(NO_CROP);
  };

  /**
   * Validates the drawn frame.
   *
   * Two things at once: the crop composes with the one already applied, and the frame **shrinks by as much**. Without this second point, the kept part would be stretched to fill the old size: the image
   * would look distorted although we only cut. This is the "keep the scale" behavior of `SvxGrfCropPage`.
   */
  const appliquerLeRognage = (): void => {
    if (!cadreEnCours) return;
    const reste = visibleFraction(cadreEnCours);
    setCropApplique(composeCrop(cropApplique, cadreEnCours));
    setWidthPt(clampSize(widthPt * reste.width));
    setHeightPt(clampSize(heightPt * reste.height));
    setCadreEnCours(null);
  };

  const annulerLeRognage = (): void => setCadreEnCours(null);

  /** Restores the whole image and gives the frame the matching size back. */
  const retirerLeRognage = (): void => {
    const reste = visibleFraction(cropApplique);
    setWidthPt(clampSize(widthPt / reste.width));
    setHeightPt(clampSize(heightPt / reste.height));
    setCropApplique(NO_CROP);
    setCadreEnCours(null);
  };

  /**
   * Style of the preview outside crop mode: the frame hides what is cut away, exactly as the page will.
   */
  const apercuRogne = hasCrop(cropApplique)
    ? cropGeometry(cropApplique, 100, 100)
    : null;

  /**
   * Left/right arrows between the tabs, `Home` and `End` at the ends.
   *
   * It is ARIA's "tabs" pattern: only one tab can be reached with Tab, the others are traversed with the arrows. Without it, crossing the dialog with the keyboard takes as many Tab presses as there are
   * tabs before reaching the first field.
   */
  const naviguerOnglets = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const pas =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let index = ONGLETS.findIndex((onglet) => onglet.id === ongletActif);

    if (pas !== 0) index = (index + pas + ONGLETS.length) % ONGLETS.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = ONGLETS.length - 1;
    else return;

    event.preventDefault();
    const suivant = ONGLETS[index]!.id;
    setOngletActif(suivant);
    // Focus follows the selection: it is what a screen reader expects, and without it the next arrows would start again from the abandoned tab.
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>(`#onglet-${suivant}`)
      ?.focus();
  };

  const valide = useMemo(() => src.length > 0 && isSafeImageSrc(src) && !chargement, [src, chargement]);

  const valider = (): void => {
    if (!valide) return;
    onSubmit({
      ...(draft.blockId !== undefined ? { blockId: draft.blockId } : {}),
      ...(draft.offset !== undefined ? { offset: draft.offset } : {}),
      src,
      widthPt: clampSize(widthPt),
      heightPt: clampSize(heightPt),
      alt: alt.trim(),
      ...(hasCrop(cropApplique) ? { crop: cropApplique } : {}),
      marginPt,
      captionGapPt,
      wrap,
      // The position settings only leave the window with a mode that reads them: attaching them to "Align" would write into the run a floating geometry that nothing would read, and that would come back out at the
      // next wrapping.
      ...(wrap === 'inline'
        ? {}
        : { horiOrient, horiRelation, xPt, yPt, wrapMarginPt }),
      // Caption turned off, or empty in manual mode: we do not keep it, rather than reserve height for nothing.
      ...(captionOn && (captionAuto || captionText.trim().length > 0)
        ? {
            caption: {
              text: captionText,
              position: captionPosition,
              align: captionAlign,
              manual: !captionAuto,
            },
          }
        : {}),
    });
  };

  return (
    <Modal
      title={isEdit ? "Modifier l'image" : 'Insérer une image'}
      onClose={onCancel}
      /*
       * Wider than before, and flexible.
       *
       * At 700 px, the five wrapping modes and the three position fields did not fit: the content was cut off on the right and a horizontal scrollbar was needed to reach "In front of the text". The window now
       * scales itself down to what the screen offers, and becomes full screen on mobile.
       */
      width={960}
      footer={
        <>
          {onDelete && (
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Supprimer l’image
            </button>
          )}
          <span className="image-dialog__spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
          <button type="button" className="btn btn--primary" disabled={!valide} onClick={valider}>
            {isEdit ? 'Appliquer' : 'Insérer'}
          </button>
        </>
      }
    >
      <div className="image-dialog">
        {!isEdit && (
          <div className="image-dialog__sources">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => fichierRef.current?.click()}
            >
              Choisir un fichier…
            </button>
            <span className="image-dialog__ou">ou</span>
            <label className="image-dialog__url">
              <span className="field__label">Adresse de l’image</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://exemple.fr/logo.png"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                onBlur={() => {
                  const valeur = urlField.trim();
                  if (valeur && valeur !== src) void adopterSource(valeur);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  const valeur = urlField.trim();
                  if (valeur) void adopterSource(valeur);
                }}
              />
            </label>
            <input
              ref={fichierRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              hidden
              onChange={(event) => {
                const fichier = event.target.files?.[0];
                if (fichier) void onFichier(fichier);
                event.target.value = '';
              }}
            />
          </div>
        )}

        {erreur && (
          <p className="image-dialog__erreur" role="alert">
            {erreur}
          </p>
        )}

        <div className="image-dialog__corps">
          <div className="image-dialog__colonne-apercu">
            {cadreEnCours ? (
              <ImageCropper
                src={src}
                alt={alt}
                value={cadreEnCours}
                onChange={setCadreEnCours}
              />
            ) : (
              <div
                className={src ? 'image-dialog__apercu image-dialog__apercu--cliquable' : 'image-dialog__apercu'}
                // Double click on the preview: it is Writer's gesture, and the one a user expects from a spreadsheet or a photo editor.
                onDoubleClick={entrerDansLeRognage}
                title={src ? 'Double-cliquer pour rogner l’image' : undefined}
              >
                {src ? (
                  // The frame shows the image as it will be on the page: cropped. Showing the original here would force people to imagine the result instead of seeing it.
                  <span className="image-dialog__cadre">
                    <img
                      src={src}
                      alt={alt || 'Aperçu de l’image'}
                      draggable={false}
                      style={
                        apercuRogne
                          ? {
                              position: 'absolute',
                              left: `${apercuRogne.offsetXPx}%`,
                              top: `${apercuRogne.offsetYPx}%`,
                              width: `${apercuRogne.widthPx}%`,
                              height: `${apercuRogne.heightPx}%`,
                              maxWidth: 'none',
                              maxHeight: 'none',
                            }
                          : undefined
                      }
                    />
                  </span>
                ) : (
                  <p className="image-dialog__vide">
                    Choisissez un fichier ou saisissez une adresse pour voir l’aperçu.
                  </p>
                )}
              </div>
            )}

            {src && (
              <div className="image-dialog__rognage">
                {cadreEnCours ? (
                  <>
                    <span className="image-dialog__consigne">
                      Tirez les poignées, ou déplacez le cadre. Les flèches du clavier
                      fonctionnent aussi.
                    </span>
                    <button type="button" className="btn" onClick={annulerLeRognage}>
                      Annuler
                    </button>
                    <button type="button" className="btn btn--primary" onClick={appliquerLeRognage}>
                      Rogner
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn" onClick={entrerDansLeRognage}>
                      Rogner l’image…
                    </button>
                    {hasCrop(cropApplique) && (
                      <button type="button" className="btn btn--ghost" onClick={retirerLeRognage}>
                        Rétablir l’image entière
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Three tabs, like the pages of `SwFrmDlg` (Type, Wrap, Options).  The form has about twenty settings. All laid out flat, they were worth the same: nothing said what concerned the image, its place or its caption, and the eye had to reread each label to find the one it was looking for. Three pages of six fields can be taken in at a glance.  The preview, for its part, does not move: it is the subject of all the pages, and seeing it change while you adjust is half the point of a dialog. */}
          <div className="image-dialog__panneaux">
            <div className="image-dialog__onglets" role="tablist" aria-label="Réglages de l’image">
              {ONGLETS.map((onglet) => (
                <button
                  key={onglet.id}
                  type="button"
                  role="tab"
                  id={`onglet-${onglet.id}`}
                  aria-selected={onglet.id === ongletActif}
                  aria-controls={`panneau-${onglet.id}`}
                  // Only one tab can be reached with Tab: the others are traversed with the arrows, ARIA's "tabs" pattern.
                  tabIndex={onglet.id === ongletActif ? 0 : -1}
                  className={
                    onglet.id === ongletActif
                      ? 'image-dialog__onglet image-dialog__onglet--actif'
                      : 'image-dialog__onglet'
                  }
                  onClick={() => setOngletActif(onglet.id)}
                  onKeyDown={naviguerOnglets}
                >
                  {onglet.label}
                </button>
              ))}
            </div>

            <div
              className="image-dialog__panneau"
              role="tabpanel"
              id={`panneau-${ongletActif}`}
              aria-labelledby={`onglet-${ongletActif}`}
              tabIndex={0}
            >
              {ongletActif === 'image' && (
                <>
              <div className="image-dialog__dimensions">
                <label className="field">
                  <span className="field__label">Largeur (mm)</span>
                  <input
                    type="number"
                    min={1}
                    step={0.5}
                    value={showMm(widthPt)}
                    onChange={(event) => changerLargeur(Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Hauteur (mm)</span>
                  <input
                    type="number"
                    min={1}
                    step={0.5}
                    value={showMm(heightPt)}
                    onChange={(event) => changerHauteur(Number(event.target.value))}
                  />
                </label>
              </div>

              <div className="image-dialog__row">
                <label className="field">
                  <span className="field__label">Marge autour (mm)</span>
                  <input
                    type="number"
                    min={0}
                    max={Math.round(ptToMm(MAX_IMAGE_MARGIN_PT))}
                    step={0.5}
                    value={showMm(marginPt)}
                    onChange={(event) =>
                      setMarginPt(
                        Math.min(
                          MAX_IMAGE_MARGIN_PT,
                          Math.max(0, mmToPt(Number(event.target.value) || 0)),
                        ),
                      )
                    }
                  />
                </label>
                {/* The gap before the caption has joined the "Title / caption" panel: it only means something with a caption, and leaving it here forced people to set one thing in two places. */}
                <label className="image-dialog__ratio">
                  <input
                    type="checkbox"
                    checked={keepRatio}
                    onChange={(event) => setKeepRatio(event.target.checked)}
                  />
                  <span>Conserver les proportions</span>
                </label>
              </div>

              <div className="image-dialog__raccourcis">
                <button type="button" className="btn" onClick={ajusterALaLargeur}>
                  Pleine largeur
                </button>
                <button type="button" className="btn" onClick={retablirProportions}>
                  Rétablir les proportions
                </button>
              </div>


              <label className="field">
                <span className="field__label">
                  Texte alternatif — lu à voix haute par les lecteurs d’écran
                </span>
                <input
                  type="text"
                  value={alt}
                  maxLength={300}
                  placeholder="Ce que montre l’image, en une phrase"
                  onChange={(event) => setAlt(event.target.value)}
                />
              </label>
                </>
              )}

              {ongletActif === 'position' && (
                <>
              {/* -- Fitting into the text (`SwFmtSurround`) ------------------- */}
              <fieldset className="image-dialog__wrap">
                <legend className="field__label">Intégration au texte</legend>

                <ImageWrapPicker value={wrap} onChange={setWrap} variant="inline" />

                <p className="image-dialog__wrap-hint" aria-live="polite">
                  {IMAGE_WRAP_MODES.find((entry) => entry.mode === wrap)?.hint}
                </p>

                {/* Position and wrapping margin only mean something once the image is out of the flow. We remove them instead of greying them out: an inert setting takes the same room and reads like a malfunction. */}
                {wrap !== 'inline' && (
                  <>
                    <div className="image-dialog__row">
                      <label className="field">
                        <span className="field__label">Alignement horizontal</span>
                        <select
                          value={horiOrient}
                          onChange={(event) =>
                            setHoriOrient(event.target.value as FlyHoriOrient)
                          }
                        >
                          <option value="left">À gauche</option>
                          <option value="center">Au centre</option>
                          <option value="right">À droite</option>
                          <option value="from-left">Position libre</option>
                        </select>
                      </label>

                      <label className="field">
                        <span className="field__label">Mesuré par rapport à</span>
                        <select
                          value={horiRelation}
                          onChange={(event) =>
                            setHoriRelation(event.target.value as FlyHoriRelation)
                          }
                        >
                          <option value="text">La colonne de texte</option>
                          <option value="page">La feuille entière</option>
                        </select>
                      </label>
                    </div>

                    <div className="image-dialog__row">
                      {/* The x coordinate only appears in free position: it is the only mode that reads it (`HoriOrientation::NONE`), and leaving it visible elsewhere would suggest it can be set there. */}
                      {horiOrient === 'from-left' && (
                        <label className="field">
                          <span className="field__label">Décalage horizontal (mm)</span>
                          <input
                            type="number"
                            step={0.5}
                            value={showMm(xPt)}
                            onChange={(event) => setXPt(mmToPt(Number(event.target.value) || 0))}
                          />
                        </label>
                      )}

                      <label className="field">
                        <span className="field__label">Décalage vertical (mm)</span>
                        <input
                          type="number"
                          step={0.5}
                          value={showMm(yPt)}
                          onChange={(event) => setYPt(mmToPt(Number(event.target.value) || 0))}
                        />
                      </label>

                      {/* The wrapping margin only pushes the text away if there is text to push: "behind" and "in front of" go through it. */}
                      {(wrap === 'wrap' || wrap === 'break') && (
                        <label className="field">
                          <span className="field__label">Écart au texte (mm)</span>
                          <input
                            type="number"
                            min={0}
                            max={Math.round(ptToMm(MAX_IMAGE_MARGIN_PT))}
                            step={0.5}
                            value={showMm(wrapMarginPt)}
                            onChange={(event) =>
                              setWrapMarginPt(
                                Math.min(
                                  MAX_IMAGE_MARGIN_PT,
                                  Math.max(0, mmToPt(Number(event.target.value) || 0)),
                                ),
                              )
                            }
                          />
                        </label>
                      )}
                    </div>
                  </>
                )}
              </fieldset>
                </>
              )}

              {ongletActif === 'legende' && (
                <>
              {/* -- Caption -------------------------------------------------- */}
              <fieldset className="image-dialog__legend">
                <legend className="field__label">Titre / légende</legend>

                <label className="image-dialog__switch">
                  <input
                    type="checkbox"
                    checked={captionOn}
                    onChange={(event) => setCaptionOn(event.target.checked)}
                  />
                  <span>
                    Afficher une légende
                    <small>
                      {captionOn
                        ? 'Un texte sous ou sur l’image, compté dans la hauteur du cadre.'
                        : 'L’image est posée seule, sans texte ni numéro de figure.'}
                    </small>
                  </span>
                </label>

                {/* The rest of the panel disappears when the caption is turned off, instead of being greyed out: five inert settings take the same room and read like a malfunction. */}
                {captionOn && (
                  <>
                    <input
                      type="text"
                      value={captionText}
                      maxLength={300}
                      placeholder="Mon titre"
                      aria-label="Titre ou légende de l’image"
                      onChange={(event) => setCaptionText(event.target.value)}
                    />

                    <label className="image-dialog__switch">
                      <input
                        type="checkbox"
                        checked={captionAuto}
                        onChange={(event) => setCaptionAuto(event.target.checked)}
                      />
                      <span>
                        Numérotation automatique
                        <small>
                          {captionAuto
                            ? 'Le numéro est calculé d’après l’ordre du document et se met à jour tout seul.'
                            : 'Le texte est affiché tel quel, sans numéro.'}
                        </small>
                      </span>
                    </label>

                    {/* Preview of the exact rendering, number included: it is the only way to make the "automatic / manual" choice obvious without closing the window to see its effect. */}
                    <p className="image-dialog__preview" aria-live="polite">
                      <span className="image-dialog__preview-label">Aperçu</span>
                      <span
                        className={`image-dialog__preview-text image-dialog__preview-text--${captionAlign}`}
                      >
                        {formatCaption(
                          {
                            text: captionText,
                            position: captionPosition,
                            align: captionAlign,
                            manual: !captionAuto,
                          },
                          captionAuto ? (draft.figureNumber ?? 1) : null,
                        ) || <em>aucune légende</em>}
                      </span>
                    </p>

                    <div className="image-dialog__row">
                      <label className="field">
                        <span className="field__label">Position du titre</span>
                        <select
                          value={captionPosition}
                          onChange={(event) =>
                            setCaptionPosition(event.target.value as 'above' | 'below')
                          }
                        >
                          <option value="above">En haut de l’image</option>
                          <option value="below">En bas de l’image</option>
                        </select>
                      </label>

                      <label className="field">
                        <span className="field__label">Alignement du titre</span>
                        <select
                          value={captionAlign}
                          onChange={(event) =>
                            setCaptionAlign(event.target.value as 'left' | 'center' | 'right')
                          }
                        >
                          <option value="left">À gauche</option>
                          <option value="center">Au centre</option>
                          <option value="right">À droite</option>
                        </select>
                      </label>
                    </div>

                    <label className="field">
                      <span className="field__label">Espace avant la légende (mm)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.round(ptToMm(MAX_IMAGE_MARGIN_PT))}
                        step={0.5}
                        value={showMm(captionGapPt)}
                        onChange={(event) =>
                          setCaptionGapPt(
                            Math.min(
                              MAX_IMAGE_MARGIN_PT,
                              Math.max(0, mmToPt(Number(event.target.value) || 0)),
                            ),
                          )
                        }
                      />
                    </label>
                  </>
                )}
              </fieldset>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
