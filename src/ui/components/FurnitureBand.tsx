// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * A physical header or footer band for OpenOffice Writer.
 *
 * A single component for both uses (rendering on the sheet and the dialog's workshop). In edit mode, it snaps movements to the page's magnetic guides (margins, center,
 * baseline, other blocks) and shows the alignments visually.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  blocksOf,
  footerLine,
  getThreeZones,
  lineHeightMm,
  renderFurniture,
  snapAxis,
  type FurnitureBand,
  type FurnitureBlock,
  type FurnitureContext,
  type PageFurniture,
  type SnapTarget,
} from '../../domain/document/pageFurniture';

/** Apparent size of a block, in millimeters: measured, never guessed. */
export interface BlockMetrics {
  widthMm: number;
  heightMm: number;
}

/** What the band gives to read during a gesture. */
export interface GestureReadout {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  reperes: string[];
}

interface FurnitureBandViewProps {
  furniture: PageFurniture;
  band: FurnitureBand;
  contexte: FurnitureContext;
  /** Usable width of the band, in millimeters (page minus the margins). */
  usableMm: number;
  /** Height of the band, in millimeters. */
  heightMm: number;
  /** Selected block, in edit mode. */
  selectedId?: string | null;
  /** Block currently in crop mode. */
  cropActiveId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Move finished: the block's new coordinates. */
  onMove?: (id: string, x: number, y: number) => void;
  /** Resizing of a block. */
  onResize?: (id: string, widthMm: number, heightMm: number, x?: number, y?: number) => void;
  /** Change of a block's crop. */
  onCropChange?: (id: string, cropTop: number, cropRight: number, cropBottom: number, cropLeft: number) => void;
  /** Cancel the crop in progress and go back to the previous crop. */
  onCropCancel?: (id: string) => void;
  /** Toggles crop mode. */
  onToggleCrop?: (id: string | null) => void;
  /** End of a gesture. */
  onCommit?: () => void;
  /** Position and dimensions read live during a gesture; `null` at rest. */
  onReadout?: (lecture: GestureReadout | null) => void;
  /** Apparent size of each block, measured after rendering. */
  onMetrics?: (metrics: Record<string, BlockMetrics>) => void;
}

/** Text of the baseline, tokens substituted. */
function ligneDeBase(
  furniture: PageFurniture,
  band: FurnitureBand,
  contexte: FurnitureContext,
): string {
  return band === 'header'
    ? renderFurniture(furniture.header, contexte)
    : footerLine(furniture, contexte);
}

const SEUIL_AIMANT_PX = 7;

function styleDeBloc(bloc: FurnitureBlock, estRognageActif: boolean): CSSProperties {
  const base: CSSProperties = {
    left: `${bloc.x * 100}%`,
    top: `${bloc.y}mm`,
  };

  if (bloc.kind === 'image') {
    if (estRognageActif) {
      return {
        ...base,
        width: `${bloc.widthMm}mm`,
        height: `${bloc.heightMm}mm`,
        overflow: 'visible',
      };
    }

    const cL = bloc.cropLeft ?? 0;
    const cR = bloc.cropRight ?? 0;
    const cT = bloc.cropTop ?? 0;
    const cB = bloc.cropBottom ?? 0;
    const cropW = Math.max(0.01, (100 - cL - cR) / 100);
    const cropH = Math.max(0.01, (100 - cT - cB) / 100);

    return {
      ...base,
      width: `${bloc.widthMm * cropW}mm`,
      height: `${bloc.heightMm * cropH}mm`,
      overflow: 'hidden',
    };
  }

  return {
    ...base,
    fontSize: `${bloc.fontSizePt}pt`,
    fontWeight: bloc.bold ? 700 : 400,
    fontStyle: bloc.italic ? 'italic' : 'normal',
    textDecoration: bloc.underline ? 'underline' : 'none',
    color: bloc.color,
  };
}

function libelleDuBloc(bloc: FurnitureBlock, contexte: FurnitureContext): string {
  const nature = bloc.kind === 'image' ? 'Image' : 'Texte';
  const contenu = bloc.kind === 'image' ? bloc.alt || 'sans description' : renderFurniture(bloc.text, contexte);
  return `${nature} « ${contenu} » — flèches pour déplacer, Suppr pour retirer`;
}

