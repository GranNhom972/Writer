// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Context menu of the document: the right click.
 *
 * The table commands only lived in the "Table" menu of the top bar. Yet people look for them on a right click **on the grid**: that is where
 * Word, Google Docs and Writer put them, and it is the only place where they unambiguously designate the targeted row and column. A user who
 * does not find "delete the row" under their cursor concludes that it does not exist.
 *
 * The panel is that of the menu bar, reused as it is: same entries, same separators, same keyboard navigation.
 */

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { MenuPanel, type MenuDefinition } from './MenuBar';

export interface ContextMenuProps {
  /** Position of the click, in window coordinates. */
  x: number;
  y: number;
  menu: MenuDefinition;
  onClose: () => void;
}

/** Minimum margin between the panel and the edge of the window. */
const EDGE_PX = 8;

export function ContextMenu({ x, y, menu, onClose }: ContextMenuProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  /*
   * The panel folds back on the opposite edge rather than overflow: a menu opened near the bottom of the screen must stay fully readable,
   * without scrolling the page. The measurement happens in `useLayoutEffect`, before painting, so that no frame shows the panel at its naive
   * position.
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
    // A click elsewhere closes it, like the menu bar. `pointerdown` rather than `click`: the menu must disappear on press, not on release.
    const onPointerDown = (event: PointerEvent): void => {
      if (!hostRef.current?.contains(event.target as Node)) onClose();
    };
    // Scrolling or resizing would leave the panel orphaned, anchored to a point that no longer has anything to do with what it designates.
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
