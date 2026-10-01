// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useEffect, useRef, useState } from 'react';
import type { Swatch } from '../color/palette';
import { parseHex, readableOutline } from '../color/color';

interface ColorGridProps {
  rows: readonly Swatch[][];
  /** Color currently applied, highlighted in the grid. */
  value: string | null;
  label: string;
  onSelect: (color: string) => void;
}

/**
 * Accessible color grid.
 *
 * 80 swatches = 80 tab stops if each one is focusable: the toolbar would become unusable with the keyboard. We therefore apply the
 * ARIA `grid` pattern with **roving tabindex**: a single tab stop, the arrow keys move from cell to cell, `Home`/`End` go to the
 * ends of the row.
 */
export function ColorGrid({ rows, value, label, onSelect }: ColorGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState<[number, number]>(() => findValue(rows, value) ?? [0, 0]);

  // Focus follows the applied color when opening: the user resumes where they are.
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
                    // Selection marker that is readable on light as well as dark.
                    ...(selected && rgb ? { boxShadow: `inset 0 0 0 2px ${readableOutline(rgb)}` } : {}),
                  }}
                  // A single tab stop in the whole grid.
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
