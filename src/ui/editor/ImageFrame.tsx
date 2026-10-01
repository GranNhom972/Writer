// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Cadre image dans le texte : légende, sélection, redimensionnement, rognage.
 *
 * Partage des rôles, conforme à la demande :
 *
 *  - la **fenêtre** règle la légende — titre, mode de numérotation, position,
 *    alignement — ainsi que le **rognage**, qu'on y ouvre en double-cliquant
 *    l'aperçu : c'est là qu'on dispose d'une image assez grande pour désigner
 *    précisément ce que l'on garde, et la taille s'y saisit au millimètre ;
 *  - l'**éditeur**, ici, donne la prise directe : on saisit l'image dans le
 *    texte et on la retaille à la souris, sans rien ouvrir.
 *
 * ## Ce que le moteur impose
 *
 * La hauteur du cadre — image **et** légende — est calculée par `lineBreak`
 * (`captionHeightPx`), qui l'a déjà comptée comme ascendance de la ligne. Ce
 * composant ne peut donc pas décider de sa propre taille : il remplit
 * exactement la boîte qu'on lui donne. Toute marge ajoutée ici ferait diverger
 * le rendu du calcul, et le curseur dériverait du texte.
 *
 * ## Le geste de redimensionnement
 *
 * Le rapport est **conservé par défaut** : déformer une image est presque
 * toujours un accident. `Alt` le relâche pour qui le veut vraiment. Les
 * transactions d'un même glissement se regroupent en une seule entrée
 * d'historique (`dragGroup`), sinon défaire une poignée tirée demanderait
 * autant de `Ctrl+Z` qu'elle a produit d'événements.
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

/** Côté d'une poignée d'angle, en pixels de page. */
const HANDLE_PX = 10;

export interface ImageFrameProps {
  formatting: RunFormatting;
  blockId: string;
  offset: number;
  /** Largeur totale du cadre — image seule, hors légende. */
  widthPx: number;
  /** Hauteur de l'image seule. */
  imageHeightPx: number;
  /** Hauteur réservée à la légende, blanc compris. Zéro s'il n'y en a pas. */
  captionHeightPx: number;
  /** Numéro de figure, ou `null` en mode manuel. */
  figureNumber: number | null;
  /** Taille de police du corps du document, en points. */
  bodyFontSizePt: number;
  selected: boolean;
  zoom: number;
  readOnly: boolean;
  onSelect: (blockId: string, offset: number) => void;
  onOpenDialog: (blockId: string, offset: number) => void;
  onResize: (blockId: string, offset: number, widthPt: number, heightPt: number) => void;
  /** Change l'intégration au texte (`SwFmtSurround`). Absent = réglage indisponible. */
  onWrapChange?: (blockId: string, offset: number, mode: ImageWrapMode) => void;
  /**
   * Déplace un cadre **flottant**, en points, dans le repère de son ancre.
   *
   * Appelé en continu pendant le glissement : le cadre suit le pointeur.
   */
  onMove?: (blockId: string, offset: number, xPt: number, yPt: number) => void;
  /**
   * Fin du glissement, aux coordonnées de la fenêtre.
   *
   * C'est l'éditeur qui sait quel paragraphe se trouve sous ce point ; ce
   * composant ne connaît que sa propre boîte. Il lui passe donc le point brut
   * et le laisse ré-ancrer (`SwFEShell::SetAnchor`).
   */
  onDrop?: (blockId: string, offset: number, clientX: number, clientY: number) => void;
}

