// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from './Popover';
import { ColorGrid } from './ColorGrid';
import { CustomColorDialog } from './CustomColorDialog';
import { describeColor, type Swatch } from '../color/palette';
import { parseHex, readableOutline, toHex } from '../color/color';

const STORAGE_KEY = 'write:custom-colors';
const MAX_CUSTOM = 10;

/** Couleurs personnalisées : conservées entre les sessions, les plus récentes d'abord. */
function readCustomColors(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && parseHex(entry) !== null);
  } catch {
    // Stockage indisponible (navigation privée, quota) : ce n'est pas une panne,
    // la palette reste utilisable sans mémoire.
    return [];
  }
}

function writeCustomColors(colors: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    /* mémoire indisponible : sans effet sur la fonction */
  }
}

interface ColorPickerProps {
  label: string;
  /** Couleur active, affichée sous le glyphe du bouton. */
  value: string | null;
  palette: readonly Swatch[][];
  /** Libellé de l'option « aucune couleur ». */
  resetLabel: string;
  /** Fond de référence pour le calcul de contraste du sélecteur personnalisé. */
  contrastBackground?: string;
  onSelect: (color: string | null) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

export function ColorPicker({
  label,
  value,
  palette,
  resetLabel,
  contrastBackground = '#ffffff',
  onSelect,
  disabled = false,
  children,
}: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customColors, setCustomColors] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) setCustomColors(readCustomColors());
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setCustomOpen(false);
    triggerRef.current?.focus();
  }, []);

  const choose = (color: string | null): void => {
    onSelect(color);
    close();
  };

  const confirmCustom = (hex: string): void => {
    const normalized = toHex(parseHex(hex) ?? { r: 0, g: 0, b: 0 });
    const next = [normalized, ...customColors.filter((entry) => entry !== normalized)].slice(0, MAX_CUSTOM);
    setCustomColors(next);
    writeCustomColors(next);
    choose(normalized);
  };

  const activeRgb = value ? parseHex(value) : null;

  return (
    <div className="picker">
      <button
        type="button"
        ref={triggerRef}
        className="btn btn--icon picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `${label} : ${describeColor(value)}` : label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        {children}
      </button>

      {open && (
        <Popover label={label} onClose={close} triggerRef={triggerRef}>
          {customOpen ? (
            <CustomColorDialog
              initial={value ?? '#1a56db'}
              background={contrastBackground}
              onCancel={() => setCustomOpen(false)}
              onConfirm={confirmCustom}
            />
          ) : (
            <div className="palette">
              <button type="button" className="palette__reset" onClick={() => choose(null)}>
                <span className="palette__reset-chip" aria-hidden="true" />
                {resetLabel}
              </button>

              <ColorGrid rows={palette} value={value} label={label} onSelect={choose} />

              <div className="palette__custom">
                <h3 className="palette__title" id={`${label}-custom`}>
                  Personnalisé
                </h3>
                <div className="palette__custom-row" role="group" aria-labelledby={`${label}-custom`}>
                  {customColors.map((color) => {
                    const rgb = parseHex(color);
                    const selected = value?.toLowerCase() === color.toLowerCase();
                    return (
                      <button
                        key={color}
                        type="button"
                        className="color-grid__swatch"
                        style={{
                          background: color,
                          ...(selected && rgb
                            ? { boxShadow: `inset 0 0 0 2px ${readableOutline(rgb)}` }
                            : {}),
                        }}
                        aria-label={`Couleur personnalisée ${color.toUpperCase()}`}
                        aria-pressed={selected}
                        title={color.toUpperCase()}
                        onClick={() => choose(color)}
                      />
                    );
                  })}

                  <button
                    type="button"
                    className="palette__add"
                    aria-label="Choisir une couleur personnalisée"
                    title="Couleur personnalisée (HEX ou RVB)"
                    onClick={() => setCustomOpen(true)}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
              </div>

              {activeRgb && (
                <p className="palette__current">
                  Actuelle : {describeColor(value ?? '')} ({value?.toUpperCase()})
                </p>
              )}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
