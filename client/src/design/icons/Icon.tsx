/**
 * Jeu d'icônes Write.
 *
 * Règles du système (un seul endroit pour toute la géométrie) :
 *  - grille **24 × 24**, zone vive 20 × 20 (2 px de marge optique sur chaque bord) ;
 *  - **contour** de 1,75 px, extrémités et jonctions arrondies : même poids optique
 *    pour toutes les icônes, quel que soit le nombre de traits ;
 *  - `currentColor` exclusivement : l'icône hérite de l'état du bouton (survol,
 *    actif, désactivé) sans règle CSS supplémentaire ;
 *  - `aria-hidden` + `focusable="false"` : l'icône est **décorative**, le nom
 *    accessible vient toujours de l'`aria-label` du bouton (directive UX §6).
 *
 * Les formes sont dessinées pour être lisibles à 16 px : pas de détail sous 2 px,
 * traits alignés sur la demi-grille pour rester nets sans rendu flou.
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'undo'
  | 'redo'
  | 'print'
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
  | 'replace';

const dot = (cx: number, cy: number): ReactNode => (
  <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.15" fill="currentColor" stroke="none" />
);

/** Barres de liste : longueurs différenciées pour évoquer du texte, pas un tableau. */
const LIST_ROWS = [6, 12, 18] as const;

/** Barres de texte des listes : même abscisse et même rythme pour les trois listes. */
const listLines = (x = 10, length = 10): ReactNode => (
  <>
    {LIST_ROWS.map((y) => (
      <path key={y} d={`M${x} ${y}h${length}`} />
    ))}
  </>
);

/**
 * Quelques icônes dérogent au contour standard : une icône « gras » dessinée au
 * même poids que les autres ne **paraît** pas grasse — l'usager lit le poids
 * optique avant la forme.
 */
const STROKE_OVERRIDES: Partial<Record<IconName, number>> = {
  bold: 2.6,
};

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
  // Le « A » est remonté dans la grille : la barre de couleur occupe le bas du
  // cadre (voir `barColor`), les deux forment un seul glyphe compact.
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
      {/* Contour affiné pour les chiffres : à 1,75 px leurs contreformes se
          bouchent dès 20 px. Le poids optique reste équivalent car les glyphes
          sont plus petits que les autres formes. */}
      <g strokeWidth={1.4}>
        {/* « 1 » : hampe + empattement, la forme la plus lisible en très petit. */}
        <path d="M3.4 4 2.3 4.8M3.9 4v4M2.6 8h2.6" />
        {/* « 2 » : arc supérieur, diagonale, base. */}
        <path d="M2.5 10.6a1.5 1.5 0 0 1 2.7 1c0 1-2.7 2.4-2.7 2.4h2.9" />
        {/* « 3 » : deux arcs empilés, contreforme ouverte à gauche. */}
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
  // Radical + barre : la forme la plus reconnaissable pour « formule », et
  // lisible à 16 px là où un « ∑ » ou un « π » se referment.
  math: (
    <>
      <path d="M3 12.5h2.2l2.6 6.5L12 5h9" />
      <path d="M14.5 10.5 20 16M20 10.5l-5.5 5.5" opacity="0.9" />
    </>
  ),

  minus: <path d="M5 12h14" />,
  'chevron-up': <path d="m5.5 15 6.5-6.5 6.5 6.5" />,
  'chevron-down': <path d="m5.5 9 6.5 6.5L18.5 9" />,

  // Deux flèches opposées : la métaphore « échanger » se lit à 16 px, là où un
  // dessin de document annoté deviendrait illisible.
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
      {/* Haut de page */}
      <path d="M6 9.5v-6h6.5L18 9v.5" />
      <path d="M12.5 3.5V9H18" />
      {/* Rupture */}
      <path d="M3 12.5h18" strokeDasharray="3.5 2.5" />
      {/* Bas de page */}
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
};

interface IconProps {
  name: IconName;
  /** 20 px dans le ruban, 16 px dans les menus. */
  size?: number;
  className?: string;
  /**
   * Barre de couleur dessinée **dans** le cadre de l'icône (couleur du texte,
   * surlignage). L'empiler sous le SVG créait un écart optique : le glyphe ne
   * remplit pas toute la grille, et la barre héritait de cet espace vide.
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
        /* Largeur calée sur celle du glyphe (et non sur le cadre) et interligne
           serré : la barre doit se lire comme le soulignement du « A », pas comme
           un second élément posé dessous. */
        <rect x="5" y="17.6" width="14" height="3.4" rx="1.1" fill={barColor} stroke="none" />
      )}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(SHAPES) as IconName[];
