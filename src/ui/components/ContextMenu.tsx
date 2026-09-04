/**
 * Menu contextuel du document — le clic droit.
 *
 * Les commandes de tableau ne vivaient que dans le menu « Tableau » de la barre
 * supérieure. Or c'est au clic droit **sur la grille** qu'on les cherche : c'est
 * là que Word, Google Docs et Writer les placent, et c'est le seul endroit où
 * elles désignent sans ambiguïté la ligne et la colonne visées. Un utilisateur
 * qui ne trouve pas « supprimer la ligne » sous son curseur conclut qu'elle
 * n'existe pas.
 *
 * Le panneau est celui de la barre de menus, réutilisé tel quel : mêmes
 * entrées, mêmes séparateurs, même navigation au clavier.
 */

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { MenuPanel, type MenuDefinition } from './MenuBar';

export interface ContextMenuProps {
  /** Position du clic, en coordonnées de fenêtre. */
  x: number;
  y: number;
  menu: MenuDefinition;
  onClose: () => void;
}

/** Marge minimale entre le panneau et le bord de la fenêtre. */
const EDGE_PX = 8;

export function ContextMenu({ x, y, menu, onClose }: ContextMenuProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  /*
   * Le panneau se replie sur le bord opposé plutôt que de déborder : un menu
   * ouvert près du bas de l'écran doit rester entièrement lisible, sans faire
   * défiler la page. La mesure a lieu en `useLayoutEffect`, avant la peinture,
   * pour qu'aucune image ne montre le panneau à sa position naïve.
   */
  useLayoutEffect(() => {
    const panel = hostRef.current?.firstElementChild;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();

    const left =
      x + rect.width + EDGE_PX > window.innerWidth
        ? Math.max(EDGE_PX, x - rect.width)
        : x;
    const top =
      y + rect.height + EDGE_PX > window.innerHeight
        ? Math.max(EDGE_PX, y - rect.height)
        : y;

    setPosition({ left, top });
  }, [x, y]);

  useEffect(() => {
    // Un clic ailleurs ferme, comme la barre de menus. `pointerdown` plutôt que
    // `click` : le menu doit disparaître dès l'appui, pas au relâchement.
    const onPointerDown = (event: PointerEvent): void => {
      if (!hostRef.current?.contains(event.target as Node)) onClose();
    };
    // Un défilement ou un redimensionnement laisserait le panneau orphelin,
    // ancré à un point qui n'a plus de rapport avec ce qu'il désigne.
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={hostRef}
      className="context-menu"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      <MenuPanel menu={menu} onClose={onClose} />
    </div>
  );
}
