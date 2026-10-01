// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Atelier de rognage.
 *
 * Transposition du mode « Rogner » de Writer (`svx/source/dialog/grfpage.cxx`,
 * `SvxGrfCropPage`) : on tire un cadre sur l'image, et ce qui est hors du cadre
 * est retranché.
 *
 * Trois choix d'ergonomie :
 *
 *  - **l'image entière reste visible**, la partie retranchée seulement
 *    assombrie. Masquer ce qu'on retire empêcherait de juger de ce qu'on garde,
 *    et interdirait d'élargir à nouveau le cadre ;
 *  - **huit poignées plus l'intérieur** : les quatre coins agissent sur deux
 *    bords à la fois, les quatre milieux sur un seul, l'intérieur déplace le
 *    cadre sans changer sa taille ;
 *  - **le clavier fait tout ce que la souris fait.** Les flèches déplacent le
 *    bord ou le cadre sélectionné ; sans elles, le rognage serait la seule
 *    fonction de l'éditeur inaccessible sans pointeur.
 *
 * Le cadre est exprimé en **fractions de l'image affichée** (0 à 1) et jamais en
 * pixels : le dialogue peut être redimensionné, et l'aperçu changer d'échelle,
 * sans que le rognage bouge.
 */

import { useCallback, useRef, type CSSProperties, type JSX } from 'react';
import { MIN_VISIBLE_FRACTION, type ImageCrop } from '../../domain/document/images';

/** Bord ou coin saisi, ou l'intérieur du cadre. */
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

/** Pas de déplacement au clavier ; `Maj` le décuple. */
const PAS_CLAVIER = 0.01;

export interface ImageCropperProps {
  src: string;
  alt: string;
  /** Rognage de départ, exprimé dans le repère de l'image montrée ici. */
  value: ImageCrop;
  onChange: (crop: ImageCrop) => void;
}

export function ImageCropper({ src, alt, value, onChange }: ImageCropperProps): JSX.Element {
  const cadreRef = useRef<HTMLDivElement | null>(null);

  /**
   * État du geste en cours.
   *
   * Tout est dans une **réf**, jamais dans un état React : le premier
   * `pointermove` peut suivre le `pointerdown` de moins d'une milliseconde, et
   * un état pas encore propagé ferait ignorer ce premier déplacement — le cadre
   * sauterait au second, avec un décalage égal à ce qui a été perdu.
   *
   * Le rognage de départ et le point de saisie sont figés à l'appui : calculer
   * chaque déplacement à partir du précédent accumulerait les arrondis, et le
   * cadre dériverait sous le pointeur au fil d'un long glissement.
   */
  const geste = useRef<{ poignee: Poignee; depart: ImageCrop; x: number; y: number } | null>(null);

  /** Position du pointeur en fraction de l'image affichée. */
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
        // Déplacement : la taille du cadre ne change pas, donc les deux bords
        // opposés bougent d'autant. Le décalage est borné pour que le cadre ne
        // sorte pas de l'image.
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

      // Chaque bord reste dans l'image et laisse passer de quoi voir : on borne
      // ici plutôt qu'après coup, pour que le bord opposé ne soit pas repoussé
      // par la normalisation — le cadre se déformerait sous la main.
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
      // La capture garde le geste vivant quand le pointeur sort du dialogue :
      // sans elle, tirer trop loin lâcherait le cadre au milieu du mouvement.
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

      {/* Zone retranchée : assombrie, mais toujours visible pour qu'on puisse
          juger de ce qu'on coupe — et revenir en arrière. */}
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