export function FurnitureBandView({
  furniture,
  band,
  contexte,
  usableMm,
  heightMm,
  selectedId = null,
  cropActiveId = null,
  onSelect,
  onMove,
  onResize,
  onCropChange,
  onCropCancel,
  onToggleCrop,
  onCommit,
  onReadout,
  onMetrics,
}: FurnitureBandViewProps): JSX.Element {
  const planRef = useRef<HTMLDivElement | null>(null);
  const editable = onMove !== undefined;
  const ligne = ligneDeBase(furniture, band, contexte);
  const blocs = blocksOf(furniture, band);

  const [guidesX, setGuidesX] = useState<SnapTarget[]>([]);
  const [guidesY, setGuidesY] = useState<SnapTarget[]>([]);

  const readoutRef = useRef(onReadout);
  readoutRef.current = onReadout;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const metricsRef = useRef(onMetrics);
  metricsRef.current = onMetrics;

  const mesures = useRef<Record<string, BlockMetrics>>({});
  const signature = useRef('');
  const geste = useRef(false);

  useLayoutEffect(() => {
    if (metricsRef.current === undefined || geste.current) return;

    const plan = planRef.current;
    if (!plan) return;
    const rectPlan = plan.getBoundingClientRect();
    if (rectPlan.width <= 0) return;
    const mmParPx = usableMm / rectPlan.width;

    const suivantes: Record<string, BlockMetrics> = {};
    for (const bloc of blocs) {
      const element = plan.querySelector<HTMLElement>(`[data-bloc-id="${bloc.id}"]`);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      suivantes[bloc.id] = {
        widthMm: Math.round(rect.width * mmParPx * 10) / 10,
        heightMm: Math.round(rect.height * mmParPx * 10) / 10,
      };
    }

    const empreinte = JSON.stringify(suivantes);
    if (empreinte === signature.current) return;
    signature.current = empreinte;
    mesures.current = suivantes;
    metricsRef.current?.(suivantes);
  });

  useEffect(() => {
    if (!cropActiveId) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onToggleCrop?.(null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCropCancel?.(cropActiveId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cropActiveId, onCropCancel, onToggleCrop]);

  const debutDeGeste = (): void => {
    geste.current = true;
  };

  const finDeGeste = (): void => {
    geste.current = false;
    setGuidesX([]);
    setGuidesY([]);
    readoutRef.current?.(null);
    commitRef.current?.();
  };

  const ciblesX = (sauf: string): SnapTarget[] => {
    const cibles: SnapTarget[] = [
      { mm: furniture.marginLeftMm, kind: 'margin', label: 'Marge gauche' },
      { mm: usableMm - furniture.marginRightMm, kind: 'margin', label: 'Marge droite' },
      { mm: usableMm / 2, kind: 'center', label: 'Centre de la page' },
    ];

    for (const autre of blocs) {
      if (autre.id === sauf) continue;
      const mesure = mesures.current[autre.id];
      if (!mesure) continue;
      const gauche = autre.x * usableMm;
      cibles.push(
        { mm: gauche, kind: 'block', label: 'Bord d’un élément' },
        { mm: gauche + mesure.widthMm / 2, kind: 'block', label: 'Axe d’un élément' },
        { mm: gauche + mesure.widthMm, kind: 'block', label: 'Bord d’un élément' },
      );
    }
    return cibles;
  };

  const ciblesY = (sauf: string): SnapTarget[] => {
    const hauteurLigne = lineHeightMm(furniture.fontSizePt);
    const hautLigne =
      band === 'header' ? furniture.headerMm : heightMm - furniture.footerMm - hauteurLigne;

    const cibles: SnapTarget[] = [
      { mm: 0, kind: 'edge', label: 'Haut de la bande' },
      { mm: heightMm / 2, kind: 'center', label: 'Milieu de la bande' },
      { mm: heightMm, kind: 'edge', label: 'Bas de la bande' },
    ];

    if (ligne !== '') {
      cibles.push(
        { mm: hautLigne, kind: 'baseline', label: 'Haut de la ligne' },
        { mm: hautLigne + hauteurLigne, kind: 'baseline', label: 'Base de la ligne' },
      );
    }

    for (const autre of blocs) {
      if (autre.id === sauf) continue;
      const mesure = mesures.current[autre.id];
      if (!mesure) continue;
      cibles.push(
        { mm: autre.y, kind: 'block', label: 'Bord d’un élément' },
        { mm: autre.y + mesure.heightMm / 2, kind: 'block', label: 'Axe d’un élément' },
        { mm: autre.y + mesure.heightMm, kind: 'block', label: 'Bord d’un élément' },
      );
    }
    return cibles;
  };

  const commencerDeplacement = (bloc: FurnitureBlock) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0 || cropActiveId === bloc.id) return;
    const plan = planRef.current;
    if (!plan) return;

    event.preventDefault();
    event.stopPropagation();
    onSelect?.(bloc.id);

    const cible = event.currentTarget;
    const planRect = plan.getBoundingClientRect();
    const blocRect = cible.getBoundingClientRect();
    const mmParPx = usableMm / planRect.width;
    const priseX = event.clientX - blocRect.left;
    const priseY = event.clientY - blocRect.top;

    const largeurMm = blocRect.width * mmParPx;
    const hauteurMm = blocRect.height * mmParPx;
    const seuilMm = SEUIL_AIMANT_PX * mmParPx;
    const cX = ciblesX(bloc.id);
    const cY = ciblesY(bloc.id);

    debutDeGeste();
    cible.setPointerCapture(event.pointerId);

    const deplacer = (mouvement: PointerEvent): void => {
      const brutX = (mouvement.clientX - priseX - planRect.left) * mmParPx;
      const brutY = (mouvement.clientY - priseY - planRect.top) * mmParPx;

      const libre = mouvement.altKey;
      const axeX = libre
        ? { startMm: brutX, guides: [] }
        : snapAxis(brutX, largeurMm, cX, seuilMm);
      const axeY = libre
        ? { startMm: brutY, guides: [] }
        : snapAxis(brutY, hauteurMm, cY, seuilMm);

      const xMm = Math.min(usableMm, Math.max(0, axeX.startMm));
      const yMm = Math.max(0, axeY.startMm);

      setGuidesX(axeX.guides);
      setGuidesY(axeY.guides);
      readoutRef.current?.({
        xMm: Math.round(xMm * 10) / 10,
        yMm: Math.round(yMm * 10) / 10,
        widthMm: Math.round(largeurMm * 10) / 10,
        heightMm: Math.round(hauteurMm * 10) / 10,
        reperes: [...axeX.guides, ...axeY.guides]
          .map((g) => g.label ?? '')
          .filter((label, index, tout) => label !== '' && tout.indexOf(label) === index),
      });

      onMove?.(bloc.id, Math.round((xMm / usableMm) * 1000) / 1000, Math.round(yMm * 10) / 10);
    };

    const relacher = (): void => {
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerup', relacher);
      window.removeEventListener('pointercancel', relacher);
      finDeGeste();
    };

    window.addEventListener('pointermove', deplacer);
    window.addEventListener('pointerup', relacher);
    window.addEventListener('pointercancel', relacher);
  };

  const commencerRedimensionnementCorner = (bloc: FurnitureBlock, corner: 'nw' | 'ne' | 'sw' | 'se') => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    const plan = planRef.current;
    if (!plan) return;

    event.preventDefault();
    event.stopPropagation();

    const planRect = plan.getBoundingClientRect();
    const mmParPx = usableMm / planRect.width;
    const startX = event.clientX;
    const startY = event.clientY;
    const cL = bloc.cropLeft ?? 0;
    const cR = bloc.cropRight ?? 0;
    const cT = bloc.cropTop ?? 0;
    const cB = bloc.cropBottom ?? 0;
    const cropW = Math.max(0.01, (100 - cL - cR) / 100);
    const cropH = Math.max(0.01, (100 - cT - cB) / 100);

    const startW = bloc.widthMm;
    const startH = bloc.heightMm;
    const startXFrac = bloc.x;
    const startYMm = bloc.y;
    const aspect = startH / Math.max(1, startW);

    debutDeGeste();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    const deplacer = (m: PointerEvent): void => {
      const dxMm = ((m.clientX - startX) * mmParPx) / cropW;

      let newW = startW;
      let newX = startXFrac;
      let newY = startYMm;

      if (corner === 'se') {
        newW = Math.max(5, startW + dxMm);
      } else if (corner === 'sw') {
        newW = Math.max(5, startW - dxMm);
        newX = Math.max(0, startXFrac + ((startW - newW) * cropW) / usableMm);
      } else if (corner === 'ne') {
        newW = Math.max(5, startW + dxMm);
        const dyMm = ((m.clientY - startY) * mmParPx) / cropH;
        newY = Math.max(0, startYMm + dyMm * cropH);
      } else if (corner === 'nw') {
        newW = Math.max(5, startW - dxMm);
        newX = Math.max(0, startXFrac + ((startW - newW) * cropW) / usableMm);
        const dyMm = ((m.clientY - startY) * mmParPx) / cropH;
        newY = Math.max(0, startYMm + dyMm * cropH);
      }

      const newH = Math.round(newW * aspect * 10) / 10;
      readoutRef.current?.({
        xMm: Math.round(newX * usableMm * 10) / 10,
        yMm: Math.round(newY * 10) / 10,
        widthMm: Math.round(newW * cropW * 10) / 10,
        heightMm: Math.round(newH * cropH * 10) / 10,
        reperes: [],
      });
      onResize?.(bloc.id, Math.round(newW * 10) / 10, newH, Math.round(newX * 1000) / 1000, Math.round(newY * 10) / 10);
    };

    const relacher = (): void => {
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerup', relacher);
      window.removeEventListener('pointercancel', relacher);
      finDeGeste();
    };

    window.addEventListener('pointermove', deplacer);
    window.addEventListener('pointerup', relacher);
    window.addEventListener('pointercancel', relacher);
  };

  const commencerRedimensionnementEdge = (bloc: FurnitureBlock, edge: 'n' | 's' | 'w' | 'e') => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    const plan = planRef.current;
    if (!plan) return;

    event.preventDefault();
    event.stopPropagation();

    const planRect = plan.getBoundingClientRect();
    const mmParPx = usableMm / planRect.width;
    const startX = event.clientX;
    const startY = event.clientY;

    const cL = bloc.cropLeft ?? 0;
    const cR = bloc.cropRight ?? 0;
    const cT = bloc.cropTop ?? 0;
    const cB = bloc.cropBottom ?? 0;
    const cropW = Math.max(0.01, (100 - cL - cR) / 100);
    const cropH = Math.max(0.01, (100 - cT - cB) / 100);

    const startW = bloc.widthMm;
    const startH = bloc.heightMm;
    const startXFrac = bloc.x;
    const startYMm = bloc.y;

    debutDeGeste();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    const deplacer = (m: PointerEvent): void => {
      const dxMm = ((m.clientX - startX) * mmParPx) / cropW;
      const dyMm = ((m.clientY - startY) * mmParPx) / cropH;

      let newW = startW;
      let newH = startH;
      let newX = startXFrac;
      let newY = startYMm;

      if (edge === 'e') {
        newW = Math.max(5, startW + dxMm);
      } else if (edge === 'w') {
        newW = Math.max(5, startW - dxMm);
        newX = Math.max(0, startXFrac + ((startW - newW) * cropW) / usableMm);
      } else if (edge === 's') {
        newH = Math.max(5, startH + dyMm);
      } else if (edge === 'n') {
        newH = Math.max(5, startH - dyMm);
        newY = Math.max(0, startYMm + dyMm * cropH);
      }

      readoutRef.current?.({
        xMm: Math.round(newX * usableMm * 10) / 10,
        yMm: Math.round(newY * 10) / 10,
        widthMm: Math.round(newW * cropW * 10) / 10,
        heightMm: Math.round(newH * cropH * 10) / 10,
        reperes: [],
      });
      onResize?.(bloc.id, Math.round(newW * 10) / 10, Math.round(newH * 10) / 10, Math.round(newX * 1000) / 1000, Math.round(newY * 10) / 10);
    };

    const relacher = (): void => {
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerup', relacher);
      window.removeEventListener('pointercancel', relacher);
      finDeGeste();
    };

    window.addEventListener('pointermove', deplacer);
    window.addEventListener('pointerup', relacher);
    window.addEventListener('pointercancel', relacher);
  };

  const commencerPanRognage = (bloc: FurnitureBlock) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    const handleEl = event.currentTarget;
    const parent = handleEl.closest('.bande__bloc') as HTMLElement;
    if (!parent) return;

    event.preventDefault();
    event.stopPropagation();

    const parentRect = parent.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;

    const initT = bloc.cropTop ?? 0;
    const initR = bloc.cropRight ?? 0;
    const initB = bloc.cropBottom ?? 0;
    const initL = bloc.cropLeft ?? 0;

    const boxW = 100 - initL - initR;
    const boxH = 100 - initT - initB;

    debutDeGeste();
    handleEl.setPointerCapture(event.pointerId);

    const deplacer = (m: PointerEvent): void => {
      const dxPx = m.clientX - startX;
      const dyPx = m.clientY - startY;

      const dxPct = (dxPx / Math.max(1, parentRect.width)) * 100;
      const dyPct = (dyPx / Math.max(1, parentRect.height)) * 100;

      const newL = Math.max(0, Math.min(100 - boxW, initL + dxPct));
      const newR = Math.max(0, 100 - boxW - newL);
      const newT = Math.max(0, Math.min(100 - boxH, initT + dyPct));
      const newB = Math.max(0, 100 - boxH - newT);

      onCropChange?.(bloc.id, Math.round(newT), Math.round(newR), Math.round(newB), Math.round(newL));
    };

    const relacher = (): void => {
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerup', relacher);
      window.removeEventListener('pointercancel', relacher);
      finDeGeste();
    };

    window.addEventListener('pointermove', deplacer);
    window.addEventListener('pointerup', relacher);
    window.addEventListener('pointercancel', relacher);
  };

  const commencerRognage = (bloc: FurnitureBlock, side: 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se') => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    const handleEl = event.currentTarget;
    const parent = handleEl.closest('.bande__bloc') as HTMLElement;
    if (!parent) return;

    event.preventDefault();
    event.stopPropagation();

    const parentRect = parent.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;

    const initT = bloc.cropTop ?? 0;
    const initR = bloc.cropRight ?? 0;
    const initB = bloc.cropBottom ?? 0;
    const initL = bloc.cropLeft ?? 0;

    debutDeGeste();
    handleEl.setPointerCapture(event.pointerId);

    const deplacer = (m: PointerEvent): void => {
      const dxPx = m.clientX - startX;
      const dyPx = m.clientY - startY;

      const dxPct = (dxPx / Math.max(1, parentRect.width)) * 100;
      const dyPct = (dyPx / Math.max(1, parentRect.height)) * 100;

      let t = initT;
      let r = initR;
      let b = initB;
      let l = initL;

      if (side.includes('n')) t = Math.max(0, Math.min(100 - initB - 5, initT + dyPct));
      if (side.includes('s')) b = Math.max(0, Math.min(100 - initT - 5, initB - dyPct));
      if (side.includes('w')) l = Math.max(0, Math.min(100 - initR - 5, initL + dxPct));
      if (side.includes('e')) r = Math.max(0, Math.min(100 - initL - 5, initR - dxPct));

      onCropChange?.(bloc.id, Math.round(t), Math.round(r), Math.round(b), Math.round(l));
    };

    const relacher = (): void => {
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerup', relacher);
      window.removeEventListener('pointercancel', relacher);
      finDeGeste();
    };

    window.addEventListener('pointermove', deplacer);
    window.addEventListener('pointerup', relacher);
    window.addEventListener('pointercancel', relacher);
  };

  const centrerRognage = (bloc: FurnitureBlock): void => {
    const cT = bloc.cropTop ?? 0;
    const cB = bloc.cropBottom ?? 0;
    const cL = bloc.cropLeft ?? 0;
    const cR = bloc.cropRight ?? 0;

    const totalV = cT + cB;
    const totalH = cL + cR;

    const halfV = Math.round(totalV / 2);
    const halfH = Math.round(totalH / 2);

    onCropChange?.(bloc.id, halfV, totalH - halfH, totalV - halfV, halfH);
  };

  const appliquerRatio = (bloc: FurnitureBlock, targetRatio: number): void => {
    const baseW = Math.max(1, bloc.widthMm);
    const baseH = Math.max(1, bloc.heightMm);
    const baseRatio = baseW / baseH;

    let t = 0;
    let b = 0;
    let l = 0;
    let r = 0;

    if (baseRatio > targetRatio) {
      const visibleWFrac = targetRatio / baseRatio;
      const cutH = Math.max(0, (1 - visibleWFrac) * 100);
      l = Math.round(cutH / 2);
      r = Math.round(cutH - l);
    } else {
      const visibleHFrac = baseRatio / targetRatio;
      const cutV = Math.max(0, (1 - visibleHFrac) * 100);
      t = Math.round(cutV / 2);
      b = Math.round(cutV - t);
    }

    onCropChange?.(bloc.id, t, r, b, l);
  };

  const auClavier = (bloc: FurnitureBlock) => (event: React.KeyboardEvent<HTMLElement>) => {
    if (!editable) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      onSelect?.(null);
      commitRef.current?.();
      return;
    }

    const pas = event.shiftKey ? 5 : 1;
    const pasX = pas / usableMm;

    const deplacements: Record<string, [number, number]> = {
      ArrowLeft: [-pasX, 0],
      ArrowRight: [pasX, 0],
      ArrowUp: [0, -pas],
      ArrowDown: [0, pas],
    };
    const delta = deplacements[event.key];
    if (!delta) return;

    event.preventDefault();
    onMove?.(
      bloc.id,
      Math.round(Math.min(1, Math.max(0, bloc.x + delta[0])) * 1000) / 1000,
      Math.round(Math.max(0, bloc.y + delta[1]) * 10) / 10,
    );
  };

  const alignement = band === 'header' ? furniture.headerAlign : furniture.footerAlign;
  const zones = getThreeZones(furniture, band, contexte.page);
  const hasThreeZones = !!(zones.left || zones.center || zones.right);
  const bg = band === 'header' ? furniture.headerBackground : furniture.footerBackground;

  return (
    <div
      ref={planRef}
      className={`bande bande--${band}${editable ? ' bande--editable' : ''}`}
      style={
        {
          width: `${usableMm}mm`,
          height: `${Math.max(heightMm, 0)}mm`,
          backgroundColor: bg || undefined,
          '--bande-marge-gauche': `${furniture.marginLeftMm}mm`,
          '--bande-marge-droite': `${furniture.marginRightMm}mm`,
        } as CSSProperties
      }
      onPointerDown={editable ? () => onSelect?.(null) : undefined}
    >
      {editable && (
        <div
          className="bande__margin-guide"
          style={{
            left: `${furniture.marginLeftMm}mm`,
            right: `${furniture.marginRightMm}mm`,
          }}
          title="Marges du corps de texte"
        />
      )}

      {/* Header separator line (at the bottom) */}
      {band === 'header' && furniture.headerSeparator && (
        <div
          className="bande__separator bande__separator--header"
          style={{
            position: 'absolute',
            left: `${furniture.marginLeftMm}mm`,
            right: `${furniture.marginRightMm}mm`,
            bottom: 0,
            borderBottom: `${furniture.headerSeparatorWidthPt ?? 0.75}pt ${furniture.headerSeparatorStyle ?? 'solid'} ${furniture.headerSeparatorColor ?? '#d0d5dd'}`,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Footer separator line (at the top) */}
      {band === 'footer' && furniture.footerSeparator && (
        <div
          className="bande__separator bande__separator--footer"
          style={{
            position: 'absolute',
            left: `${furniture.marginLeftMm}mm`,
            right: `${furniture.marginRightMm}mm`,
            top: 0,
            borderTop: `${furniture.footerSeparatorWidthPt ?? 0.75}pt ${furniture.footerSeparatorStyle ?? 'solid'} ${furniture.footerSeparatorColor ?? '#d0d5dd'}`,
            pointerEvents: 'none',
          }}
        />
      )}

      {hasThreeZones ? (
        <div
          className="bande__three-zones"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
            position: 'absolute',
            fontSize: `${furniture.fontSizePt}pt`,
            paddingLeft: `${furniture.marginLeftMm}mm`,
            paddingRight: `${furniture.marginRightMm}mm`,
            boxSizing: 'border-box',
            top: band === 'header' ? `${furniture.headerMm}mm` : undefined,
            bottom: band === 'footer' ? `${furniture.footerMm}mm` : undefined,
          }}
        >
          <span className="bande__zone bande__zone--left" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {renderFurniture(zones.left, contexte)}
          </span>
          <span className="bande__zone bande__zone--center" style={{ flex: 1, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {renderFurniture(zones.center, contexte)}
          </span>
          <span className="bande__zone bande__zone--right" style={{ flex: 1, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {renderFurniture(zones.right, contexte)}
          </span>
        </div>
      ) : ligne !== '' ? (
        <span
          className="bande__ligne"
          style={{
            textAlign: alignement,
            fontSize: `${furniture.fontSizePt}pt`,
            paddingLeft: `${furniture.marginLeftMm}mm`,
            paddingRight: `${furniture.marginRightMm}mm`,
            boxSizing: 'border-box',
            top: band === 'header' ? `${furniture.headerMm}mm` : undefined,
            bottom: band === 'footer' ? `${furniture.footerMm}mm` : undefined,
          }}
        >
          {ligne}
        </span>
      ) : null}

      {blocs.map((bloc) => {
        const selectionne = bloc.id === selectedId;
        const estRognageActif = cropActiveId === bloc.id;

        const cL = bloc.cropLeft ?? 0;
        const cR = bloc.cropRight ?? 0;
        const cT = bloc.cropTop ?? 0;
        const cB = bloc.cropBottom ?? 0;

        const classes = [
          'bande__bloc',
          `bande__bloc--${bloc.kind}`,
          selectionne ? 'bande__bloc--selectionne' : '',
          estRognageActif ? 'bande__bloc--cropping' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={bloc.id}
            data-bloc-id={bloc.id}
            className={classes}
            style={styleDeBloc(bloc, estRognageActif)}
            tabIndex={editable ? 0 : undefined}
            role={editable ? 'button' : undefined}
            aria-pressed={editable ? selectionne : undefined}
            aria-label={editable ? libelleDuBloc(bloc, contexte) : undefined}
            onPointerDown={commencerDeplacement(bloc)}
            onDoubleClick={(event) => {
              if (bloc.kind === 'image' && editable) {
                event.stopPropagation();
                onToggleCrop?.(estRognageActif ? null : bloc.id);
              }
            }}
            onKeyDown={auClavier(bloc)}
            onBlur={editable ? () => commitRef.current?.() : undefined}
          >
            {bloc.kind === 'image' ? (
              estRognageActif ? (
                <>
                  <img
                    className="bande__crop-full-img"
                    src={bloc.src}
                    alt=""
                    draggable={false}
                  />

                  <div className="bande__crop-dimmer bande__crop-dimmer--top" style={{ top: 0, left: 0, right: 0, height: `${cT}%` }} />
                  <div className="bande__crop-dimmer bande__crop-dimmer--bottom" style={{ bottom: 0, left: 0, right: 0, height: `${cB}%` }} />
                  <div className="bande__crop-dimmer bande__crop-dimmer--left" style={{ top: `${cT}%`, bottom: `${cB}%`, left: 0, width: `${cL}%` }} />
                  <div className="bande__crop-dimmer bande__crop-dimmer--right" style={{ top: `${cT}%`, bottom: `${cB}%`, right: 0, width: `${cR}%` }} />

                  <div
                    className="bande__crop-box"
                    style={{
                      top: `${cT}%`,
                      left: `${cL}%`,
                      right: `${cR}%`,
                      bottom: `${cB}%`,
                    }}
                    onPointerDown={commencerPanRognage(bloc)}
                    title="Glisser pour recadrer l'image"
                  >
                    <div className="bande__crop-grid" />
                    <div className="bande__crop-handle bande__crop-handle--nw" onPointerDown={commencerRognage(bloc, 'nw')} title="Rogner coin haut-gauche" />
                    <div className="bande__crop-handle bande__crop-handle--ne" onPointerDown={commencerRognage(bloc, 'ne')} title="Rogner coin haut-droit" />
                    <div className="bande__crop-handle bande__crop-handle--sw" onPointerDown={commencerRognage(bloc, 'sw')} title="Rogner coin bas-gauche" />
                    <div className="bande__crop-handle bande__crop-handle--se" onPointerDown={commencerRognage(bloc, 'se')} title="Rogner coin bas-droit" />

                    <div className="bande__crop-handle bande__crop-handle--n" onPointerDown={commencerRognage(bloc, 'n')} title="Rogner haut" />
                    <div className="bande__crop-handle bande__crop-handle--s" onPointerDown={commencerRognage(bloc, 's')} title="Rogner bas" />
                    <div className="bande__crop-handle bande__crop-handle--w" onPointerDown={commencerRognage(bloc, 'w')} title="Rogner gauche" />
                    <div className="bande__crop-handle bande__crop-handle--e" onPointerDown={commencerRognage(bloc, 'e')} title="Rogner droite" />
                  </div>

                  <div className="bande__crop-toolbar" onPointerDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="bande__crop-btn bande__crop-btn--valider"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleCrop?.(null);
                      }}
                      title="Valider le rognage (Entrée)"
                    >
                      ✓ Valider
                    </button>
                    <button
                      type="button"
                      className="bande__crop-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCropCancel?.(bloc.id);
                      }}
                      title="Annuler le rognage (Échap)"
                    >
                      ✕ Annuler
                    </button>
                    <span className="bande__crop-divider" />
                    <button
                      type="button"
                      className="bande__crop-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        centrerRognage(bloc);
                      }}
                      title="Centrer le cadrage"
                    >
                      ⌖ Centrer
                    </button>
                    <button
                      type="button"
                      className="bande__crop-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCropChange?.(bloc.id, 0, 0, 0, 0);
                      }}
                      title="Réinitialiser le rognage"
                    >
                      ↺ 0%
                    </button>
                    <span className="bande__crop-divider" />
                    <div className="bande__crop-ratios">
                      <button type="button" className="bande__crop-ratio-btn" onClick={(e) => { e.stopPropagation(); appliquerRatio(bloc, 1); }} title="Ratio carré 1:1">1:1</button>
                      <button type="button" className="bande__crop-ratio-btn" onClick={(e) => { e.stopPropagation(); appliquerRatio(bloc, 4 / 3); }} title="Ratio photo 4:3">4:3</button>
                      <button type="button" className="bande__crop-ratio-btn" onClick={(e) => { e.stopPropagation(); appliquerRatio(bloc, 16 / 9); }} title="Ratio écran 16:9">16:9</button>
                    </div>
                  </div>
                </>
              ) : (
                <img
                  src={bloc.src}
                  alt={bloc.alt}
                  draggable={false}
                  className="bande__img"
                  style={{
                    position: 'absolute',
                    width: `${bloc.widthMm}mm`,
                    height: `${bloc.heightMm}mm`,
                    left: `-${bloc.widthMm * (cL / 100)}mm`,
                    top: `-${bloc.heightMm * (cT / 100)}mm`,
                    objectFit: 'fill',
                    pointerEvents: 'none',
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }}
                />
              )
            ) : (
              renderFurniture(bloc.text, contexte)
            )}

            {editable && bloc.kind === 'image' && selectionne && !estRognageActif && (
              <>
                <div className="bande__handle bande__handle--nw" onPointerDown={commencerRedimensionnementCorner(bloc, 'nw')} title="Redimensionner proportionnellement" />
                <div className="bande__handle bande__handle--ne" onPointerDown={commencerRedimensionnementCorner(bloc, 'ne')} title="Redimensionner proportionnellement" />
                <div className="bande__handle bande__handle--sw" onPointerDown={commencerRedimensionnementCorner(bloc, 'sw')} title="Redimensionner proportionnellement" />
                <div className="bande__handle bande__handle--se" onPointerDown={commencerRedimensionnementCorner(bloc, 'se')} title="Redimensionner proportionnellement" />

                <div className="bande__handle bande__handle--n" onPointerDown={commencerRedimensionnementEdge(bloc, 'n')} title="Élargir / étirer haut" />
                <div className="bande__handle bande__handle--s" onPointerDown={commencerRedimensionnementEdge(bloc, 's')} title="Élargir / étirer bas" />
                <div className="bande__handle bande__handle--w" onPointerDown={commencerRedimensionnementEdge(bloc, 'w')} title="Élargir / étirer gauche" />
                <div className="bande__handle bande__handle--e" onPointerDown={commencerRedimensionnementEdge(bloc, 'e')} title="Élargir / étirer droite" />
              </>
            )}
          </div>
        );
      })}

      {guidesX.map((guide, index) => (
        <div
          key={`x-${index}-${guide.mm}`}
          className={`bande__repere bande__repere--v bande__repere--${guide.kind}`}
          style={{ left: `${guide.mm}mm` }}
          aria-hidden="true"
        />
      ))}
      {guidesY.map((guide, index) => (
        <div
          key={`y-${index}-${guide.mm}`}
          className={`bande__repere bande__repere--h bande__repere--${guide.kind}`}
          style={{ top: `${guide.mm}mm` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
