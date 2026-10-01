// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Crop workshop.
 *
 * A transposition of Writer's "Crop" mode (`svx/source/dialog/grfpage.cxx`, `SvxGrfCropPage`): you drag a frame on the image, and what is outside the frame is cut away.
 *
 * Three ergonomic choices:
 *
 *  - **the whole image stays visible**, the cut-away part only darkened. Hiding what you remove would make it impossible to judge what you keep, and would forbid widening the
 *    frame again;
 *  - **eight handles plus the inside**: the four corners act on two edges at once, the four midpoints on one, and the inside moves the frame without changing its size;
 *  - **the keyboard does everything the mouse does.** The arrows move the selected edge or the frame; without them, cropping would be the only editor function inaccessible
 *    without a pointer.
 *
 * The frame is expressed in **fractions of the displayed image** (0 to 1) and never in pixels: the dialog can be resized, and the preview change scale, without the crop moving.
 */

import { useCallback, useRef, type CSSProperties, type JSX } from 'react';
import { MIN_VISIBLE_FRACTION, type ImageCrop } from '../../domain/document/images';

/** Edge or corner grabbed, or the inside of the frame. */
type Poignee =
  | 'haut'
  | 'bas'
  | 'gauche'
  | 'droite'
  | 'haut-gauche'
  | 'haut-droite'
  | 'bas-gauche'
  | 'bas-droite'
  | 'interieur';

const POIGNEES: readonly { nom: Poignee; libelle: string; style: CSSProperties }[] = [
  { nom: 'haut-gauche', libelle: 'Coin supérieur gauche', style: { left: 0, top: 0, cursor: 'nwse-resize' } },
  { nom: 'haut', libelle: 'Bord supérieur', style: { left: '50%', top: 0, cursor: 'ns-resize' } },
  { nom: 'haut-droite', libelle: 'Coin supérieur droit', style: { left: '100%', top: 0, cursor: 'nesw-resize' } },
  { nom: 'gauche', libelle: 'Bord gauche', style: { left: 0, top: '50%', cursor: 'ew-resize' } },
  { nom: 'droite', libelle: 'Bord droit', style: { left: '100%', top: '50%', cursor: 'ew-resize' } },
  { nom: 'bas-gauche', libelle: 'Coin inférieur gauche', style: { left: 0, top: '100%', cursor: 'nesw-resize' } },
  { nom: 'bas', libelle: 'Bord inférieur', style: { left: '50%', top: '100%', cursor: 'ns-resize' } },
  { nom: 'bas-droite', libelle: 'Coin inférieur droit', style: { left: '100%', top: '100%', cursor: 'nwse-resize' } },
];

/** Keyboard move step; `Shift` makes it ten times larger. */
const PAS_CLAVIER = 0.01;

export interface ImageCropperProps {
  src: string;
  alt: string;
  /** Starting crop, expressed in the frame of reference of the image shown here. */
  value: ImageCrop;
  onChange: (crop: ImageCrop) => void;
}

