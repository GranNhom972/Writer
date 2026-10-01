// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * The Write icon set.
 *
 * Rules of the system (one single place for all the geometry):
 *  - **24 × 24** grid, live area 20 × 20 (2 px of optical margin on each edge);
 *  - **stroke** of 1.75 px, with rounded ends and joins: the same optical weight for every icon, whatever the number of strokes;
 *  - `currentColor` only: the icon inherits the state of the button (hover, active, disabled) with no extra CSS rule;
 *  - `aria-hidden` + `focusable="false"`: the icon is **decorative**, the accessible name always comes from the button's `aria-label`
 *    (UX directive §6).
 *
 * The shapes are drawn to be readable at 16 px: no detail under 2 px, strokes aligned on the half grid to stay crisp without blurry
 * rendering.
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'undo'
  | 'redo'
  | 'print'
  | 'export-pdf'
  | 'page-preview'
  | 'clear-format'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'text-color'
  | 'highlight'
  | 'link'
  | 'image'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-justify'
  | 'line-height'
  | 'list-check'
  | 'list-bullet'
  | 'list-ordered'
  | 'indent-decrease'
  | 'indent-increase'
  | 'font-smaller'
  | 'font-larger'
  | 'share'
  | 'page-break'
  | 'math'
  | 'table'
  | 'footnote'
  | 'search'
  | 'outline'
  | 'close'
  | 'trash'
  | 'plus'
  | 'minus'
  | 'chevron-up'
  | 'chevron-down'
  | 'replace'
  | 'wrap-inline'
  | 'wrap-around'
  | 'wrap-break'
  | 'wrap-behind'
  | 'wrap-front';

const dot = (cx: number, cy: number): ReactNode => (
  <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.15" fill="currentColor" stroke="none" />
);

/** List bars: lengths differ to suggest text, not a table. */
const LIST_ROWS = [6, 12, 18] as const;

/** Text bars of the lists: same x coordinate and same rhythm for the three lists. */
const listLines = (x = 10, length = 10): ReactNode => (
  <>
    {LIST_ROWS.map((y) => (
      <path key={y} d={`M${x} ${y}h${length}`} />
    ))}
  </>
);

/**
 * A few icons depart from the standard stroke: a "bold" icon drawn at the same weight as the others does not **look** bold, since
 * users read the optical weight before the shape.
 */
const STROKE_OVERRIDES: Partial<Record<IconName, number>> = {
  bold: 2.6,
};

/**
 * Wrapping icons: a block for the image, lines for the text.
 *
 * The five can be read at a glance because they share the **same** block and only differ by how the lines are drawn: it is the
 * relationship between the two that the user compares, not their drawing.
 */
const wrapBox = (x: number, y: number, w: number, h: number): ReactNode => (
  <rect x={x} y={y} width={w} height={h} rx="1.5" />
);

/** A line of text, solid or interrupted where the block is. */
const wrapRule = (y: number, from = 3, to = 21): ReactNode => (
  <path key={`${y}-${from}`} d={`M${from} ${y}h${to - from}`} />
);

