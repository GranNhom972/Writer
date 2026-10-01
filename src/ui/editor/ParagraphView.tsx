// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Rendering of a paragraph placed on a page.
 *
 * The component decides nothing: it **paints** what the engine has computed. Each line is an element positioned at the x and y coordinates given to it by `layoutParagraph`, and the segments follow one another
 * inside it in the flow. This separation guarantees that the DOM is only a reactive projection of the state: no measurement goes back up from the DOM to the model.
 */

import { memo, type CSSProperties, type JSX } from 'react';
import type {
  LayoutMarker,
  LayoutSegment,
  ParagraphLayout,
} from '../../domain/engine/lineBreak';
import type { PlacedParagraph } from '../../domain/engine/paginate';
import { renderMathHtml } from '../../domain/math/render';
import { ptToPx } from '../../domain/document/units';
import type { ImageWrapMode } from '../../domain/document/images';
import {
  cropGeometry,
  hasCrop,
  imageCrop,
  imageKey,
  IMAGE_PLACEHOLDER,
} from '../../domain/document/images';
import { ImageFrame } from './ImageFrame';
import { safeLinkHref } from '../../domain/document/url';

/** CSS style of a segment, derived from the font the engine resolved. */
function segmentStyle(segment: LayoutSegment): CSSProperties {
  const style: CSSProperties = {
    fontFamily: segment.font.fontFamily,
    fontSize: `${segment.font.fontSizePx}px`,
    color: segment.color,
  };
  if (segment.font.bold) style.fontWeight = 700;
  if (segment.font.italic) style.fontStyle = 'italic';
  if (segment.formatting.backgroundColor) {
    style.backgroundColor = segment.formatting.backgroundColor;
  }

  // Underline and strikethrough add up: `text-decoration-line` accepts both, whereas two separate rules would overwrite each other.
  const decorations: string[] = [];
  if (segment.formatting.underline) decorations.push('underline');
  if (segment.formatting.strikeThrough) decorations.push('line-through');

  /*
   * -- Revisions (`SwRedline`) -------------------------------------------
   *
   * Writer paints an insertion **underlined** and a deletion **struck through**, both in the author's color (`SwRedlineTbl`). They are the same decorations as ordinary underline and strikethrough: they are
   * therefore added to the list rather than replacing it, otherwise striking out a deletion would erase the underline the author had set.
   */
  const redlineType = segment.formatting.redlineType;
  if (redlineType === 'insert') {
    decorations.push('underline');
    style.textDecorationThickness = '2px';
  } else if (redlineType === 'delete') {
    decorations.push('line-through');
    style.opacity = 0.7;
  } else if (redlineType === 'format') {
    style.outline = '1px dotted currentColor';
    style.outlineOffset = '1px';
  }

  if (decorations.length > 0) style.textDecorationLine = decorations.join(' ');

  /*
   * -- Comment anchor (`SwPostItMgr`) ------------------------------------
   *
   * A pale yellow background rather than a strong highlight: the commented text stays text to read, and Writer treats it the same way. The background set by the user, if there is one, keeps priority: it is an
   * explicit choice.
   */
  if (segment.formatting.commentIds && !style.backgroundColor) {
    style.backgroundColor = 'var(--comment-highlight, rgba(255, 214, 102, 0.35))';
  }

  // A bookmark is not painted: it has no visual existence in Writer either. It can only be found through the navigation panel.

  return style;
}

