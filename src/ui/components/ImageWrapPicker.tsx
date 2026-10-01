// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Choice of how an image fits into the text.
 *
 * Equivalent of Writer's "Format ▸ Wrap" menu (`sw/source/ui/shells/frmsh.cxx`, `FN_FRAME_WRAP*`): five entries, only one ticked, and the effect
 * is immediate on the page.
 *
 * ## Why a menu and not five buttons
 *
 * The five modes are **exclusive** and rarely changed. A row of five buttons would take that much space permanently for a setting that is touched
 * once per image; a menu shows the current state as one pictogram and only unfolds the others on request. It is Writer's choice, and for the same
 * reason.
 *
 * The component is **controlled**: it does not know the document, only the current mode and what to call to change it. It therefore serves as it is
 * for the toolbar of the selected image as well as for the editing window, without either having to know about the other.
 */

import { useRef, useState, type JSX } from 'react';
import { Popover } from '../../design/components/Popover';
import { Icon, type IconName } from '../../design/icons/Icon';
import { IMAGE_WRAP_MODES, type ImageWrapMode } from '../../domain/document/images';

/** Pictogram of each mode. */
const WRAP_ICONS: Record<ImageWrapMode, IconName> = {
  inline: 'wrap-inline',
  wrap: 'wrap-around',
  break: 'wrap-break',
  behind: 'wrap-behind',
  front: 'wrap-front',
};

export interface ImageWrapPickerProps {
  value: ImageWrapMode;
  onChange: (mode: ImageWrapMode) => void;
  disabled?: boolean;
  /**
   * Layout. `menu` is the compact trigger of the floating toolbars; `inline` unfolds the five choices, for a window where there is no lack of room and
   * where seeing the options side by side helps to choose.
   */
  variant?: 'menu' | 'inline';
}

const LABEL = 'Intégration de l’image au texte';

function modeLabel(mode: ImageWrapMode): string {
  return IMAGE_WRAP_MODES.find((entry) => entry.mode === mode)?.label ?? '';
}

export function ImageWrapPicker({
  value,
  onChange,
  disabled,
  variant = 'menu',
}: ImageWrapPickerProps): JSX.Element {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  if (variant === 'inline') {
    return (
      <div className="wrap-picker__choices" role="radiogroup" aria-label={LABEL}>
        {IMAGE_WRAP_MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            role="radio"
            aria-checked={entry.mode === value}
            className={
              entry.mode === value
                ? 'wrap-picker__choice wrap-picker__choice--active'
                : 'wrap-picker__choice'
            }
            title={entry.hint}
            disabled={disabled}
            onClick={() => onChange(entry.mode)}
          >
            <Icon name={WRAP_ICONS[entry.mode]} size={22} />
            <span className="wrap-picker__choice-label">{entry.label}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="wrap-picker">
      <button
        type="button"
        ref={(element) => {
          triggerRef.current = element;
        }}
        className="writer-image__action writer-image__action--icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${LABEL} — ${modeLabel(value)}`}
        title={`${LABEL} : ${modeLabel(value)}`}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon name={WRAP_ICONS[value]} size={20} />
        <Icon name="chevron-down" size={14} />
      </button>

      {open && (
        <Popover label={LABEL} onClose={() => setOpen(false)} triggerRef={triggerRef}>
          <div role="menu" aria-label={LABEL} className="wrap-picker__menu">
            {IMAGE_WRAP_MODES.map((entry) => (
              <button
                key={entry.mode}
                type="button"
                role="menuitemradio"
                aria-checked={entry.mode === value}
                className="wrap-picker__item"
                title={entry.hint}
                onClick={() => {
                  onChange(entry.mode);
                  setOpen(false);
                }}
              >
                <Icon name={WRAP_ICONS[entry.mode]} size={20} />
                <span className="wrap-picker__item-label">{entry.label}</span>
                {/* The tick takes its place even when absent: without that, the labels would slide by one notch on every change of mode and the menu would seem to jump. */}
                <span className="wrap-picker__check" aria-hidden="true">
                  {entry.mode === value ? '✓' : ''}
                </span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
