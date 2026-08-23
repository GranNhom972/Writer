/**
 * Atelier d'une bande : l'aperçu **est** la surface de travail.
 *
 * Trois partis pris répondent à ce qui rendait l'édition pénible :
 *
 *  1. **La bande n'est plus montrée seule.** On voit la tranche de feuille qui
 *     la porte — bord du papier, marges, et un fantôme des premières lignes du
 *     corps. Une bande de 20 mm flottant dans le vide ne dit pas si le logo
 *     tombera sur le texte ; la tranche de feuille, si.
 *  2. **Le zoom est un réglage, pas une fatalité.** La bande faisait 75 pixels
 *     de haut : y poser une image au millimètre relevait de l'orfèvrerie.
 *  3. **L'inspecteur est une colonne fixe.** Il occupait la place sous la
 *     surface et n'apparaissait qu'à la sélection : tout le dialogue sautait à
 *     chaque clic, et les réglages passaient hors écran.
 *
 * Les images ne sont pas encodées dans le document. Elles sont déposées sur le
 * serveur, qui vérifie leur format en lisant leurs octets, et seule leur adresse
 * rejoint les métadonnées répliquées.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type MutableRefObject,
} from 'react';
import { ApiError, uploadAsset } from '../collab/api';
import {
  blocksOf,
  createBlock,
  FURNITURE_LIMITS,
  FURNITURE_PRESETS,
  FURNITURE_TOKENS,
  isSafeImageSrc,
  lineHeightMm,
  MAX_BLOCK_TEXT_LENGTH,
  MAX_BLOCKS_PER_BAND,
  MAX_FURNITURE_LENGTH,
  PAGE_NUMBER_FORMATS,
  type FurnitureAlign,
  type FurnitureBand,
  type FurnitureBlock,
  type FurnitureContext,
  type PageFurniture,
} from '../document/pageFurniture';
import { FurnitureBandView, type BlockMetrics, type GestureReadout } from './FurnitureBand';
import { Button } from '../design/components/Button';
import { Mesure } from './Mesure';

const PX_PAR_MM = 96 / 25.4;

/** Hauteur minimale de la surface : une bande vide reste une cible visible. */
const HAUTEUR_MINIMALE_MM = 14;

/** Largeur donnée à une image déposée, avant respect de ses proportions. */
const LARGEUR_IMAGE_MM = 35;

/** Tranche de feuille montrée sous (ou sur) la bande, en millimètres. */
const CONTEXTE_FEUILLE_MM = 38;

/** Paliers de zoom offerts, « Ajuster » compris. */
const PALIERS_ZOOM = [0.5, 0.75, 1, 1.5, 2] as const;

const LIBELLES: Record<
  FurnitureBand,
  { titre: string; distance: string; ligne: string; exemple: string }
> = {
  header: {
    titre: 'En-tête',
    distance: 'Distance au bord haut',
    ligne: 'Ligne de l’en-tête',
    exemple: 'Ex. : {titre} — Direction générale',
  },
  footer: {
    titre: 'Pied de page',
    distance: 'Distance au bord bas',
    ligne: 'Ligne du pied',
    exemple: 'Ex. : Confidentiel — {date}',
  },
};

/**
 * Une modification du mobilier : soit les champs à écraser, soit une fonction
 * qui les calcule à partir de l'état courant. La seconde forme est indispensable
 * dès qu'une modification arrive en différé (chargement d'image, glissement).
 */
export type MajFurniture =
  | Partial<PageFurniture>
  | ((precedent: PageFurniture) => Partial<PageFurniture>);

/**
 * Pilotage de l'annulation.
 *
 * L'historique appartient au dialogue, pas à l'atelier : il doit survivre au
 * passage d'un onglet à l'autre et couvrir aussi la ligne de base, les marges
 * et le retrait d'une bande — pas seulement les blocs.
 */
export interface PiloteHistorique {
  annuler: () => void;
  retablir: () => void;
  peutAnnuler: boolean;
  peutRetablir: boolean;
  /** Ferme le geste en cours : la prochaine modification ouvrira un nouveau pas. */
  cloreGeste: () => void;
}

type Calage = 'gauche' | 'centre' | 'droite' | 'haut' | 'milieu' | 'bas';

interface FurnitureBandEditorProps {
  band: FurnitureBand;
  furniture: PageFurniture;
  contexte: FurnitureContext;
  /** Largeur utile de la bande, en millimètres. */
  usableMm: number;
  /** Hauteur du contenu de la bande, en millimètres. */
  heightMm: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /**
   * Applique une modification. `fusion` regroupe les modifications successives
   * portant la même étiquette en un seul pas d'annulation — sans quoi un
   * glissement laisse une centaine de pas d'un pixel.
   */
  onChange: (maj: MajFurniture, fusion?: string) => void;
  historique: PiloteHistorique;
  /** Document serveur, ou `null` en mode local : sans lui, pas de dépôt d'image. */
  docId: string | null;
  token: string;
}

/**
 * Échelle d'affichage de la feuille.
 *
 * La feuille fait 210 mm de large ; la colonne de travail en fait moins. On
 * mesure la place disponible pour proposer un « Ajuster » honnête, et
 * l'utilisateur reste libre de zoomer au-delà.
 */
