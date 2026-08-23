/**
 * Une bande d'en-tête ou de pied — celle qu'on voit sur la feuille, et celle
 * qu'on manipule dans le dialogue.
 *
 * **Un seul composant pour les deux usages**, à dessein : un aperçu qui ne
 * partage pas son code avec le rendu finit toujours par mentir. Il est ici posé
 * en millimètres réels ; c'est l'appelant qui décide de l'échelle (naturelle sur
 * la feuille, réduite dans le dialogue).
 *
 * La bande contient deux choses de nature différente, comme chez Writer :
 *  - la **ligne de base**, qui coule dans le cadre (`SwHeaderFrm`) et se cale
 *    sur l'alignement choisi ;
 *  - les **blocs libres**, qui sont des objets ancrés (`SwFlyFrm`) dont la
 *    position est donnée en absolu.
 */

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  blocksOf,
  footerLine,
  renderFurniture,
  type FurnitureBand,
  type FurnitureBlock,
  type FurnitureContext,
  type PageFurniture,
} from '../document/pageFurniture';

const PX_PAR_MM = 96 / 25.4;

interface FurnitureBandViewProps {
  furniture: PageFurniture;
  band: FurnitureBand;
  contexte: FurnitureContext;
  /** Largeur utile de la bande, en millimètres (page moins les marges). */
  usableMm: number;
  /** Hauteur de la bande, en millimètres. */
  heightMm: number;
  /** Bloc sélectionné, en mode édition. */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Déplacement terminé : nouvelles coordonnées du bloc. */
  onMove?: (id: string, x: number, y: number) => void;
}

/** Texte de la ligne de base, jetons substitués. */
function ligneDeBase(
  furniture: PageFurniture,
  band: FurnitureBand,
  contexte: FurnitureContext,
): string {
  return band === 'header'
    ? renderFurniture(furniture.header, contexte)
    : footerLine(furniture, contexte);
}

function styleDeBloc(bloc: FurnitureBlock): CSSProperties {
  const base: CSSProperties = {
    left: `${bloc.x * 100}%`,
    top: `${bloc.y}mm`,
  };

  if (bloc.kind === 'image') {
    return { ...base, width: `${bloc.widthMm}mm`, height: `${bloc.heightMm}mm` };
  }

  return {
    ...base,
    fontSize: `${bloc.fontSizePt}pt`,
    fontWeight: bloc.bold ? 700 : 400,
    fontStyle: bloc.italic ? 'italic' : 'normal',
    textDecoration: bloc.underline ? 'underline' : 'none',
    // La couleur a traversé `readFurniture` : c'est un `#rrggbb`, jamais une
    // valeur libre venue du réseau.
    color: bloc.color,
  };
}

export function FurnitureBandView({
  furniture,
  band,
  contexte,
  usableMm,
  heightMm,
  selectedId = null,
  onSelect,
  onMove,
}: FurnitureBandViewProps) {
  const planRef = useRef<HTMLDivElement | null>(null);
  const editable = onMove !== undefined;
  const ligne = ligneDeBase(furniture, band, contexte);
  const blocs = blocksOf(furniture, band);

  /**
   * Déplacement d'un bloc.
   *
   * Les millimètres se déduisent du rectangle mesuré, jamais d'une échelle
   * supposée : la bande est réduite dans le dialogue et à taille réelle sur la
   * feuille, et le même code doit valoir dans les deux cas.
   */
  const commencerDeplacement = (bloc: FurnitureBlock) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    const plan = planRef.current;
    if (!plan) return;

    event.preventDefault();
    event.stopPropagation();
    onSelect?.(bloc.id);

    const cible = event.currentTarget;
    const planRect = plan.getBoundingClientRect();
    const blocRect = cible.getBoundingClientRect();
    const mmParPx = usableMm / planRect.width;
    // Distance entre le point saisi et le coin du bloc : sans elle, le bloc
    // sauterait sous le pointeur au premier mouvement.
    const priseX = event.clientX - blocRect.left;
    const priseY = event.clientY - blocRect.top;
    const largeurMm = blocRect.width * mmParPx;

    cible.setPointerCapture(event.pointerId);

    const deplacer = (mouvement: PointerEvent): void => {
      const gaucheMm = (mouvement.clientX - priseX - planRect.left) * mmParPx;
      const hautMm = (mouvement.clientY - priseY - planRect.top) * mmParPx;

      // Le bloc reste dans la bande : au-delà, il passerait sous la marge ou
      // hors de la feuille, où personne ne le retrouverait.
      const xMax = Math.max(0, 1 - largeurMm / usableMm);
      const x = Math.min(xMax, Math.max(0, gaucheMm / usableMm));
      const y = Math.max(0, hautMm);

      onMove?.(bloc.id, Math.round(x * 1000) / 1000, Math.round(y * 10) / 10);
    };

    const relacher = (): void => {
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerup', relacher);
      window.removeEventListener('pointercancel', relacher);
    };

    window.addEventListener('pointermove', deplacer);
    window.addEventListener('pointerup', relacher);
    window.addEventListener('pointercancel', relacher);
  };

  /** Déplacement au clavier : la souris ne DOIT pas être le seul moyen. */
  const auClavier = (bloc: FurnitureBlock) => (event: React.KeyboardEvent<HTMLElement>) => {
    if (!editable) return;
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

  return (
    <div
      ref={planRef}
      className={`bande bande--${band}${editable ? ' bande--editable' : ''}`}
      style={{ width: `${usableMm}mm`, height: `${Math.max(heightMm, 0)}mm` }}
      onPointerDown={editable ? () => onSelect?.(null) : undefined}
    >
      {ligne !== '' && (
        <span
          className="bande__ligne"
          style={{
            textAlign: alignement,
            fontSize: `${furniture.fontSizePt}pt`,
            // L'en-tête pose sa ligne en haut de bande, le pied la pose en bas :
            // c'est le bord du filet qui sert de repère dans les deux cas.
            [band === 'header' ? 'top' : 'bottom']: 0,
          }}
        >
          {ligne}
        </span>
      )}

      {blocs.map((bloc) => {
        const selectionne = bloc.id === selectedId;
        const classes = [
          'bande__bloc',
          `bande__bloc--${bloc.kind}`,
          selectionne ? 'bande__bloc--selectionne' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return bloc.kind === 'image' ? (
          <img
            key={bloc.id}
            className={classes}
            style={styleDeBloc(bloc)}
            src={bloc.src}
            alt={bloc.alt}
            draggable={false}
            tabIndex={editable ? 0 : undefined}
            onPointerDown={commencerDeplacement(bloc)}
            onKeyDown={auClavier(bloc)}
          />
        ) : (
          <span
            key={bloc.id}
            className={classes}
            style={styleDeBloc(bloc)}
            tabIndex={editable ? 0 : undefined}
            onPointerDown={commencerDeplacement(bloc)}
            onKeyDown={auClavier(bloc)}
          >
            {renderFurniture(bloc.text, contexte)}
          </span>
        );
      })}
    </div>
  );
}

/** Millimètres par pixel à l'échelle naturelle — utile aux appelants. */
export const MM_PAR_PX = 1 / PX_PAR_MM;