export function ImageCropper({ src, alt, value, onChange }: ImageCropperProps): JSX.Element {
  const cadreRef = useRef<HTMLDivElement | null>(null);

  /**
   * State of the gesture in progress.
   *
   * All of it is in a **ref**, never in React state: the first `pointermove` can follow the `pointerdown` by less than a millisecond, and a state that has not propagated yet would make
   * us ignore that first move: the frame would jump at the second one, with an offset equal to what was lost.
   *
   * The starting crop and the grab point are frozen at press time: computing each move from the previous one would accumulate rounding, and the frame would drift under the pointer over a long
   * drag.
   */
  const geste = useRef<{ poignee: Poignee; depart: ImageCrop; x: number; y: number } | null>(null);

  /** Pointer position as a fraction of the displayed image. */
  const fractionDe = useCallback((clientX: number, clientY: number) => {
    const boite = cadreRef.current?.getBoundingClientRect();
    if (!boite || boite.width === 0 || boite.height === 0) return null;
    return {
      x: (clientX - boite.left) / boite.width,
      y: (clientY - boite.top) / boite.height,
    };
  }, []);

  const appliquer = useCallback(
    (poignee: Poignee, depart: ImageCrop, dx: number, dy: number) => {
      let { topPct, rightPct, bottomPct, leftPct } = depart;

      if (poignee === 'interieur') {
        // Move: the frame's size does not change, so the two opposite edges move by the same amount. The offset is bounded so that the frame does not leave the image.
        const dxBorne = Math.max(-leftPct, Math.min(rightPct, dx));
        const dyBorne = Math.max(-topPct, Math.min(bottomPct, dy));
        leftPct += dxBorne;
        rightPct -= dxBorne;
        topPct += dyBorne;
        bottomPct -= dyBorne;
      } else {
        if (poignee.includes('gauche')) leftPct += dx;
        if (poignee.includes('droite')) rightPct -= dx;
        if (poignee.includes('haut')) topPct += dy;
        if (poignee.includes('bas')) bottomPct -= dy;
      }

      // Each edge stays inside the image and leaves enough to see: we bound here rather than afterwards, so that the opposite edge is not pushed by normalization, which would make the frame
      // deform under the hand.
      leftPct = Math.max(0, Math.min(1 - rightPct - MIN_VISIBLE_FRACTION, leftPct));
      rightPct = Math.max(0, Math.min(1 - leftPct - MIN_VISIBLE_FRACTION, rightPct));
      topPct = Math.max(0, Math.min(1 - bottomPct - MIN_VISIBLE_FRACTION, topPct));
      bottomPct = Math.max(0, Math.min(1 - topPct - MIN_VISIBLE_FRACTION, bottomPct));

      onChange({ topPct, rightPct, bottomPct, leftPct });
    },
    [onChange],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, poignee: Poignee) => {
      event.preventDefault();
      event.stopPropagation();
      const position = fractionDe(event.clientX, event.clientY);
      if (!position) return;

      geste.current = { poignee, depart: value, x: position.x, y: position.y };
      // Pointer capture keeps the gesture alive when the pointer leaves the dialog: without it, dragging too far would drop the frame in the middle of the move.
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [fractionDe, value],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const encours = geste.current;
      if (!encours) return;
      const position = fractionDe(event.clientX, event.clientY);
      if (!position) return;
      appliquer(
        encours.poignee,
        encours.depart,
        position.x - encours.x,
        position.y - encours.y,
      );
    },
    [fractionDe, appliquer],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    geste.current = null;
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, poignee: Poignee) => {
      const pas = PAS_CLAVIER * (event.shiftKey ? 10 : 1);
      const deplacements: Record<string, [number, number]> = {
        ArrowLeft: [-pas, 0],
        ArrowRight: [pas, 0],
        ArrowUp: [0, -pas],
        ArrowDown: [0, pas],
      };
      const deplacement = deplacements[event.key];
      if (!deplacement) return;
      event.preventDefault();
      appliquer(poignee, value, deplacement[0], deplacement[1]);
    },
    [appliquer, value],
  );

  const cadre: CSSProperties = {
    left: `${value.leftPct * 100}%`,
    top: `${value.topPct * 100}%`,
    right: `${value.rightPct * 100}%`,
    bottom: `${value.bottomPct * 100}%`,
  };

  const garde = Math.round((1 - value.leftPct - value.rightPct) * 100);
  const gardeHauteur = Math.round((1 - value.topPct - value.bottomPct) * 100);

  return (
    <div
      className="cropper"
      ref={cadreRef}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img className="cropper__image" src={src} alt={alt || 'Image à rogner'} draggable={false} />

      {/* Cut-away area: darkened, but still visible so that you can judge what you are cutting, and go back. */}
      <div className="cropper__ombre" style={cadre} aria-hidden="true" />

      <div
        className="cropper__cadre"
        style={cadre}
        role="group"
        aria-label={`Cadre de rognage : ${garde} % de la largeur, ${gardeHauteur} % de la hauteur`}
      >
        <button
          type="button"
          className="cropper__interieur"
          aria-label="Déplacer le cadre de rognage"
          onPointerDown={(event) => onPointerDown(event, 'interieur')}
          onKeyDown={(event) => onKeyDown(event, 'interieur')}
        />
        {POIGNEES.map((poignee) => (
          <button
            key={poignee.nom}
            type="button"
            className="cropper__poignee"
            style={poignee.style}
            aria-label={poignee.libelle}
            onPointerDown={(event) => onPointerDown(event, poignee.nom)}
            onKeyDown={(event) => onKeyDown(event, poignee.nom)}
          />
        ))}
      </div>
    </div>
  );
}
