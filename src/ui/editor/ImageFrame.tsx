// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Image frame inside the text: caption, selection, resizing, cropping.
 *
 * Split of roles, as requested:
 *
 *  - the **window** sets the caption (title, numbering mode, position, alignment) as well as the **crop**, which you open by double-clicking the preview: that is where you have an image large enough to designate
 *    precisely what you keep, and where the size is entered to the millimeter;
 *  - the **editor**, here, gives direct manipulation: you grab the image in the text and resize it with the mouse, without opening anything.
 *
 * ## What the engine imposes
 *
 * The height of the frame, image **and** caption, is computed by `lineBreak` (`captionHeightPx`), which already counted it as the ascent of the line. This component therefore cannot decide its own size: it fills
 * exactly the box it is given. Any margin added here would make the rendering diverge from the calculation, and the cursor would drift away from the text.
 *
 * ## The resize gesture
 *
 * The ratio is **kept by default**: distorting an image is almost always an accident. `Alt` releases it for whoever really wants that. The transactions of one drag are grouped into a single history entry
 * (`dragGroup`), otherwise undoing one dragged handle would take as many `Ctrl+Z` as it produced events.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  captionText,
  clampSize,
  cropGeometry,
  hasCaption,
  hasCrop,
  imageCaptionGapPt,
  imageCaptionOf,
  imageCrop,
  imageMarginPt,
  imageWrapMode,
  MIN_IMAGE_SIZE_PT,
  type ImageWrapMode,
} from '../../domain/document/images';
import { ImageWrapPicker } from '../components/ImageWrapPicker';
import { ptToPx, pxToPt } from '../../domain/document/units';
import type { RunFormatting } from '../../domain/document/types';
import { CAPTION_FONT_RATIO, CAPTION_LINE_RATIO } from '../../domain/engine/lineBreak';

/** Side of a corner handle, in page pixels. */
const HANDLE_PX = 10;

export interface ImageFrameProps {
  formatting: RunFormatting;
  blockId: string;
  offset: number;
  /** Total width of the frame: the image alone, without the caption. */
  widthPx: number;
  /** Height of the image alone. */
  imageHeightPx: number;
  /** Height reserved for the caption, white space included. Zero if there is none. */
  captionHeightPx: number;
  /** Figure number, or `null` in manual mode. */
  figureNumber: number | null;
  /** Font size of the document body, in points. */
  bodyFontSizePt: number;
  selected: boolean;
  zoom: number;
  readOnly: boolean;
  onSelect: (blockId: string, offset: number) => void;
  onOpenDialog: (blockId: string, offset: number) => void;
  onResize: (blockId: string, offset: number, widthPt: number, heightPt: number) => void;
  /** Changes how the image fits into the text (`SwFmtSurround`). Absent = setting unavailable. */
  onWrapChange?: (blockId: string, offset: number, mode: ImageWrapMode) => void;
  /**
   * Moves a **floating** frame, in points, in the frame of reference of its anchor.
   *
   * Called continuously during the drag: the frame follows the pointer.
   */
  onMove?: (blockId: string, offset: number, xPt: number, yPt: number) => void;
  /**
   * End of the drag, at window coordinates.
   *
   * It is the editor that knows which paragraph is under that point; this component only knows its own box. So it hands it the raw point and lets it re-anchor (`SwFEShell::SetAnchor`).
   */
  onDrop?: (blockId: string, offset: number, clientX: number, clientY: number) => void;
}

/** The four corners, with their cursor and the direction of their drag. */
const CORNERS = [
  { key: 'nw', cursor: 'nwse-resize', dx: -1, dy: -1, top: 0, left: 0 },
  { key: 'ne', cursor: 'nesw-resize', dx: 1, dy: -1, top: 0, left: 1 },
  { key: 'sw', cursor: 'nesw-resize', dx: -1, dy: 1, top: 1, left: 0 },
  { key: 'se', cursor: 'nwse-resize', dx: 1, dy: 1, top: 1, left: 1 },
] as const;

