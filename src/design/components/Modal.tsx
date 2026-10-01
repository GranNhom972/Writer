// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Largeur **souhaitée**, en pixels.
   *
   * Ce n'est pas une largeur ferme : le CSS la ramène à ce que l'écran offre
   * (`min(largeur, 100vw - marges)`). Une valeur en dur débordait des petits
   * écrans, et il fallait alors faire défiler la fenêtre horizontalement pour
   * atteindre un bouton — le pire des défauts d'un dialogue.
   */
  width?: number;
  /**
   * Barre d'actions, épinglée **hors** de la zone défilante.
   *
   * Sans elle, « Appliquer » descend avec le contenu et disparaît sous le bord
   * de l'écran dès que le formulaire dépasse la hauteur disponible : on croit
   * le dialogue sans issue. Les dialogues courts peuvent l'ignorer et garder
   * leurs boutons dans le flux.
   */
  footer?: ReactNode;
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Dialogue modal accessible (directive UX §6.7) : focus déplacé à l'ouverture,
 * **piégé** pendant, et **restitué au déclencheur** à la fermeture ; `Échap` ferme ;
 * `aria-modal` isole le reste de la page pour les technologies d'assistance.
 */
export function Modal({ title, onClose, children, width = 640, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /**
   * Fermeture lue par référence.
   *
   * L'appelant passe presque toujours une fonction fléchée, donc une identité
   * neuve à chaque rendu. En dépendre relançait l'effet à chaque frappe : le
   * focus repartait sur le premier champ du dialogue, et la saisie devenait
   * impossible. L'effet ne doit s'armer qu'à l'ouverture.
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

      // Piège à focus : la tabulation boucle à l'intérieur du dialogue.
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
        // Largeur souhaitée passée en variable : c'est le CSS qui arbitre entre
        // elle et la place réellement disponible, et lui seul connaît les
        // marges du fond et le point de rupture mobile.
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
