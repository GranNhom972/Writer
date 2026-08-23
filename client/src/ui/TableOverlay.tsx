/**
 * Manipulation directe du tableau, posée sur le tableau lui-même.
 *
 * L'idée : arrêter de faire voyager l'usager entre son tableau et un panneau
 * distant. Trois gestes couvrent 95 % des besoins, à l'endroit exact où il
 * regarde :
 *
 *  1. **Poignées de ligne et de colonne** (barres fines sur les bords). Survol →
 *     la ligne ou la colonne s'éclaire ; clic → menu court (insérer avant/après,
 *     supprimer). Chaque poignée est un vrai bouton, donc atteignable au clavier.
 *  2. **Points d'insertion « + » aux frontières.** Un clic ajoute exactement là
 *     où l'on pointe — pas « à la fin », pas « après la ligne courante ».
 *  3. **Poignée d'angle** en bas à droite : on tire pour dimensionner le tableau
 *     comme on étire une plage de tableur, avec un badge « 4 × 6 » qui suit le
 *     geste. Le redimensionnement n'est appliqué qu'au relâchement — tirer ne
 *     doit pas produire vingt entrées d'historique.
 *
 * L'ensemble s'efface dès que le curseur quitte le tableau : aucune décoration
 * permanente sur le document.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorView } from 'prosemirror-view';
import { Icon } from '../design/icons/Icon';
import type { TableInfo } from '../editor/commands';

export interface TableGeometry {
  /** Position du tableau dans le repère du conteneur. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Bords droits de chaque colonne, relatifs à `left`. */
  columnEdges: number[];
  /** Bords bas de chaque ligne, relatifs à `top`. */
  rowEdges: number[];
}

/**
 * Mesure le tableau dans le repère d'un conteneur.
 * Exporté pour être testable : c'est du calcul de géométrie, pas du rendu.
 */
export function measureTable(table: HTMLElement, container: HTMLElement): TableGeometry | null {
  const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
  if (rows.length === 0) return null;

  const tableRect = table.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const scrollTop = container.scrollTop;

  const firstRow = rows[0]!;
  const columnEdges = Array.from(firstRow.children).map(
    (cell) => cell.getBoundingClientRect().right - tableRect.left,
  );
  const rowEdges = rows.map((row) => row.getBoundingClientRect().bottom - tableRect.top);

  return {
    left: tableRect.left - containerRect.left,
    top: tableRect.top - containerRect.top + scrollTop,
    width: tableRect.width,
    height: tableRect.height,
    columnEdges,
    rowEdges,
  };
}

/**
 * Élément DOM du tableau courant.
 *
 * `nodeDOM` ne répond pas toujours (nœud rendu par une vue personnalisée, ou
 * position pas encore reflétée dans le DOM). On retombe alors sur la position du
 * curseur, qui est forcément dans le tableau puisque `info` en vient.
 */
function findTableElement(view: EditorView, info: TableInfo): HTMLElement | null {
  const dom = view.nodeDOM(info.pos);
  if (dom instanceof HTMLElement) {
    const found = dom.tagName === 'TABLE' ? dom : dom.querySelector('table');
    if (found instanceof HTMLElement) return found;
  }

  const at = view.domAtPos(view.state.selection.from);
  const node = at.node instanceof HTMLElement ? at.node : at.node.parentElement;
  return node?.closest('table') ?? null;
}

interface TableOverlayProps {
  view: EditorView | null;
  info: TableInfo | null;
  disabled?: boolean;
  container: HTMLElement | null;
  onInsertRow: (index: number) => void;
  onDeleteRow: (index: number) => void;
  onInsertColumn: (index: number) => void;
  onDeleteColumn: (index: number) => void;
  onResize: (rows: number, cols: number) => void;
  onOpenProperties: () => void;
}

type Menu = { kind: 'row' | 'column'; index: number } | null;

