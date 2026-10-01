// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * **Desired** width, in pixels.
   *
   * It is not a firm width: the CSS brings it down to what the screen offers (`min(width, 100vw - margins)`). A hard-coded value
   * overflowed small screens, and the window then had to be scrolled sideways to reach a button, the worst defect of a dialog.
   */
  width?: number;
  /**
   * Action bar, pinned **outside** the scrolling area.
   *
   * Without it, "Apply" goes down with the content and disappears under the edge of the screen as soon as the form is taller than the
   * available height: the dialog looks like it has no way out. Short dialogs can ignore it and keep their buttons in the flow.
   */
  footer?: ReactNode;
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog (UX directive §6.7): focus moved on opening, **trapped** while open, and **given back to the trigger** on
 * closing; `Escape` closes; `aria-modal` isolates the rest of the page for assistive technologies.
 */
export function Modal({ title, onClose, children, width = 640, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /**
   * Close callback read by reference.
   *
   * The caller almost always passes an arrow function, so a new identity on every render. Depending on it re-ran the effect on every
   * keystroke: the focus went back to the first field of the dialog, and typing became impossible. The effect must only arm itself on
   * opening.
   */
  const fermerRef = useRef(onClose);
  fermerRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        fermerRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      // Focus trap: Tab loops inside the dialog.
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Desired width passed as a variable: it is the CSS that arbitrates between it and the room actually available, and only it knows the
        // margins of the backdrop and the mobile breakpoint.
        style={{ '--modal-width': `${width}px` } as CSSProperties}
        ref={panelRef}
      >
        <header className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="btn btn--icon" aria-label="Fermer" onClick={onClose}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
