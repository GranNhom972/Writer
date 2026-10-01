// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface PopoverProps {
  /** Positionnement explicite (panneau détaché de son bouton dans le DOM). */
  style?: React.CSSProperties;
  className?: string;
  /** Libellé accessible du panneau. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Élément déclencheur : le focus lui revient à la fermeture (WCAG 2.4.3). */
  triggerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Panneau flottant accessible : `Échap` ferme, un clic extérieur ferme, le focus
 * entre à l'ouverture et **revient au déclencheur** à la fermeture.
 */
export function Popover({ label, onClose, children, triggerRef, style, className }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const [alignEnd, setAlignEnd] = useState(false);

  /**
   * Bascule d'alignement quand le panneau déborderait de la fenêtre : mesuré
   * avant peinture (`useLayoutEffect`), sinon l'usager voit le panneau sauter.
   * Sans cela, un sélecteur situé à droite du ruban pousse une barre de
   * défilement horizontale sur toute la page.
   */
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    if (rect.right > window.innerWidth - margin) setAlignEnd(true);
  }, [children]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = panel.querySelector<HTMLElement>(
      'input, button, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        triggerRef.current?.focus();
      }
    };

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!panel.contains(target) && !triggerRef.current?.contains(target)) onClose();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, triggerRef]);

  return (
    <div
      className={[alignEnd ? 'popover popover--end' : 'popover', className].filter(Boolean).join(' ')}
      role="dialog"
      aria-label={label}
      aria-labelledby={labelId}
      ref={panelRef}
      {...(style ? { style } : {})}
    >
      <span id={labelId} className="visually-hidden">
        {label}
      </span>
      {children}
    </div>
  );
}
