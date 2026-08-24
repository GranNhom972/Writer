/**
 * Une feuille physique A4/Letter. Transposition visuelle de `SwPageFrm`.
 *
 * Supporte :
 *  - En-têtes (`SwHeaderFrm`) et pieds de page (`SwFooterFrm`) physiques avec rendu véridique ;
 *  - Double-clic direct pour ouvrir l'atelier ergonomique de mise en page ;
 *  - Affichage précis des marges, tableaux et sélections multi-lignes.
 */

import { memo, type JSX } from 'react';
import type { PageGeometry } from '../../domain/document/pageSetup';
import type { ParagraphLayout } from '../../domain/engine/lineBreak';
import type { LaidOutPage, PlacedParagraph, PlacedTable } from '../../domain/engine/paginate';
import type { SelectionRect } from '../../domain/engine/cursor';
import type { PageFurniture, FurnitureBand } from '../../domain/document/pageFurniture';
import { showsOn, resolveGeometry, bandIsEmpty } from '../../domain/document/pageFurniture';
import { FurnitureBandView } from '../components/FurnitureBand';
import { ParagraphView } from './ParagraphView';

export interface A4PageProps {
  page: LaidOutPage;
  totalPages: number;
  documentTitle: string;
  furniture?: PageFurniture;
  geometry: PageGeometry;
  paragraphLayouts: ReadonlyMap<string, ParagraphLayout>;
  placements: { blockId: string; placed: PlacedParagraph }[];
  selectionRects: SelectionRect[];
  /** Occurrences de la recherche à peindre sur cette page. */
  searchRects: { rect: SelectionRect; current: boolean }[];
  caret: { pageIndex: number; xPx: number; topPx: number; heightPx: number } | null;
  caretIdle: boolean;
  showMargins: boolean;
  onToggleTask: (blockId: string) => void;
  onOpenFurniture?: (band: FurnitureBand) => void;
  onEditMath?: (blockId: string, latex: string, display: boolean) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
}

/** Cadres des cellules d'un tableau posé sur cette page. */
function TableFrames({ table }: { table: PlacedTable }): JSX.Element {
  const color = table.table.borderColor ?? 'var(--border-strong)';
  const widthPx = table.table.borderWidthPt ? `${table.table.borderWidthPt * (96 / 72)}px` : '1px';

  return (
    <>
      {table.rows.flatMap((row) =>
        row.cells.map((cell) => (
          <div
            key={`${row.rowId}-${cell.cellId}`}
            className="writer-table-cell"
            style={{
              left: `${cell.leftPx}px`,
              top: `${table.topPx + row.topPx}px`,
              width: `${cell.widthPx}px`,
              height: `${row.heightPx}px`,
              borderColor: color,
              borderWidth: widthPx,
              background: row.isHeader ? 'var(--bg-sunken)' : undefined,
            }}
            aria-hidden="true"
          />
        )),
      )}
    </>
  );
}

