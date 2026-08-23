/**
 * En-tête et pied de page.
 *
 * Ils sont identiques sur toutes les pages : le dialogue en tient compte et
 * n'expose donc **qu'une seule définition**, pas un éditeur par page. Les jetons
 * ({page}, {titre}…) évitent d'apprendre une syntaxe : ils sont listés et
 * cliquables.
 *
 * Chaque bande a son propre éditeur, et cet éditeur EST l'aperçu : on y place
 * les éléments à la souris, sur la bande telle qu'elle sera imprimée. Un aperçu
 * séparé du rendu finit toujours par diverger de lui.
 */

import { useCallback, useRef, useState } from 'react';
import { Modal } from '../design/components/Modal';
import {
  FURNITURE_LIMITS,
  resolveGeometry,
  type FurnitureAlign,
  type FurnitureBand,
  type PageFurniture,
} from '../document/pageFurniture';
import { A4 } from '../design/tokens';
import { FurnitureBandEditor, type MajFurniture } from './FurnitureBandEditor';

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

interface MesureProps {
  label: string;
  valeur: number;
  bornes: { min: number; max: number };
  unite?: string;
  onChange: (valeur: number) => void;
}

/** Champ de mesure borné : la saisie hors plage est ramenée, jamais refusée. */
function Mesure({ label, valeur, bornes, unite = 'mm', onChange }: MesureProps) {
  return (
    <label className="furniture__mesure">
      <span className="field__label">{label}</span>
      <span className="furniture__mesure-champ">
        <input
          className="stepper__input"
          type="number"
          min={bornes.min}
          max={bornes.max}
          step={unite === 'pt' ? 1 : 0.5}
          value={valeur}
          onChange={(event) => {
            const nombre = Number.parseFloat(event.target.value);
            if (Number.isFinite(nombre)) {
              onChange(Math.min(bornes.max, Math.max(bornes.min, nombre)));
            }
          }}
        />
        <span className="furniture__unite">{unite}</span>
      </span>
    </label>
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
}) {
  return (
    <label className="furniture__mesure">
      <span className="field__label">{label}</span>
      <select
        className="furniture__select"
        value={valeur}
        onChange={(event) => onChange(event.target.value as FurnitureAlign)}
      >
        <option value="left">Gauche</option>
        <option value="center">Centré</option>
        <option value="right">Droite</option>
      </select>
    </label>
  );
}

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

  const modifier = useCallback(
    (maj: MajFurniture): void => {
      const base = brouillonRef.current;
      const suivant = { ...base, ...(typeof maj === 'function' ? maj(base) : maj) };
      // Mise à jour immédiate de la référence : deux modifications dans le même
      // tour doivent se composer, pas s'écraser.
      brouillonRef.current = suivant;
      setBrouillon(suivant);
      // Application immédiate : le document est l'aperçu, comme pour les tableaux.
      onChange(suivant);
    },
    [onChange],
  );

  const contexteApercu = { page: Math.min(2, pages), pages, titre: titreDocument };
  const geometrie = resolveGeometry(brouillon);
  const utileMm = A4.widthMm - geometrie.marginLeftMm - geometrie.marginRightMm;

  // La bande cliquée passe en premier : c'est celle qu'on venait modifier.
  const ordre: FurnitureBand[] =
    bandeInitiale === 'footer' ? ['footer', 'header'] : ['header', 'footer'];

  return (
    <Modal title="En-tête et pied de page" onClose={onClose} width={640}>
      <div className="furniture">
        {ordre.map((band) => (
          <FurnitureBandEditor
            key={band}
            band={band}
            furniture={brouillon}
            contexte={contexteApercu}
            usableMm={utileMm}
            heightMm={band === 'header' ? geometrie.headerContentMm : geometrie.footerContentMm}
            selectedId={selection}
            onSelect={setSelection}
            onChange={modifier}
            docId={docId}
            token={token}
          />
        ))}

        <section className="furniture__section">
          <h3 className="table-props__title">Format</h3>

          <div className="furniture__grid">
            <Mesure
              label="En-tête, depuis le haut"
              valeur={brouillon.headerMm}
              bornes={FURNITURE_LIMITS.distanceMm}
              onChange={(headerMm) => modifier({ headerMm })}
            />
            <Alignement
              label="Alignement de l’en-tête"
              valeur={brouillon.headerAlign}
              onChange={(headerAlign) => modifier({ headerAlign })}
            />
            <Mesure
              label="Pied, depuis le bas"
              valeur={brouillon.footerMm}
              bornes={FURNITURE_LIMITS.distanceMm}
              onChange={(footerMm) => modifier({ footerMm })}
            />
            <Alignement
              label="Alignement du pied"
              valeur={brouillon.footerAlign}
              onChange={(footerAlign) => modifier({ footerAlign })}
            />
            <Mesure
              label="Taille du texte"
              unite="pt"
              valeur={brouillon.fontSizePt}
              bornes={FURNITURE_LIMITS.fontSizePt}
              onChange={(fontSizePt) => modifier({ fontSizePt })}
            />
          </div>
        </section>

        <section className="furniture__section">
          <h3 className="table-props__title">Marges du document</h3>

          <div className="furniture__grid">
            <Mesure
              label="Haut"
              valeur={brouillon.marginTopMm}
              bornes={FURNITURE_LIMITS.marginMm}
              onChange={(marginTopMm) => modifier({ marginTopMm })}
            />
            <Mesure
              label="Bas"
              valeur={brouillon.marginBottomMm}
              bornes={FURNITURE_LIMITS.marginMm}
              onChange={(marginBottomMm) => modifier({ marginBottomMm })}
            />
            <Mesure
              label="Gauche"
              valeur={brouillon.marginLeftMm}
              bornes={FURNITURE_LIMITS.marginMm}
              onChange={(marginLeftMm) => modifier({ marginLeftMm })}
            />
            <Mesure
              label="Droite"
              valeur={brouillon.marginRightMm}
              bornes={FURNITURE_LIMITS.marginMm}
              onChange={(marginRightMm) => modifier({ marginRightMm })}
            />
          </div>

          <p className="table-props__hint">
            Si l’en-tête ou le pied dépasse la marge, celle-ci est repoussée
            automatiquement : le texte ne peut pas passer dessous.
          </p>
        </section>

        <div className="furniture__options">
          <label className="furniture__check">
            <input
              type="checkbox"
              checked={brouillon.pageNumber}
              onChange={(event) => modifier({ pageNumber: event.target.checked })}
            />
            Numéroter les pages
          </label>
          <label className="furniture__check">
            <input
              type="checkbox"
              checked={!brouillon.onFirstPage}
              onChange={(event) => modifier({ onFirstPage: !event.target.checked })}
            />
            Masquer sur la première page
          </label>
        </div>

        <footer className="furniture__actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSelection(null);
              modifier({ header: '', footer: '', pageNumber: false, blocks: [] });
            }}
          >
            Tout retirer
          </button>
          <span className="titlebar__spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Terminé
          </button>
        </footer>
      </div>
    </Modal>
  );
}