function useEchelleAjustee(usableMm: number): {
  cadre: MutableRefObject<HTMLDivElement | null>;
  ajustee: number;
} {
  const cadre = useRef<HTMLDivElement | null>(null);
  const [ajustee, setAjustee] = useState(1);

  useEffect(() => {
    const element = cadre.current;
    if (!element) return;

    const mesurer = (): void => {
      const voulue = usableMm * PX_PAR_MM;
      const disponible = element.clientWidth;
      if (disponible <= 0 || voulue <= 0) return;
      const suivante = Math.min(1, Math.round(((disponible - 2) / voulue) * 1000) / 1000);

      // Zone morte. Redimensionner la feuille change la hauteur du dialogue, donc
      // la largeur dont on est reparti : sans seuil, la mesure se poursuit d'un
      // rendu à l'autre et React finit par couper la boucle.
      setAjustee((precedente) => (Math.abs(precedente - suivante) < 0.01 ? precedente : suivante));
    };

    mesurer();
    const observateur = new ResizeObserver(mesurer);
    observateur.observe(element);
    return () => observateur.disconnect();
  }, [usableMm]);

  return { cadre, ajustee };
}

/** Mesure affichée à la française, sans décimale inutile. */
function mm(valeur: number): string {
  return `${valeur.toFixed(1).replace('.0', '').replace('.', ',')} mm`;
}

