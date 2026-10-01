// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Menu bar (File, Edit, View, Insert, Format, Tools, Help).
 *
 * Follows the ARIA "menubar" pattern: `Alt` reveals the access keys, the arrows navigate, `Escape` closes and gives the focus back. Every entry shows
 * its shortcut: the menu bar is the channel through which shortcuts are discovered (UX directive §5.1).
 */

import { useEffect, useRef, useState } from 'react';

export interface MenuEntry {
  label: string;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
  /** Marks a toggle entry as active (display, mode...). */
  checked?: boolean;
  /** Visual separator before this entry. */
  separatorBefore?: boolean;
}

export interface MenuDefinition {
  label: string;
  entries: MenuEntry[];
}

interface MenuBarProps {
  menus: MenuDefinition[];
}

export function MenuBar({ menus }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (openIndex === null) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!barRef.current?.contains(event.target as Node)) setOpenIndex(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [openIndex]);

  const focusTrigger = (index: number): void => {
    const next = (index + menus.length) % menus.length;
    triggerRefs.current[next]?.focus();
    setOpenIndex((current) => (current === null ? null : next));
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTrigger(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTrigger(index - 1);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        setOpenIndex(index);
        break;
      case 'Escape':
        setOpenIndex(null);
        break;
      default:
    }
  };

  const onPointerEnterTrigger = (index: number): void => {
    if (openIndex !== null && openIndex !== index) {
      setOpenIndex(index);
    }
  };

  return (
    <div className="menubar" role="menubar" aria-label="Menus de l’application" ref={barRef}>
      {menus.map((menu, index) => (
        <div className="menubar__item" key={menu.label}>
          <button
            type="button"
            role="menuitem"
            className="menubar__trigger"
            aria-haspopup="true"
            aria-expanded={openIndex === index}
            ref={(element) => {
              triggerRefs.current[index] = element;
            }}
            onClick={() => setOpenIndex((current) => (current === index ? null : index))}
            onPointerEnter={() => onPointerEnterTrigger(index)}
            onKeyDown={(event) => onTriggerKeyDown(event, index)}
          >
            {menu.label}
          </button>

          {openIndex === index && (
            <MenuPanel
              menu={menu}
              onClose={() => {
                setOpenIndex(null);
                triggerRefs.current[index]?.focus();
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Panel of a menu: the list of entries itself.
 *
 * Exported so that the context menu reuses it as it is: two separate implementations would end up diverging on a detail of focus, separator or tick,
 * and the user would see two different menus for the same commands.
 */
export function MenuPanel({ menu, onClose }: { menu: MenuDefinition; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, []);

  const items = (): HTMLButtonElement[] =>
    Array.from(panelRef.current?.querySelectorAll('button:not(:disabled)') ?? []);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const buttons = items();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        buttons[(current + 1) % buttons.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        buttons[(current - 1 + buttons.length) % buttons.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        buttons[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        buttons[buttons.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      default:
    }
  };

  return (
    <div className="menu" role="menu" aria-label={menu.label} ref={panelRef} onKeyDown={onKeyDown}>
      {menu.entries.map((entry) => (
        <div key={entry.label} className={entry.separatorBefore ? 'menu__group' : undefined}>
          <button
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            {...(entry.checked === undefined ? {} : { 'aria-checked': entry.checked })}
            className="menu__entry"
            // Explicit accessible name: the visual tick is decorative, the real state is carried by `aria-checked` (no double announcement).
            aria-label={entry.label}
            disabled={entry.disabled ?? false}
            onClick={() => {
              entry.run();
              onClose();
            }}
          >
            <span className="menu__label">
              <span className="menu__check" aria-hidden="true">
                {entry.checked ? '✓' : ''}
              </span>
              {entry.label}
            </span>
            {entry.shortcut && (
              <span className="menu__shortcut" aria-hidden="true">
                {entry.shortcut}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
