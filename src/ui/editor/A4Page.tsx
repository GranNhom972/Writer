// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * A physical A4/Letter sheet. A visual transposition of `SwPageFrm`.
 *
 * Supports:
 *  - physical headers (`SwHeaderFrm`) and footers (`SwFooterFrm`) with a truthful rendering;
 *  - a direct double click to open the ergonomic page layout workshop;
 *  - precise display of margins, tables and multi-line selections.
 */

import { memo, type JSX } from 'react';
import type { PageGeometry } from '../../domain/document/pageSetup';
import type { ParagraphLayout } from '../../domain/engine/lineBreak';
import type { LaidOutFly, LaidOutPage, PlacedParagraph, PlacedTable } from '../../domain/engine/paginate';
import { cellFrameHeightPx } from '../../domain/engine/paginate';
import type { SelectionRect } from '../../domain/engine/cursor';
import type { PageFurniture, FurnitureBand } from '../../domain/document/pageFurniture';
import { showsOn, resolveGeometry, bandIsEmpty } from '../../domain/document/pageFurniture';
import { FurnitureBandView } from '../components/FurnitureBand';
import { ParagraphView, type ImageContext } from './ParagraphView';
import { ImageFrame } from './ImageFrame';
import { imageKey } from '../../domain/document/images';
import { mmToPx, ptToPx, pxToMm } from '../../domain/document/units';

/** Fallback band height when the document has no page furniture. */
const DEFAULT_BAND_PX = 40;
import { TableHandles, TableTint, type TableFocus } from './TableOverlay';

/** A search match placed on the page. */
export interface SearchRect {
  rect: SelectionRect;
  current: boolean;
}

/**
 * Shared, frozen empty arrays.
 *
 * `A4Page` is memoized, so it is compared prop by prop by identity. A `?? []` written at the call site would hand back a new array on every render and be enough to make the comparison fail: memoization
 * would be useless for every page with no selection or match, which is almost all of them. These constants are the fallback value to use in their place.
 */
export const AUCUN_RECT: readonly SelectionRect[] = Object.freeze([]);
export const AUCUNE_OCCURRENCE: readonly SearchRect[] = Object.freeze([]);
export const AUCUN_PLACEMENT: readonly { blockId: string; placed: PlacedParagraph }[] =
  Object.freeze([]);

export interface A4PageProps {
  page: LaidOutPage;
  totalPages: number;
  documentTitle: string;
  furniture?: PageFurniture;
  geometry: PageGeometry;
  paragraphLayouts: ReadonlyMap<string, ParagraphLayout>;
  placements: readonly { blockId: string; placed: PlacedParagraph }[];
  selectionRects: readonly SelectionRect[];
  /** Search matches to paint on this page. */
  searchRects: readonly SearchRect[];
  caret: { pageIndex: number; xPx: number; topPx: number; heightPx: number } | null;
  caretIdle: boolean;
  showMargins: boolean;
  /** Current zoom: the table handles convert gestures with it. */
  zoom: number;
  /** Table and cell under the cursor, to paint the handles. */
  activeTable: ({ tableId: string } & TableFocus) | null;
  onResizeColumn: (tableId: string, boundaryIndex: number, deltaPercent: number) => void;
  onSelectRow: (tableId: string, rowIndex: number) => void;
  onSelectColumn: (tableId: string, columnIndex: number) => void;
  onSelectTable: (tableId: string) => void;
  /** Document that cannot be modified: the width handles are not shown. */
  readOnly?: boolean;
  /** Context of the image frames: captions, selection, handles. */
  images?: ImageContext | undefined;
  onToggleTask: (blockId: string) => void;
  onOpenFurniture?: (band: FurnitureBand) => void;
  onEditMath?: (blockId: string, latex: string, display: boolean) => void;
  onEditImage?: (blockId: string, offset: number) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>, pageIndex: number) => void;
}

