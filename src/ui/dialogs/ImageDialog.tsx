/**
 * Atelier d'insertion et de retouche d'image.
 *
 * Équivalent du dialogue « Insertion ▸ Image » de Writer
 * (`sw/source/ui/dialog/`, onglets Type, Adaptation du texte et Options de
 * `SwFrmDlg`) : la source, les dimensions, le texte alternatif, la légende et
 * l'intégration au texte — habillage, alignement et calque.
 *
 * Quatre décisions d'ergonomie :
 *
 *  - **le rapport est verrouillé par défaut.** Déformer une image est presque
 *    toujours un accident ; le faire exprès reste possible, en décochant ;
 *  - **les dimensions sont en millimètres**, comme les marges et la règle. Les
 *    points sont l'unité interne du modèle, pas celle du papier ;
 *  - **un fichier local devient une `data:` immédiatement.** Le document reste
 *    complet hors ligne ; c'est le partage, ensuite, qui dépose les octets sur
 *    le serveur et remplace l'adresse ;
 *  - **les réglages de position ne paraissent qu'une fois l'image sortie du
 *    fil du texte.** Writer les grise dans le même cas : une abscisse n'a pas
 *    de sens pour un cadre dont le formateur décide de la place, et la montrer
 *    quand même invite à la régler pour rien.
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
// Les deux conversions vivaient ici en double, reconstruites autour d'un
// `72 / 25.4` local. Une définition unique, partagée avec le moteur et l'export.
import { mmToPt, ptToMm, pxToPt } from '../../domain/document/units';

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
  /** Réglages de légende. Absent = pas de légende. */
  caption?: ImageCaption;
  /** Numéro qu'aurait cette figure — pour l'aperçu seul, jamais enregistré. */
  figureNumber?: number;
  /** Marge autour du cadre, en points. */
  marginPt?: number;
  /** Blanc entre l'image et sa légende, en points. */
  captionGapPt?: number;

  /* -- Intégration au texte (`SwFmtSurround`, `SwFmtHoriOrient`) ---------- */

  /** Comment l'image s'intègre au texte. Absent = dans le fil (`FLY_AS_CHAR`). */
  wrap?: ImageWrapMode;
  /** Alignement horizontal d'un cadre flottant. */
  horiOrient?: FlyHoriOrient;
  /** Repère de cet alignement : la colonne de texte ou la feuille. */
  horiRelation?: FlyHoriRelation;
  /** Décalage horizontal, en points — consulté par le seul `from-left`. */
  xPt?: number;
  /** Décalage vertical depuis le haut de l'ancre, en points. */
  yPt?: number;
  /** Marge d'habillage : le blanc que le texte laisse autour du cadre. */
  wrapMarginPt?: number;
}

/**
 * Les trois pages du dialogue.
 *
 * Le découpage est celui des onglets de `SwFrmDlg` : ce que l'image **est**,
 * où elle **se pose**, ce qu'on **écrit dessous**. Chaque page répond à une
 * question, et l'on sait donc toujours laquelle ouvrir.
 */
const ONGLETS = [
  { id: 'image', label: 'Image' },
  { id: 'position', label: 'Position' },
  { id: 'legende', label: 'Légende' },
] as const;

