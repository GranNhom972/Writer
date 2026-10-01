// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  contrastRatio,
  contrastVerdict,
  hsvToRgb,
  parseHex,
  rgbToHsv,
  toHex,
  type Rgb,
} from '../color/color';

interface CustomColorDialogProps {
  /** Starting color (the applied one, or black). */
  initial: string;
  /** Background on which the color will be read: used for the contrast calculation. */
  background?: string;
  onCancel: () => void;
  onConfirm: (hex: string) => void;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Custom color picker.
 *
 * Three paths to the same value, all synchronized: the saturation/brightness square, the hue, and exact entry (HEX or R/G/B).
 *
 * Accessibility: the 2D square has no satisfactory ARIA role (a `slider` is one-dimensional). It can still be handled with the arrow
 * keys, but **the reference accessible path is numeric entry**: labeled, announced, with no trap. The contrast ratio is displayed
 * continuously: choosing unreadable text color is a decision, not an accident (UX directive §6).
 */
export function CustomColorDialog({
  initial,
  background = '#ffffff',
  onCancel,
  onConfirm,
}: CustomColorDialogProps) {
  const initialRgb = parseHex(initial) ?? { r: 0, g: 0, b: 0 };
  const [rgb, setRgb] = useState<Rgb>(initialRgb);
  const [hue, setHue] = useState(() => rgbToHsv(initialRgb).h);
  const [hexDraft, setHexDraft] = useState(toHex(initialRgb));
  const areaRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const hsv = useMemo(() => rgbToHsv(rgb), [rgb]);
  const hex = toHex(rgb);

  const backgroundRgb = parseHex(background) ?? WHITE;
  const ratio = contrastRatio(rgb, backgroundRgb);
  const verdict = contrastVerdict(ratio);

  const applyRgb = useCallback((next: Rgb, options: { keepHue?: boolean } = {}) => {
    setRgb(next);
    setHexDraft(toHex(next));
    if (!options.keepHue) {
      const nextHsv = rgbToHsv(next);
      // A desaturated color has no hue of its own: we keep the previous one so that the hue slider does not jump to zero.
      if (nextHsv.s > 0.001) setHue(nextHsv.h);
    }
  }, []);

  const setFromArea = useCallback(
    (clientX: number, clientY: number) => {
      const area = areaRef.current;
      if (!area) return;
      const rect = area.getBoundingClientRect();
      const s = clamp01((clientX - rect.left) / rect.width);
      const v = 1 - clamp01((clientY - rect.top) / rect.height);
      applyRgb(hsvToRgb({ h: hue, s, v }), { keepHue: true });
    },
    [applyRgb, hue],
  );

  // Dragging in the square: events are followed at document level, otherwise releasing outside the area would leave the cursor "stuck".
  const startDrag = (event: React.PointerEvent): void => {
    event.preventDefault();
    areaRef.current?.focus();
    setFromArea(event.clientX, event.clientY);

    const onMove = (moveEvent: PointerEvent): void =>
      setFromArea(moveEvent.clientX, moveEvent.clientY);
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const onAreaKeyDown = (event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const deltas: Record<string, [number, number]> = {
      ArrowRight: [step, 0],
      ArrowLeft: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    applyRgb(
      hsvToRgb({ h: hue, s: clamp01(hsv.s + delta[0]), v: clamp01(hsv.v + delta[1]) }),
      { keepHue: true },
    );
  };

  // `Escape` cancels, `Enter` confirms: dialog conventions, no surprises.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const channel = (key: keyof Rgb, label: string) => (
    <label className="channel" key={key}>
      <span className="channel__label">{label}</span>
      <input
        className="channel__input"
        type="number"
        min={0}
        max={255}
        value={rgb[key]}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          applyRgb({ ...rgb, [key]: Number.isFinite(parsed) ? clampByte(parsed) : 0 });
        }}
      />
    </label>
  );

  return (
    <div className="custom-color" ref={dialogRef}>
      <div
        className="custom-color__area"
        ref={areaRef}
        tabIndex={0}
        role="group"
        aria-label={`Saturation ${Math.round(hsv.s * 100)} %, luminosité ${Math.round(hsv.v * 100)} %. Flèches pour ajuster.`}
        style={{ background: toHex(hsvToRgb({ h: hue, s: 1, v: 1 })) }}
        onPointerDown={startDrag}
        onKeyDown={onAreaKeyDown}
      >
        <div className="custom-color__white" />
        <div className="custom-color__black" />
        <span
          className="custom-color__thumb"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hex,
          }}
        />
      </div>

      <label className="custom-color__hue">
        <span className="visually-hidden">Teinte, en degrés</span>
        <input
          type="range"
          min={0}
          max={360}
          value={Math.round(hue)}
          aria-valuetext={`${Math.round(hue)} degrés`}
          onChange={(event) => {
            const nextHue = Number(event.target.value);
            setHue(nextHue);
            applyRgb(hsvToRgb({ h: nextHue, s: hsv.s, v: hsv.v }), { keepHue: true });
          }}
        />
      </label>

      <div className="custom-color__fields">
        <label className="channel channel--hex">
          <span className="channel__label">HEX</span>
          <input
            className="channel__input"
            value={hexDraft}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="custom-color-hint"
            onChange={(event) => {
              const raw = event.target.value;
              setHexDraft(raw);
              const parsed = parseHex(raw);
              // Partial input ("#1a5"): we only apply what is valid, without erasing what the user is in the middle of typing.
              if (parsed) applyRgb(parsed);
            }}
          />
        </label>
        {channel('r', 'R')}
        {channel('g', 'V')}
        {channel('b', 'B')}
      </div>

      <p id="custom-color-hint" className="custom-color__hint">
        Format accepté : #RGB ou #RRGGBB.
      </p>

      <div className="custom-color__preview">
        <span className="custom-color__sample" style={{ background: initial }}>
          <span className="visually-hidden">Couleur actuelle</span>
        </span>
        <span className="custom-color__arrow" aria-hidden="true">
          →
        </span>
        <span className="custom-color__sample" style={{ background: hex }}>
          <span className="visually-hidden">Nouvelle couleur {hex.toUpperCase()}</span>
        </span>

        <span className={`custom-color__contrast custom-color__contrast--${verdict}`}>
          Contraste {ratio.toFixed(1)}:1 —{' '}
          {verdict === 'insuffisant'
            ? 'insuffisant pour du texte courant'
            : verdict === 'AA-large'
              ? 'suffisant à partir de 18 pt'
              : `conforme ${verdict}`}
        </span>
      </div>

      <div className="custom-color__actions">
        <button type="button" className="btn" onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className="btn btn--primary" onClick={() => onConfirm(hex)}>
          Appliquer
        </button>
      </div>
    </div>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
