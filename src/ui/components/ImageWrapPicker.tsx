// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Choix de l'intégration d'une image au texte.
 *
 * Équivalent du menu « Format ▸ Adaptation du texte » de Writer
 * (`sw/source/ui/shells/frmsh.cxx`, `FN_FRAME_WRAP*`) : cinq entrées, une seule
 * cochée, et l'effet est immédiat sur la page.
 *
 * ## Pourquoi un menu et non cinq boutons
 *
 * Les cinq modes sont **exclusifs** et rarement changés. Une rangée de cinq
 * boutons demanderait autant de place en permanence pour un réglage qu'on
 * touche une fois par image ; un menu montre l'état courant en un pictogramme
 * et ne déploie les autres que si on le demande. C'est le choix de Writer, et
 * la raison en est la même.
 *
 * Le composant est **contrôlé** : il ne connaît pas le document, seulement le
 * mode courant et ce qu'il faut appeler pour en changer. Il sert donc tel quel
 * à la barre de l'image sélectionnée comme à la fenêtre de retouche, sans que
 * l'une ait à connaître l'autre.
 */

import { useRef, useState, type JSX } from 'react';
import { Popover } from '../../design/components/Popover';
import { Icon, type IconName } from '../../design/icons/Icon';
import { IMAGE_WRAP_MODES, type ImageWrapMode } from '../../domain/document/images';

/** Pictogramme de chaque mode. */
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
   * Disposition. `menu` est le déclencheur compact des barres flottantes ;
   * `inline` déplie les cinq choix, pour une fenêtre où la place ne manque pas
   * et où voir les options côte à côte aide à choisir.
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
                {/*
                  La coche occupe sa place même quand elle est absente : sans
                  cela, les libellés glisseraient d'un cran à chaque changement
                  de mode et le menu paraîtrait sauter.
                */}
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
