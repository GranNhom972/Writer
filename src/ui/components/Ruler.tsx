import { useCallback, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

interface RulerProps {
  zoom?: number;
  /** Largeur de la feuille, en centimètres. A4 par défaut. */
  pageWidthCm?: number;
  leftMarginCm?: number;
  rightMarginCm?: number;
  firstLineIndentCm?: number;
  onMarginChange?: (margins: { leftMm?: number; rightMm?: number }) => void;
  onFirstLineIndentChange?: (indentCm: number) => void;
  onOpenMarginsDialog?: () => void;
}

export function Ruler({
  zoom = 1,
  pageWidthCm = 21,
  leftMarginCm = 2.5,
  rightMarginCm = 2.5,
  firstLineIndentCm = 0,
  onMarginChange,
  onFirstLineIndentChange,
  onOpenMarginsDialog,
}: RulerProps) {
  // La règle suit le format réel de la feuille : figée à 21 cm, elle mentirait
  // sur un document en paysage ou au format Letter.
  const totalWidthCm = pageWidthCm;
  const divisions = Array.from({ length: Math.floor(totalWidthCm) + 1 }, (_, i) => i);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const [, setDragging] = useState<'left' | 'right' | 'first-line' | null>(null);
  const [tooltip, setTooltip] = useState<{ text: string; x: number } | null>(null);

  const startDrag = useCallback(
    (kind: 'left' | 'right' | 'first-line', event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDragging(kind);

      const onPointerMove = (e: globalThis.PointerEvent) => {
        if (!rulerRef.current) return;
        const rect = rulerRef.current.getBoundingClientRect();
        const clientX = e.clientX;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const cm = Math.round(ratio * totalWidthCm * 10) / 10;

        if (kind === 'left') {
          const maxLeftCm = totalWidthCm - rightMarginCm - 2;
          const newLeftCm = Math.max(1, Math.min(maxLeftCm, cm));
          setTooltip({ text: `${newLeftCm.toFixed(1)} cm`, x: (newLeftCm / totalWidthCm) * rect.width });
          onMarginChange?.({ leftMm: Math.round(newLeftCm * 10) });
        } else if (kind === 'right') {
          const rightCmFromRight = Math.round((totalWidthCm - cm) * 10) / 10;
          const maxRightCm = totalWidthCm - leftMarginCm - 2;
          const newRightCm = Math.max(1, Math.min(maxRightCm, rightCmFromRight));
          setTooltip({
            text: `${newRightCm.toFixed(1)} cm`,
            x: ((totalWidthCm - newRightCm) / totalWidthCm) * rect.width,
          });
          onMarginChange?.({ rightMm: Math.round(newRightCm * 10) });
        } else if (kind === 'first-line') {
          const rawIndent = cm - leftMarginCm;
          const newIndentCm = Math.max(-2, Math.min(5, Math.round(rawIndent * 10) / 10));
          setTooltip({
            text: `Retrait : ${newIndentCm > 0 ? '+' : ''}${newIndentCm.toFixed(1)} cm`,
            x: ((leftMarginCm + newIndentCm) / totalWidthCm) * rect.width,
          });
          onFirstLineIndentChange?.(newIndentCm);
        }
      };

      const onPointerUp = (e: globalThis.PointerEvent) => {
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          // Ignored
        }
        setDragging(null);
        setTooltip(null);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    },
    [leftMarginCm, rightMarginCm, totalWidthCm, onMarginChange, onFirstLineIndentChange],
  );

  const handleDoubleClick = (e: MouseEvent) => {
    e.preventDefault();
    onOpenMarginsDialog?.();
  };

  return (
    <div
      className="ruler ruler-container"
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-canvas)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
        padding: '0 var(--space-5)',
        boxSizing: 'border-box',
      }}
      onDoubleClick={handleDoubleClick}
      title="Règle — Double-cliquez pour ouvrir les paramètres de marges et styles"
    >
      <div
        ref={rulerRef}
        aria-hidden="true"
        onDoubleClick={handleDoubleClick}
        style={
          {
            width: `calc(var(--page-width) * ${zoom})`,
            flex: 'none',
            boxSizing: 'border-box',
            height: 22,
            backgroundColor: 'var(--bg-app)',
            borderLeft: '1px solid var(--border-subtle)',
            borderRight: '1px solid var(--border-subtle)',
            position: 'relative',
            userSelect: 'none',
            display: 'flex',
            alignItems: 'flex-end',
            fontSize: 9,
            color: 'var(--fg-secondary)',
            cursor: 'default',
          } as CSSProperties
        }
      >
        {/* Zone marge gauche */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${(leftMarginCm / totalWidthCm) * 100}%`,
            backgroundColor: 'var(--bg-sunken)',
            opacity: 0.7,
            borderRight: '1px dashed var(--accent)',
          }}
        />

        {/* Zone marge droite */}
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: `${(rightMarginCm / totalWidthCm) * 100}%`,
            backgroundColor: 'var(--bg-sunken)',
            opacity: 0.7,
            borderLeft: '1px dashed var(--accent)',
          }}
        />

        {/* Graduations cm */}
        {divisions.map((cm) => {
          const leftPercent = (cm / totalWidthCm) * 100;
          return (
            <div
              key={cm}
              style={{
                position: 'absolute',
                left: `${leftPercent}%`,
                bottom: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                transform: 'translateX(-50%)',
                pointerEvents: 'none',
              }}
            >
              <span style={{ fontSize: 8, lineHeight: 1, marginBottom: 2 }}>{cm > 0 && cm < 21 ? cm : ''}</span>
              <div style={{ width: 1, height: cm % 5 === 0 ? 8 : 4, backgroundColor: 'var(--fg-disabled)' }} />
            </div>
          );
        })}

        {/* Curseur retrait 1ère ligne */}
        <div
          title={`Retrait 1ère ligne (${firstLineIndentCm >= 0 ? '+' : ''}${firstLineIndentCm} cm) — Glisser pour ajuster`}
          onPointerDown={(e) => startDrag('first-line', e)}
          style={{
            position: 'absolute',
            left: `${((leftMarginCm + firstLineIndentCm) / totalWidthCm) * 100}%`,
            top: 1,
            width: 14,
            height: 10,
            marginLeft: -7,
            display: 'flex',
            justifyContent: 'center',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              borderTop: '6px solid var(--accent)',
            }}
          />
        </div>

        {/* Curseur marge gauche */}
        <div
          title={`Marge gauche (${leftMarginCm.toFixed(1)} cm) — Glisser pour ajuster`}
          onPointerDown={(e) => startDrag('left', e)}
          style={{
            position: 'absolute',
            left: `${(leftMarginCm / totalWidthCm) * 100}%`,
            bottom: 0,
            width: 14,
            height: 10,
            marginLeft: -7,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              borderBottom: '6px solid var(--accent)',
            }}
          />
        </div>

        {/* Curseur marge droite */}
        <div
          title={`Marge droite (${rightMarginCm.toFixed(1)} cm) — Glisser pour ajuster`}
          onPointerDown={(e) => startDrag('right', e)}
          style={{
            position: 'absolute',
            right: `${(rightMarginCm / totalWidthCm) * 100}%`,
            bottom: 0,
            width: 14,
            height: 10,
            marginRight: -7,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              borderBottom: '6px solid var(--accent)',
            }}
          />
        </div>

        {/* Bulle d'information pendant le glissement */}
        {tooltip && (
          <div
            style={{
              position: 'absolute',
              left: tooltip.x,
              top: -24,
              transform: 'translateX(-50%)',
              backgroundColor: 'var(--fg-primary)',
              color: 'var(--bg-app)',
              padding: '2px 6px',
              borderRadius: 'var(--radius-xs)',
              fontSize: '11px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 20,
              boxShadow: 'var(--elevation-hover)',
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
}
