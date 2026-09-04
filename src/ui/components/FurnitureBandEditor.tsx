/**
 * Atelier d'une bande d'en-tête ou pied : l'aperçu EST la surface de travail.
 *
 *  1. La bande montre la tranche de feuille réelle (papier, marges, fantôme du texte).
 *  2. Zoom ajustable au choix (Ajuster ou paliers 50% à 200%).
 *  3. Inspecteur fixe sur le côté avec calages magnétiques, 3 zones OpenOffice,
 *     différenciation paires/impaires, filets séparateurs, fonds, saisie des jetons, styles.
 *  4. Support complet des images locales (data URL) et distantes avec outil de rognage/recadrage.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type JSX,
  type MutableRefObject,
} from 'react';
import {
  blocksOf,
  createBlock,
  DEFAULT_SEPARATOR_COLOR,
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
} from '../../domain/document/pageFurniture';
import { FurnitureBandView, type BlockMetrics, type GestureReadout } from './FurnitureBand';
import { Button } from '../../design/components/Button';
import { Mesure } from './Mesure';
import { mmToPx } from '../../domain/document/units';

const PX_PAR_MM = mmToPx(1);

const HAUTEUR_MINIMALE_MM = 14;

const LARGEUR_IMAGE_MM = 35;

const CONTEXTE_FEUILLE_MM = 38;

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

export type MajFurniture =
  | Partial<PageFurniture>
  | ((precedent: PageFurniture) => Partial<PageFurniture>);

export interface PiloteHistorique {
  annuler: () => void;
  retablir: () => void;
  peutAnnuler: boolean;
  peutRetablir: boolean;
  cloreGeste: () => void;
}

type Calage = 'gauche' | 'centre' | 'droite' | 'haut' | 'milieu' | 'bas';

interface FurnitureBandEditorProps {
  band: FurnitureBand;
  furniture: PageFurniture;
  contexte: FurnitureContext;
  usableMm: number;
  heightMm: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (maj: MajFurniture, fusion?: string) => void;
  historique: PiloteHistorique;
  docId?: string | null | undefined;
  token?: string | undefined;
}

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
      setAjustee((precedente) => (Math.abs(precedente - suivante) < 0.01 ? precedente : suivante));
    };

    mesurer();
    const observateur = new ResizeObserver(mesurer);
    observateur.observe(element);
    return () => observateur.disconnect();
  }, [usableMm]);

  return { cadre, ajustee };
}

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
}: FurnitureBandEditorProps): JSX.Element {
  const { cadre, ajustee } = useEchelleAjustee(usableMm);
  const fichierRef = useRef<HTMLInputElement | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [adresseOuverte, setAdresseOuverte] = useState(false);
  const [adresse, setAdresse] = useState('');
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [zoomChoisi, setZoomChoisi] = useState<number | 'ajuster'>('ajuster');
  const [lecture, setLecture] = useState<GestureReadout | null>(null);
  const [mesures, setMesures] = useState<Record<string, BlockMetrics>>({});

  // Cible de page (odd/all, even, first)
  const [pageCible, setPageCible] = useState<'odd' | 'even' | 'first'>('odd');

  // Champ actif pour l'insertion de jeton
  const [champActif, setChampActif] = useState<'single' | 'left' | 'center' | 'right'>('single');
  const singleRef = useRef<HTMLInputElement | null>(null);
  const leftRef = useRef<HTMLInputElement | null>(null);
  const centerRef = useRef<HTMLInputElement | null>(null);
  const rightRef = useRef<HTMLInputElement | null>(null);

  const [cropActiveId, setCropActiveId] = useState<string | null>(null);
  const [cropSnapshot, setCropSnapshot] = useState<FurnitureBlock | null>(null);

  const pageNumSimulee = pageCible === 'first' ? 1 : pageCible === 'even' ? 2 : 3;
  const blocs = blocksOf(furniture, band, pageNumSimulee);
  const pleine = blocs.length >= MAX_BLOCKS_PER_BAND;
  const selection = blocs.find((bloc) => bloc.id === selectedId) ?? null;
  const libelles = LIBELLES[band];
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

  const tailleDe = useCallback(
    (bloc: FurnitureBlock): BlockMetrics => {
      const mesuree = mesures[bloc.id];
      if (mesuree) return mesuree;
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
      setEnvoiEnCours(true);
      setErreur(null);
      try {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            poserImage(reader.result);
          }
        };
        reader.readAsDataURL(fichier);
      } catch {
        setErreur('L’image n’a pas pu être lue.');
      } finally {
        setEnvoiEnCours(false);
      }
    },
    [poserImage],
  );

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

  // Insertion de jetons dans le champ actuellement ciblé
  const insererJeton = (jeton: string): void => {
    let champ: HTMLInputElement | null = null;
    let nomProp = estHeader ? 'header' : 'footer';

    if (pageCible === 'even' && furniture.differentEvenOdd) {
      if (champActif === 'left') {
        nomProp = estHeader ? 'headerEvenLeft' : 'footerEvenLeft';
        champ = leftRef.current;
      } else if (champActif === 'center') {
        nomProp = estHeader ? 'headerEvenCenter' : 'footerEvenCenter';
        champ = centerRef.current;
      } else if (champActif === 'right') {
        nomProp = estHeader ? 'headerEvenRight' : 'footerEvenRight';
        champ = rightRef.current;
      } else {
        nomProp = estHeader ? 'headerEven' : 'footerEven';
        champ = singleRef.current;
      }
    } else if (pageCible === 'first' && furniture.differentFirstPage) {
      if (champActif === 'left') {
        nomProp = estHeader ? 'firstPageHeaderLeft' : 'firstPageFooterLeft';
        champ = leftRef.current;
      } else if (champActif === 'center') {
        nomProp = estHeader ? 'firstPageHeaderCenter' : 'firstPageFooterCenter';
        champ = centerRef.current;
      } else if (champActif === 'right') {
        nomProp = estHeader ? 'firstPageHeaderRight' : 'firstPageFooterRight';
        champ = rightRef.current;
      } else {
        nomProp = estHeader ? 'firstPageHeader' : 'firstPageFooter';
        champ = singleRef.current;
      }
    } else {
      if (champActif === 'left') {
        nomProp = estHeader ? 'headerLeft' : 'footerLeft';
        champ = leftRef.current;
      } else if (champActif === 'center') {
        nomProp = estHeader ? 'headerCenter' : 'footerCenter';
        champ = centerRef.current;
      } else if (champActif === 'right') {
        nomProp = estHeader ? 'headerRight' : 'footerRight';
        champ = rightRef.current;
      } else {
        nomProp = estHeader ? 'header' : 'footer';
        champ = singleRef.current;
      }
    }

    const texteActuel = (furniture as unknown as Record<string, string>)[nomProp] ?? '';
    const debut = champ?.selectionStart ?? texteActuel.length;
    const fin = champ?.selectionEnd ?? texteActuel.length;
    const suivant = `${texteActuel.slice(0, debut)}${jeton}${texteActuel.slice(fin)}`.slice(
      0,
      MAX_FURNITURE_LENGTH,
    );

    onChange({ [nomProp]: suivant } as unknown as Partial<PageFurniture>);

    setTimeout(() => {
      if (!champ) return;
      champ.focus();
      const position = Math.min(debut + jeton.length, suivant.length);
      champ.setSelectionRange(position, position);
    }, 0);
  };

  const gabarits = useMemo(() => FURNITURE_PRESETS.filter((p) => p.band === band), [band]);

  const graduations = useMemo(() => {
    const traits: { mm: number; px: number; majeur: boolean }[] = [];
    for (let valeur = 0; valeur <= usableMm; valeur += 5) {
      traits.push({ mm: valeur, px: valeur * PX_PAR_MM * echelle, majeur: valeur % 10 === 0 });
    }
    return traits;
  }, [echelle, usableMm]);

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

  const fantomeStyle: CSSProperties = estHeader
    ? { top: `${Math.max(furniture.marginTopMm, bandeMm + 2)}mm`, bottom: 0 }
    : { top: 0, bottom: `${Math.max(furniture.marginBottomMm, bandeMm + 2)}mm` };

  // Détermination des valeurs de texte selon la page cible
  const valGauche =
    pageCible === 'even' && furniture.differentEvenOdd
      ? (estHeader ? furniture.headerEvenLeft : furniture.footerEvenLeft) ?? ''
      : pageCible === 'first' && furniture.differentFirstPage
        ? (estHeader ? furniture.firstPageHeaderLeft : furniture.firstPageFooterLeft) ?? ''
        : (estHeader ? furniture.headerLeft : furniture.footerLeft) ?? '';

  const valCentre =
    pageCible === 'even' && furniture.differentEvenOdd
      ? (estHeader ? furniture.headerEvenCenter : furniture.footerEvenCenter) ?? ''
      : pageCible === 'first' && furniture.differentFirstPage
        ? (estHeader ? furniture.firstPageHeaderCenter : furniture.firstPageFooterCenter) ?? ''
        : (estHeader ? furniture.headerCenter : furniture.footerCenter) ?? '';

  const valDroite =
    pageCible === 'even' && furniture.differentEvenOdd
      ? (estHeader ? furniture.headerEvenRight : furniture.footerEvenRight) ?? ''
      : pageCible === 'first' && furniture.differentFirstPage
        ? (estHeader ? furniture.firstPageHeaderRight : furniture.firstPageFooterRight) ?? ''
        : (estHeader ? furniture.headerRight : furniture.footerRight) ?? '';

  const valSimple =
    pageCible === 'even' && furniture.differentEvenOdd
      ? (estHeader ? furniture.headerEven : furniture.footerEven) ?? ''
      : pageCible === 'first' && furniture.differentFirstPage
        ? (estHeader ? furniture.firstPageHeader : furniture.firstPageFooter) ?? ''
        : (estHeader ? furniture.header : furniture.footer) ?? '';

  const majChamp = (champ: 'left' | 'center' | 'right' | 'single', valeur: string): void => {
    let cle = estHeader ? 'header' : 'footer';
    if (pageCible === 'even' && furniture.differentEvenOdd) {
      if (champ === 'left') cle = estHeader ? 'headerEvenLeft' : 'footerEvenLeft';
      else if (champ === 'center') cle = estHeader ? 'headerEvenCenter' : 'footerEvenCenter';
      else if (champ === 'right') cle = estHeader ? 'headerEvenRight' : 'footerEvenRight';
      else cle = estHeader ? 'headerEven' : 'footerEven';
    } else if (pageCible === 'first' && furniture.differentFirstPage) {
      if (champ === 'left') cle = estHeader ? 'firstPageHeaderLeft' : 'firstPageFooterLeft';
      else if (champ === 'center') cle = estHeader ? 'firstPageHeaderCenter' : 'firstPageFooterCenter';
      else if (champ === 'right') cle = estHeader ? 'firstPageHeaderRight' : 'firstPageFooterRight';
      else cle = estHeader ? 'firstPageHeader' : 'firstPageFooter';
    } else {
      if (champ === 'left') cle = estHeader ? 'headerLeft' : 'footerLeft';
      else if (champ === 'center') cle = estHeader ? 'headerCenter' : 'footerCenter';
      else if (champ === 'right') cle = estHeader ? 'headerRight' : 'footerRight';
      else cle = estHeader ? 'header' : 'footer';
    }

    onChange({ [cle]: valeur } as unknown as Partial<PageFurniture>, `texte:${cle}`);
  };

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
          disabled={pleine || envoiEnCours}
          title="Choisir une image (PNG, JPEG, GIF, WebP)"
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

        {/* Sélecteur de page cible si pages paires/impaires ou 1ère page actives */}
        {(furniture.differentEvenOdd || furniture.differentFirstPage) && (
          <div className="segmente" role="group" aria-label="Page à configurer" style={{ marginRight: '8px' }}>
            <button
              type="button"
              className="segmente__btn"
              aria-pressed={pageCible === 'odd'}
              onClick={() => setPageCible('odd')}
              title="Pages impaires (recto / droite)"
            >
              Pages impaires
            </button>
            {furniture.differentEvenOdd && (
              <button
                type="button"
                className="segmente__btn"
                aria-pressed={pageCible === 'even'}
                onClick={() => setPageCible('even')}
                title="Pages paires (verso / gauche)"
              >
                Pages paires
              </button>
            )}
            {furniture.differentFirstPage && (
              <button
                type="button"
                className="segmente__btn"
                aria-pressed={pageCible === 'first'}
                onClick={() => setPageCible('first')}
                title="Première page (page de garde)"
              >
                Première page
              </button>
            )}
          </div>
        )}

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
          <div
            className="atelier__cadre"
            ref={cadre}
            onPaste={auCollage}
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
                    contexte={{ ...contexte, page: pageNumSimulee }}
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

          {/* Saisie 3 zones OpenOffice (Gauche / Centre / Droite) */}
          <div className="atelier__zones-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginTop: '12px' }}>
            <label className="field">
              <span className="field__label">Zone gauche (alignée gauche)</span>
              <input
                ref={leftRef}
                className="field__input"
                value={valGauche}
                placeholder="Titre, logo, chapitre…"
                onFocus={() => setChampActif('left')}
                onChange={(e) => majChamp('left', e.target.value)}
                onBlur={historique.cloreGeste}
              />
            </label>

            <label className="field">
              <span className="field__label">Zone centrale (centrée)</span>
              <input
                ref={centerRef}
                className="field__input"
                value={valCentre}
                placeholder="Titre, date…"
                onFocus={() => setChampActif('center')}
                onChange={(e) => majChamp('center', e.target.value)}
                onBlur={historique.cloreGeste}
              />
            </label>

            <label className="field">
              <span className="field__label">Zone droite (alignée droite)</span>
              <input
                ref={rightRef}
                className="field__input"
                value={valDroite}
                placeholder="{page} / {pages}, date…"
                onFocus={() => setChampActif('right')}
                onChange={(e) => majChamp('right', e.target.value)}
                onBlur={historique.cloreGeste}
              />
            </label>
          </div>

          {/* Ligne simple de secours si les 3 zones ne sont pas utilisées */}
          {!valGauche && !valCentre && !valDroite && (
            <label className="field atelier__ligne" style={{ marginTop: '8px' }}>
              <span className="field__label">Ou ligne simple unifiée</span>
              <input
                ref={singleRef}
                className="field__input"
                value={valSimple}
                maxLength={MAX_FURNITURE_LENGTH}
                placeholder={libelles.exemple}
                onFocus={() => setChampActif('single')}
                onChange={(e) => majChamp('single', e.target.value)}
                onBlur={historique.cloreGeste}
              />
            </label>
          )}

          {/* Boutons d'insertion rapide de jetons */}
          <div className="furniture__token-row" style={{ marginTop: '8px' }}>
            <span className="atelier__legende">Insérer un champ&nbsp;:</span>
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

          {/* Préréglages */}
          {gabarits.length > 0 && (
            <div className="atelier__gabarits">
              <span className="atelier__legende">Dispositions prédéfinies&nbsp;:</span>
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
          event.target.value = '';
          if (fichier) void envoyer(fichier);
        }}
      />
    </div>
  );
}

