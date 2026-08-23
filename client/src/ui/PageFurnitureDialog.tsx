/**
 * En-tête et pied de page.
 *
 * Ils sont identiques sur toutes les pages : le dialogue en tient compte et
 * n'expose donc **qu'une seule définition**, pas un éditeur par page. Les jetons
 * ({page}, {titre}…) évitent d'apprendre une syntaxe : ils sont listés et
 * cliquables.
 *
 * Chaque bande a son propre atelier, et cet atelier EST l'aperçu : on y place
 * les éléments à la souris, sur la feuille telle qu'elle sera imprimée. Un
 * aperçu séparé du rendu finit toujours par diverger de lui.
 *
 * Le dialogue tient **l'annulation** pour tout ce qu'il contient. C'était
 * auparavant l'affaire de l'atelier, qui n'en gardait que ses propres blocs : le
 * retour arrière effaçait la bande d'en face, oubliait les marges et repartait
 * de zéro au changement d'onglet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../design/components/Modal';
import {
  bandIsEmpty,
  resolveGeometry,
  type FurnitureBand,
  type PageFurniture,
} from '../document/pageFurniture';
import { FurnitureBandEditor, type MajFurniture } from './FurnitureBandEditor';
import { Button } from '../design/components/Button';
import { A4 } from '../design/tokens';

interface PageFurnitureDialogProps {
  valeur: PageFurniture;
  titreDocument: string;
  /** Nombre de pages du document, pour un aperçu véridique. */
  pages: number;
  /** Bande à mettre en avant à l'ouverture (celle sur laquelle on a cliqué). */
  bandeInitiale?: FurnitureBand;
  /** Document serveur, ou `null` en mode local : sans lui, pas de dépôt d'image. */
  docId: string | null;
  token: string;
  onChange: (furniture: PageFurniture) => void;
  onClose: () => void;
}

/**
 * Durée pendant laquelle deux modifications de même nature n'en font qu'une
 * dans l'historique.
 *
 * Un glissement produit une modification par déplacement du pointeur : sans
 * regroupement, `Ctrl+Z` reculait d'un pixel à la fois et il fallait le marteler
 * cent fois pour défaire un geste. Une pause d'une seconde marque en revanche
 * une intention nouvelle — c'est la convention des éditeurs de texte.
 */
const FENETRE_FUSION_MS = 900;

/** Profondeur de l'historique. Au-delà, le plus ancien est oublié. */
const PROFONDEUR_HISTORIQUE = 120;

