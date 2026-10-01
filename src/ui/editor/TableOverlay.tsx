// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Handles and guides of a table placed on a page.
 *
 * The engine paints tables as it paints text: absolute frames, without a single interactive node. That is what makes the layout exact, but it leaves the user with nothing to grab: nothing to hold, nothing to hover,
 * no sign that a column can be resized.
 *
 * This layer makes visible the gestures that the grid already allows:
 *
 *  - a **handle per column boundary**, which gives the `col-resize` cursor on hover: the affordance comes before the explanation;
 *  - a **guide per row and per column**, outside the text, which selects the whole band with one click (`SwFEShell::SelTblRow` / `SelTblCol`);
 *  - a **corner** that selects the whole table;
 *  - the **outline of the current cell**, without which you cannot know what "delete the row" or "merge" will act on.
 *
 * The guides only appear when the cursor is in the table: on a twenty-five page document, showing them all permanently would drown the text under decorations.
 *
 * ## Why two layers
 *
 * The selection tint has to go **under** the text: painted over it, even very transparent, it washes out the letters it is supposed to highlight. The handles, on the other hand, must stay **above** to be
 * grabbable. These two requirements contradict each other in a single node: hence `TableTint`, placed before the paragraphs, and `TableHandles`, placed after.
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  tableColumnCount,
  tableColumnWidths,
  type CellRect,
} from '../../domain/document/document';
import type { PlacedTable } from '../../domain/engine/paginate';
import { cellFrameHeightPx } from '../../domain/engine/paginate';

/** Thickness of the selection guides, in page pixels. */
const GRIP_PX = 12;
/** Gap between a guide and the edge of the table. */
const GRIP_GAP_PX = 3;
/** Half-width of the grab zone of a column boundary. */
const GRAB_PX = 4;

/** Cell under the cursor and selected rectangle, for a given table. */
export interface TableFocus {
  rowIndex: number;
  cellIndex: number;
  rect: CellRect | null;
}

/** Geometry of each grid column, in page pixels. */
function columnBoxes(
  table: PlacedTable,
  contentWidthPx: number,
): { leftPx: number; widthPx: number }[] {
  let x = 0;
  return tableColumnWidths(table.table).map((percent) => {
    const widthPx = (percent * contentWidthPx) / 100;
    const leftPx = x;
    x += widthPx;
    return { leftPx, widthPx };
  });
}

/** Vertical bounds of the table fragment placed on this page. */
function verticalExtent(table: PlacedTable): { top: number; height: number } | null {
  const first = table.rows[0];
  const last = table.rows[table.rows.length - 1];
  if (!first || !last) return null;
  const top = table.topPx + first.topPx;
  return { top, height: table.topPx + last.topPx + last.heightPx - top };
}

/* ------------------------------------------------------------ lower layer */

/** Tint of the selected cells and outline of the current cell. */
export function TableTint({
  table,
  focus,
}: {
  table: PlacedTable;
  focus: TableFocus | null;
}): JSX.Element | null {
  if (!focus) return null;
  const rect = focus.rect;

  return (
    <div className="writer-table-chrome" aria-hidden="true">
      {table.rows.flatMap((row, rowPos) =>
        row.cells.map((cell) => {
          if (cell.covered) return null;

          const inRect =
            rect !== null &&
            row.rowIndex >= rect.fromRow &&
            row.rowIndex <= rect.toRow &&
            cell.cellIndex >= rect.fromCol &&
            cell.cellIndex <= rect.toCol;

          // Outside a multiple selection, only the cursor's cell shows itself, and by an outline: a tint on the cell where you are typing would make people think its content is selected.
          const isCurrent =
            rect === null &&
            row.rowIndex === focus.rowIndex &&
            cell.cellIndex === focus.cellIndex;

          if (!inRect && !isCurrent) return null;

          return (
            <div
              key={`${row.rowId}-${cell.cellId}`}
              className={inRect ? 'writer-table-cell-selected' : 'writer-table-cell-active'}
              style={{
                left: `${cell.leftPx}px`,
                top: `${table.topPx + row.topPx}px`,
                width: `${cell.widthPx}px`,
                height: `${cellFrameHeightPx(table.rows, rowPos, cell)}px`,
              }}
            />
          );
        }),
      )}
    </div>
  );
}

/* ------------------------------------------------------------ upper layer */

export interface TableHandlesProps {
  table: PlacedTable;
  /** Usable width of the page: the base of the column percentages. */
  contentWidthPx: number;
  /** Scale factor applied to the sheet, to convert movements. */
  zoom: number;
  /** Cell and selection in this table, or `null` if the cursor is elsewhere. */
  focus: TableFocus | null;
  /** In read-only mode, the width handles disappear (see below). */
  readOnly?: boolean;
  onResizeColumn: (tableId: string, boundaryIndex: number, deltaPercent: number) => void;
  onSelectRow: (tableId: string, rowIndex: number) => void;
  onSelectColumn: (tableId: string, columnIndex: number) => void;
  onSelectTable: (tableId: string) => void;
}

