import type { CSSProperties } from 'react';

interface RulerProps {
  zoom?: number;
  leftMarginCm?: number;
  rightMarginCm?: number;
  firstLineIndentCm?: number;
}

export function Ruler({
  zoom = 1,
  leftMarginCm = 2.5,
  rightMarginCm = 2.5,
  firstLineIndentCm = 0,
}: RulerProps) {
  const totalWidthCm = 21.0; // Largeur A4 en cm
  const divisions = Array.from({ length: Math.floor(totalWidthCm) + 1 }, (_, i) => i);

  return (
    <div
      aria-hidden="true"
      style={
        {
          width: 'var(--page-width)',
          maxWidth: '100%',
          zoom,
          height: 22,
          backgroundColor: 'var(--bg-app)',
          borderBottom: '1px solid var(--border-subtle)',
          margin: '0 auto',
          position: 'relative',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'flex-end',
          fontSize: 9,
          color: 'var(--fg-secondary)',
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
          opacity: 0.6,
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
          opacity: 0.6,
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
            }}
          >
            <span style={{ fontSize: 8, lineHeight: 1, marginBottom: 2 }}>{cm > 0 ? cm : ''}</span>
            <div style={{ width: 1, height: cm % 5 === 0 ? 8 : 4, backgroundColor: 'var(--fg-disabled)' }} />
          </div>
        );
      })}

      {/* Curseur retrait 1ère ligne */}
      <div
        title="Retrait 1ère ligne"
        style={{
          position: 'absolute',
          left: `${((leftMarginCm + firstLineIndentCm) / totalWidthCm) * 100}%`,
          top: 1,
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '6px solid var(--accent)',
          transform: 'translateX(-50%)',
          cursor: 'ew-resize',
        }}
      />

      {/* Curseur retrait gauche */}
      <div
        title="Marge / retrait gauche"
        style={{
          position: 'absolute',
          left: `${(leftMarginCm / totalWidthCm) * 100}%`,
          bottom: 0,
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderBottom: '6px solid var(--accent)',
          transform: 'translateX(-50%)',
          cursor: 'ew-resize',
        }}
      />
    </div>
  );
}
