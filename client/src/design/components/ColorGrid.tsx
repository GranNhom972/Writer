import { useEffect, useRef, useState } from 'react';
import type { Swatch } from '../color/palette';
import { parseHex, readableOutline } from '../color/color';

interface ColorGridProps {
  rows: readonly Swatch[][];
  /** Couleur actuellement appliquée, mise en évidence dans la grille. */
  value: string | null;
  label: string;
  onSelect: (color: string) => void;
}

/**
 * Grille de couleurs accessible.
 *
 * 80 pastilles = 80 arrêts de tabulation si chacune est focusable : la barre
 * d'outils deviendrait impraticable au clavier. On applique donc le motif ARIA
 * `grid` avec **tabulation itinérante** : un seul arrêt, les flèches se déplacent
 * de case en case, `Origine`/`Fin` vont aux extrémités de la ligne.
 */
export function ColorGrid({ rows, value, label, onSelect }: ColorGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState<[number, number]>(() => findValue(rows, value) ?? [0, 0]);

  // Le focus suit la couleur appliquée à l'ouverture : l'usager repart d'où il en est.
  useEffect(() => {
    const position = findValue(rows, value);
    if (position) setFocused(position);
  }, [rows, value]);

  const move = (rowDelta: number, colDelta: number): void => {
    setFocused(([row, col]) => {
      const nextRow = clamp(row + rowDelta, 0, rows.length - 1);
      const width = rows[nextRow]?.length ?? 1;
      const nextCol = clamp(col + colDelta, 0, width - 1);
      focusCell(gridRef.current, nextRow, nextCol);
      return [nextRow, nextCol];
    });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        move(0, 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        move(0, -1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        move(1, 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1, 0);
        break;
      case 'Home':
        event.preventDefault();
        move(0, -rows.length * 100);
        break;
      case 'End':
        event.preventDefault();
        move(0, rows.length * 100);
        break;
      default:
    }
  };

  return (
    <div className="color-grid" role="grid" aria-label={label} ref={gridRef} onKeyDown={onKeyDown}>
      {rows.map((row, rowIndex) => (
        <div className="color-grid__row" role="row" key={row[0]?.value ?? rowIndex}>
          {row.map((swatch, colIndex) => {
            const selected = value?.toLowerCase() === swatch.value.toLowerCase();
            const isFocusTarget = focused[0] === rowIndex && focused[1] === colIndex;
            const rgb = parseHex(swatch.value);

            return (
              <div role="gridcell" key={swatch.value}>
                <button
                  type="button"
                  className="color-grid__swatch"
                  style={{
                    background: swatch.value,
                    // Repère de sélection lisible sur clair comme sur foncé.
                    ...(selected && rgb ? { boxShadow: `inset 0 0 0 2px ${readableOutline(rgb)}` } : {}),
                  }}
                  // Un seul arrêt de tabulation dans toute la grille.
                  tabIndex={isFocusTarget ? 0 : -1}
                  aria-label={swatch.name}
                  aria-selected={selected}
                  title={`${swatch.name} · ${swatch.value.toUpperCase()}`}
                  data-row={rowIndex}
                  data-col={colIndex}
                  onFocus={() => setFocused([rowIndex, colIndex])}
                  onClick={() => onSelect(swatch.value)}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function findValue(rows: readonly Swatch[][], value: string | null): [number, number] | null {
  if (!value) return null;
  const needle = value.toLowerCase();
  for (let row = 0; row < rows.length; row += 1) {
    const index = rows[row]?.findIndex((swatch) => swatch.value.toLowerCase() === needle) ?? -1;
    if (index >= 0) return [row, index];
  }
  return null;
}

function focusCell(grid: HTMLElement | null, row: number, col: number): void {
  grid
    ?.querySelector<HTMLButtonElement>(`button[data-row="${row}"][data-col="${col}"]`)
    ?.focus();
}