export function TableOverlay({
  view,
  info,
  disabled = false,
  container,
  onInsertRow,
  onDeleteRow,
  onInsertColumn,
  onDeleteColumn,
  onResize,
  onOpenProperties,
}: TableOverlayProps) {
  const [geometry, setGeometry] = useState<TableGeometry | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [drag, setDrag] = useState<{ rows: number; cols: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // La géométrie est relue après chaque changement du document, au défilement et
  // au redimensionnement : le tableau bouge, les poignées doivent suivre.
  const measure = useCallback(() => {
    if (!view || view.isDestroyed || !info || !container) {
      setGeometry(null);
      return;
    }
    const element = findTableElement(view, info);
    setGeometry(element ? measureTable(element, container) : null);
  }, [view, info, container]);

  // Mesure **avant peinture** : les poignées apparaissent déjà placées, sans le
  // saut d'une frame que produirait `requestAnimationFrame`.
  useLayoutEffect(() => {
    measure();
  }, [measure, info?.rows, info?.cols, info?.pos]);

  useEffect(() => {
    if (!container) return;
    const onChange = (): void => measure();
    container.addEventListener('scroll', onChange, { passive: true });
    window.addEventListener('resize', onChange);
    const observer = new ResizeObserver(onChange);
    observer.observe(container);
    return () => {
      container.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
      observer.disconnect();
    };
  }, [container, measure]);

  useEffect(() => setMenu(null), [info?.pos, info?.rows, info?.cols]);

  /** Étirement depuis l'angle : aperçu pendant le geste, application au relâcher. */
  const startCornerDrag = (event: React.PointerEvent): void => {
    if (!geometry || !info || disabled) return;
    event.preventDefault();

    const cellWidth = geometry.width / Math.max(1, info.cols);
    const cellHeight = geometry.height / Math.max(1, info.rows);
    const originX = event.clientX;
    const originY = event.clientY;

    const compute = (moveEvent: PointerEvent): { rows: number; cols: number } => ({
      cols: Math.max(1, Math.min(20, info.cols + Math.round((moveEvent.clientX - originX) / cellWidth))),
      rows: Math.max(1, Math.min(50, info.rows + Math.round((moveEvent.clientY - originY) / cellHeight))),
    });

    const onMove = (moveEvent: PointerEvent): void => setDrag(compute(moveEvent));
    const onUp = (upEvent: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);

      const target = compute(upEvent);
      setDrag(null);
      if (target.rows !== info.rows || target.cols !== info.cols) {
        onResize(target.rows, target.cols);
      }
    };

    setDrag({ rows: info.rows, cols: info.cols });
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  if (!info || !geometry) return null;

  const preview = drag ?? { rows: info.rows, cols: info.cols };

  return (
    <div
      className="table-overlay"
      ref={overlayRef}
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
      // Décoration d'édition : elle ne fait pas partie du document lu.
      aria-hidden={disabled}
    >
      {/* --- Poignées de colonne, au-dessus du tableau --- */}
      {!disabled &&
        geometry.columnEdges.map((edge, index) => {
          const start = index === 0 ? 0 : geometry.columnEdges[index - 1]!;
          return (
            <button
              key={`col-${index}`}
              type="button"
              className={`table-overlay__grip table-overlay__grip--col${menu?.kind === 'column' && menu.index === index ? ' table-overlay__grip--active' : ''}`}
              style={{ left: start, width: edge - start }}
              aria-label={`Colonne ${index + 1} : options`}
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'column' && menu.index === index}
              onClick={() =>
                setMenu((current) =>
                  current?.kind === 'column' && current.index === index ? null : { kind: 'column', index },
                )
              }
            />
          );
        })}

      {/* --- Poignées de ligne, à gauche --- */}
      {!disabled &&
        geometry.rowEdges.map((edge, index) => {
          const start = index === 0 ? 0 : geometry.rowEdges[index - 1]!;
          return (
            <button
              key={`row-${index}`}
              type="button"
              className={`table-overlay__grip table-overlay__grip--row${menu?.kind === 'row' && menu.index === index ? ' table-overlay__grip--active' : ''}`}
              style={{ top: start, height: edge - start }}
              aria-label={`Ligne ${index + 1} : options`}
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'row' && menu.index === index}
              onClick={() =>
                setMenu((current) =>
                  current?.kind === 'row' && current.index === index ? null : { kind: 'row', index },
                )
              }
            />
          );
        })}

      {/* --- Points d'insertion aux frontières de colonnes --- */}
      {!disabled &&
        [0, ...geometry.columnEdges].map((edge, index) => (
          <button
            key={`add-col-${index}`}
            type="button"
            className="table-overlay__add table-overlay__add--col"
            style={{ left: edge }}
            aria-label={`Insérer une colonne en position ${index + 1}`}
            title="Insérer une colonne ici"
            onClick={() => onInsertColumn(index)}
          >
            <Icon name="plus" size={12} />
          </button>
        ))}

      {/* --- Points d'insertion aux frontières de lignes --- */}
      {!disabled &&
        [0, ...geometry.rowEdges].map((edge, index) => (
          <button
            key={`add-row-${index}`}
            type="button"
            className="table-overlay__add table-overlay__add--row"
            style={{ top: edge }}
            aria-label={`Insérer une ligne en position ${index + 1}`}
            title="Insérer une ligne ici"
            onClick={() => onInsertRow(index)}
          >
            <Icon name="plus" size={12} />
          </button>
        ))}

      {/* --- Poignée d'angle : étirer pour dimensionner --- */}
      {!disabled && (
        <button
          type="button"
          className="table-overlay__corner"
          aria-label={`Dimensions : ${info.cols} colonnes sur ${info.rows} lignes. Ouvrir les propriétés pour les modifier au clavier.`}
          title="Étirer pour redimensionner"
          onPointerDown={startCornerDrag}
          onClick={onOpenProperties}
        />
      )}

      {drag && (
        <span className="table-overlay__badge" role="status" aria-live="polite">
          {preview.cols} × {preview.rows}
        </span>
      )}

      {/* --- Menu court d'une ligne ou d'une colonne --- */}
      {menu && (
        <div
          className={`table-overlay__menu table-overlay__menu--${menu.kind}`}
          role="menu"
          aria-label={menu.kind === 'row' ? `Ligne ${menu.index + 1}` : `Colonne ${menu.index + 1}`}
          style={
            menu.kind === 'column'
              ? { left: menu.index === 0 ? 0 : geometry.columnEdges[menu.index - 1] }
              : { top: menu.index === 0 ? 0 : geometry.rowEdges[menu.index - 1] }
          }
        >
          <button
            type="button"
            role="menuitem"
            className="table-overlay__item"
            onClick={() => {
              menu.kind === 'row' ? onInsertRow(menu.index) : onInsertColumn(menu.index);
              setMenu(null);
            }}
          >
            Insérer {menu.kind === 'row' ? 'au-dessus' : 'à gauche'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="table-overlay__item"
            onClick={() => {
              menu.kind === 'row' ? onInsertRow(menu.index + 1) : onInsertColumn(menu.index + 1);
              setMenu(null);
            }}
          >
            Insérer {menu.kind === 'row' ? 'en dessous' : 'à droite'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="table-overlay__item table-overlay__item--danger"
            disabled={menu.kind === 'row' ? info.rows <= 1 : info.cols <= 1}
            onClick={() => {
              menu.kind === 'row' ? onDeleteRow(menu.index) : onDeleteColumn(menu.index);
              setMenu(null);
            }}
          >
            Supprimer {menu.kind === 'row' ? 'la ligne' : 'la colonne'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="table-overlay__item"
            onClick={() => {
              onOpenProperties();
              setMenu(null);
            }}
          >
            Propriétés du tableau…
          </button>
        </div>
      )}
    </div>
  );
}