export function FurnitureBandEditor({
  band,
  furniture,
  contexte,
  usableMm,
  heightMm,
  selectedId,
  onSelect,
  onChange,
  historique,
  docId,
  token,
}: FurnitureBandEditorProps) {
  const { cadre, ajustee } = useEchelleAjustee(usableMm);
  const fichierRef = useRef<HTMLInputElement | null>(null);
  const ligneRef = useRef<HTMLInputElement | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [adresseOuverte, setAdresseOuverte] = useState(false);
  const [adresse, setAdresse] = useState('');
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [zoomChoisi, setZoomChoisi] = useState<number | 'ajuster'>('ajuster');
  const [lecture, setLecture] = useState<GestureReadout | null>(null);
  const [mesures, setMesures] = useState<Record<string, BlockMetrics>>({});

  const [cropActiveId, setCropActiveId] = useState<string | null>(null);
  const [cropSnapshot, setCropSnapshot] = useState<FurnitureBlock | null>(null);

  const blocs = blocksOf(furniture, band);
  const pleine = blocs.length >= MAX_BLOCKS_PER_BAND;
  const selection = blocs.find((bloc) => bloc.id === selectedId) ?? null;
  const libelles = LIBELLES[band];
  const ligne = band === 'header' ? furniture.header : furniture.footer;
  const estHeader = band === 'header';

  const echelle = zoomChoisi === 'ajuster' ? ajustee : zoomChoisi;
  const bandeMm = Math.max(heightMm, HAUTEUR_MINIMALE_MM);
  const sceneMm = bandeMm + CONTEXTE_FEUILLE_MM;

  const modifierBloc = useCallback(
    (id: string, partiel: Partial<FurnitureBlock>, fusion?: string): void => {
      onChange(
        (precedent) => ({
          blocks: precedent.blocks.map((bloc) => (bloc.id === id ? { ...bloc, ...partiel } : bloc)),
        }),
        fusion,
      );
    },
    [onChange],
  );

  const supprimer = useCallback(
    (id: string): void => {
      onChange((precedent) => ({ blocks: precedent.blocks.filter((bloc) => bloc.id !== id) }));
      onSelect(null);
      if (cropActiveId === id) setCropActiveId(null);
    },
    [onChange, onSelect, cropActiveId],
  );

  const dupliquer = useCallback(
    (id: string): void => {
      if (pleine) {
        setErreur(`Pas plus de ${MAX_BLOCKS_PER_BAND} éléments par bande.`);
        return;
      }
      const source = blocs.find((b) => b.id === id);
      if (!source) return;
      const copie: FurnitureBlock = {
        ...source,
        id: createBlock(band, source.kind).id,
        x: Math.min(0.9, source.x + 0.03),
        y: Math.min(FURNITURE_LIMITS.blockYMm.max, source.y + 2),
      };
      setErreur(null);
      onChange((precedent) => ({ blocks: [...precedent.blocks, copie] }));
      onSelect(copie.id);
    },
    [blocs, band, onChange, onSelect, pleine],
  );

  /** Largeur et hauteur apparentes du bloc, mesurées sur le rendu. */
  const tailleDe = useCallback(
    (bloc: FurnitureBlock): BlockMetrics => {
      const mesuree = mesures[bloc.id];
      if (mesuree) return mesuree;
      // Repli avant la première mesure : exact pour une image, approché pour un texte.
      const cL = bloc.cropLeft ?? 0;
      const cR = bloc.cropRight ?? 0;
      const cT = bloc.cropTop ?? 0;
      const cB = bloc.cropBottom ?? 0;
      return bloc.kind === 'image'
        ? {
            widthMm: (bloc.widthMm * (100 - cL - cR)) / 100,
            heightMm: (bloc.heightMm * (100 - cT - cB)) / 100,
          }
        : { widthMm: bloc.widthMm, heightMm: lineHeightMm(bloc.fontSizePt) };
    },
    [mesures],
  );

  const caler = useCallback(
    (ou: Calage): void => {
      if (!selection) return;
      const taille = tailleDe(selection);
      const arrondiX = (valeur: number): number => Math.round(Math.max(0, valeur / usableMm) * 1000) / 1000;
      const arrondiY = (valeur: number): number => Math.max(0, Math.round(valeur * 10) / 10);

      switch (ou) {
        case 'gauche':
          return modifierBloc(selection.id, { x: arrondiX(furniture.marginLeftMm) });
        case 'centre':
          return modifierBloc(selection.id, { x: arrondiX((usableMm - taille.widthMm) / 2) });
        case 'droite':
          return modifierBloc(selection.id, {
            x: arrondiX(usableMm - furniture.marginRightMm - taille.widthMm),
          });
        case 'haut':
          return modifierBloc(selection.id, { y: 0 });
        case 'milieu':
          return modifierBloc(selection.id, { y: arrondiY((bandeMm - taille.heightMm) / 2) });
        default:
          return modifierBloc(selection.id, { y: arrondiY(bandeMm - taille.heightMm) });
      }
    },
    [
      bandeMm,
      furniture.marginLeftMm,
      furniture.marginRightMm,
      modifierBloc,
      selection,
      tailleDe,
      usableMm,
    ],
  );

  // Suppr efface l'élément sélectionné. L'annulation, elle, est tenue par le
  // dialogue : elle doit valoir pour les deux bandes et pour tous les réglages.
  useEffect(() => {
    const auClavierGlobal = (e: KeyboardEvent): void => {
      const cible = e.target as HTMLElement | null;
      const dansUnChamp =
        cible?.tagName === 'INPUT' || cible?.tagName === 'TEXTAREA' || cible?.isContentEditable;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !cropActiveId && !dansUnChamp) {
        e.preventDefault();
        supprimer(selectedId);
      }
    };
    window.addEventListener('keydown', auClavierGlobal);
    return () => window.removeEventListener('keydown', auClavierGlobal);
  }, [selectedId, cropActiveId, supprimer]);

  const basculerRognage = useCallback(
    (id: string | null): void => {
      if (id !== null) {
        const blocActuel = blocs.find((b) => b.id === id);
        if (blocActuel) setCropSnapshot({ ...blocActuel });
      } else {
        setCropSnapshot(null);
      }
      setCropActiveId(id);
    },
    [blocs],
  );

  const annulerRognage = useCallback(
    (id: string): void => {
      if (cropSnapshot && cropSnapshot.id === id) {
        modifierBloc(id, {
          cropTop: cropSnapshot.cropTop ?? 0,
          cropRight: cropSnapshot.cropRight ?? 0,
          cropBottom: cropSnapshot.cropBottom ?? 0,
          cropLeft: cropSnapshot.cropLeft ?? 0,
        });
      }
      setCropActiveId(null);
      setCropSnapshot(null);
    },
    [cropSnapshot, modifierBloc],
  );

  const ajouter = useCallback(
    (bloc: FurnitureBlock): void => {
      if (pleine) {
        setErreur(`Pas plus de ${MAX_BLOCKS_PER_BAND} éléments par bande.`);
        return;
      }
      setErreur(null);
      onChange((precedent) => ({ blocks: [...precedent.blocks, bloc] }));
      onSelect(bloc.id);
    },
    [onChange, onSelect, pleine],
  );

  /**
   * Pose une image et respecte ses proportions.
   *
   * La hauteur n'est pas devinée : on lit les dimensions réelles du fichier. Une
   * image écrasée dans un rapport arbitraire serait remarquée avant tout le reste.
   */
  const poserImage = useCallback(
    (src: string): void => {
      const bloc = { ...createBlock(band, 'image'), src, widthMm: LARGEUR_IMAGE_MM, heightMm: 20 };
      ajouter(bloc);

      const sonde = new Image();
      sonde.onload = () => {
        if (sonde.naturalWidth <= 0) return;
        const rapport = sonde.naturalHeight / sonde.naturalWidth;
        modifierBloc(bloc.id, {
          heightMm: Math.round(LARGEUR_IMAGE_MM * rapport * 10) / 10,
        });
      };
      sonde.src = src;
    },
    [ajouter, band, modifierBloc],
  );

  const envoyer = useCallback(
    async (fichier: File | Blob): Promise<void> => {
      if (docId === null) {
        setErreur('Le mode local n’a pas de serveur : ajoutez l’image par son adresse.');
        return;
      }
      setEnvoiEnCours(true);
      setErreur(null);
      try {
        const depose = await uploadAsset(token, docId, fichier);
        poserImage(depose.url);
      } catch (cause) {
        setErreur(cause instanceof ApiError ? cause.message : 'L’image n’a pas pu être déposée.');
      } finally {
        setEnvoiEnCours(false);
      }
    },
    [docId, poserImage, token],
  );

  /** Coller une image directement sur la feuille. */
  const auCollage = (event: ClipboardEvent<HTMLDivElement>): void => {
    const image = Array.from(event.clipboardData.files).find((f) => f.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    void envoyer(image);
  };

  const validerAdresse = (): void => {
    const valeur = adresse.trim();
    if (!isSafeImageSrc(valeur)) {
      setErreur('Adresse d’image invalide : une adresse http ou https est attendue.');
      return;
    }
    poserImage(valeur);
    setAdresse('');
    setAdresseOuverte(false);
  };

  /**
   * Insère un jeton **au curseur**, et pas en fin de ligne.
   *
   * L'ajout en queue obligeait à retailler la ligne à la main dès qu'on voulait
   * un numéro au milieu d'une phrase : le raccourci coûtait plus cher que la
   * frappe qu'il remplaçait.
   */
  const insererJeton = (jeton: string): void => {
    const champ = ligneRef.current;
    const debut = champ?.selectionStart ?? ligne.length;
    const fin = champ?.selectionEnd ?? ligne.length;
    const suivant = `${ligne.slice(0, debut)}${jeton}${ligne.slice(fin)}`.slice(
      0,
      MAX_FURNITURE_LENGTH,
    );
    onChange({ [band]: suivant } as unknown as Partial<PageFurniture>);

    // Le curseur reprend sa place derrière le jeton : sans cela il repart en
    // tête et la frappe suivante s'insère au mauvais endroit. Après le rendu,
    // donc — et par un `setTimeout` plutôt qu'une trame d'animation, qui ne
    // vient jamais dans un onglet en arrière-plan.
    setTimeout(() => {
      if (!champ) return;
      champ.focus();
      const position = Math.min(debut + jeton.length, suivant.length);
      champ.setSelectionRange(position, position);
    }, 0);
  };

  const gabarits = useMemo(() => FURNITURE_PRESETS.filter((p) => p.band === band), [band]);

  /** Graduations de la règle, en pixels d'écran — libellés à taille constante. */
  const graduations = useMemo(() => {
    const traits: { mm: number; px: number; majeur: boolean }[] = [];
    for (let valeur = 0; valeur <= usableMm; valeur += 5) {
      traits.push({ mm: valeur, px: valeur * PX_PAR_MM * echelle, majeur: valeur % 10 === 0 });
    }
    return traits;
  }, [echelle, usableMm]);

  /** Glissement d'une marge sur la règle : le geste du traitement de texte. */
  const glisserMarge =
    (cote: 'gauche' | 'droite') =>
    (event: React.PointerEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const poignee = event.currentTarget;
      const regle = poignee.parentElement;
      if (!regle) return;
      const rect = regle.getBoundingClientRect();
      poignee.setPointerCapture(event.pointerId);

      const deplacer = (m: PointerEvent): void => {
        const depuisGauche = (m.clientX - rect.left) / (PX_PAR_MM * echelle);
        const brut = cote === 'gauche' ? depuisGauche : usableMm - depuisGauche;
        const borne = Math.min(
          FURNITURE_LIMITS.marginMm.max,
          Math.max(FURNITURE_LIMITS.marginMm.min, Math.round(brut * 2) / 2),
        );
        onChange(
          cote === 'gauche' ? { marginLeftMm: borne } : { marginRightMm: borne },
          `marge:${cote}`,
        );
      };

      const relacher = (): void => {
        window.removeEventListener('pointermove', deplacer);
        window.removeEventListener('pointerup', relacher);
        window.removeEventListener('pointercancel', relacher);
        historique.cloreGeste();
      };

      window.addEventListener('pointermove', deplacer);
      window.addEventListener('pointerup', relacher);
      window.addEventListener('pointercancel', relacher);
    };

  const largeurScenePx = usableMm * PX_PAR_MM * echelle;

  /** Fantôme du corps de texte : montre ce que la bande repousse. */
  const fantomeStyle: CSSProperties = estHeader
    ? { top: `${Math.max(furniture.marginTopMm, bandeMm + 2)}mm`, bottom: 0 }
    : { top: 0, bottom: `${Math.max(furniture.marginBottomMm, bandeMm + 2)}mm` };

  return (
    <div className="atelier">
      <div
        className="atelier__barre"
        role="toolbar"
        aria-label={`Outils — ${libelles.titre}`}
      >
        <Button variant="ghost" onClick={() => ajouter(createBlock(band, 'text'))} disabled={pleine}>
          ＋ Texte
        </Button>
        <Button
          variant="ghost"
          onClick={() => fichierRef.current?.click()}
          disabled={pleine || envoiEnCours || docId === null}
          title={
            docId === null
              ? 'Indisponible en mode local'
              : 'Choisir une image (PNG, JPEG, GIF, WebP)'
          }
        >
          {envoiEnCours ? 'Envoi…' : '＋ Image'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setAdresseOuverte((ouvert) => !ouvert)}
          disabled={pleine}
          aria-expanded={adresseOuverte}
          aria-label="Ajouter une image par son adresse web"
          title="Ajouter une image par son adresse web"
        >
          🔗
        </Button>

        <span className="atelier__separateur" />

        <Button
          variant="ghost"
          onClick={historique.annuler}
          disabled={!historique.peutAnnuler}
          aria-label="Annuler"
          title="Annuler (Ctrl+Z)"
        >
          ↩
        </Button>
        <Button
          variant="ghost"
          onClick={historique.retablir}
          disabled={!historique.peutRetablir}
          aria-label="Rétablir"
          title="Rétablir (Ctrl+Y)"
        >
          ↪
        </Button>

        <span className="atelier__spacer" />

        <label className="atelier__zoom">
          <span className="field__label">Zoom</span>
          <select
            className="furniture__select"
            value={String(zoomChoisi)}
            onChange={(event) =>
              setZoomChoisi(
                event.target.value === 'ajuster' ? 'ajuster' : Number(event.target.value),
              )
            }
          >
            <option value="ajuster">Ajuster ({Math.round(ajustee * 100)} %)</option>
            {PALIERS_ZOOM.map((palier) => (
              <option key={palier} value={palier}>
                {Math.round(palier * 100)} %
              </option>
            ))}
          </select>
        </label>
      </div>

      {adresseOuverte && (
        <div className="bande-editeur__adresse">
          <input
            className="field__input"
            value={adresse}
            placeholder="https://exemple.fr/logo.png"
            aria-label="Adresse de l’image"
            onChange={(event) => setAdresse(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                validerAdresse();
              }
            }}
          />
          <Button variant="ghost" onClick={validerAdresse}>
            Ajouter
          </Button>
        </div>
      )}

      {erreur !== null && (
        <p className="bande-editeur__erreur" role="alert">
          {erreur}
        </p>
      )}

      <div className="atelier__corps">
        <div className="atelier__scene">
          {/* Surface de travail. Le collage y est écouté : c'est là qu'on regarde
              quand on colle une image. La règle défile avec la feuille — séparée
              d'elle, ses graduations ne tomberaient plus en face du papier dès
              qu'on zoome. */}
          <div
            className="atelier__cadre"
            ref={cadre}
            onPaste={auCollage}
            // Le collage n'arrive qu'à un élément focalisable.
            tabIndex={-1}
          >
            <div className="atelier__piste" style={{ width: `${largeurScenePx}px` }}>
              <div className="regle">
                <span
                  className="regle__zone"
                  style={{
                    left: `${furniture.marginLeftMm * PX_PAR_MM * echelle}px`,
                    width: `${
                      (usableMm - furniture.marginLeftMm - furniture.marginRightMm) * PX_PAR_MM * echelle
                    }px`,
                  }}
                  aria-hidden="true"
                />
                {graduations.map((trait) => (
                  <span
                    key={trait.mm}
                    className={`regle__trait${trait.majeur ? ' regle__trait--majeur' : ''}`}
                    style={{ left: `${trait.px}px` }}
                    aria-hidden="true"
                  >
                    {trait.majeur && trait.mm % 20 === 0 && <i className="regle__nombre">{trait.mm}</i>}
                  </span>
                ))}
                <button
                  type="button"
                  className="regle__poignee"
                  style={{ left: `${furniture.marginLeftMm * PX_PAR_MM * echelle}px` }}
                  onPointerDown={glisserMarge('gauche')}
                  title={`Marge gauche : ${mm(furniture.marginLeftMm)} — glisser pour changer`}
                  aria-label={`Marge gauche, ${mm(furniture.marginLeftMm)}`}
                />
                <button
                  type="button"
                  className="regle__poignee"
                  style={{
                    left: `${(usableMm - furniture.marginRightMm) * PX_PAR_MM * echelle}px`,
                  }}
                  onPointerDown={glisserMarge('droite')}
                  title={`Marge droite : ${mm(furniture.marginRightMm)} — glisser pour changer`}
                  aria-label={`Marge droite, ${mm(furniture.marginRightMm)}`}
                />
              </div>

              <div
                className={`atelier__feuille atelier__feuille--${band}`}
                style={{ zoom: echelle, width: `${usableMm}mm`, height: `${sceneMm}mm` }}
              >
                {/* Fantôme du corps : des lignes grisées à la place du texte, pour
                    voir d'un coup d'œil ce que la bande lui laisse. */}
                <div
                  className="atelier__fantome"
                  style={{
                    ...fantomeStyle,
                    left: `${furniture.marginLeftMm}mm`,
                    right: `${furniture.marginRightMm}mm`,
                  }}
                  aria-hidden="true"
                />

                <div className={`atelier__bande atelier__bande--${band}`}>
                  <FurnitureBandView
                    furniture={furniture}
                    band={band}
                    contexte={contexte}
                    usableMm={usableMm}
                    heightMm={bandeMm}
                    selectedId={selectedId}
                    cropActiveId={cropActiveId}
                    onSelect={(id) => {
                      onSelect(id);
                      if (id !== cropActiveId) setCropActiveId(null);
                    }}
                    onMove={(id, x, y) => modifierBloc(id, { x, y }, `deplacer:${id}`)}
                    onResize={(id, largeur, hauteur, x, y) => {
                      const partiel: Partial<FurnitureBlock> = {
                        widthMm: largeur,
                        heightMm: hauteur,
                      };
                      if (x !== undefined) partiel.x = x;
                      if (y !== undefined) partiel.y = y;
                      modifierBloc(id, partiel, `redimensionner:${id}`);
                    }}
                    onCropChange={(id, cropTop, cropRight, cropBottom, cropLeft) => {
                      modifierBloc(id, { cropTop, cropRight, cropBottom, cropLeft }, `rogner:${id}`);
                    }}
                    onCropCancel={annulerRognage}
                    onToggleCrop={basculerRognage}
                    onCommit={historique.cloreGeste}
                    onReadout={setLecture}
                    onMetrics={setMesures}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Lecture de position. Fixe et hors de la surface : une bulle qui suit
              le curseur masque justement ce qu'on essaie de placer. */}
          <div className="atelier__lecture" role="status">
            {lecture ? (
              <>
                <b>X</b> {mm(lecture.xMm)} <span className="atelier__point">·</span> <b>Y</b>{' '}
                {mm(lecture.yMm)} <span className="atelier__point">·</span> {mm(lecture.widthMm)} ×{' '}
                {mm(lecture.heightMm)}
                {lecture.reperes.length > 0 && (
                  <span className="atelier__reperes">{lecture.reperes.join(' · ')}</span>
                )}
              </>
            ) : (
              <span className="atelier__aide">
                Glissez pour placer — aimantation sur les marges, le centre et les autres éléments.
                <kbd>Alt</kbd> la suspend, <kbd>←↑↓→</kbd> déplacent au millimètre.
              </span>
            )}
          </div>

          <label className="field atelier__ligne">
            <span className="field__label">{libelles.ligne}</span>
            <input
              ref={ligneRef}
              className="field__input"
              value={ligne}
              maxLength={MAX_FURNITURE_LENGTH}
              placeholder={libelles.exemple}
              onChange={(event) =>
                onChange(
                  { [band]: event.target.value } as unknown as Partial<PageFurniture>,
                  `ligne:${band}`,
                )
              }
              onBlur={historique.cloreGeste}
            />
          </label>

          <div className="furniture__token-row">
            <span className="atelier__legende">Insérer&nbsp;:</span>
            {FURNITURE_TOKENS.map((jeton) => (
              <button
                key={jeton.jeton}
                type="button"
                className="btn"
                title={`Insère ${jeton.description} au curseur`}
                onClick={() => insererJeton(jeton.jeton)}
              >
                {jeton.jeton}
              </button>
            ))}
          </div>

          {gabarits.length > 0 && (
            <div className="atelier__gabarits">
              <span className="atelier__legende">Dispositions&nbsp;:</span>
              {gabarits.map((gabarit) => (
                <button
                  key={gabarit.id}
                  type="button"
                  className="atelier__gabarit"
                  onClick={() => onChange(gabarit.patch)}
                  title={`Applique : ${gabarit.apercu}`}
                >
                  <span className="atelier__gabarit-nom">{gabarit.label}</span>
                  <span className="atelier__gabarit-apercu">{gabarit.apercu}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Inspecteur. Colonne de largeur fixe qui défile pour elle-même : les
            réglages changent, la surface de travail ne bouge pas d'un pixel. */}
        <aside className="atelier__inspecteur" aria-label="Réglages">
          {selection ? (
            <ProprietesDuBloc
              bloc={selection}
              usableMm={usableMm}
              taille={tailleDe(selection)}
              cropActive={cropActiveId === selection.id}
              onToggleCrop={() =>
                basculerRognage(cropActiveId === selection.id ? null : selection.id)
              }
              onCropCancel={() => annulerRognage(selection.id)}
              onChange={(partiel, fusion) => modifierBloc(selection.id, partiel, fusion)}
              onCaler={caler}
              onDupliquer={() => dupliquer(selection.id)}
              onSupprimer={() => supprimer(selection.id)}
              onFermer={() => onSelect(null)}
            />
          ) : (
            <ReglagesDeBande band={band} furniture={furniture} onChange={onChange} />
          )}
        </aside>
      </div>

      <input
        ref={fichierRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const fichier = event.target.files?.[0];
          // Le champ est remis à zéro : rechoisir le même fichier doit redéclencher.
          event.target.value = '';
          if (fichier) void envoyer(fichier);
        }}
      />
    </div>
  );
}

/* --- Inspecteur : réglages de la bande ------------------------------------ */

function Alignement({
  label,
  valeur,
  onChange,
}: {
  label: string;
  valeur: FurnitureAlign;
  onChange: (valeur: FurnitureAlign) => void;
}) {
  const choix: { valeur: FurnitureAlign; icone: string; nom: string }[] = [
    { valeur: 'left', icone: '⇤', nom: 'Gauche' },
    { valeur: 'center', icone: '⇹', nom: 'Centré' },
    { valeur: 'right', icone: '⇥', nom: 'Droite' },
  ];
  return (
    <div className="inspecteur__champ">
      <span className="field__label">{label}</span>
      <div className="segmente" role="group" aria-label={label}>
        {choix.map((c) => (
          <button
            key={c.valeur}
            type="button"
            className="segmente__btn"
            aria-pressed={valeur === c.valeur}
            title={c.nom}
            onClick={() => onChange(c.valeur)}
          >
            <span aria-hidden="true">{c.icone}</span>
            <span className="segmente__nom">{c.nom}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ReglagesDeBande({
  band,
  furniture,
  onChange,
}: {
  band: FurnitureBand;
  furniture: PageFurniture;
  onChange: (maj: MajFurniture, fusion?: string) => void;
}) {
  const estHeader = band === 'header';
  const libelles = LIBELLES[band];

  return (
    <div className="inspecteur">
      <h4 className="inspecteur__titre">{libelles.titre}</h4>
      <p className="inspecteur__vide">
        Sélectionnez un élément sur la feuille pour le régler — ou ajustez la bande ci-dessous.
      </p>

      <Mesure
        label={libelles.distance}
        valeur={estHeader ? furniture.headerMm : furniture.footerMm}
        bornes={FURNITURE_LIMITS.distanceMm}
        onChange={(valeur) =>
          onChange(estHeader ? { headerMm: valeur } : { footerMm: valeur }, `distance:${band}`)
        }
      />

      <Alignement
        label="Alignement de la ligne"
        valeur={estHeader ? furniture.headerAlign : furniture.footerAlign}
        onChange={(valeur) =>
          onChange(estHeader ? { headerAlign: valeur } : { footerAlign: valeur })
        }
      />

      <Mesure
        label="Taille du texte"
        unite="pt"
        valeur={furniture.fontSizePt}
        bornes={FURNITURE_LIMITS.fontSizePt}
        onChange={(fontSizePt) => onChange({ fontSizePt }, 'corps')}
      />

      {!estHeader && (
        <>
          <label className="furniture__check">
            <input
              type="checkbox"
              checked={furniture.pageNumber}
              onChange={(event) => onChange({ pageNumber: event.target.checked })}
            />
            Numéroter les pages
          </label>

          {furniture.pageNumber && (
            <div className="inspecteur__champ">
              <span className="field__label">Format du numéro</span>
              <div className="inspecteur__formats" role="group" aria-label="Format du numéro">
                {PAGE_NUMBER_FORMATS.map((format) => (
                  <button
                    key={format.valeur}
                    type="button"
                    className="segmente__btn"
                    aria-pressed={furniture.pageNumberFormat === format.valeur}
                    onClick={() => onChange({ pageNumberFormat: format.valeur })}
                  >
                    {format.exemple}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <label className="furniture__check">
        <input
          type="checkbox"
          checked={!furniture.onFirstPage}
          onChange={(event) => onChange({ onFirstPage: !event.target.checked })}
        />
        Masquer sur la première page
      </label>

      <details className="inspecteur__replie">
        <summary>Marges du document</summary>
        <div className="inspecteur__marges">
          <Mesure
            label="Haut"
            valeur={furniture.marginTopMm}
            bornes={FURNITURE_LIMITS.marginMm}
            onChange={(marginTopMm) => onChange({ marginTopMm }, 'marge:haut')}
          />
          <Mesure
            label="Bas"
            valeur={furniture.marginBottomMm}
            bornes={FURNITURE_LIMITS.marginMm}
            onChange={(marginBottomMm) => onChange({ marginBottomMm }, 'marge:bas')}
          />
          <Mesure
            label="Gauche"
            valeur={furniture.marginLeftMm}
            bornes={FURNITURE_LIMITS.marginMm}
            onChange={(marginLeftMm) => onChange({ marginLeftMm }, 'marge:gauche')}
          />
          <Mesure
            label="Droite"
            valeur={furniture.marginRightMm}
            bornes={FURNITURE_LIMITS.marginMm}
            onChange={(marginRightMm) => onChange({ marginRightMm }, 'marge:droite')}
          />
        </div>
        <p className="inspecteur__note">
          Une bande plus haute que sa marge repousse celle-ci : le texte ne peut jamais passer sous
          l’en-tête.
        </p>
      </details>
    </div>
  );
}

/* --- Inspecteur : réglages de l'élément sélectionné ----------------------- */

interface ProprietesProps {
  bloc: FurnitureBlock;
  usableMm: number;
  taille: BlockMetrics;
  cropActive: boolean;
  onToggleCrop: () => void;
  onCropCancel: () => void;
  onChange: (partiel: Partial<FurnitureBlock>, fusion?: string) => void;
  onCaler: (ou: Calage) => void;
  onDupliquer: () => void;
  onSupprimer: () => void;
  onFermer: () => void;
}

/** Réglages de l'élément sélectionné : ils changent selon sa nature. */
function ProprietesDuBloc({
  bloc,
  usableMm,
  taille,
  cropActive,
  onToggleCrop,
  onCropCancel,
  onChange,
  onCaler,
  onDupliquer,
  onSupprimer,
  onFermer,
}: ProprietesProps) {
  const reinitialiserTailleEtRognage = (): void => {
    const sonde = new Image();
    sonde.onload = () => {
      if (sonde.naturalWidth <= 0) return;
      const rapport = sonde.naturalHeight / sonde.naturalWidth;
      onChange({
        heightMm: Math.round(bloc.widthMm * rapport * 10) / 10,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0,
      });
    };
    sonde.src = bloc.src;
  };

  /**
   * Calages. Les libellés disent ce qu'ils font : « Centrer H. » se lisait
   * « horizontalement » alors qu'il centrait dans la hauteur.
   */
  const calages: { cle: Calage; icone: string; nom: string }[] = [
    { cle: 'gauche', icone: '⇤', nom: 'Caler sur la marge gauche' },
    { cle: 'centre', icone: '⇹', nom: 'Centrer horizontalement' },
    { cle: 'droite', icone: '⇥', nom: 'Caler sur la marge droite' },
    { cle: 'haut', icone: '⤒', nom: 'Caler en haut de la bande' },
    { cle: 'milieu', icone: '⇳', nom: 'Centrer verticalement' },
    { cle: 'bas', icone: '⤓', nom: 'Caler en bas de la bande' },
  ];

  return (
    <div className="inspecteur">
      <div className="inspecteur__entete">
        <h4 className="inspecteur__titre">{bloc.kind === 'image' ? 'Image' : 'Texte'}</h4>
        <button
          type="button"
          className="btn btn--icon"
          onClick={onFermer}
          title="Désélectionner (Échap)"
          aria-label="Désélectionner"
        >
          ✕
        </button>
      </div>

      <div className="inspecteur__champ">
        <span className="field__label">Caler l’élément</span>
        <div className="inspecteur__calage" role="group" aria-label="Caler l’élément">
          {calages.map((calage) => (
            <button
              key={calage.cle}
              type="button"
              className="btn btn--icon"
              onClick={() => onCaler(calage.cle)}
              title={calage.nom}
              aria-label={calage.nom}
            >
              <span aria-hidden="true">{calage.icone}</span>
            </button>
          ))}
        </div>
      </div>

      {bloc.kind === 'text' ? (
        <>
          <label className="field">
            <span className="field__label">Texte</span>
            <input
              className="field__input"
              value={bloc.text}
              maxLength={MAX_BLOCK_TEXT_LENGTH}
              onChange={(event) => onChange({ text: event.target.value }, `texte:${bloc.id}`)}
            />
          </label>

          <div className="furniture__token-row">
            {FURNITURE_TOKENS.map((jeton) => (
              <button
                key={jeton.jeton}
                type="button"
                className="btn"
                title={`Ajoute ${jeton.description}`}
                onClick={() =>
                  onChange({ text: `${bloc.text}${jeton.jeton}`.slice(0, MAX_BLOCK_TEXT_LENGTH) })
                }
              >
                {jeton.jeton}
              </button>
            ))}
          </div>

          <Mesure
            label="Taille"
            unite="pt"
            valeur={bloc.fontSizePt}
            bornes={FURNITURE_LIMITS.blockFontSizePt}
            onChange={(fontSizePt) => onChange({ fontSizePt }, `corps:${bloc.id}`)}
          />

          <div className="bande-editeur__styles" role="group" aria-label="Style du texte">
            <button
              type="button"
              className={`btn${bloc.bold ? ' btn--actif' : ''}`}
              aria-pressed={bloc.bold}
              title="Gras"
              onClick={() => onChange({ bold: !bloc.bold })}
            >
              <strong>G</strong>
            </button>
            <button
              type="button"
              className={`btn${bloc.italic ? ' btn--actif' : ''}`}
              aria-pressed={bloc.italic}
              title="Italique"
              onClick={() => onChange({ italic: !bloc.italic })}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              className={`btn${bloc.underline ? ' btn--actif' : ''}`}
              aria-pressed={bloc.underline}
              title="Souligné"
              onClick={() => onChange({ underline: !bloc.underline })}
            >
              <u>S</u>
            </button>
            <label className="bande-editeur__couleur">
              <span className="field__label">Couleur</span>
              <input
                type="color"
                value={bloc.color}
                onChange={(event) => onChange({ color: event.target.value }, `couleur:${bloc.id}`)}
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span className="field__label">Description (lecteurs d’écran)</span>
            <input
              className="field__input"
              value={bloc.alt}
              maxLength={MAX_BLOCK_TEXT_LENGTH}
              placeholder="Ex. : logo de la société"
              onChange={(event) => onChange({ alt: event.target.value }, `alt:${bloc.id}`)}
            />
          </label>

          <div className="inspecteur__paire">
            <Mesure
              label="Largeur"
              unite="mm"
              valeur={bloc.widthMm}
              bornes={FURNITURE_LIMITS.blockWidthMm}
              onChange={(widthMm) => onChange({ widthMm }, `largeur:${bloc.id}`)}
            />
            <Mesure
              label="Hauteur"
              unite="mm"
              valeur={bloc.heightMm}
              bornes={FURNITURE_LIMITS.blockWidthMm}
              onChange={(heightMm) => onChange({ heightMm }, `hauteur:${bloc.id}`)}
            />
          </div>

          <div className="bande-editeur__crop-section">
            <div className="bande-editeur__crop-actions">
              <Button
                variant={cropActive ? 'primary' : 'ghost'}
                onClick={onToggleCrop}
                title="Active le mode rognage visuel sur l'image"
              >
                {cropActive ? '✓ Valider le rognage' : '✂ Rogner l’image'}
              </Button>

              {cropActive && (
                <Button
                  variant="ghost"
                  onClick={onCropCancel}
                  title="Annule le rognage en cours et revient à l'image précédente"
                >
                  ✕ Annuler
                </Button>
              )}

              <Button
                variant="ghost"
                onClick={reinitialiserTailleEtRognage}
                title="Restaure le ratio d'origine et efface le rognage"
              >
                Réinitialiser
              </Button>
            </div>

            <details className="inspecteur__replie">
              <summary>Rognage au chiffre</summary>
              <div className="bande-editeur__crop-inputs">
                <Mesure
                  label="Haut"
                  unite="%"
                  valeur={bloc.cropTop ?? 0}
                  bornes={{ min: 0, max: 80 }}
                  step={1}
                  onChange={(cropTop) => onChange({ cropTop }, `crop:${bloc.id}`)}
                />
                <Mesure
                  label="Bas"
                  unite="%"
                  valeur={bloc.cropBottom ?? 0}
                  bornes={{ min: 0, max: 80 }}
                  step={1}
                  onChange={(cropBottom) => onChange({ cropBottom }, `crop:${bloc.id}`)}
                />
                <Mesure
                  label="Gauche"
                  unite="%"
                  valeur={bloc.cropLeft ?? 0}
                  bornes={{ min: 0, max: 80 }}
                  step={1}
                  onChange={(cropLeft) => onChange({ cropLeft }, `crop:${bloc.id}`)}
                />
                <Mesure
                  label="Droite"
                  unite="%"
                  valeur={bloc.cropRight ?? 0}
                  bornes={{ min: 0, max: 80 }}
                  step={1}
                  onChange={(cropRight) => onChange({ cropRight }, `crop:${bloc.id}`)}
                />
              </div>
            </details>
          </div>
        </>
      )}

      <div className="inspecteur__paire">
        <Mesure
          label="Position X"
          unite="mm"
          valeur={Math.round(bloc.x * usableMm * 10) / 10}
          bornes={{ min: 0, max: Math.max(0, Math.round(usableMm - taille.widthMm)) }}
          onChange={(posMm) =>
            onChange(
              { x: Math.min(1, Math.max(0, Math.round((posMm / usableMm) * 1000) / 1000)) },
              `x:${bloc.id}`,
            )
          }
        />
        <Mesure
          label="Position Y"
          unite="mm"
          valeur={bloc.y}
          bornes={FURNITURE_LIMITS.blockYMm}
          onChange={(y) => onChange({ y }, `y:${bloc.id}`)}
        />
      </div>

      <div className="inspecteur__actions">
        <Button variant="ghost" onClick={onDupliquer} title="Dupliquer l’élément">
          ⧉ Dupliquer
        </Button>
        <Button variant="danger" onClick={onSupprimer} title="Supprimer l’élément (Suppr)">
          🗑 Supprimer
        </Button>
      </div>
    </div>
  );
}
