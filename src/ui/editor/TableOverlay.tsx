// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Poignées et repères d'un tableau posé sur une page.
 *
 * Le moteur peint les tableaux comme il peint le texte : des cadres absolus,
 * sans le moindre nœud interactif. C'est ce qui rend la mise en page exacte,
 * mais cela laisse l'utilisateur sans prise — rien à saisir, rien à survoler,
 * aucune indication qu'une colonne puisse se redimensionner.
 *
 * Cette couche rend visibles les gestes que la grille autorise déjà :
 *
 *  - une **poignée par frontière de colonne**, qui donne le curseur
 *    `col-resize` au survol : l'affordance précède l'explication ;
 *  - une **réglette par ligne et par colonne**, hors du texte, qui sélectionne
 *    la bande entière d'un clic (`SwFEShell::SelTblRow` / `SelTblCol`) ;
 *  - un **coin** qui sélectionne le tableau entier ;
 *  - le **liseré de la cellule courante**, sans lequel on ne sait pas sur quoi
 *    porteront « supprimer la ligne » ou « fusionner ».
 *
 * Les réglettes n'apparaissent que lorsque le curseur est dans le tableau : sur
 * un document de vingt-cinq pages, les afficher toutes en permanence noierait
 * le texte sous les décorations.
 *
 * ## Pourquoi deux couches
 *
 * La teinte de sélection doit passer **sous** le texte — peinte par-dessus,
 * même très transparente, elle délave les lettres qu'elle est censée mettre en
 * valeur. Les poignées, elles, doivent rester **au-dessus** pour être
 * saisissables. Ces deux exigences sont contradictoires dans un seul nœud :
 * d'où `TableTint`, posée avant les paragraphes, et `TableHandles`, posée
 * après.
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  tableColumnCount,
  tableColumnWidths,
  type CellRect,
} from '../../domain/document/document';
import type { PlacedTable } from '../../domain/engine/paginate';
import { cellFrameHeightPx } from '../../domain/engine/paginate';

/** Épaisseur des réglettes de sélection, en pixels de page. */
const GRIP_PX = 12;
/** Écart entre une réglette et le bord du tableau. */
const GRIP_GAP_PX = 3;
/** Demi-largeur de la zone de saisie d'une frontière de colonne. */
const GRAB_PX = 4;

/** Cellule sous le curseur et rectangle sélectionné, pour un tableau donné. */
export interface TableFocus {
  rowIndex: number;
  cellIndex: number;
  rect: CellRect | null;
}

/** Géométrie de chaque colonne de grille, en pixels de page. */
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

/** Bornes verticales du fragment de tableau posé sur cette page. */
function verticalExtent(table: PlacedTable): { top: number; height: number } | null {
  const first = table.rows[0];
  const last = table.rows[table.rows.length - 1];
  if (!first || !last) return null;
  const top = table.topPx + first.topPx;
  return { top, height: table.topPx + last.topPx + last.heightPx - top };
}

/* ------------------------------------------------------------ couche basse */

/** Teinte des cellules sélectionnées et liseré de la cellule courante. */
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

          // Hors sélection multiple, seule la cellule du curseur se signale, et
          // par un liseré : une teinte sur la cellule où l'on tape ferait
          // croire que son contenu est sélectionné.
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

/* ------------------------------------------------------------ couche haute */

export interface TableHandlesProps {
  table: PlacedTable;
  /** Largeur utile de la page — la base des pourcentages de colonne. */
  contentWidthPx: number;
  /** Facteur d'échelle appliqué à la feuille, pour convertir les mouvements. */
  zoom: number;
  /** Cellule et sélection dans ce tableau, ou `null` si le curseur est ailleurs. */
  focus: TableFocus | null;
  /** En lecture seule, les poignées de largeur disparaissent (voir plus bas). */
  readOnly?: boolean;
  onResizeColumn: (tableId: string, boundaryIndex: number, deltaPercent: number) => void;
  onSelectRow: (tableId: string, rowIndex: number) => void;
  onSelectColumn: (tableId: string, columnIndex: number) => void;
  onSelectTable: (tableId: string) => void;
}

/** Poignées de largeur et réglettes de sélection. */
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
   * Le glissement se mesure en **écart au dernier événement**, pas en écart au
   * point de départ : la commande applique un delta relatif, et cumuler depuis
   * l'origine appliquerait plusieurs fois le même déplacement.
   */
  const drag = useRef<{ boundary: number; lastX: number } | null>(null);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      // Le mouvement est en pixels d'écran : le zoom le ramène en pixels de
      // page, seule unité dans laquelle un pourcentage de colonne a un sens.
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
    // Les écouteurs vivent sur la fenêtre, pas sur la poignée : un glissement
    // rapide sort de la bande de 8 px bien avant que la souris ne s'arrête, et
    // un `onPointerMove` local perdrait le geste en route.
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
   * Les réglettes se calent sur la **grille**, pas sur les cellules de la
   * première ligne.
   *
   * Une ligne d'en-tête fusionnée n'a qu'une cellule pour trois colonnes : s'en
   * servir de gabarit ne donnait qu'une seule réglette, et les colonnes
   * absorbées devenaient insélectionnables. La grille, elle, a toujours autant
   * de colonnes que le tableau.
   */
  const columns = columnBoxes(table, contentWidthPx);
  const boundaries = columns.slice(0, -1).map((column) => column.leftPx + column.widthPx);
  const rect = focus?.rect ?? null;
  const gripTop = extent.top - GRIP_PX - GRIP_GAP_PX;
  const gripLeft = -GRIP_PX - GRIP_GAP_PX;

  /*
   * Une réglette ne s'allume que si **toute sa bande** est prise.
   *
   * Se contenter de l'intersection allumerait les trois réglettes de colonne
   * dès qu'une ligne est sélectionnée — la sélection d'une ligne couvre bien
   * toutes les colonnes, mais aucune colonne n'est pour autant sélectionnée.
   * L'utilisateur y lirait « ligne et colonnes », c'est-à-dire tout le tableau.
   *
   * Les bornes se prennent sur le tableau entier, pas sur le fragment posé ici :
   * une grille à cheval sur deux pages n'a pas trois lignes parce que la
   * première page n'en montre que trois.
   */
  const totalRows = table.table.rows.length;
  const totalColumns = tableColumnCount(table.table);
  const spansAllRows = rect !== null && rect.fromRow === 0 && rect.toRow >= totalRows - 1;
  const spansAllColumns = rect !== null && rect.fromCol === 0 && rect.toCol >= totalColumns - 1;

  return (
    <div className="writer-table-chrome">
      {/*
        Poignées de largeur, sur chaque frontière interne.

        Rien à saisir en lecture seule : la transaction serait refusée par
        `transactionAutorisee`, et un curseur `col-resize` qui ne redimensionne
        pas promet un geste que le document n'accepte pas.
      */}
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
            // Sans cela, le clic traverse jusqu'à la page et repose le curseur
            // dans la cellule voisine avant même que le glissement commence.
            event.preventDefault();
            event.stopPropagation();
            drag.current = { boundary: index, lastX: event.clientX };
            document.body.classList.add('writer-resizing-column');
          }}
        >
          <span className="writer-table-resize__line" />
        </div>
      ))}

      {/*
        Les réglettes ne sortent qu'avec le curseur : ce sont elles qui portent
        la sélection de bande, geste sans objet tant qu'on n'édite pas la grille.
      */}
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
