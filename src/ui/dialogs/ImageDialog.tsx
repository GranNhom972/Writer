/**
 * Atelier d'insertion et de retouche d'image.
 *
 * Équivalent du dialogue « Insertion ▸ Image » de Writer
 * (`sw/source/ui/dialog/`, onglets Type et Options de `SwFrmDlg`) réduit à ce
 * que porte l'ancrage « comme caractère » : la source, les dimensions et le
 * texte alternatif.
 *
 * Trois décisions d'ergonomie :
 *
 *  - **le rapport est verrouillé par défaut.** Déformer une image est presque
 *    toujours un accident ; le faire exprès reste possible, en décochant ;
 *  - **les dimensions sont en millimètres**, comme les marges et la règle. Les
 *    points sont l'unité interne du modèle, pas celle du papier ;
 *  - **un fichier local devient une `data:` immédiatement.** Le document reste
 *    complet hors ligne ; c'est le partage, ensuite, qui dépose les octets sur
 *    le serveur et remplace l'adresse.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Modal } from '../../design/components/Modal';
import {
  ACCEPTED_IMAGE_TYPES,
  clampSize,
  composeCrop,
  cropGeometry,
  fitToContentWidth,
  hasCrop,
  heightForWidth,
  isSafeImageSrc,
  visibleFraction,
  widthForHeight,
  MAX_IMAGE_BYTES,
  NO_CROP,
  type ImageCrop,
} from '../../domain/document/images';
import { ImageCropper } from './ImageCropper';
import { probeImageSize, readFileAsDataUrl } from '../../domain/image/raster';
import { pxToPt } from '../../domain/document/units';

const PT_PER_MM = 72 / 25.4;

function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
}

function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

/** Arrondi d'affichage : le dixième de millimètre, la précision d'une règle. */
function showMm(pt: number): string {
  return (Math.round(ptToMm(pt) * 10) / 10).toString();
}

export interface ImageDraft {
  /** Présent en retouche, absent à l'insertion. */
  blockId?: string;
  /** Offset du cadre dans le paragraphe, en retouche. */
  offset?: number;
  src: string;
  widthPt: number;
  heightPt: number;
  alt: string;
  /** Rognage déjà appliqué, dans le repère de l'image d'origine. */
  crop?: ImageCrop;
}

export interface ImageDialogProps {
  draft: ImageDraft;
  /** Largeur de la zone imprimable, en points : plafond d'insertion. */
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
  const [keepRatio, setKeepRatio] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);

  /**
   * Rognage **déjà appliqué**, dans le repère de l'image d'origine.
   *
   * Distinct du cadre en cours de tracé : celui-ci s'exprime dans le repère de
   * ce que l'aperçu montre, donc de l'image déjà rognée. Les confondre ferait
   * couper au second geste bien plus que ce qui a été désigné.
   */
  const [cropApplique, setCropApplique] = useState<ImageCrop>(draft.crop ?? NO_CROP);
  /** Cadre en cours de tracé ; `null` hors du mode rognage. */
  const [cadreEnCours, setCadreEnCours] = useState<ImageCrop | null>(null);

  /**
   * Rapport de référence.
   *
   * Il est figé à la dernière **source** connue, jamais aux dimensions
   * courantes : sans cela, chaque arrondi d'affichage se reporterait dans le
   * rapport et l'image dériverait à force de retouches.
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
        // Le rognage désigne une région de **cette** image : changer d'image le
        // laisserait pointer une région qui n'existe plus.
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

  // En retouche, on relit la taille naturelle pour connaître le rapport d'origine :
  // le cadre a pu être déformé, et « rétablir les proportions » doit repartir de
  // l'image, pas de ce que valait le cadre.
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
        /* rapport laissé à celui du cadre : mieux que rien */
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

  /* ------------------------------------------------------------- rognage */

  const entrerDansLeRognage = (): void => {
    if (!src) return;
    // On repart d'un cadre plein : il désigne l'intégralité de ce qui est
    // **actuellement visible**, ce que l'aperçu montre déjà.
    setCadreEnCours(NO_CROP);
  };

  /**
   * Valide le cadre tracé.
   *
   * Deux choses en même temps : le rognage se compose avec celui déjà appliqué,
   * et le cadre **rétrécit d'autant**. Sans ce second point, la partie conservée
   * serait étirée pour remplir l'ancienne taille — l'image paraîtrait déformée
   * alors qu'on n'a fait que couper. C'est le comportement « conserver
   * l'échelle » de `SvxGrfCropPage`.
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

  /** Rétablit l'image entière et rend au cadre la taille correspondante. */
  const retirerLeRognage = (): void => {
    const reste = visibleFraction(cropApplique);
    setWidthPt(clampSize(widthPt / reste.width));
    setHeightPt(clampSize(heightPt / reste.height));
    setCropApplique(NO_CROP);
    setCadreEnCours(null);
  };

  /**
   * Style de l'aperçu hors mode rognage : le cadre masque ce qui est retranché,
   * exactement comme le fera la page.
   */
  const apercuRogne = hasCrop(cropApplique)
    ? cropGeometry(cropApplique, 100, 100)
    : null;

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
    });
  };

  return (
    <Modal title={isEdit ? "Modifier l'image" : 'Insérer une image'} onClose={onCancel} width={700}>
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
                // Double-clic sur l'aperçu : c'est le geste de Writer, et celui
                // qu'attend l'usager d'un tableur ou d'un logiciel de photo.
                onDoubleClick={entrerDansLeRognage}
                title={src ? 'Double-cliquer pour rogner l’image' : undefined}
              >
                {src ? (
                  // Le cadre montre l'image telle qu'elle sera sur la page :
                  // rognée. Montrer l'original ici obligerait à imaginer le
                  // résultat au lieu de le voir.
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

          <div className="image-dialog__reglages">
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

            <label className="image-dialog__ratio">
              <input
                type="checkbox"
                checked={keepRatio}
                onChange={(event) => setKeepRatio(event.target.checked)}
              />
              <span>Conserver les proportions</span>
            </label>

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
          </div>
        </div>

        <footer className="image-dialog__actions">
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
        </footer>
      </div>
    </Modal>
  );
}