export const A4Page = memo(function A4Page({
  page,
  totalPages,
  documentTitle,
  furniture,
  geometry,
  paragraphLayouts,
  placements,
  selectionRects,
  searchRects,
  caret,
  caretIdle,
  showMargins,
  onToggleTask,
  onOpenFurniture,
  onEditMath,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: A4PageProps): JSX.Element {
  const pageNumber = page.index + 1;
  const showFurniture = furniture ? showsOn(furniture, pageNumber) : false;
  const geom = furniture ? resolveGeometry(furniture, pageNumber) : null;
  const pageWidthMm = geometry.pageWidthPx * (25.4 / 96);
  const contexte = { page: pageNumber, pages: totalPages, titre: documentTitle };
  const headerVide = !furniture || bandIsEmpty(furniture, 'header', pageNumber);
  const footerVide = !furniture || bandIsEmpty(furniture, 'footer', pageNumber);

  return (
    <div
      className="writer-page"
      style={{ width: `${geometry.pageWidthPx}px`, height: `${geometry.pageHeightPx}px` }}
      onPointerDown={(event) => onPointerDown(event, page.index)}
      onPointerMove={(event) => onPointerMove(event, page.index)}
      onPointerUp={(event) => onPointerUp(event, page.index)}
    >
      {/* En-tête de page physique interactif */}
      <div
        className="writer-page__furniture-header"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${geometry.pageWidthPx}px`,
          height: `${Math.max(geometry.contentTopPx, geom ? (geom.headerContentMm * 96 / 25.4) : 40)}px`,
          zIndex: 4,
          cursor: 'pointer',
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('header');
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('header');
        }}
        title="Cliquer ou double-cliquer pour modifier l'en-tête"
      >
        {showFurniture && furniture && geom && (
          <FurnitureBandView
            furniture={furniture}
            band="header"
            contexte={contexte}
            usableMm={pageWidthMm}
            heightMm={geom.headerContentMm}
          />
        )}
        <button
          type="button"
          className="page-guide__acces page-guide__acces--header"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFurniture?.('header');
          }}
          title={headerVide ? "Ajouter un en-tête" : "Modifier l'en-tête"}
        >
          {headerVide ? '+ Ajouter un en-tête' : '✏️ Modifier l’en-tête'}
        </button>
      </div>

      {/* Guide des marges */}
      {showMargins ? (
        <div
          className="writer-page__margins"
          style={{
            left: `${geometry.contentLeftPx}px`,
            top: `${geometry.contentTopPx}px`,
            width: `${geometry.contentWidthPx}px`,
            height: `${geometry.contentHeightPx}px`,
          }}
        />
      ) : null}

      {/* Contenu textuel et tableaux */}
      <div
        className="writer-page__content"
        style={{
          left: `${geometry.contentLeftPx}px`,
          top: `${geometry.contentTopPx}px`,
          width: `${geometry.contentWidthPx}px`,
          height: `${geometry.contentHeightPx}px`,
        }}
      >
        {/*
          Les occurrences trouvées se peignent **sous** la sélection : les deux
          se superposent sur l'occurrence courante, qui est aussi sélectionnée,
          et c'est la sélection qui doit rester lisible.
        */}
        {searchRects.map(({ rect, current }, index) => (
          <div
            key={`recherche-${index}`}
            className={current ? 'writer-search writer-search--current' : 'writer-search'}
            style={{
              left: `${rect.leftPx}px`,
              top: `${rect.topPx}px`,
              width: `${rect.widthPx}px`,
              height: `${rect.heightPx}px`,
            }}
          />
        ))}

        {selectionRects.map((rect, index) => (
          <div
            key={index}
            className="writer-selection"
            style={{
              left: `${rect.leftPx}px`,
              top: `${rect.topPx}px`,
              width: `${rect.widthPx}px`,
              height: `${rect.heightPx}px`,
            }}
          />
        ))}

        {page.blocks
          .filter((block): block is PlacedTable => block.kind === 'table')
          .map((table) => (
            <TableFrames key={`${table.blockId}-${table.topPx}`} table={table} />
          ))}

        {placements.map(({ blockId, placed }) => {
          const layout = paragraphLayouts.get(blockId);
          if (!layout) return null;
          return (
            <div
              key={`${blockId}-${placed.fromLine}`}
              style={{ position: 'absolute', left: `${placed.leftPx}px`, top: 0 }}
            >
              <ParagraphView
                placed={placed}
                layout={layout}
                onToggleTask={onToggleTask}
                onEditMath={onEditMath}
              />
            </div>
          );
        })}

        {caret ? (
          <div
            className={caretIdle ? 'writer-caret writer-caret--idle' : 'writer-caret'}
            style={{
              left: `${caret.xPx}px`,
              top: `${caret.topPx}px`,
              height: `${caret.heightPx}px`,
            }}
          />
        ) : null}
      </div>

      {/* Pied de page physique interactif */}
      <div
        className="writer-page__furniture-footer"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: `${geometry.pageWidthPx}px`,
          height: `${Math.max(geometry.pageHeightPx - (geometry.contentTopPx + geometry.contentHeightPx), geom ? (geom.footerContentMm * 96 / 25.4) : 40)}px`,
          zIndex: 4,
          cursor: 'pointer',
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('footer');
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('footer');
        }}
        title="Cliquer ou double-cliquer pour modifier le pied de page"
      >
        {showFurniture && furniture && geom && (
          <FurnitureBandView
            furniture={furniture}
            band="footer"
            contexte={contexte}
            usableMm={pageWidthMm}
            heightMm={geom.footerContentMm}
          />
        )}
        <button
          type="button"
          className="page-guide__acces page-guide__acces--footer"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFurniture?.('footer');
          }}
          title={footerVide ? "Ajouter un pied de page" : "Modifier le pied de page"}
        >
          {footerVide ? '+ Ajouter un pied de page' : '✏️ Modifier le pied de page'}
        </button>
      </div>
    </div>
  );
});