type OngletId = (typeof ONGLETS)[number]['id'];

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

  /*
   * Légende. La numérotation automatique est le mode par défaut : c'est celui
   * qui produit « Figure n°1 : … » sans que l'utilisateur ait rien à régler.
   */
  const [captionText, setCaptionText] = useState(draft.caption?.text ?? '');
  const [captionPosition, setCaptionPosition] = useState<'above' | 'below'>(
    draft.caption?.position ?? 'below',
  );
  const [captionAlign, setCaptionAlign] = useState<'left' | 'center' | 'right'>(
    draft.caption?.align ?? 'center',
  );
  /*
   * Une image a-t-elle une légende du tout ?
   *
   * Cet interrupteur manquait, et son absence se voyait : la numérotation
   * automatique étant le défaut, toute image passée par cette fenêtre
   * ressortait légendée « Figure n°1 », sans moyen de le refuser autrement
   * qu'en devinant qu'il fallait décocher la numérotation **et** vider le
   * texte. Une image déposée par glisser-lâcher, elle, n'avait pas de légende :
   * les deux chemins d'insertion ne donnaient donc pas le même résultat.
   *
   * Le défaut est désormais celui du document ouvert — légende s'il y en avait
   * une, aucune pour une image neuve — et le choix est explicite.
   */
  const [captionOn, setCaptionOn] = useState(draft.caption !== undefined);
  const [captionAuto, setCaptionAuto] = useState(draft.caption ? !draft.caption.manual : true);
  const [marginPt, setMarginPt] = useState(draft.marginPt ?? 0);

  /*
   * Intégration au texte. Les quatre réglages de position ne servent qu'aux
   * modes flottants ; ils restent néanmoins en état, pour qu'un aller-retour
   * par « Aligner » ne les efface pas sous les doigts de l'utilisateur.
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

  /**
   * Flèches gauche/droite entre les onglets, `Début` et `Fin` aux extrémités.
   *
   * C'est le motif « tabs » d'ARIA : un seul onglet est atteignable à la
   * tabulation, les autres se parcourent aux flèches. Sans cela, traverser le
   * dialogue au clavier demande autant de tabulations qu'il y a d'onglets avant
   * d'atteindre le premier champ.
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
    // Le focus suit la sélection : c'est ce qu'attend un lecteur d'écran, et
    // sans cela les flèches suivantes repartiraient de l'onglet abandonné.
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
      // Les réglages de position ne quittent la fenêtre qu'avec un mode qui les
      // consulte : les joindre à « Aligner » écrirait dans le run une géométrie
      // flottante que rien ne lirait, et qui ressortirait au prochain habillage.
      ...(wrap === 'inline'
        ? {}
        : { horiOrient, horiRelation, xPt, yPt, wrapMarginPt }),
      // Légende éteinte, ou vide en mode manuel : on ne la garde pas, plutôt
      // que de réserver de la hauteur pour rien.
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
       * Plus large qu'auparavant, et souple.
       *
       * À 700 px, les cinq modes d'habillage et les trois champs de position ne
       * tenaient pas : le contenu se coupait à droite et il fallait un ascenseur
       * horizontal pour atteindre « Devant le texte ». La fenêtre se ramène
       * d'elle-même à ce que l'écran offre, et devient plein écran sur mobile.
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

          {/*
            Trois onglets, comme les pages de `SwFrmDlg` (Type, Adaptation du
            texte, Options).

            Le formulaire compte une vingtaine de réglages. Tous à plat, ils se
            valaient : rien ne disait ce qui touchait à l'image, à sa place ou à
            sa légende, et l'œil devait relire chaque libellé pour retrouver
            celui qu'il cherchait. Trois pages de six champs se parcourent d'un
            coup d'œil.

            L'aperçu, lui, ne bouge pas : il est le sujet de toutes les pages,
            et le voir changer pendant qu'on règle est la moitié de l'intérêt
            d'un dialogue.
          */}
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
                  // Un seul onglet est atteignable à la tabulation : les autres
                  // se parcourent aux flèches, motif « tabs » d'ARIA.
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
                {/*
                  Le blanc avant la légende a rejoint le panneau « Titre /
                  légende » : il n'a de sens qu'avec une légende, et le laisser
                  ici obligeait à régler à deux endroits une même chose.
                */}
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
              {/* -- Intégration au texte (`SwFmtSurround`) -------------------- */}
              <fieldset className="image-dialog__wrap">
                <legend className="field__label">Intégration au texte</legend>

                <ImageWrapPicker value={wrap} onChange={setWrap} variant="inline" />

                <p className="image-dialog__wrap-hint" aria-live="polite">
                  {IMAGE_WRAP_MODES.find((entry) => entry.mode === wrap)?.hint}
                </p>

                {/*
                  Position et marge d'habillage n'ont de sens qu'une fois l'image
                  sortie du fil. On les retire au lieu de les griser : un réglage
                  inerte occupe la même place et se lit comme une panne.
                */}
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
                      {/*
                        L'abscisse ne paraît qu'en position libre : c'est le seul
                        mode qui la consulte (`HoriOrientation::NONE`), et la
                        laisser visible ailleurs ferait croire qu'on l'y règle.
                      */}
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

                      {/*
                        La marge d'habillage n'écarte le texte que s'il y a un
                        texte à écarter : « derrière » et « devant » le traversent.
                      */}
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
              {/* -- Légende -------------------------------------------------- */}
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

                {/*
                  Le reste du panneau disparaît quand la légende est éteinte, au
                  lieu d'être grisé : cinq réglages inertes occupent la même place
                  et se lisent comme une panne.
                */}
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

                    {/*
                      Aperçu du rendu exact, numéro compris : c'est la seule façon
                      de rendre le choix « automatique / manuel » évident sans
                      fermer la fenêtre pour en constater l'effet.
                    */}
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
