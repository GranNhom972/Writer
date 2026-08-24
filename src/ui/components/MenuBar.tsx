/**
 * Barre de menus (Fichier, Édition, Affichage, Insertion, Format, Outils, Aide).
 *
 * Conforme au motif ARIA « menubar » : `Alt` révèle les accès, les flèches
 * naviguent, `Échap` ferme et rend le focus. Toute entrée affiche son raccourci —
 * la barre de menus est le canal de découverte des raccourcis (directive UX §5.1).
 */

import { useEffect, useRef, useState } from 'react';

export interface MenuEntry {
  label: string;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
  /** Marque une entrée à bascule active (affichage, mode…). */
  checked?: boolean;
  /** Séparateur visuel avant cette entrée. */
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

function MenuPanel({ menu, onClose }: { menu: MenuDefinition; onClose: () => void }) {
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
            // Nom accessible explicite : la coche visuelle est décorative, l'état
            // réel est porté par `aria-checked` (pas de double annonce).
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
