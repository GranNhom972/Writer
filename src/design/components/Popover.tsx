// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface PopoverProps {
  /** Explicit positioning (panel detached from its button in the DOM). */
  style?: React.CSSProperties;
  className?: string;
  /** Accessible label of the panel. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Trigger element: focus returns to it on closing (WCAG 2.4.3). */
  triggerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Accessible floating panel: `Escape` closes, a click outside closes, focus enters on opening and **returns to the trigger** on
 * closing.
 */
export function Popover({ label, onClose, children, triggerRef, style, className }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const [alignEnd, setAlignEnd] = useState(false);

  /**
   * Alignment flip when the panel would overflow the window: measured before painting (`useLayoutEffect`), otherwise the user sees the
   * panel jump. Without it, a picker located at the right of the ribbon pushes a horizontal scrollbar across the whole page.
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
