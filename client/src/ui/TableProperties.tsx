/**
 * Propriétés du tableau sous le curseur.
 *
 * Tout s'applique **immédiatement** : pas de bouton « Appliquer », pas d'aperçu
 * fictif — le document EST l'aperçu. Chaque réglage reste annulable (`Ctrl+Z`),
 * ce qui rend l'essai sans risque et supprime le besoin d'un « Annuler » propre
 * au panneau.
 */

import { useEffect, useState } from 'react';
import { Popover } from '../design/components/Popover';
import { ColorPicker } from '../design/components/ColorPicker';
import { Icon } from '../design/icons/Icon';
import { DOCUMENT_PALETTE } from '../design/color/palette';
import type { TableInfo } from '../editor/commands';

export const MIN_TABLE_BORDER = 0;
export const MAX_TABLE_BORDER = 6;

interface TablePropertiesProps {
  info: TableInfo;
  disabled?: boolean;
  onResize: (rows: number, cols: number) => void;
  onBorderWidth: (width: number) => void;
  onBorderColor: (color: string | null) => void;
  onHeaderRow: (enabled: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
  triggerRef: React.MutableRefObject<HTMLButtonElement | null>;
  /** Coin haut-droit sous lequel afficher le panneau (repère de la fenêtre). */
  anchor?: { top: number; right: number } | undefined;
}

export function TableProperties({
  info,
  disabled = false,
  onResize,
  onBorderWidth,
  onBorderColor,
  onHeaderRow,
  onDelete,
  onClose,
  triggerRef,
  anchor,
}: TablePropertiesProps) {
  // État local synchronisé sur le document : le tableau peut aussi changer sous
  // nos pieds (modification d'un collaborateur, annulation).
  const [rows, setRows] = useState(info.rows);
  const [cols, setCols] = useState(info.cols);

  useEffect(() => {
    setRows(info.rows);
    setCols(info.cols);
  }, [info.rows, info.cols]);

  const applyRows = (value: number): void => {
    const next = Math.max(1, Math.min(50, value));
    setRows(next);
    onResize(next, cols);
  };

  const applyCols = (value: number): void => {
    const next = Math.max(1, Math.min(20, value));
    setCols(next);
    onResize(rows, next);
  };

  return (
    <Popover
      label="Propriétés du tableau"
      onClose={onClose}
      triggerRef={triggerRef}
      className="popover--anchored"
      {...(anchor
        ? {
            style: {
              position: 'fixed' as const,
              top: anchor.top,
              right: anchor.right,
              insetInlineStart: 'auto',
            },
          }
        : {})}
    >
      <div className="table-props">
        <section className="table-props__section">
          <h3 className="table-props__title">Dimensions</h3>

          <Stepper
            label="Lignes"
            value={rows}
            min={1}
            max={50}
            disabled={disabled}
            onChange={applyRows}
          />
          <Stepper
            label="Colonnes"
            value={cols}
            min={1}
            max={20}
            disabled={disabled}
            onChange={applyCols}
          />

          <p className="table-props__hint">
            Réduire supprime les lignes et colonnes de fin, avec leur contenu.
            <br />
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> revient en arrière.
          </p>
        </section>

        <section className="table-props__section">
          <h3 className="table-props__title">Bordures</h3>

          <label className="table-props__field">
            <span className="table-props__label">
              Épaisseur
              <output className="table-props__value">
                {info.borderWidth === 0 ? 'aucune' : `${info.borderWidth} px`}
              </output>
            </span>
            <input
              type="range"
              min={MIN_TABLE_BORDER}
              max={MAX_TABLE_BORDER}
              step={1}
              value={info.borderWidth}
              disabled={disabled}
              aria-label="Épaisseur des bordures, en pixels"
              aria-valuetext={info.borderWidth === 0 ? 'aucune bordure' : `${info.borderWidth} pixels`}
              onChange={(event) => onBorderWidth(Number(event.target.value))}
            />
          </label>

          <div className="table-props__field table-props__field--inline">
            <span className="table-props__label">Couleur</span>
            <ColorPicker
              label="Couleur des bordures"
              value={info.borderColor}
              palette={DOCUMENT_PALETTE}
              resetLabel="Couleur automatique"
              disabled={disabled}
              onSelect={onBorderColor}
            >
              <Icon name="table" />
            </ColorPicker>
          </div>

          <label className="table-props__check">
            <input
              type="checkbox"
              checked={info.headerRow}
              disabled={disabled}
              onChange={(event) => onHeaderRow(event.target.checked)}
            />
            Première ligne en en-tête
          </label>
        </section>

        <footer className="table-props__actions">
          <button type="button" className="btn" disabled={disabled} onClick={onDelete}>
            <Icon name="trash" size={16} />
            Supprimer le tableau
          </button>
        </footer>
      </div>
    </Popover>
  );
}

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

/** Champ numérique encadré de deux boutons : cibles larges, pas de flèches natives. */
function Stepper({ label, value, min, max, disabled, onChange }: StepperProps) {
  return (
    <div className="table-props__field table-props__field--inline">
      <span className="table-props__label" id={`stepper-${label}`}>
        {label}
      </span>
      <div className="stepper">
        <button
          type="button"
          className="btn btn--icon"
          aria-label={`Retirer une ${label.toLowerCase().replace(/s$/, '')}`}
          disabled={disabled || value <= min}
          onClick={() => onChange(value - 1)}
        >
          <Icon name="minus" size={16} />
        </button>
        <input
          className="stepper__input"
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          aria-labelledby={`stepper-${label}`}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
        <button
          type="button"
          className="btn btn--icon"
          aria-label={`Ajouter une ${label.toLowerCase().replace(/s$/, '')}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(value + 1)}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
    </div>
  );
}