/** Width handles and selection guides. */
export function TableHandles({
  table,
  contentWidthPx,
  zoom,
  focus,
  readOnly = false,
  onResizeColumn,
  onSelectRow,
  onSelectColumn,
  onSelectTable,
}: TableHandlesProps): JSX.Element | null {
  const tableId = table.table.id;

  /*
   * The drag is measured as the **difference from the last event**, not from the starting point: the command applies a relative delta, and accumulating from the origin would apply the same movement several times.
   */
  const drag = useRef<{ boundary: number; lastX: number } | null>(null);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      // The movement is in screen pixels: the zoom brings it back to page pixels, the only unit in which a column percentage means anything.
      const deltaPx = (event.clientX - current.lastX) / zoom;
      if (deltaPx === 0) return;
      current.lastX = event.clientX;
      onResizeColumn(tableId, current.boundary, (deltaPx / contentWidthPx) * 100);
    },
    [zoom, contentWidthPx, tableId, onResizeColumn],
  );

  const endDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('writer-resizing-column');
  }, []);

  useEffect(() => {
    // The listeners live on the window, not on the handle: a fast drag leaves the 8 px band long before the mouse stops, and a local `onPointerMove` would lose the gesture on the way.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      endDrag();
    };
  }, [onPointerMove, endDrag]);

  const extent = verticalExtent(table);
  if (!extent) return null;

  /*
   * The guides line up on the **grid**, not on the cells of the first row.
   *
   * A merged header row only has one cell for three columns: using it as a template gave a single guide, and the absorbed columns became unselectable. The grid always has as many columns as the table.
   */
  const columns = columnBoxes(table, contentWidthPx);
  const boundaries = columns.slice(0, -1).map((column) => column.leftPx + column.widthPx);
  const rect = focus?.rect ?? null;
  const gripTop = extent.top - GRIP_PX - GRIP_GAP_PX;
  const gripLeft = -GRIP_PX - GRIP_GAP_PX;

  /*
   * A guide only lights up if **its whole band** is taken.
   *
   * Settling for the intersection would light up the three column guides as soon as a row is selected: selecting a row does cover all the columns, but no column is selected for that. The user would read "row and
   * columns", meaning the whole table.
   *
   * The bounds are taken on the whole table, not on the fragment placed here: a grid that straddles two pages does not have three rows because the first page only shows three.
   */
  const totalRows = table.table.rows.length;
  const totalColumns = tableColumnCount(table.table);
  const spansAllRows = rect !== null && rect.fromRow === 0 && rect.toRow >= totalRows - 1;
  const spansAllColumns = rect !== null && rect.fromCol === 0 && rect.toCol >= totalColumns - 1;

  return (
    <div className="writer-table-chrome">
      {/* Width handles, on every inner boundary.  Nothing to grab in read-only mode: the transaction would be refused by `transactionAutorisee`, and a `col-resize` cursor that does not resize promises a gesture that the document does not accept. */}
      {(readOnly ? [] : boundaries).map((left, index) => (
        <div
          key={`bnd-${index}`}
          className="writer-table-resize"
          style={{
            left: `${left - GRAB_PX}px`,
            top: `${extent.top}px`,
            width: `${GRAB_PX * 2}px`,
            height: `${extent.height}px`,
          }}
          title="Glisser pour changer la largeur de la colonne"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // Without this, the click goes through to the page and puts the cursor back in the neighboring cell before the drag even starts.
            event.preventDefault();
            event.stopPropagation();
            drag.current = { boundary: index, lastX: event.clientX };
            document.body.classList.add('writer-resizing-column');
          }}
        >
          <span className="writer-table-resize__line" />
        </div>
      ))}

      {/* The guides only come out with the cursor: they are what carries the band selection, a gesture with no purpose as long as you are not editing the grid. */}
      {focus ? (
        <>
          <button
            type="button"
            className="writer-table-grip writer-table-grip--corner"
            style={{
              left: `${gripLeft}px`,
              top: `${gripTop}px`,
              width: `${GRIP_PX}px`,
              height: `${GRIP_PX}px`,
            }}
            title="Sélectionner le tableau"
            aria-label="Sélectionner le tableau"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectTable(tableId);
            }}
          />

          {columns.map((column, columnIndex) => (
            <button
              key={`gc-${columnIndex}`}
              type="button"
              className={
                rect && spansAllRows && columnIndex >= rect.fromCol && columnIndex <= rect.toCol
                  ? 'writer-table-grip writer-table-grip--column is-selected'
                  : 'writer-table-grip writer-table-grip--column'
              }
              style={{
                left: `${column.leftPx}px`,
                top: `${gripTop}px`,
                width: `${column.widthPx}px`,
                height: `${GRIP_PX}px`,
              }}
              title="Sélectionner la colonne"
              aria-label={`Sélectionner la colonne ${columnIndex + 1}`}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelectColumn(tableId, columnIndex);
              }}
            />
          ))}

          {table.rows.map((row) => (
            <button
              key={`gr-${row.rowId}`}
              type="button"
              className={
                rect &&
                spansAllColumns &&
                row.rowIndex >= rect.fromRow &&
                row.rowIndex <= rect.toRow
                  ? 'writer-table-grip writer-table-grip--row is-selected'
                  : 'writer-table-grip writer-table-grip--row'
              }
              style={{
                left: `${gripLeft}px`,
                top: `${table.topPx + row.topPx}px`,
                width: `${GRIP_PX}px`,
                height: `${row.heightPx}px`,
              }}
              title="Sélectionner la ligne"
              aria-label={`Sélectionner la ligne ${row.rowIndex + 1}`}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelectRow(tableId, row.rowIndex);
              }}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
