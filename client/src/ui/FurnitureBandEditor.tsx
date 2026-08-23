/**
 * Éditeur d'une bande : l'aperçu **est** la surface de travail.
 *
 * On y pose des blocs — du texte ou une image — et on les déplace à la souris ou
 * aux flèches. La bande affichée ici est le composant qui dessine la feuille
 * (`FurnitureBandView`), simplement réduit : ce qu'on voit est ce qu'on aura.
 *
 * Les images ne sont pas encodées dans le document. Elles sont déposées sur le
 * serveur, qui vérifie leur format en lisant leurs octets, et seul leur adresse
 * rejoint les métadonnées répliquées.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type MutableRefObject,
} from 'react';
import { ApiError, uploadAsset } from '../collab/api';
import {
  blocksOf,
  createBlock,
  FURNITURE_LIMITS,
  FURNITURE_TOKENS,
  isSafeImageSrc,
  MAX_BLOCK_TEXT_LENGTH,
  MAX_BLOCKS_PER_BAND,
  MAX_FURNITURE_LENGTH,
  type FurnitureBand,
  type FurnitureBlock,
  type FurnitureContext,
  type PageFurniture,
} from '../document/pageFurniture';
import { FurnitureBandView } from './FurnitureBand';
import { Button } from '../design/components/Button';

const PX_PAR_MM = 96 / 25.4;

/** Hauteur minimale de la surface : une bande vide reste une cible visible. */
const HAUTEUR_MINIMALE_MM = 14;

/** Largeur donnée à une image déposée, avant respect de ses proportions. */
const LARGEUR_IMAGE_MM = 35;

const LIBELLES: Record<FurnitureBand, { titre: string; distance: string }> = {
  header: { titre: 'En-tête', distance: 'Depuis le haut de la feuille' },
  footer: { titre: 'Pied de page', distance: 'Depuis le bas de la feuille' },
};

/**
 * Une modification du mobilier : soit les champs à écraser, soit une fonction
 * qui les calcule à partir de l'état courant. La seconde forme est indispensable
 * dès qu'une modification arrive en différé (chargement d'image, glissement).
 */
export type MajFurniture =
  | Partial<PageFurniture>
  | ((precedent: PageFurniture) => Partial<PageFurniture>);

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
  onChange: (maj: MajFurniture) => void;
  /** Document serveur, ou `null` en mode local : sans lui, pas de dépôt d'image. */
  docId: string | null;
  token: string;
}

/**
 * Échelle d'affichage de la bande.
 *
 * La bande fait 160 mm de large ; le dialogue en fait moins. On la réduit plutôt
 * que de la tronquer, et le facteur se mesure — il dépend de la largeur réelle
 * disponible, donc de la fenêtre.
 */