/** Frames of the cells of a table placed on this page. */
function TableFrames({ table }: { table: PlacedTable }): JSX.Element {
  // "Paper" token: the grid is printed, it does not follow the theme.
  const color = table.table.borderColor ?? 'var(--paper-border)';
  const widthPx = table.table.borderWidthPt ? `${ptToPx(table.table.borderWidthPt)}px` : '1px';

  return (
    <>
      {table.rows.flatMap((row, rowPos) =>
        row.cells.map((cell) =>
          /*
           * A cell covered by a merge is not painted.
           *
           * The engine gives it a zero width, which does not cancel its frame: `border-box` shrinks the content to zero but keeps the two one-pixel borders, and a 2 px line was left in the middle of every merged cell,
           * exactly where the erased boundary ran. It is the master that carries the frame of the whole area.
           */
          cell.covered ? null : (
          <div
            key={`${row.rowId}-${cell.cellId}`}
            className="writer-table-cell"
            style={{
              left: `${cell.leftPx}px`,
              top: `${table.topPx + row.topPx}px`,
              width: `${cell.widthPx}px`,
              height: `${cellFrameHeightPx(table.rows, rowPos, cell)}px`,
              borderColor: color,
              borderWidth: widthPx,
              background: row.isHeader ? 'var(--paper-sunken)' : undefined,
            }}
            aria-hidden="true"
          />
          ),
        ),
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
  zoom,
  activeTable,
  onResizeColumn,
  onSelectRow,
  onSelectColumn,
  onSelectTable,
  readOnly,
  images,
  onToggleTask,
  onOpenFurniture,
  onEditMath,
  onEditImage,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
}: A4PageProps): JSX.Element {
  const pageNumber = page.index + 1;

  /**
   * A floating frame, painted in its place on the sheet.
   *
   * The same rendering serves the **two layers**: `SwRootFrm::Paint` paints `hell` before the text and `heaven` after it, but it is the same frame, and only the order of passes changes, and with it what covers what.
   */
  const peindreCadre = (laid: LaidOutFly, index: number): JSX.Element => (
    <div
      key={`fly-${laid.fly.anchorBlockId}-${index}`}
      className="writer-fly"
      style={{
        position: 'absolute',
        left: `${laid.leftPx}px`,
        top: `${laid.topPx}px`,
        width: `${laid.widthPx}px`,
        height: `${laid.heightPx}px`,
        /*
         * The frame stays grabbable, even in `through` mode.
         *
         * Letting clicks pass through it made the text underneath easier to select, but closed the door: an image placed "behind the text" could never be reached again, so never adjusted or deleted again. The text, for its
         * part, can always be selected: you just have to start the gesture outside the frame.
         */
        pointerEvents: 'auto',
      }}
    >
      {/* Same frame as in the flow: it is here, and only here, that a floating image is painted. It also gets the caption and the resize handles, instead of being a simple inert thumbnail. */}
      {images ? (
        <ImageFrame
          formatting={laid.fly.run}
          blockId={laid.fly.anchorBlockId}
          offset={laid.fly.anchorOffset}
          widthPx={laid.widthPx}
          // The height set by `flyLayout` includes the caption: it is that of the whole frame. The image takes up the rest.
          imageHeightPx={laid.heightPx - (laid.fly.captionHeightPx ?? 0)}
          captionHeightPx={laid.fly.captionHeightPx ?? 0}
          figureNumber={
            images.figureNumbers.get(
              imageKey(laid.fly.anchorBlockId, laid.fly.anchorOffset),
            ) ?? null
          }
          bodyFontSizePt={images.bodyFontSizePt}
          selected={
            images.selected?.blockId === laid.fly.anchorBlockId &&
            images.selected.offset === laid.fly.anchorOffset
          }
          zoom={images.zoom}
          readOnly={images.readOnly}
          onSelect={images.onSelect}
          onOpenDialog={(b, o) => {
            images.onOpenDialog(b, o);
            onEditImage?.(b, o);
          }}
          onResize={images.onResize}
          onWrapChange={images.onWrapChange}
          onMove={images.onMove}
          onDrop={images.onDrop}
        />
      ) : (
        <img
          src={laid.fly.run.imageSrc ?? ''}
          alt={laid.fly.run.imageAlt ?? ''}
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
        />
      )}
    </div>
  );

  const showFurniture = furniture ? showsOn(furniture, pageNumber) : false;
  const geom = furniture ? resolveGeometry(furniture, pageNumber) : null;
  const pageWidthMm = pxToMm(geometry.pageWidthPx);

  /*
   * Heights of the header and footer bands.
   *
   * Bounded to the area **outside the text**, and that is the whole point: the band is placed at `zIndex: 4` above `.writer-page__content`, which has no `z-index` of its own, and it stops the propagation of
   * `pointerdown` so that the click opens the workshop instead of placing the cursor. A band taller than the margin therefore covers the first lines of the text and makes it impossible to place the cursor there:
   * the click opens the header instead.
   *
   * The case was not theoretical: `resolveGeometry` floored the content of a band at 16 mm, empty band included, while the margin follows the user's setting. Under 16 mm of top margin the band overflowed: 22.7 px
   * of text unreachable at a 10 mm margin. The default A4 template (20 mm) hid the defect.
   *
   * `geom` is therefore only used to claim **less** than the margin, never more.
   */
  const headerBandPx = Math.min(
    geometry.contentTopPx,
    geom ? mmToPx(geom.headerContentMm) : DEFAULT_BAND_PX,
  );
  const footerZonePx = geometry.pageHeightPx - (geometry.contentTopPx + geometry.contentHeightPx);
  const footerBandPx = Math.min(
    footerZonePx,
    geom ? mmToPx(geom.footerContentMm) : DEFAULT_BAND_PX,
  );
  const contexte = { page: pageNumber, pages: totalPages, titre: documentTitle };
  const headerVide = !furniture || bandIsEmpty(furniture, 'header', pageNumber);
  const footerVide = !furniture || bandIsEmpty(furniture, 'footer', pageNumber);

  return (
    <div
      className="writer-page"
      // Index of the sheet, read when an image is dropped: the drag listens on the window and so does not have the `pageIndex` that this component's pointer handlers receive.
      data-page-index={page.index}
      style={{ width: `${geometry.pageWidthPx}px`, height: `${geometry.pageHeightPx}px` }}
      onPointerDown={(event) => onPointerDown(event, page.index)}
      onPointerMove={(event) => onPointerMove(event, page.index)}
      onPointerUp={(event) => onPointerUp(event, page.index)}
      onContextMenu={(event) => onContextMenu(event, page.index)}
    >
      {/* Interactive physical page header */}
      <div
        className="writer-page__furniture-header"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${geometry.pageWidthPx}px`,
          height: `${headerBandPx}px`,
          overflow: 'hidden',
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
            heightMm={pxToMm(headerBandPx)}
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

      {/* Margin guide */}
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

      {/* Text content and tables */}
      <div
        className="writer-page__content"
        style={{
          left: `${geometry.contentLeftPx}px`,
          top: `${geometry.contentTopPx}px`,
          width: `${geometry.contentWidthPx}px`,
          height: `${geometry.contentHeightPx}px`,
        }}
      >
        {/* Floating frames of the `hell` layer (`SwFlyFreeFrm`). Painted **before** the text, so underneath: it is the order of `SwRootFrm::Paint`, and it only has a visible consequence for `through` wrapping, where the text has to pass over the image. */}
        {page.fliesHell.map(peindreCadre)}

        {page.tables.map((table) => (
          <TableFrames key={`${table.blockId}-${table.topPx}`} table={table} />
        ))}

        {/* Selection tint: under the text, so as not to wash it out. */}
        {page.tables.map((table) => (
          <TableTint
            key={`tint-${table.blockId}-${table.topPx}`}
            table={table}
            focus={activeTable?.tableId === table.table.id ? activeTable : null}
          />
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
                onEditImage={onEditImage}
                images={images}
              />
            </div>
          );
        })}

        {/* Selection tint and search matches.  Painted **over** the content, and that is what makes them reliable: under the content, any opaque flat color placed higher in the stack erased them. The defect showed at `Ctrl+A`: the header row of a table (`--paper-sunken`), a character with a colored background (`RES_CHRATR_BACKGROUND`) or an image anchored as a character stayed white in the middle of an entirely highlighted document, although the engine had produced their rectangles.  That is the C++ order: the selection is not a layer of the document but a **view overlay**, painted after it. `SwRootFrm::Paint` draws the content, then the overlay manager (`sdr::overlay::OverlaySelection`) lays the translucent tint over what it produced, frames and graphics included.  The `multiply` blend protects readability: it can only darken. On the white of the paper, which is the case of almost the whole page, multiplying by the tint is exactly the previous rendering; on a black glyph, black wins and the text keeps its contrast; on a grey flat color or an image, the tint finally shows. The rectangles first compose among themselves (`isolation`), so that the overlap of a match and the selection does not double the darkening.  Left above, and so untouched: the table handles, the cursor, the footnotes (which `Ctrl+A` does not select, any more than in Writer), and the `heaven` layer. */}
        {searchRects.length > 0 || selectionRects.length > 0 ? (
          <div className="writer-selection-layer" aria-hidden="true">
            {/* The matches found are painted **under** the selection: the two overlap on the current match, which is also selected, and it is the selection that must stay readable. */}
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
          </div>
        ) : null}

        {/* Table handles: after the text, so above it: a handle that a word would cover could not be grabbed. */}
        {page.tables.map((table) => (
          <TableHandles
            key={`poignees-${table.blockId}-${table.topPx}`}
            table={table}
            contentWidthPx={geometry.contentWidthPx}
            zoom={zoom}
            focus={activeTable?.tableId === table.table.id ? activeTable : null}
            readOnly={readOnly ?? false}
            onResizeColumn={onResizeColumn}
            onSelectRow={onSelectRow}
            onSelectColumn={onSelectColumn}
            onSelectTable={onSelectTable}
          />
        ))}

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

        {/* Footnote area (`SwFtnContFrm`).  Its height is **reserved by pagination** (`PageBuilder`): the text body stops above it, so the banner no longer covers anything. `height` takes up that exact height rather than let the box size itself on its content: the two must coincide, otherwise the reserve and the rendering would diverge. */}
        {page.footnotes && page.footnotes.length > 0 && (
          <div
            className="writer-page__footnotes"
            style={{
              position: 'absolute',
              height: page.footnoteAreaHeightPx ? `${page.footnoteAreaHeightPx}px` : undefined,
              bottom: 0,
              left: 0,
              right: 0,
              borderTop: '1px solid var(--paper-border)',
              paddingTop: '8px',
              fontSize: '11px',
              lineHeight: '1.4',
              // `--text-muted` does not exist in any stylesheet: the rule always fell back on its default value.
              color: 'var(--paper-secondary)',
              pointerEvents: 'auto',
            }}
          >
            {page.footnotes.map((fn) => (
              <div key={fn.id} className="writer-footnote-entry" style={{ marginBottom: '2px' }}>
                <sup style={{ fontWeight: 600, marginRight: '4px', color: 'var(--text-color, #111)' }}>{fn.index}</sup>
                <span>{fn.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* `heaven` layer: the "in front of the text" frames (`RES_OPAQUE`).  Painted **last**, after the handles, the cursor and the notes: it is the end of `SwRootFrm::Paint`, and it is what gives "in front of the text" its meaning. An opaque frame therefore covers everything the page carries, without exception.  They used to be inserted between the handles and the cursor, which made them go *under* the cursor and under the notes banner: the order of the layers was inverted for those two elements, and an image placed in front of the text still did not hide its cursor.  An accepted consequence: an opaque frame placed over the typing area hides the cursor. It is the requested behavior for an object "in front of the text"; the way back is to send it behind. */}
        {page.fliesHeaven.map(peindreCadre)}
      </div>

      {/* Interactive physical page footer */}
      <div
        className="writer-page__furniture-footer"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: `${geometry.pageWidthPx}px`,
          height: `${footerBandPx}px`,
          overflow: 'hidden',
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
            heightMm={pxToMm(footerBandPx)}
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