export function PageFurnitureDialog({
  valeur,
  titreDocument,
  pages,
  bandeInitiale = 'header',
  docId,
  token,
  onChange,
  onClose,
}: PageFurnitureDialogProps) {
  const [brouillon, setBrouillon] = useState<PageFurniture>(valeur);
  const [bandeActive, setBandeActive] = useState<FurnitureBand>(bandeInitiale);
  const [selection, setSelection] = useState<string | null>(null);

  /**
   * Dernier état connu, tenu à jour dès la modification.
   *
   * Une modification différée — la hauteur d'une image, connue seulement une fois
   * le fichier chargé — travaillerait sinon sur la liste de blocs capturée avant
   * l'ajout, et effacerait au passage le bloc qu'elle vient de régler. On repart
   * donc de cette référence, jamais de la valeur figée dans la fermeture.
   */
  const brouillonRef = useRef(brouillon);
  brouillonRef.current = brouillon;

  /** État à l'ouverture : c'est là que ramène « Tout réinitialiser ». */
  const ouverture = useRef(valeur);

  // Historique complet du mobilier — les deux bandes, les marges et les options
  // comprises. En référence et non en état : il est lu pendant les gestes, où un
  // rendu de retard suffirait à empiler des pas incohérents.
  const pile = useRef<PageFurniture[]>([valeur]);
  const curseur = useRef(0);
  const derniereCle = useRef<string | null>(null);
  const derniereDate = useRef(0);
  const [jalons, setJalons] = useState({ index: 0, total: 1 });

  const publier = useCallback(
    (suivant: PageFurniture): void => {
      brouillonRef.current = suivant;
      setBrouillon(suivant);
      // Application immédiate : le document est l'aperçu, comme pour les tableaux.
      onChange(suivant);
    },
    [onChange],
  );

  const modifier = useCallback(
    (maj: MajFurniture, fusion?: string): void => {
      const base = brouillonRef.current;
      const suivant = { ...base, ...(typeof maj === 'function' ? maj(base) : maj) };
      publier(suivant);

      const maintenant = Date.now();
      const fusionne =
        fusion !== undefined &&
        fusion === derniereCle.current &&
        maintenant - derniereDate.current < FENETRE_FUSION_MS;

      if (fusionne) {
        pile.current[curseur.current] = suivant;
      } else {
        const tronquee = pile.current.slice(0, curseur.current + 1);
        tronquee.push(suivant);
        // Le plus ancien pas est oublié plutôt que de laisser la pile enfler
        // sans borne : un dialogue ouvert longtemps ne DOIT pas retenir la
        // mémoire d'une session entière.
        const debordement = Math.max(0, tronquee.length - PROFONDEUR_HISTORIQUE);
        pile.current = tronquee.slice(debordement);
        curseur.current = pile.current.length - 1;
      }

      derniereCle.current = fusion ?? null;
      derniereDate.current = maintenant;
      setJalons({ index: curseur.current, total: pile.current.length });
    },
    [publier],
  );

  const deplacerDansHistorique = useCallback(
    (pas: -1 | 1): void => {
      const cible = curseur.current + pas;
      const etat = pile.current[cible];
      if (!etat) return;
      curseur.current = cible;
      derniereCle.current = null;
      publier(etat);
      setJalons({ index: cible, total: pile.current.length });
    },
    [publier],
  );

  const annuler = useCallback(() => deplacerDansHistorique(-1), [deplacerDansHistorique]);
  const retablir = useCallback(() => deplacerDansHistorique(1), [deplacerDansHistorique]);

  /** Ferme le geste : la modification suivante ouvrira un pas neuf. */
  const cloreGeste = useCallback((): void => {
    derniereCle.current = null;
  }, []);

  // Ctrl+Z / Ctrl+Maj+Z / Ctrl+Y. Capturés au niveau du dialogue : ils valent
  // aussi bien dans un champ de saisie que sur la surface de travail.
  useEffect(() => {
    const auClavier = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const touche = event.key.toLowerCase();
      if (touche === 'z') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) retablir();
        else annuler();
      } else if (touche === 'y') {
        event.preventDefault();
        event.stopPropagation();
        retablir();
      }
    };
    window.addEventListener('keydown', auClavier, true);
    return () => window.removeEventListener('keydown', auClavier, true);
  }, [annuler, retablir]);

  const contexteApercu = { page: Math.min(2, pages), pages, titre: titreDocument };
  const geometrie = resolveGeometry(brouillon);
  const isHeader = bandeActive === 'header';

  const changerDeBande = (band: FurnitureBand): void => {
    setBandeActive(band);
    setSelection(null);
    cloreGeste();
  };

  /** Onglets pilotables aux flèches, comme l'exige le motif `tablist`. */
  const auClavierDesOnglets = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    changerDeBande(isHeader ? 'footer' : 'header');
  };

  const retirer = (): void => {
    setSelection(null);
    modifier((precedent) =>
      isHeader
        ? { header: '', blocks: precedent.blocks.filter((b) => b.band !== 'header') }
        : {
            footer: '',
            pageNumber: false,
            blocks: precedent.blocks.filter((b) => b.band !== 'footer'),
          },
    );
  };

  const vide = bandIsEmpty(brouillon, bandeActive);
  const autreVide = bandIsEmpty(brouillon, isHeader ? 'footer' : 'header');

  return (
    <Modal title="En-tête et pied de page" onClose={onClose} width={1120}>
      <div className="furniture">
        {/* Les onglets disent aussi ce que contient la bande d'en face : sans
            cela, on ne sait pas qu'un pied existe sans aller voir. */}
        <div
          className="furniture__tabs"
          role="tablist"
          aria-label="Bande à modifier"
          onKeyDown={auClavierDesOnglets}
        >
          {(['header', 'footer'] as const).map((band) => {
            const actif = band === bandeActive;
            const bandeVide = actif ? vide : autreVide;
            return (
              <button
                key={band}
                type="button"
                role="tab"
                id={`furniture-tab-${band}`}
                aria-selected={actif}
                aria-controls="furniture-panneau"
                tabIndex={actif ? 0 : -1}
                className={`furniture__tab${actif ? ' furniture__tab--active' : ''}`}
                onClick={() => changerDeBande(band)}
              >
                {band === 'header' ? 'En-tête' : 'Pied de page'}
                <span className={`furniture__pastille${bandeVide ? '' : ' furniture__pastille--pleine'}`}>
                  {bandeVide ? 'vide' : 'défini'}
                </span>
              </button>
            );
          })}
        </div>

        <div id="furniture-panneau" role="tabpanel" aria-labelledby={`furniture-tab-${bandeActive}`}>
          <FurnitureBandEditor
            key={bandeActive}
            band={bandeActive}
            furniture={brouillon}
            contexte={contexteApercu}
            usableMm={A4.widthMm}
            heightMm={isHeader ? geometrie.headerContentMm : geometrie.footerContentMm}
            selectedId={selection}
            onSelect={setSelection}
            onChange={modifier}
            historique={{
              annuler,
              retablir,
              peutAnnuler: jalons.index > 0,
              peutRetablir: jalons.index < jalons.total - 1,
              cloreGeste,
            }}
            docId={docId}
            token={token}
          />
        </div>

        <footer className="furniture__actions">
          {/* Destructif, donc à distance de « Terminé » — et rattrapable par
              Ctrl+Z, ce que le libellé rappelle. */}
          <Button
            variant="ghost"
            onClick={retirer}
            disabled={vide}
            title="Vide la bande — Ctrl+Z la rétablit"
          >
            {isHeader ? 'Vider l’en-tête' : 'Vider le pied de page'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setSelection(null);
              modifier(() => ouverture.current);
            }}
            title="Revient à l’état du document à l’ouverture de ce dialogue"
          >
            Tout réinitialiser
          </Button>
          <span className="titlebar__spacer" />
          <Button variant="primary" onClick={onClose}>
            Terminé
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