function SegmentView({
  segment,
  blockId,
  onEditMath,
  onEditImage,
  images,
}: {
  segment: LayoutSegment;
  blockId: string;
  onEditMath?: ((blockId: string, latex: string, display: boolean) => void) | undefined;
  onEditImage?: ((blockId: string, offset: number) => void) | undefined;
  images?: ImageContext | undefined;
}): JSX.Element {
  if (segment.isTab) {
    // The width of a tab depends on the stop that is reached: it is given in pixels, never left to the browser, which does not know its position.
    return (
      <span
        className="writer-tab"
        style={{ width: `${segment.widthPx}px` }}
        aria-hidden="true"
      />
    );
  }

  if (segment.formatting.imageSrc) {
    /*
     * A **floating** image is not painted here.
     *
     * Its geometry comes from `flyLayout`, which places it at its anchor position and carves the text around it; the floating-frame layer takes care of it. Painting it in the line too drew it **twice**: once in its
     * place, once in the flow, side by side. The run stays in the line, with no width: that is what the model says (`imageAnchor` ≠ `as-char`).
     */
    if (segment.formatting.imageAnchor && segment.formatting.imageAnchor !== 'as-char') {
      return <span aria-hidden="true" />;
    }

    const widthPx = ptToPx(segment.formatting.imageWidthPt ?? 0);
    const imageHeightPx = ptToPx(segment.formatting.imageHeightPt ?? 0);

    // Height of the caption as the **engine** reserved it in the line. Recomputing it here would make the display depend on a second derivation.
    const captionPx = segment.captionHeightPx ?? 0;

    if (!images) {
      // With no image context (printing, export), the frame is painted bare.
      const crop = imageCrop(segment.formatting);
      const decoupe = hasCrop(crop) ? cropGeometry(crop, widthPx, imageHeightPx) : null;
      return (
        <span
          className="writer-image"
          style={{
            display: 'inline-block',
            width: `${widthPx}px`,
            height: `${imageHeightPx}px`,
            overflow: 'hidden',
            position: 'relative',
            verticalAlign: 'baseline',
          }}
        >
          <img
            src={segment.formatting.imageSrc}
            alt={segment.formatting.imageAlt ?? ''}
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
      );
    }

    const key = imageKey(blockId, segment.startOffset);

    return (
      <ImageFrame
        formatting={segment.formatting}
        blockId={blockId}
        offset={segment.startOffset}
        widthPx={widthPx}
        imageHeightPx={imageHeightPx}
        captionHeightPx={captionPx}
        figureNumber={images.figureNumbers.get(key) ?? null}
        bodyFontSizePt={images.bodyFontSizePt}
        selected={
          images.selected?.blockId === blockId && images.selected.offset === segment.startOffset
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
        onDrop={images.onDrop}
      />
    );
  }

  if (segment.formatting.mathLatex) {
    const latex = segment.formatting.mathLatex;
    const isDisplay = Boolean(segment.formatting.mathDisplay);
    const html = renderMathHtml(latex, isDisplay);
    const style = segmentStyle(segment);

    return (
      <span
        className={`writer-math ${isDisplay ? 'writer-math--display' : 'writer-math--inline'}`}
        style={{
          ...style,
          display: 'inline-flex',
          verticalAlign: isDisplay ? 'middle' : '-0.15em',
        }}
        title="Formule mathématique — Cliquer pour modifier"
        onPointerDown={(event) => {
          event.stopPropagation();
          onEditMath?.(blockId, latex, isDisplay);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onEditMath?.(blockId, latex, isDisplay);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onEditMath?.(blockId, latex, isDisplay);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const style = segmentStyle(segment);
  /*
   * The object replacement character is never painted.
   *
   * U+FFFC (`CH_TXTATR_BREAKWORD`) is an **anchor point**, not a glyph: it gives the object a position in the paragraph's string, and Writer draws nothing for it. The engine measures it at zero as well
   * (`measureText` returns a zero advance for it), whereas leaving it in the DOM text makes the browser paint a 16 px fallback box that is absent from all the measurements.
   *
   * Everything that followed on the line was shifted by it: the selection rectangle stopped 16 px before the end, the cursor landed beside the click, and the box itself stayed white under `Ctrl+A`. A segment only
   * gets here once the objects have been handled above (image, formula): the character that remains in it has lost its attribute (an ODF round trip through other software leaves some) and therefore no longer
   * anchors anything at all.
   */
  const content = segment.text.includes(IMAGE_PLACEHOLDER)
    ? segment.text.split(IMAGE_PLACEHOLDER).join('')
    : segment.text;

  if (segment.formatting.footnoteText) {
    return (
      <sup
        className="writer-footnote-anchor"
        style={{
          ...style,
          fontSize: '0.75em',
          verticalAlign: 'super',
          lineHeight: 0,
          cursor: 'pointer',
          color: 'var(--accent, #1a73e8)',
          fontWeight: 600,
        }}
        title={`Note de bas de page : ${segment.formatting.footnoteText}`}
      >
        {content}
      </sup>
    );
  }

  if (segment.formatting.linkHref) {
    // The document comes from disk, from an ODF import, or from another participant through the CRDT: we revalidate at render time, the only place all those sources go through. A refused address falls back to
    // plain text rather than disappear: the user must see that there was something there.
    const href = safeLinkHref(segment.formatting.linkHref);
    if (href) {
      return (
        <a href={href} rel="noopener noreferrer nofollow" style={{ ...style, color: 'var(--accent)' }}>
          {content}
        </a>
      );
    }
    return (
      <span style={style} title="Lien retiré : adresse non autorisée">
        {content}
      </span>
    );
  }
  return <span style={style}>{content}</span>;
}

/**
 * Bullet, number or checkbox of a list item.
 *
 * The checkbox of a checklist is a real `<input>`: it can be ticked with the keyboard and is announced as a checkbox to assistive technologies, which a ☐ glyph would not be.
 */
function MarkerView({
  marker,
  topPx,
  heightPx,
  onToggle,
}: {
  marker: LayoutMarker;
  topPx: number;
  heightPx: number;
  onToggle: (() => void) | undefined;
}): JSX.Element {
  const base: CSSProperties = {
    left: `${marker.leftPx}px`,
    top: `${topPx}px`,
    width: `${marker.widthPx}px`,
    height: `${heightPx}px`,
    lineHeight: `${heightPx}px`,
    fontFamily: marker.font.fontFamily,
    fontSize: `${marker.font.fontSizePx}px`,
    color: marker.color,
  };

  if (marker.kind === 'task') {
    return (
      <span className="writer-marker writer-marker--task" style={base}>
        <input
          type="checkbox"
          checked={marker.checked}
          aria-label="Élément fait"
          onChange={() => onToggle?.()}
          // The pointer must reach the checkbox, whereas the rest of the marker lets the click through to the document to place the cursor there.
          style={{ pointerEvents: 'auto' }}
        />
      </span>
    );
  }

  return (
    <span className="writer-marker" style={base}>
      {marker.text}
    </span>
  );
}

/**
 * Everything an image frame needs, in a single object.
 *
 * Grouped rather than split into ten properties: the chain of transmission crosses three components, and ten arguments at each level would make unreadable what is only a pass-through of context.
 */
export interface ImageContext {
  /** Figure numbers of the document, by `blockId:offset`. */
  figureNumbers: ReadonlyMap<string, number>;
  bodyFontSizePt: number;
  selected: { blockId: string; offset: number } | null;
  zoom: number;
  readOnly: boolean;
  onSelect: (blockId: string, offset: number) => void;
  onOpenDialog: (blockId: string, offset: number) => void;
  onResize: (blockId: string, offset: number, widthPt: number, heightPt: number) => void;
  /** Changes how the frame fits into the text (`SwFmtSurround`). */
  onWrapChange: (blockId: string, offset: number, mode: ImageWrapMode) => void;
  /** Moves a floating frame, in points, in the frame of reference of its anchor. */
  onMove: (blockId: string, offset: number, xPt: number, yPt: number) => void;
  /** End of an image drag, at window coordinates. */
  onDrop: (blockId: string, offset: number, clientX: number, clientY: number) => void;
}

export interface ParagraphViewProps {
  placed: PlacedParagraph;
  layout: ParagraphLayout;
  /** Toggles the checkbox of a checklist item. */
  onToggleTask?: (blockId: string) => void;
  /** Opens the formula editor to modify an existing formula. */
  onEditMath?: ((blockId: string, latex: string, display: boolean) => void) | undefined;
  /** Opens the image workshop on the frame located at this offset. */
  onEditImage?: ((blockId: string, offset: number) => void) | undefined;
  images?: ImageContext | undefined;
}

/**
 * The lines of a piece of paragraph placed on a page.
 *
 * `memo` on the identity of the placement: as long as the engine has not recomputed this paragraph, React has nothing to redo, which keeps typing smooth in a long document, where only the touched paragraph
 * changes identity.
 */
export const ParagraphView = memo(function ParagraphView({
  placed,
  layout,
  onToggleTask,
  onEditMath,
  onEditImage,
  images,
}: ParagraphViewProps): JSX.Element {
  const top = placed.topPx + (placed.isContinuation ? 0 : layout.marginTopPx);
  const rows: JSX.Element[] = [];
  let y = top;

  // The marker only goes with the **first** line: a list carried over to the next page does not show its bullet again, it continues its item.
  if (layout.marker && placed.fromLine === 0) {
    const first = layout.lines[0];
    if (first) {
      rows.push(
        <MarkerView
          key="marqueur"
          marker={layout.marker}
          topPx={top}
          heightPx={first.heightPx}
          onToggle={onToggleTask ? () => onToggleTask(placed.blockId) : undefined}
        />,
      );
    }
  }

  for (let index = placed.fromLine; index < placed.toLine; index += 1) {
    const line = layout.lines[index];
    if (!line) continue;

    rows.push(
      <div
        key={index}
        className="writer-line"
        style={{
          left: `${line.leftPx}px`,
          top: `${y}px`,
          height: `${line.heightPx}px`,
          // The baseline is the one the engine computed: a `line-height` equal to the height puts the text in the right place in the band.
          lineHeight: `${line.heightPx}px`,
          wordSpacing: line.wordSpacingPx > 0 ? `${line.wordSpacingPx}px` : undefined,
        }}
      >
        {line.segments.map((segment) => (
          <SegmentView
            key={segment.startOffset}
            segment={segment}
            blockId={placed.blockId}
            onEditMath={onEditMath}
            onEditImage={onEditImage}
            images={images}
          />
        ))}
      </div>,
    );
    y += line.heightPx;
  }

  return <>{rows}</>;
});
