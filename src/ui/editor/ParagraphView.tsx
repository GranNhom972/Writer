/**
 * Rendu d'un paragraphe posé sur une page.
 *
 * Le composant ne décide de rien : il **peint** ce que le moteur a calculé.
 * Chaque ligne est un élément positionné à l'abscisse et à l'ordonnée que lui
 * a données `layoutParagraph`, et les segments s'y enchaînent dans le flux.
 * Cette séparation est ce que le cahier des charges appelle « le DOM n'est qu'une
 * projection réactive de l'état » : aucune mesure ne remonte du DOM vers le
 * modèle.
 */

import { memo, type CSSProperties, type JSX } from 'react';
import type {
  LayoutMarker,
  LayoutSegment,
  ParagraphLayout,
} from '../../domain/engine/lineBreak';
import type { PlacedParagraph } from '../../domain/engine/paginate';
import { renderMathHtml } from '../../domain/math/render';

/** Style CSS d'un segment, dérivé de la fonte que le moteur a résolue. */
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

  // Souligné et barré se cumulent : `text-decoration-line` accepte les deux,
  // là où deux règles séparées s'écraseraient l'une l'autre.
  const decorations: string[] = [];
  if (segment.formatting.underline) decorations.push('underline');
  if (segment.formatting.strikeThrough) decorations.push('line-through');
  if (decorations.length > 0) style.textDecorationLine = decorations.join(' ');

  return style;
}

function SegmentView({
  segment,
  blockId,
  onEditMath,
}: {
  segment: LayoutSegment;
  blockId: string;
  onEditMath?: ((blockId: string, latex: string, display: boolean) => void) | undefined;
}): JSX.Element {
  if (segment.isTab) {
    // La largeur d'une tabulation dépend du taquet atteint : elle est donnée en
    // pixels, jamais laissée au navigateur qui n'en connaît pas la position.
    return (
      <span
        className="writer-tab"
        style={{ width: `${segment.widthPx}px` }}
        aria-hidden="true"
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
  const content = segment.text;

  if (segment.formatting.linkHref) {
    return (
      <a href={segment.formatting.linkHref} style={{ ...style, color: 'var(--accent)' }}>
        {content}
      </a>
    );
  }
  return <span style={style}>{content}</span>;
}

/**
 * Puce, numéro ou case à cocher d'un élément de liste.
 *
 * La case d'une liste à cocher est un vrai `<input>` : elle se coche au clavier
 * et s'annonce comme une case aux technologies d'assistance, ce qu'un glyphe ☐
 * ne ferait pas.
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
          // Le pointeur doit atteindre la case, alors que le reste du marqueur
          // laisse passer le clic vers le document pour y poser le curseur.
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

export interface ParagraphViewProps {
  placed: PlacedParagraph;
  layout: ParagraphLayout;
  /** Bascule la case d'un élément de liste à cocher. */
  onToggleTask?: (blockId: string) => void;
  /** Ouvre l'éditeur de formule pour modifier une formule existante. */
  onEditMath?: ((blockId: string, latex: string, display: boolean) => void) | undefined;
}

/**
 * Les lignes d'un morceau de paragraphe posé sur une page.
 *
 * `memo` sur l'identité du placement : tant que le moteur n'a pas recalculé ce
 * paragraphe, React n'a rien à refaire — ce qui garde la frappe fluide dans un
 * document long, où seul le paragraphe touché change d'identité.
 */
export const ParagraphView = memo(function ParagraphView({
  placed,
  layout,
  onToggleTask,
  onEditMath,
}: ParagraphViewProps): JSX.Element {
  const top = placed.topPx + (placed.isContinuation ? 0 : layout.marginTopPx);
  const rows: JSX.Element[] = [];
  let y = top;

  // Le marqueur n'accompagne que la **première** ligne : une liste reportée sur
  // la page suivante ne réaffiche pas sa puce, elle poursuit son élément.
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
          // La ligne de base est celle qu'a calculée le moteur : `line-height`
          // égale à la hauteur pose le texte au bon endroit dans la bande.
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
          />
        ))}
      </div>,
    );
    y += line.heightPx;
  }

  return <>{rows}</>;
});