function Alignement({
  label,
  valeur,
  onChange,
}: {
  label: string;
  valeur: FurnitureAlign;
  onChange: (valeur: FurnitureAlign) => void;
}): JSX.Element {
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
}): JSX.Element {
  const estHeader = band === 'header';
  const libelles = LIBELLES[band];

  const separatorActive = estHeader ? !!furniture.headerSeparator : !!furniture.footerSeparator;
  const separatorWidth = estHeader ? furniture.headerSeparatorWidthPt ?? 0.75 : furniture.footerSeparatorWidthPt ?? 0.75;
  const separatorColor = estHeader ? furniture.headerSeparatorColor ?? DEFAULT_SEPARATOR_COLOR : furniture.footerSeparatorColor ?? DEFAULT_SEPARATOR_COLOR;
  const separatorStyle = estHeader ? furniture.headerSeparatorStyle ?? 'solid' : furniture.footerSeparatorStyle ?? 'solid';
  const backgroundVal = estHeader ? furniture.headerBackground ?? '' : furniture.footerBackground ?? '';

  return (
    <div className="inspecteur">
      <h4 className="inspecteur__titre">{libelles.titre}</h4>
      <p className="inspecteur__vide">
        Sélectionnez un élément sur la feuille pour le régler — ou ajustez les paramètres ci-dessous.
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
        label="Alignement par défaut"
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

      {/* Filet séparateur (Bordure) */}
      <div className="inspecteur__section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '10px' }}>
        <label className="furniture__check">
          <input
            type="checkbox"
            checked={separatorActive}
            onChange={(e) => {
              const active = e.target.checked;
              onChange(
                estHeader ? { headerSeparator: active } : { footerSeparator: active },
                `filet:${band}`,
              );
            }}
          />
          <b>Filet séparateur ({estHeader ? 'bas' : 'haut'})</b>
        </label>

        {separatorActive && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px', paddingLeft: '16px' }}>
            <Mesure
              label="Épaisseur"
              unite="pt"
              valeur={separatorWidth}
              bornes={FURNITURE_LIMITS.separatorWidthPt}
              onChange={(val) =>
                onChange(
                  estHeader ? { headerSeparatorWidthPt: val } : { footerSeparatorWidthPt: val },
                  `filet-epaisseur:${band}`,
                )
              }
            />

            <div className="inspecteur__champ">
              <span className="field__label">Style de trait</span>
              <div className="segmente" role="group">
                {(['solid', 'dashed', 'dotted'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    className="segmente__btn"
                    aria-pressed={separatorStyle === st}
                    onClick={() =>
                      onChange(
                        estHeader ? { headerSeparatorStyle: st } : { footerSeparatorStyle: st },
                      )
                    }
                  >
                    {st === 'solid' ? 'Continu' : st === 'dashed' ? 'Tirets' : 'Points'}
                  </button>
                ))}
              </div>
            </div>

            <div className="inspecteur__champ">
              <span className="field__label">Couleur du filet</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="color"
                  value={separatorColor.startsWith('#') && separatorColor.length === 7 ? separatorColor : '#d0d5dd'}
                  onChange={(e) =>
                    onChange(
                      estHeader ? { headerSeparatorColor: e.target.value } : { footerSeparatorColor: e.target.value },
                    )
                  }
                  style={{ width: '32px', height: '28px', border: '1px solid var(--border-subtle)', borderRadius: '4px', cursor: 'pointer' }}
                />
                <input
                  className="field__input"
                  value={separatorColor}
                  onChange={(e) =>
                    onChange(
                      estHeader ? { headerSeparatorColor: e.target.value } : { footerSeparatorColor: e.target.value },
                    )
                  }
                  style={{ width: '90px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Fond coloré de la bande */}
      <div className="inspecteur__section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '10px' }}>
        <span className="field__label" style={{ fontWeight: 600, display: 'block', marginBottom: '6px' }}>Couleur d’arrière-plan</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="color"
            value={backgroundVal.startsWith('#') && backgroundVal.length === 7 ? backgroundVal : '#ffffff'}
            onChange={(e) =>
              onChange(
                estHeader ? { headerBackground: e.target.value } : { footerBackground: e.target.value },
              )
            }
            style={{ width: '32px', height: '28px', border: '1px solid var(--border-subtle)', borderRadius: '4px', cursor: 'pointer' }}
          />
          <input
            className="field__input"
            value={backgroundVal}
            placeholder="Transparent"
            onChange={(e) =>
              onChange(
                estHeader ? { headerBackground: e.target.value } : { footerBackground: e.target.value },
              )
            }
            style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
          />
          {backgroundVal && (
            <Button
              variant="ghost"
              onClick={() =>
                onChange(
                  estHeader ? { headerBackground: '' } : { footerBackground: '' },
                )
              }
              title="Effacer le fond"
            >
              ✕
            </Button>
          )}
        </div>
      </div>

      {/* Numérotation des pages (pour le pied de page) */}
      {!estHeader && (
        <div className="inspecteur__section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '10px' }}>
          <label className="furniture__check">
            <input
              type="checkbox"
              checked={furniture.pageNumber}
              onChange={(event) => onChange({ pageNumber: event.target.checked })}
            />
            <b>Numéroter les pages</b>
          </label>

          {furniture.pageNumber && (
            <div className="inspecteur__champ" style={{ marginTop: '8px' }}>
              <span className="field__label">Format du numéro</span>
              <div className="inspecteur__formats" role="group" aria-label="Format du numéro" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
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
        </div>
      )}

      {/* Options de pages OpenOffice */}
      <div className="inspecteur__section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span className="field__label" style={{ fontWeight: 600 }}>Pages & pagination</span>

        <label className="furniture__check">
          <input
            type="checkbox"
            checked={furniture.differentEvenOdd === true}
            onChange={(e) => onChange({ differentEvenOdd: e.target.checked })}
          />
          Pages paires et impaires différentes
        </label>

        <label className="furniture__check">
          <input
            type="checkbox"
            checked={furniture.differentFirstPage === true}
            onChange={(e) => onChange({ differentFirstPage: e.target.checked })}
          />
          Première page différente
        </label>

        <label className="furniture__check">
          <input
            type="checkbox"
            checked={!furniture.onFirstPage}
            onChange={(event) => onChange({ onFirstPage: !event.target.checked })}
          />
          Masquer sur la première page
        </label>
      </div>

      <details className="inspecteur__replie" style={{ marginTop: '10px' }}>
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

function ProprietesDuBloc({
  bloc,
  cropActive,
  onToggleCrop,
  onCropCancel,
  onChange,
  onCaler,
  onDupliquer,
  onSupprimer,
  onFermer,
}: ProprietesProps): JSX.Element {
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

  return (
    <div className="inspecteur">
      <div className="inspecteur__entete">
        <h4 className="inspecteur__titre">
          {bloc.kind === 'image' ? 'Image / Logo' : 'Élément texte'}
        </h4>
        <Button variant="ghost" onClick={onFermer} aria-label="Fermer" title="Fermer l’inspecteur">
          ✕
        </Button>
      </div>

      {bloc.kind === 'text' ? (
        <label className="field">
          <span className="field__label">Contenu textuel</span>
          <textarea
            className="field__input inspecteur__texte"
            value={bloc.text}
            rows={3}
            maxLength={MAX_BLOCK_TEXT_LENGTH}
            onChange={(event) => onChange({ text: event.target.value }, `texte:${bloc.id}`)}
          />
        </label>
      ) : (
        <label className="field">
          <span className="field__label">Description accessible (alt)</span>
          <input
            className="field__input"
            value={bloc.alt}
            placeholder="Logo de l’entreprise…"
            onChange={(event) => onChange({ alt: event.target.value }, `alt:${bloc.id}`)}
          />
        </label>
      )}

      <div className="inspecteur__dimensions">
        <Mesure
          label="Largeur"
          valeur={bloc.widthMm}
          bornes={FURNITURE_LIMITS.blockWidthMm}
          onChange={(widthMm) => onChange({ widthMm }, `largeur:${bloc.id}`)}
        />
        {bloc.kind === 'image' && (
          <Mesure
            label="Hauteur"
            valeur={bloc.heightMm}
            bornes={FURNITURE_LIMITS.blockWidthMm}
            onChange={(heightMm) => onChange({ heightMm }, `hauteur:${bloc.id}`)}
          />
        )}
      </div>

      {bloc.kind === 'text' && (
        <>
          <Mesure
            label="Taille de police"
            unite="pt"
            valeur={bloc.fontSizePt}
            bornes={FURNITURE_LIMITS.blockFontSizePt}
            onChange={(fontSizePt) => onChange({ fontSizePt }, `corps:${bloc.id}`)}
          />

          <div className="inspecteur__champ">
            <span className="field__label">Style de texte</span>
            <div className="segmente" role="group">
              <button
                type="button"
                className="segmente__btn"
                aria-pressed={bloc.bold}
                onClick={() => onChange({ bold: !bloc.bold })}
                title="Gras"
              >
                <b>G</b>
              </button>
              <button
                type="button"
                className="segmente__btn"
                aria-pressed={bloc.italic}
                onClick={() => onChange({ italic: !bloc.italic })}
                title="Italique"
              >
                <i>I</i>
              </button>
              <button
                type="button"
                className="segmente__btn"
                aria-pressed={bloc.underline}
                onClick={() => onChange({ underline: !bloc.underline })}
                title="Souligné"
              >
                <u>S</u>
              </button>
            </div>
          </div>

          <div className="inspecteur__champ">
            <span className="field__label">Couleur</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="color"
                value={bloc.color.startsWith('#') && bloc.color.length === 7 ? bloc.color : '#475467'}
                onChange={(e) => onChange({ color: e.target.value })}
                style={{ width: '32px', height: '28px', border: '1px solid var(--border-subtle)', borderRadius: '4px', cursor: 'pointer' }}
              />
              <input
                className="field__input"
                value={bloc.color}
                onChange={(e) => onChange({ color: e.target.value })}
                style={{ width: '90px', fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </div>
        </>
      )}

      {bloc.kind === 'image' && (
        <div className="inspecteur__champ" style={{ marginTop: '8px' }}>
          <Button
            variant={cropActive ? 'primary' : 'ghost'}
            onClick={onToggleCrop}
            title="Recadrer / rogner l’image interactivement"
          >
            {cropActive ? '✓ Valider le rognage' : '✂ Recadrer / Rogner'}
          </Button>
          {cropActive && (
            <Button variant="ghost" onClick={onCropCancel} title="Annuler le rognage en cours">
              Annuler
            </Button>
          )}
          {((bloc.cropTop ?? 0) > 0 || (bloc.cropBottom ?? 0) > 0 || (bloc.cropLeft ?? 0) > 0 || (bloc.cropRight ?? 0) > 0) && (
            <Button variant="ghost" onClick={reinitialiserTailleEtRognage} title="Réinitialiser le rognage">
              Réinitialiser
            </Button>
          )}
        </div>
      )}

      <div className="inspecteur__section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '10px' }}>
        <span className="field__label" style={{ fontWeight: 600, display: 'block', marginBottom: '6px' }}>Aligner sur la page</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
          <button type="button" className="segmente__btn" onClick={() => onCaler('gauche')}>Gauche</button>
          <button type="button" className="segmente__btn" onClick={() => onCaler('centre')}>Centre</button>
          <button type="button" className="segmente__btn" onClick={() => onCaler('droite')}>Droite</button>
          <button type="button" className="segmente__btn" onClick={() => onCaler('haut')}>Haut</button>
          <button type="button" className="segmente__btn" onClick={() => onCaler('milieu')}>Milieu</button>
          <button type="button" className="segmente__btn" onClick={() => onCaler('bas')}>Bas</button>
        </div>
      </div>

      <div className="inspecteur__section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '10px' }}>
        <span className="field__label">Afficher sur</span>
        <select
          className="furniture__select"
          style={{ width: '100%', marginTop: '4px' }}
          value={bloc.targetPageType ?? 'all'}
          onChange={(e) => onChange({ targetPageType: e.target.value as 'all' | 'odd' | 'even' | 'first' })}
        >
          <option value="all">Toutes les pages</option>
          <option value="odd">Pages impaires uniquement</option>
          <option value="even">Pages paires uniquement</option>
          <option value="first">Première page uniquement</option>
        </select>
      </div>

      <div className="inspecteur__actions" style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <Button variant="ghost" onClick={onDupliquer}>Dupliquer</Button>
        <Button variant="danger" onClick={onSupprimer}>Supprimer</Button>
      </div>
    </div>
  );
}