export function ImageFrame({
  formatting,
  blockId,
  offset,
  widthPx,
  imageHeightPx,
  captionHeightPx: captionBoxPx,
  figureNumber,
  bodyFontSizePt,
  selected,
  zoom,
  readOnly,
  onSelect,
  onOpenDialog,
  onResize,
  onWrapChange,
  onMove,
  onDrop,
}: ImageFrameProps): JSX.Element {
  const wrapMode = imageWrapMode(formatting);
  const flottant = wrapMode !== 'inline';
  const deplacable = Boolean(onDrop) && !readOnly;

  /**
   * Visual offset while dragging an image **from the text flow**.
   *
   * A floating frame really moves: the model carries its position, and the page repaints it where it goes. An image in the line has no position to modify: it only takes one when it is dropped, when we know which
   * paragraph it belongs to. In between, this purely graphic offset makes it follow the pointer; without it, the gesture shows nothing and people think nothing is happening.
   */
  const [glissement, setGlissement] = useState<{ x: number; y: number } | null>(null);
  const caption = imageCaptionOf(formatting);
  const legende = hasCaption(formatting) ? captionText(caption, figureNumber) : '';
  const crop = imageCrop(formatting);
  const decoupe = hasCrop(crop) ? cropGeometry(crop, widthPx, imageHeightPx) : null;
  const alt = formatting.imageAlt ?? '';

  /* ------------------------------------------------- resizing */

  const resize = useRef<{
    startX: number;
    startY: number;
    widthPt: number;
    heightPt: number;
    dx: number;
    dy: number;
  } | null>(null);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = resize.current;
      if (!drag) return;

      // The gesture is measured from its **origin**, not from the last event: the size is absolute, and accumulating deltas would accumulate the rounding of a `clampSize` at each step.
      const deltaXPt = pxToPt((event.clientX - drag.startX) / zoom) * drag.dx;
      const deltaYPt = pxToPt((event.clientY - drag.startY) / zoom) * drag.dy;

      const ratio = drag.heightPt / Math.max(1, drag.widthPt);
      let widthPt: number;
      let heightPt: number;

      if (event.altKey) {
        // Deliberate distortion: each axis follows its own handle.
        widthPt = drag.widthPt + deltaXPt;
        heightPt = drag.heightPt + deltaYPt;
      } else {
        // Ratio kept. We follow the axis that is stressed the most, so that the diagonal responds smoothly whatever the direction of the gesture.
        const parWidth = drag.widthPt + deltaXPt;
        const parHeight = (drag.heightPt + deltaYPt) / Math.max(0.0001, ratio);
        widthPt = Math.abs(deltaXPt) >= Math.abs(deltaYPt) ? parWidth : parHeight;
        heightPt = widthPt * ratio;
      }

      onResize(blockId, offset, clampSize(widthPt), clampSize(heightPt));
    },
    [zoom, blockId, offset, onResize],
  );

  const endResize = useCallback(() => {
    if (!resize.current) return;
    resize.current = null;
    document.body.classList.remove('writer-resizing-image');
  }, []);

  /* ---------------------------------------------------- moving */

  /**
   * Dragging a floating frame.
   *
   * Same principle as resizing: the gesture is measured **from its origin**, not from the last event. The position is absolute within the anchor, and accumulating deltas would accumulate the rounding of the
   * point ↔ pixel conversion: the frame would drift under the cursor along the drag.
   */
  const move = useRef<{
    startX: number;
    startY: number;
    xPt: number;
    yPt: number;
    /** The frame floats: the model carries its position and follows it live. */
    flottant: boolean;
    /** Has the pointer really moved? A simple click moves nothing. */
    bouge: boolean;
  } | null>(null);

  /** Under this threshold, in pixels, the gesture is a click and not a drag. */
  const SEUIL_PX = 3;

  const onMovePointer = useCallback(
    (event: PointerEvent) => {
      const drag = move.current;
      if (!drag) return;

      const dxPx = (event.clientX - drag.startX) / zoom;
      const dyPx = (event.clientY - drag.startY) / zoom;
      if (!drag.bouge && Math.abs(dxPx) + Math.abs(dyPx) < SEUIL_PX) return;
      drag.bouge = true;

      if (drag.flottant && onMove) {
        onMove(blockId, offset, drag.xPt + pxToPt(dxPx), drag.yPt + pxToPt(dyPx));
      } else {
        setGlissement({ x: dxPx, y: dyPx });
      }
    },
    [blockId, offset, zoom, onMove],
  );

  const endMove = useCallback(
    (event?: PointerEvent) => {
      const drag = move.current;
      if (!drag) return;
      move.current = null;
      setGlissement(null);
      document.body.classList.remove('writer-resizing-image');

      // A click is not a drop: re-anchoring in place would replace the run and lose the selection every time the image is touched.
      if (drag.bouge && event && onDrop) onDrop(blockId, offset, event.clientX, event.clientY);
    },
    [blockId, offset, onDrop],
  );

  useEffect(() => {
    const fin = (event: PointerEvent): void => endMove(event);
    window.addEventListener('pointermove', onMovePointer);
    window.addEventListener('pointerup', fin);
    window.addEventListener('pointercancel', fin);
    return () => {
      window.removeEventListener('pointermove', onMovePointer);
      window.removeEventListener('pointerup', fin);
      window.removeEventListener('pointercancel', fin);
      endMove();
    };
  }, [onMovePointer, endMove]);

  useEffect(() => {
    // Listeners on the window: a fast drag leaves the 10 px handle long before the mouse stops.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      endResize();
    };
  }, [onPointerMove, endResize]);

  const captionFontPx = ptToPx(bodyFontSizePt) * CAPTION_FONT_RATIO;
  const gapPx = captionBoxPx > 0 ? ptToPx(imageCaptionGapPt(formatting)) : 0;
  const margePx = ptToPx(imageMarginPt(formatting));

  const captionStyle = {
    // The white space is placed **between** the image and the caption, on the right side depending on whether the caption is above or below. It used to be subtracted from the height of the text and ended up at the
    // bottom of the frame, as pure emptiness.
    height: `${Math.max(0, captionBoxPx - gapPx)}px`,
    [caption.position === 'above' ? 'marginBottom' : 'marginTop']: `${gapPx}px`,
    fontSize: `${captionFontPx}px`,
    lineHeight: `${captionFontPx * CAPTION_LINE_RATIO}px`,
    textAlign: caption.align,
  } as const;

  const legendeNode =
    captionBoxPx > 0 ? (
      <span className="writer-image__caption" style={captionStyle}>
        {legende}
      </span>
    ) : null;

  return (
    <span
      className={selected ? 'writer-image writer-image--selected' : 'writer-image'}
      style={{
        display: 'inline-flex',
        flexDirection: caption.position === 'above' ? 'column-reverse' : 'column',
        width: `${widthPx + margePx * 2}px`,
        height: `${imageHeightPx + captionBoxPx + margePx * 2}px`,
        padding: `${margePx}px`,
        // The frame is placed **on** the baseline and rises by as much: that is what `SwFlyCntFrm` does, and it is the height the engine has already counted as ascent.
        verticalAlign: 'baseline',
        position: 'relative',
        ...(deplacable ? { cursor: 'move', touchAction: 'none' } : {}),
        // The ghost of an in-flow image, while it is being moved.
        ...(glissement
          ? {
              transform: `translate(${glissement.x}px, ${glissement.y}px)`,
              opacity: 0.7,
              zIndex: 5,
            }
          : {}),
      }}
      title={
        alt ||
        (deplacable
          ? 'Image — glisser pour déplacer, double-cliquer pour régler la légende'
          : 'Image — cliquer pour sélectionner, double-cliquer pour régler la légende')
      }
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(blockId, offset);

        /*
         * Every image can be grabbed and dropped: `SwFEShell::BeginDrag`.
         *
         * The gesture is the same in both cases, only its effect differs: a floating frame changes coordinates, an in-flow image changes place in the text. Reserving the drag for floating frames left the most natural
         * gesture on an image unanswered, and the default mode is precisely the in-flow one.
         */
        if (!deplacable || event.button !== 0) return;
        event.preventDefault();
        move.current = {
          startX: event.clientX,
          startY: event.clientY,
          xPt: formatting.imageXPt ?? 0,
          yPt: formatting.imageYPt ?? 0,
          flottant,
          bouge: false,
        };
        document.body.classList.add('writer-resizing-image');
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpenDialog(blockId, offset);
      }}
    >
      <span
        className="writer-image__box"
        style={{
          width: `${widthPx}px`,
          height: `${imageHeightPx}px`,
          overflow: 'hidden',
          position: 'relative',
          display: 'block',
          flex: 'none',
        }}
      >
        <img
          src={formatting.imageSrc}
          alt={alt}
          draggable={false}
          style={
            decoupe
              ? {
                  position: 'absolute',
                  left: `${decoupe.offsetXPx}px`,
                  top: `${decoupe.offsetYPx}px`,
                  width: `${decoupe.widthPx}px`,
                  height: `${decoupe.heightPx}px`,
                  display: 'block',
                  maxWidth: 'none',
                }
              : { width: '100%', height: '100%', objectFit: 'fill', display: 'block' }
          }
        />

      </span>

      {legendeNode}

      {selected && !readOnly
        ? CORNERS.map((corner) => (
            <span
              key={corner.key}
              className="writer-image__handle"
              style={{
                cursor: corner.cursor,
                // The handles sit on the corners of the **image**, not of the frame: the caption cannot be resized.
                left: corner.left ? `${widthPx - HANDLE_PX / 2}px` : `${-HANDLE_PX / 2}px`,
                top:
                  (caption.position === 'above' ? captionBoxPx : 0) +
                  (corner.top ? imageHeightPx - HANDLE_PX / 2 : -HANDLE_PX / 2),
                width: `${HANDLE_PX}px`,
                height: `${HANDLE_PX}px`,
              }}
              title="Glisser pour redimensionner — Alt pour déformer"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                resize.current = {
                  startX: event.clientX,
                  startY: event.clientY,
                  widthPt: formatting.imageWidthPt ?? MIN_IMAGE_SIZE_PT,
                  heightPt: formatting.imageHeightPt ?? MIN_IMAGE_SIZE_PT,
                  dx: corner.dx,
                  dy: corner.dy,
                };
                document.body.classList.add('writer-resizing-image');
              }}
            />
          ))
        : null}

      {/* Action bar of the selected image.  **Cropping is not in it**: it is set in the window, by double-clicking the preview, where you have an image large enough to designate precisely what you keep. The editor keeps the direct gesture: grab the image and resize it. */}
      {selected && !readOnly ? (
        <span
          className="writer-image__bar"
          style={{ top: `${imageHeightPx + captionBoxPx + 6}px` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {onWrapChange && (
            <ImageWrapPicker
              value={wrapMode}
              onChange={(mode) => onWrapChange(blockId, offset, mode)}
            />
          )}
          <button
            type="button"
            className="writer-image__action"
            onClick={() => onOpenDialog(blockId, offset)}
          >
            Modifier l'image
          </button>
        </span>
      ) : null}

    </span>
  );
}
