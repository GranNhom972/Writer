// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Dialogue ergonomique d'édition des en-têtes et pieds de page.
 *
 * Ils sont identiques sur toutes les pages : le dialogue en tient compte et
 * n'expose qu'une seule définition, pas un éditeur par page. Les jetons
 * ({page}, {titre}, {date}…) évitent d'apprendre une syntaxe.
 *
 * Chaque bande a son propre atelier avec rendu véridique et repères magnétiques.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Modal } from '../../design/components/Modal';
import {
  bandIsEmpty,
  resolveGeometry,
  type FurnitureBand,
  type PageFurniture,
} from '../../domain/document/pageFurniture';
import { FurnitureBandEditor, type MajFurniture } from '../components/FurnitureBandEditor';
import { Button } from '../../design/components/Button';
import { A4 } from '../../design/tokens';

export interface PageFurnitureDialogProps {
  valeur: PageFurniture;
  titreDocument: string;
  pages: number;
  bandeInitiale?: FurnitureBand;
  docId?: string | null;
  token?: string;
  onChange: (furniture: PageFurniture) => void;
  onClose: () => void;
}

const FENETRE_FUSION_MS = 900;
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
}: PageFurnitureDialogProps): JSX.Element {
  const [brouillon, setBrouillon] = useState<PageFurniture>(valeur);
  const [bandeActive, setBandeActive] = useState<FurnitureBand>(bandeInitiale);
  const [selection, setSelection] = useState<string | null>(null);

  const brouillonRef = useRef(brouillon);
  brouillonRef.current = brouillon;

  const ouverture = useRef(valeur);

  const pile = useRef<PageFurniture[]>([valeur]);
  const curseur = useRef(0);
  const derniereCle = useRef<string | null>(null);
  const derniereDate = useRef(0);
  const [jalons, setJalons] = useState({ index: 0, total: 1 });

  const publier = useCallback(
    (suivant: PageFurniture): void => {
      brouillonRef.current = suivant;
      setBrouillon(suivant);
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

  const cloreGeste = useCallback((): void => {
    derniereCle.current = null;
  }, []);

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

  const auClavierDesOnglets = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    changerDeBande(isHeader ? 'footer' : 'header');
  };

  const retirer = (): void => {
    setSelection(null);
    modifier((precedent) =>
      isHeader
        ? {
            header: '',
            headerLeft: '',
            headerCenter: '',
            headerRight: '',
            headerEven: '',
            headerEvenLeft: '',
            headerEvenCenter: '',
            headerEvenRight: '',
            firstPageHeader: '',
            firstPageHeaderLeft: '',
            firstPageHeaderCenter: '',
            firstPageHeaderRight: '',
            headerSeparator: false,
            headerBackground: '',
            blocks: precedent.blocks.filter((b) => b.band !== 'header'),
          }
        : {
            footer: '',
            footerLeft: '',
            footerCenter: '',
            footerRight: '',
            footerEven: '',
            footerEvenLeft: '',
            footerEvenCenter: '',
            footerEvenRight: '',
            firstPageFooter: '',
            firstPageFooterLeft: '',
            firstPageFooterCenter: '',
            firstPageFooterRight: '',
            pageNumber: false,
            footerSeparator: false,
            footerBackground: '',
            blocks: precedent.blocks.filter((b) => b.band !== 'footer'),
          },
    );
  };

  const vide = bandIsEmpty(brouillon, bandeActive);
  const autreVide = bandIsEmpty(brouillon, isHeader ? 'footer' : 'header');

  return (
    <Modal title="En-tête et pied de page" onClose={onClose} width={1120}>
      <div className="furniture">
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
