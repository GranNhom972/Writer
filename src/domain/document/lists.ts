/**
 * Numérotation des listes. Transposition de `SwNumRule` et `SwNodeNum`
 * (`sw/source/core/doc/number.cxx`, `sw/source/core/SwNumberTree/`).
 *
 * Aucun compteur n'est stocké dans le document : le numéro d'un élément est
 * **recalculé** en parcourant ce qui le précède, exactement comme Writer
 * reconstruit son arbre de numérotation (`SwNodeNum::GetNumberVector`).
 *
 * C'est la seule façon d'être correct : un numéro mémorisé serait faux dès
 * qu'on insère, supprime ou déplace un élément au milieu de la liste — et il
 * faudrait renuméroter toute la suite à chaque frappe.
 */

import {
  isParagraph,
  isTable,
  MAX_LIST_LEVEL,
  type ListKind,
  type ParagraphNode,
  type WriterDocumentState,
} from './types';

/**
 * Retrait par niveau, en points.
 *
 * `SwNumRule::aDefNumIndents` vaut 1440/4 twips pour le premier niveau puis un
 * quart de pouce par niveau : 0,25 pouce = 18 pt.
 */
export const LIST_INDENT_PT = 18;

/** Puces par niveau, en cycle — la suite qu'emploie Writer par défaut. */
const BULLETS = ['•', '◦', '▪', '‣'] as const;

/** Ce qu'il faut peindre devant un élément de liste. */
export interface ListMarker {
  kind: ListKind;
  level: number;
  /** Texte du marqueur : « • », « 3. », « b) »… Vide pour une case à cocher. */
  text: string;
  /** État de la case, pour une liste à cocher. */
  checked: boolean;
  /** Valeur numérique de l'élément, pour les listes ordonnées. */
  value: number;
}

/** Un paragraphe fait-il partie d'une liste ? */
export function isListItem(paragraph: ParagraphNode): boolean {
  return paragraph.listKind !== undefined;
}

/** Niveau effectif, borné à la profondeur maximale de Writer. */
export function listLevelOf(paragraph: ParagraphNode): number {
  const level = paragraph.listLevel ?? 0;
  return Math.max(0, Math.min(MAX_LIST_LEVEL - 1, Math.floor(level)));
}

/**
 * Retrait total du texte d'un paragraphe, numérotation comprise.
 *
 * Un élément de liste est décalé d'un cran par niveau **en plus** de son propre
 * retrait : les deux se cumulent, comme `SvxLRSpaceItem` se cumule au retrait
 * de la règle de numérotation.
 */
export function effectiveIndentLeftPt(paragraph: ParagraphNode): number {
  const own = paragraph.indentLeftPt ?? 0;
  if (!isListItem(paragraph)) return own;
  return own + (listLevelOf(paragraph) + 1) * LIST_INDENT_PT;
}

/** Numérotation romaine minuscule — `SVX_NUM_ROMAN_LOWER`. */
function toRoman(value: number): string {
  const table: readonly [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let reste = Math.max(1, Math.floor(value));
  let out = '';
  for (const [poids, signe] of table) {
    while (reste >= poids) {
      out += signe;
      reste -= poids;
    }
  }
  return out;
}

/** Numérotation alphabétique — `SVX_NUM_CHARS_LOWER_LETTER` : a…z, aa…az, ba… */
function toLetters(value: number): string {
  let reste = Math.max(1, Math.floor(value));
  let out = '';
  while (reste > 0) {
    reste -= 1;
    out = String.fromCharCode(97 + (reste % 26)) + out;
    reste = Math.floor(reste / 26);
  }
  return out;
}

/**
 * Forme du numéro selon le niveau.
 *
 * Writer alterne les formats par niveau pour qu'une liste imbriquée reste
 * lisible : « 1. », puis « a) », puis « i. ». Trois formats suffisent, le cycle
 * reprend au-delà.
 */
export function formatOrdered(level: number, value: number): string {
  switch (level % 3) {
    case 0:
      return `${value}.`;
    case 1:
      return `${toLetters(value)})`;
    default:
      return `${toRoman(value)}.`;
  }
}

export function bulletFor(level: number): string {
  return BULLETS[level % BULLETS.length]!;
}

/**
 * Calcule le marqueur de chaque élément de liste du document.
 *
 * Un seul parcours, dans l'ordre de lecture. Les compteurs sont tenus par
 * niveau : entrer dans un niveau plus profond ne touche pas au compteur du
 * niveau au-dessus, en ressortir remet à zéro tout ce qui était en dessous —
 * c'est le comportement d'un `SwNumberTree`.
 */
export function computeListMarkers(doc: WriterDocumentState): Map<string, ListMarker> {
  const markers = new Map<string, ListMarker>();
  const counters: number[] = new Array(MAX_LIST_LEVEL).fill(0);
  let currentListId: string | null = null;

  const visit = (paragraph: ParagraphNode): void => {
    const kind = paragraph.listKind;

    if (kind === undefined) {
      // Sortir d'une liste ferme ses compteurs : le texte courant qui la suit
      // sépare deux listes distinctes.
      currentListId = null;
      counters.fill(0);
      return;
    }

    const listId = paragraph.listId ?? '';
    if (listId !== currentListId) {
      currentListId = listId;
      counters.fill(0);
    }

    const level = listLevelOf(paragraph);
    // Redescendre d'un niveau annule la numérotation des niveaux plus profonds.
    for (let deeper = level + 1; deeper < counters.length; deeper += 1) counters[deeper] = 0;

    if (paragraph.listRestart) {
      counters[level] = Math.max(1, paragraph.listStartValue ?? 1);
    } else {
      counters[level] = (counters[level] ?? 0) + 1;
    }

    const value = counters[level]!;
    markers.set(paragraph.id, {
      kind,
      level,
      text: kind === 'ordered' ? formatOrdered(level, value) : kind === 'bullet' ? bulletFor(level) : '',
      checked: paragraph.listChecked === true,
      value,
    });
  };

  for (const block of doc.blocks) {
    // Un sommaire n'a pas de numérotation propre : ses lignes sont engendrées à
    // la pagination et n'entrent donc pas dans le compteur de listes.
    if (isParagraph(block)) {
      visit(block);
      continue;
    }
    if (!isTable(block)) continue;
    // Chaque cellule est un conteneur à part : une liste n'y continue pas celle
    // du corps du document, et deux cellules ne partagent pas de compteur.
    for (const row of block.rows) {
      for (const cell of row.cells) {
        currentListId = null;
        counters.fill(0);
        for (const inner of cell.blocks) visit(inner);
      }
    }
    currentListId = null;
    counters.fill(0);
  }

  return markers;
}