const SHAPES: Record<IconName, ReactNode> = {
  undo: (
    <>
      <path d="M8 5 3.5 9.5 8 14" />
      <path d="M3.5 9.5h9a6.5 6.5 0 0 1 0 13H9" />
    </>
  ),
  redo: (
    <>
      <path d="M16 5l4.5 4.5L16 14" />
      <path d="M20.5 9.5h-9a6.5 6.5 0 0 0 0 13H15" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V3.5h10V9" />
      <path d="M6.5 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1.5" />
      <rect x="6.5" y="14.5" width="11" height="6" rx="1" />
    </>
  ),
  'export-pdf': (
    <>
      <path d="M14 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5z" />
      <path d="M14 3.5v6h6" />
      <path d="M7 15h2a1.5 1.5 0 0 0 0-3H7v5" />
      <path d="M12 12v5m0-5h1.5a2 2 0 0 1 0 4H12" />
    </>
  ),
  'page-preview': (
    <>
      <path d="M14 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5z" />
      <path d="M14 3.5v6h6" />
      <circle cx="11.5" cy="14.5" r="2.5" />
      <path d="m13.5 16.5 2.5 2.5" />
    </>
  ),
  'clear-format': (
    <>
      <path d="M8.5 5h11" />
      <path d="M12.5 5 9 19" />
      <path d="M14.5 14.5l5 5m0-5-5 5" />
    </>
  ),

  bold: (
    <>
      <path d="M8 5h5a3.5 3.5 0 0 1 0 7H8z" />
      <path d="M8 12h6a3.5 3.5 0 0 1 0 7H8z" />
    </>
  ),
  italic: (
    <>
      <path d="M10 4.5h8" />
      <path d="M6 19.5h8" />
      <path d="M14.5 4.5 9.5 19.5" />
    </>
  ),
  underline: (
    <>
      <path d="M7 4.5v6.5a5 5 0 0 0 10 0V4.5" />
      <path d="M5.5 20h13" />
    </>
  ),
  strikethrough: (
    <>
      <path d="M4 12h16" />
      <path d="M16 7.2A4.4 4.4 0 0 0 12 5C9.5 5 7.6 6.3 7.6 8.2c0 1.5 1.1 2.5 2.9 3.1" />
      <path d="M8 16.8A4.4 4.4 0 0 0 12 19c2.6 0 4.5-1.3 4.5-3.2 0-1-.5-1.8-1.4-2.4" />
    </>
  ),
  // The "A" is raised in the grid: the color bar takes the bottom of the frame (see `barColor`), and the two form one compact glyph.
  'text-color': (
    <>
      <path d="M5.5 15 11 4h2l5.5 11" />
      <path d="M7.6 11h8.8" />
    </>
  ),
  highlight: (
    <>
      <path d="M10.5 12.8 7.8 15.5 6.4 14l2.7-2.7" />
      <path d="m12.6 4 6.4 6.4-5.9 5.9-6.4-6.4z" />
    </>
  ),

  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 5.7.3l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7-.3l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L16 17" />
      <path d="m13.5 14.5 2-2a2 2 0 0 1 2.8 0l2.2 2.2" />
    </>
  ),

  'align-left': (
    <>
      <path d="M4 5.5h16M4 10h10M4 14.5h16M4 19h10" />
    </>
  ),
  'align-center': (
    <>
      <path d="M4 5.5h16M7 10h10M4 14.5h16M7 19h10" />
    </>
  ),
  'align-right': (
    <>
      <path d="M4 5.5h16M10 10h10M4 14.5h16M10 19h10" />
    </>
  ),
  'align-justify': (
    <>
      <path d="M4 5.5h16M4 10h16M4 14.5h16M4 19h16" />
    </>
  ),
  'line-height': (
    <>
      <path d="M4 5.5 4 18.5" />
      <path d="M1.8 7.7 4 5.5l2.2 2.2" />
      <path d="M1.8 16.3 4 18.5l2.2-2.2" />
      <path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h11" />
    </>
  ),

  'list-check': (
    <>
      {LIST_ROWS.map((y) => (
        <path key={y} d={`m3 ${y} 1.7 1.7L7.6 ${y - 2.4}`} />
      ))}
      {listLines()}
    </>
  ),
  'list-bullet': (
    <>
      {LIST_ROWS.map((y) => dot(5, y))}
      {listLines()}
    </>
  ),
  'list-ordered': (
    <>
      {/* Finer stroke for the digits: at 1.75 px their counters fill in from 20 px. The optical weight stays equivalent because the glyphs are smaller than the other shapes. */}
      <g strokeWidth={1.4}>
        {/* "1": stem + serif, the most readable form at a very small size. */}
        <path d="M3.4 4 2.3 4.8M3.9 4v4M2.6 8h2.6" />
        {/* "2": upper arc, diagonal, base. */}
        <path d="M2.5 10.6a1.5 1.5 0 0 1 2.7 1c0 1-2.7 2.4-2.7 2.4h2.9" />
        {/* "3": two stacked arcs, counter open on the left. */}
        <path d="M2.6 16.5a1.4 1.4 0 0 1 2.6.8c0 .7-.6 1.1-1.3 1.1.8 0 1.4.5 1.4 1.2a1.5 1.5 0 0 1-2.8.7" />
      </g>
      {listLines()}
    </>
  ),
  'indent-decrease': (
    <>
      <path d="M4 5h16M9 9.5h11M9 14.5h11M4 19h16" />
      <path d="m6.5 9.5-2.5 2.5 2.5 2.5" />
    </>
  ),
  'indent-increase': (
    <>
      <path d="M4 5h16M9 9.5h11M9 14.5h11M4 19h16" />
      <path d="m4 9.5 2.5 2.5L4 14.5" />
    </>
  ),

  'font-smaller': (
    <>
      <path d="M3.5 17.5 8 6.5h1.6l4.5 11" />
      <path d="M5.3 14h6.9" />
      <path d="M16 12h5.5" />
    </>
  ),
  'font-larger': (
    <>
      <path d="M2.5 17.5 7 6.5h1.6l4.5 11" />
      <path d="M4.3 14h6.9" />
      <path d="M15 12h6M18 9v6" />
    </>
  ),

  share: (
    <>
      <circle cx="18" cy="6" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <path d="m8.3 10.7 7.4-3.4M8.3 13.3l7.4 3.4" />
    </>
  ),
  // Radical + bar: the most recognizable shape for "formula", and readable at 16 px where a "∑" or a "π" close up.
  math: (
    <>
      <path d="M3 12.5h2.2l2.6 6.5L12 5h9" />
      <path d="M14.5 10.5 20 16M20 10.5l-5.5 5.5" opacity="0.9" />
    </>
  ),

  minus: <path d="M5 12h14" />,
  'chevron-up': <path d="m5.5 15 6.5-6.5 6.5 6.5" />,
  'chevron-down': <path d="m5.5 9 6.5 6.5L18.5 9" />,

  // Two opposite arrows: the "swap" metaphor reads at 16 px, where a drawing of an annotated document would become unreadable.
  replace: (
    <>
      <path d="M4 8.5h13" />
      <path d="m14 5.5 3 3-3 3" />
      <path d="M20 15.5H7" />
      <path d="m10 12.5-3 3 3 3" />
    </>
  ),

  'page-break': (
    <>
      {/* Top of page */}
      <path d="M6 9.5v-6h6.5L18 9v.5" />
      <path d="M12.5 3.5V9H18" />
      {/* Break */}
      <path d="M3 12.5h18" strokeDasharray="3.5 2.5" />
      {/* Bottom of page */}
      <path d="M6 15.5v5h12v-5" />
    </>
  ),

  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15M15 4.5v15" />
    </>
  ),

  footnote: (
    <>
      <path d="M5 4.5h14v11H8l-3 3v-14z" />
      <path d="M8.5 8.5h7M8.5 11.5h4" />
    </>
  ),

  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 20.5 20.5" />
    </>
  ),

  outline: (
    <>
      <path d="M4 6h16M4 12h10M4 18h14" />
      <circle cx="2" cy="6" r="0.8" fill="currentColor" />
      <circle cx="2" cy="12" r="0.8" fill="currentColor" />
      <circle cx="2" cy="18" r="0.8" fill="currentColor" />
    </>
  ),

  close: (
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  ),

  trash: (
    <>
      <path d="M4 6.5h16M9 6.5V4h6v2.5M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-13" />
      <path d="M10 10v6M14 10v6" />
    </>
  ),

  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  /* In the line: the block and the text share the same baseline height. */
  'wrap-inline': (
    <>
      {wrapBox(3, 8.5, 7, 7)}
      {wrapRule(10.5, 12)}
      {wrapRule(14, 12)}
    </>
  ),
  /* Wrap: the text goes around the block, above, below and beside it. */
  'wrap-around': (
    <>
      {wrapRule(5)}
      {wrapBox(3, 8.5, 7, 7)}
      {wrapRule(10.5, 12)}
      {wrapRule(14, 12)}
      {wrapRule(19)}
    </>
  ),
  /* Break: the text stops above and resumes below, never beside it. */
  'wrap-break': (
    <>
      {wrapRule(4.5)}
      {wrapRule(7.5)}
      {wrapBox(5, 10, 14, 5)}
      {wrapRule(17.5)}
      {wrapRule(20.5)}
    </>
  ),
  /* Behind: the lines go through the block without being cut. */
  'wrap-behind': (
    <>
      {wrapBox(6, 6.5, 12, 11)}
      {wrapRule(9)}
      {wrapRule(12)}
      {wrapRule(15)}
    </>
  ),
  /* In front: the block cuts the lines, which reappear on either side. */
  'wrap-front': (
    <>
      {wrapRule(9, 3, 6)}
      {wrapRule(9, 18, 21)}
      {wrapRule(12, 3, 6)}
      {wrapRule(12, 18, 21)}
      {wrapRule(15, 3, 6)}
      {wrapRule(15, 18, 21)}
      {wrapBox(6, 6.5, 12, 11)}
    </>
  ),
};

interface IconProps {
  name: IconName;
  /** 20 px in the ribbon, 16 px in the menus. */
  size?: number;
  className?: string;
  /**
   * Color bar drawn **inside** the icon's frame (text color, highlight). Stacking it under the SVG created an optical gap: the glyph does
   * not fill the whole grid, and the bar inherited that empty space.
   */
  barColor?: string;
}

export function Icon({ name, size = 20, className, barColor }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE_OVERRIDES[name] ?? 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
      {barColor && (
        /*
         * Width matched to the glyph's (and not to the frame) and tight line spacing: the bar must read as the underline of the "A", not as a second element placed below it.
         */
        <rect x="5" y="17.6" width="14" height="3.4" rx="1.1" fill={barColor} stroke="none" />
      )}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(SHAPES) as IconName[];
