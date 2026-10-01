// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Choix de la taille d'un tableau par survol d'une grille.
 *
 * Deux champs numériques dans une fenêtre modale demandent de se représenter un
 * tableau à partir de deux nombres, puis de valider pour savoir si on s'est
 * trompé. La grille **montre** la taille pendant qu'on la choisit : un geste,
 * aucune validation, aucun aller-retour.
 *
 * Le clavier reste équivalent : flèches pour dimensionner, `Entrée` pour insérer
 * — le libellé annonce en continu la taille visée.
 */

import { useRef, useState } from 'react';
import { Popover } from '../../design/components/Popover';

const MAX_COLS = 10;
const MAX_ROWS = 8;

interface TableSizePickerProps {
  label: string;
  disabled?: boolean;
  onInsert: (rows: number, cols: number) => void;
  children: React.ReactNode;
  buttonRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

export function TableSizePicker({
  label,
  disabled = false,
  onInsert,
  children,
  buttonRef,
}: TableSizePickerProps) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ rows: 1, cols: 1 });
  const localRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = buttonRef ?? localRef;

  const close = (): void => {
    setOpen(false);
    setSize({ rows: 1, cols: 1 });
    triggerRef.current?.focus();
  };

  const insert = (rows: number, cols: number): void => {
    onInsert(rows, cols);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const moves: Record<string, [number, number]> = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
    };
    const move = moves[event.key];

    if (move) {
      event.preventDefault();
      setSize((current) => ({
        rows: Math.min(MAX_ROWS, Math.max(1, current.rows + move[0])),
        cols: Math.min(MAX_COLS, Math.max(1, current.cols + move[1])),
      }));
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      insert(size.rows, size.cols);
    }
  };

  return (
    <div className="picker">
      <button
        type="button"
        ref={(element) => {
          triggerRef.current = element;
        }}
        className="btn btn--icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        {children}
      </button>

      {open && (
        <Popover label={label} onClose={close} triggerRef={triggerRef}>
          <div className="table-picker">
            <div
              className="table-picker__grid"
              role="grid"
              aria-label={`Taille du tableau, jusqu’à ${MAX_ROWS} lignes sur ${MAX_COLS} colonnes`}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onMouseLeave={() => setSize({ rows: 1, cols: 1 })}
            >
              {Array.from({ length: MAX_ROWS }, (_, row) => (
                <div className="table-picker__row" role="row" key={row}>
                  {Array.from({ length: MAX_COLS }, (_, col) => {
                    const active = row < size.rows && col < size.cols;
                    return (
                      <button
                        key={col}
                        type="button"
                        role="gridcell"
                        // Une seule cellule est atteignable par tabulation : les
                        // 80 cases sont parcourues aux flèches (motif « grid »).
                        tabIndex={-1}
                        className={`table-picker__cell${active ? ' table-picker__cell--active' : ''}`}
                        aria-label={`${col + 1} colonne${col > 0 ? 's' : ''} sur ${row + 1} ligne${row > 0 ? 's' : ''}`}
                        aria-selected={active}
                        onMouseEnter={() => setSize({ rows: row + 1, cols: col + 1 })}
                        onFocus={() => setSize({ rows: row + 1, cols: col + 1 })}
                        onClick={() => insert(row + 1, col + 1)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Retour permanent : la taille visée se lit sans compter les cases. */}
            <p className="table-picker__label" aria-live="polite">
              {size.cols} × {size.rows}
              <span className="table-picker__hint">
                {' '}
                — {size.cols} colonne{size.cols > 1 ? 's' : ''}, {size.rows} ligne
                {size.rows > 1 ? 's' : ''}
              </span>
            </p>
          </div>
        </Popover>
      )}
    </div>
  );
}