/** Les quatre angles, avec leur curseur et le sens de leur tirage. */
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
   * Décalage visuel pendant le glissement d'une image **du fil du texte**.
   *
   * Un cadre flottant se déplace pour de vrai — le modèle porte sa position, et
   * la page le repeint où il va. Une image dans la ligne n'a pas de position à
   * modifier : elle n'en prend une qu'au moment où on la lâche, quand on sait
   * de quel paragraphe elle relève. Entre les deux, ce décalage purement
   * graphique la fait suivre le pointeur — sans lui, le geste ne montre rien et
   * l'on croit que rien ne se passe.
   */
  const [glissement, setGlissement] = useState<{ x: number; y: number } | null>(null);
  const caption = imageCaptionOf(formatting);
  const legende = hasCaption(formatting) ? captionText(caption, figureNumber) : '';
  const crop = imageCrop(formatting);
  const decoupe = hasCrop(crop) ? cropGeometry(crop, widthPx, imageHeightPx) : null;
  const alt = formatting.imageAlt ?? '';

  /* ------------------------------------------------- redimensionnement */

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

      // Le geste se mesure depuis son **origine**, non depuis le dernier
      // événement : la taille est absolue, et cumuler des deltas y accumulerait
      // les arrondis d'un `clampSize` à chaque pas.
      const deltaXPt = pxToPt((event.clientX - drag.startX) / zoom) * drag.dx;
      const deltaYPt = pxToPt((event.clientY - drag.startY) / zoom) * drag.dy;

      const ratio = drag.heightPt / Math.max(1, drag.widthPt);
      let widthPt: number;
      let heightPt: number;

      if (event.altKey) {
        // Déformation assumée : chaque axe suit sa propre poignée.
        widthPt = drag.widthPt + deltaXPt;
        heightPt = drag.heightPt + deltaYPt;
      } else {
        // Rapport conservé. On suit l'axe le plus sollicité, pour que la
        // diagonale réponde sans à-coups quel que soit le sens du geste.
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

  /* ---------------------------------------------------- déplacement */

  /**
   * Glissement d'un cadre flottant.
   *
   * Même principe que le redimensionnement : le geste se mesure **depuis son
   * origine**, non depuis le dernier événement. La position est absolue dans
   * l'ancre, et cumuler des deltas y accumulerait les arrondis de conversion
   * point ↔ pixel — le cadre dériverait sous le curseur au fil du glissement.
   */
  const move = useRef<{
    startX: number;
    startY: number;
    xPt: number;
    yPt: number;
    /** Le cadre flotte : le modèle porte sa position et la suit en direct. */
    flottant: boolean;
    /** Le pointeur a-t-il vraiment bougé ? Un simple clic ne déplace rien. */
    bouge: boolean;
  } | null>(null);

  /** Sous ce seuil, en pixels, le geste est un clic et non un glissement. */
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

      // Un clic n'est pas un dépôt : ré-ancrer sur place remplacerait le run et
      // ferait perdre la sélection à chaque fois qu'on touche l'image.
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
    // Écouteurs sur la fenêtre : un glissement rapide quitte la poignée de
    // 10 px bien avant que la souris ne s'arrête.
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
    // Le blanc est posé **entre** l'image et la légende, du bon côté selon que
    // celle-ci est au-dessus ou au-dessous. Il était auparavant retranché de la
    // hauteur du texte et se retrouvait en bas du cadre, en pur vide.
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
        // Le cadre est posé **sur** la ligne de base et monte d'autant : c'est
        // ce que fait `SwFlyCntFrm`, et c'est la hauteur que le moteur a déjà
        // comptée comme ascendance.
        verticalAlign: 'baseline',
        position: 'relative',
        ...(deplacable ? { cursor: 'move', touchAction: 'none' } : {}),
        // Le fantôme d'une image du fil, pendant qu'on la déplace.
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
         * Toute image se saisit et se pose — `SwFEShell::BeginDrag`.
         *
         * Le geste est le même dans les deux cas, seul son effet diffère : un
         * cadre flottant change de coordonnées, une image du fil change de
         * place dans le texte. Réserver le glissement aux cadres flottants
         * laissait sans réponse le geste le plus naturel sur une image, et le
         * mode par défaut est justement celui du fil.
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
                // Les poignées se posent sur les angles de l'**image**, pas du
                // cadre : la légende n'est pas redimensionnable.
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

      {/*
        Barre d'actions de l'image sélectionnée.

        Le **rognage n'y est pas** : il se règle dans la fenêtre, en
        double-cliquant l'aperçu — c'est là qu'on dispose d'une image assez
        grande pour désigner précisément ce qu'on garde. L'éditeur, lui, garde
        le geste direct : saisir l'image et la retailler.
      */}
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