function useEchelle(usableMm: number): {
  cadre: MutableRefObject<HTMLDivElement | null>;
  echelle: number;
} {
  const cadre = useRef<HTMLDivElement | null>(null);
  const [echelle, setEchelle] = useState(1);

  useEffect(() => {
    const element = cadre.current;
    if (!element) return;

    const mesurer = (): void => {
      const voulue = usableMm * PX_PAR_MM;
      const disponible = element.clientWidth;
      setEchelle(disponible > 0 && voulue > 0 ? Math.min(1, disponible / voulue) : 1);
    };

    mesurer();
    const observateur = new ResizeObserver(mesurer);
    observateur.observe(element);
    return () => observateur.disconnect();
  }, [usableMm]);

  return { cadre, echelle };
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
  docId,
  token,
}: FurnitureBandEditorProps) {
  const { cadre, echelle } = useEchelle(usableMm);
  const fichierRef = useRef<HTMLInputElement | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [adresseOuverte, setAdresseOuverte] = useState(false);
  const [adresse, setAdresse] = useState('');
  const [envoiEnCours, setEnvoiEnCours] = useState(false);

  const blocs = blocksOf(furniture, band);
  const pleine = blocs.length >= MAX_BLOCKS_PER_BAND;
  const selection = blocs.find((bloc) => bloc.id === selectedId) ?? null;
  const libelles = LIBELLES[band];
  const ligne = band === 'header' ? furniture.header : furniture.footer;

  /** Écriture de blocs : toujours à partir de l'état au moment de l'application. */
  const majBlocs = useCallback(
    (transformer: (blocs: FurnitureBlock[]) => FurnitureBlock[]): void =>
      onChange((precedent) => ({ blocks: transformer(precedent.blocks) })),
    [onChange],
  );

  const ajouter = useCallback(
    (bloc: FurnitureBlock): void => {
      if (pleine) {
        setErreur(`Pas plus de ${MAX_BLOCKS_PER_BAND} éléments par bande.`);
        return;
      }
      setErreur(null);
      majBlocs((blocs) => [...blocs, bloc]);
      onSelect(bloc.id);
    },
    [majBlocs, onSelect, pleine],
  );

  const modifierBloc = useCallback(
    (id: string, partiel: Partial<FurnitureBlock>): void => {
      majBlocs((blocs) => blocs.map((bloc) => (bloc.id === id ? { ...bloc, ...partiel } : bloc)));
    },
    [majBlocs],
  );

  const supprimer = useCallback(
    (id: string): void => {
      majBlocs((blocs) => blocs.filter((bloc) => bloc.id !== id));
      onSelect(null);
    },
    [majBlocs, onSelect],
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
        setErreur(
          cause instanceof ApiError ? cause.message : 'L’image n’a pas pu être déposée.',
        );
      } finally {
        setEnvoiEnCours(false);
      }
    },
    [docId, poserImage, token],
  );

  /** Coller une image directement sur la bande. */
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

  return (
    <section className="bande-editeur">
      <h3 className="table-props__title">{libelles.titre}</h3>

      {/* Surface de travail. Le collage y est écouté : c'est là qu'on regarde
          quand on colle une image. */}
      <div
        className="bande-editeur__cadre"
        ref={cadre}
        onPaste={auCollage}
        // Le collage n'arrive qu'à un élément focalisable.
        tabIndex={-1}
      >
        <div className="bande-editeur__plan" style={{ zoom: echelle }}>
          <FurnitureBandView
            furniture={furniture}
            band={band}
            contexte={contexte}
            usableMm={usableMm}
            heightMm={Math.max(heightMm, HAUTEUR_MINIMALE_MM)}
            selectedId={selectedId}
            onSelect={onSelect}
            onMove={(id, x, y) => modifierBloc(id, { x, y })}
          />
        </div>
      </div>

      <p className="table-props__hint">
        Glissez un élément pour le placer. Au clavier : Tab pour l’atteindre, les
        flèches pour le déplacer (Maj pour un pas de 5 mm).
      </p>

      <div className="bande-editeur__outils">
        <Button variant="ghost" onClick={() => ajouter(createBlock(band, 'text'))} disabled={pleine}>
          + Texte
        </Button>
        <Button
          variant="ghost"
          onClick={() => fichierRef.current?.click()}
          disabled={pleine || envoiEnCours || docId === null}
          title={docId === null ? 'Indisponible en mode local' : 'Choisir une image (PNG, JPEG, GIF, WebP)'}
        >
          {envoiEnCours ? 'Envoi…' : '+ Image…'}
        </Button>
        <Button variant="ghost" onClick={() => setAdresseOuverte((ouvert) => !ouvert)} disabled={pleine}>
          + Image par adresse
        </Button>
        {selection && (
          <Button variant="ghost" onClick={() => supprimer(selection.id)}>
            Supprimer l’élément
          </Button>
        )}
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

      {selection && (
        <ProprietesDuBloc
          bloc={selection}
          usableMm={usableMm}
          onChange={(partiel) => modifierBloc(selection.id, partiel)}
        />
      )}

      {/* Ligne de base : le texte qui coule dans la bande, distinct des blocs
          libres posés dessus. */}
      <div className="bande-editeur__ligne">
        <label className="field">
          <span className="field__label">Ligne de {band === 'header' ? 'l’en-tête' : 'pied'}</span>
          <input
            className="field__input"
            value={ligne}
            maxLength={MAX_FURNITURE_LENGTH}
            placeholder={
              band === 'header' ? 'Ex. : {titre} — Direction générale' : 'Ex. : Confidentiel — {date}'
            }
            onChange={(event) =>
              onChange({ [band]: event.target.value } as unknown as Partial<PageFurniture>)
            }
          />
        </label>
        <div className="furniture__token-row">
          {FURNITURE_TOKENS.map((token) => (
            <button
              key={token.jeton}
              type="button"
              className="btn"
              title={`Insère ${token.description}`}
              onClick={() =>
                onChange({
                  [band]: `${ligne}${token.jeton}`.slice(0, MAX_FURNITURE_LENGTH),
                } as unknown as Partial<PageFurniture>)
              }
            >
              {token.jeton}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

interface ProprietesProps {
  bloc: FurnitureBlock;
  usableMm: number;
  onChange: (partiel: Partial<FurnitureBlock>) => void;
}

/** Réglages de l'élément sélectionné : ils changent selon sa nature. */
function ProprietesDuBloc({ bloc, usableMm, onChange }: ProprietesProps) {
  const nombre = (valeur: string, bornes: { min: number; max: number }, defaut: number): number => {
    const lu = Number.parseFloat(valeur);
    if (!Number.isFinite(lu)) return defaut;
    return Math.min(bornes.max, Math.max(bornes.min, Math.round(lu * 10) / 10));
  };

  return (
    <div className="bande-editeur__proprietes">
      {bloc.kind === 'text' ? (
        <>
          <label className="field bande-editeur__large">
            <span className="field__label">Texte</span>
            <input
              className="field__input"
              value={bloc.text}
              maxLength={MAX_BLOCK_TEXT_LENGTH}
              onChange={(event) => onChange({ text: event.target.value })}
            />
          </label>

          <label className="furniture__mesure">
            <span className="field__label">Taille</span>
            <span className="furniture__mesure-champ">
              <input
                className="stepper__input"
                type="number"
                min={FURNITURE_LIMITS.blockFontSizePt.min}
                max={FURNITURE_LIMITS.blockFontSizePt.max}
                value={bloc.fontSizePt}
                onChange={(event) =>
                  onChange({
                    fontSizePt: nombre(
                      event.target.value,
                      FURNITURE_LIMITS.blockFontSizePt,
                      bloc.fontSizePt,
                    ),
                  })
                }
              />
              <span className="furniture__unite">pt</span>
            </span>
          </label>

          <div className="bande-editeur__styles" role="group" aria-label="Style du texte">
            <button
              type="button"
              className={`btn${bloc.bold ? ' btn--actif' : ''}`}
              aria-pressed={bloc.bold}
              onClick={() => onChange({ bold: !bloc.bold })}
            >
              <strong>G</strong>
            </button>
            <button
              type="button"
              className={`btn${bloc.italic ? ' btn--actif' : ''}`}
              aria-pressed={bloc.italic}
              onClick={() => onChange({ italic: !bloc.italic })}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              className={`btn${bloc.underline ? ' btn--actif' : ''}`}
              aria-pressed={bloc.underline}
              onClick={() => onChange({ underline: !bloc.underline })}
            >
              <u>S</u>
            </button>
            <label className="bande-editeur__couleur">
              <span className="field__label">Couleur</span>
              <input
                type="color"
                value={bloc.color}
                onChange={(event) => onChange({ color: event.target.value })}
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <label className="field bande-editeur__large">
            <span className="field__label">Description (lecteurs d’écran)</span>
            <input
              className="field__input"
              value={bloc.alt}
              maxLength={MAX_BLOCK_TEXT_LENGTH}
              placeholder="Ex. : logo de la société"
              onChange={(event) => onChange({ alt: event.target.value })}
            />
          </label>

          <label className="furniture__mesure">
            <span className="field__label">Largeur</span>
            <span className="furniture__mesure-champ">
              <input
                className="stepper__input"
                type="number"
                min={FURNITURE_LIMITS.blockWidthMm.min}
                max={FURNITURE_LIMITS.blockWidthMm.max}
                value={bloc.widthMm}
                onChange={(event) => {
                  const largeur = nombre(
                    event.target.value,
                    FURNITURE_LIMITS.blockWidthMm,
                    bloc.widthMm,
                  );
                  // Les proportions suivent : redimensionner en largeur seule
                  // écraserait le logo.
                  const rapport = bloc.widthMm > 0 ? bloc.heightMm / bloc.widthMm : 1;
                  onChange({
                    widthMm: largeur,
                    heightMm: Math.round(largeur * rapport * 10) / 10,
                  });
                }}
              />
              <span className="furniture__unite">mm</span>
            </span>
          </label>
        </>
      )}

      <label className="furniture__mesure">
        <span className="field__label">Position horizontale</span>
        <span className="furniture__mesure-champ">
          <input
            className="stepper__input"
            type="number"
            min={0}
            max={Math.round(usableMm)}
            value={Math.round(bloc.x * usableMm)}
            onChange={(event) =>
              onChange({
                x: Math.min(1, Math.max(0, nombre(event.target.value, { min: 0, max: usableMm }, 0) / usableMm)),
              })
            }
          />
          <span className="furniture__unite">mm</span>
        </span>
      </label>

      <label className="furniture__mesure">
        <span className="field__label">Position verticale</span>
        <span className="furniture__mesure-champ">
          <input
            className="stepper__input"
            type="number"
            min={FURNITURE_LIMITS.blockYMm.min}
            max={FURNITURE_LIMITS.blockYMm.max}
            value={bloc.y}
            onChange={(event) =>
              onChange({ y: nombre(event.target.value, FURNITURE_LIMITS.blockYMm, bloc.y) })
            }
          />
          <span className="furniture__unite">mm</span>
        </span>
      </label>
    </div>
  );
}
