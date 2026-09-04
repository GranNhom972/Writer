/**
 * Curseur, sélection et navigation. Transposition de `SwPaM` / `SwCursor`
 * (`sw/source/core/crsr/pam.cxx`, `swcrsr.cxx`).
 *
 * `SwPaM` tient deux positions : le **Mark** (l'ancre, posée au début du geste)
 * et le **Point** (la tête, celle que déplacent les flèches). Une sélection
 * peut donc être « à l'envers », Point avant Mark ; les opérations d'édition
 * travaillent sur la forme normalisée (`SwPaM::Normalize`), l'affichage sur la
 * forme brute — c'est ce qui fait que raccourcir une sélection vers le haut
 * puis vers le bas retrouve exactement le même état.
 */

import { paragraphIndex, paragraphText } from '../document/document';
import { clamp } from '../document/runs';
import type {
  DocumentPosition,
  DocumentSelection,
  WriterDocumentState,
} from '../document/types';
import { graphemeBoundaries, graphemes, type TextMeasurer } from './measure';
import { isBlank, type LayoutLine, type ParagraphLayout } from './lineBreak';
import type { DocumentLayout, PlacedParagraph, PlacedTable } from './paginate';

export function makePosition(blockId: string, offset: number): DocumentPosition {
  return { blockId, offset };
}

export function collapsedSelection(position: DocumentPosition): DocumentSelection {
  return { anchor: position, focus: position, isCollapsed: true, desiredX: null };
}

export function makeSelection(
  anchor: DocumentPosition,
  focus: DocumentPosition,
  desiredX: number | null = null,
): DocumentSelection {
  return {
    anchor,
    focus,
    isCollapsed: samePosition(anchor, focus),
    desiredX,
  };
}

export function samePosition(a: DocumentPosition, b: DocumentPosition): boolean {
  return a.blockId === b.blockId && a.offset === b.offset;
}

/**
 * Ordre documentaire de deux positions (`SwPosition::operator<`).
 *
 * Writer compare d'abord l'index de nœud puis l'index de contenu ; le rang du
 * paragraphe dans l'index plat joue ici le rôle de l'index de nœud.
 */
export function comparePositions(
  doc: WriterDocumentState,
  a: DocumentPosition,
  b: DocumentPosition,
): number {
  if (a.blockId === b.blockId) return a.offset - b.offset;
  const { order } = paragraphIndex(doc);
  const rankA = order.indexOf(a.blockId);
  const rankB = order.indexOf(b.blockId);
  if (rankA === -1 || rankB === -1) return 0;
  return rankA - rankB;
}

/** Sélection remise à l'endroit : début avant fin (`SwPaM::Normalize`). */
export function normalizeSelection(
  doc: WriterDocumentState,
  selection: DocumentSelection,
): { start: DocumentPosition; end: DocumentPosition } {
  return comparePositions(doc, selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

/** Borne une position dans les limites réelles de son paragraphe. */
export function clampPosition(
  doc: WriterDocumentState,
  position: DocumentPosition,
): DocumentPosition {
  const { byId, order } = paragraphIndex(doc);
  const found = byId.get(position.blockId);
  if (!found) {
    const fallbackId = order[0];
    if (!fallbackId) return position;
    return { blockId: fallbackId, offset: 0 };
  }
  const length = paragraphText(found.paragraph).length;
  return { blockId: position.blockId, offset: clamp(position.offset, 0, length) };
}

/* ------------------------------------------------------ navigation textuelle */

export type HorizontalGranularity = 'character' | 'word';
export type Direction = -1 | 1;

/**
 * Déplace d'une **grappe de graphèmes**, pas d'une unité de code.
 *
 * `SwIndex` avance d'un `sal_Unicode`, ce qui suffisait à l'UCS-2 de l'époque.
 * En UTF-16 moderne, avancer d'une unité couperait un emoji en deux et le
 * rendrait invalide : on avance donc par grappe, comme le fait le
 * `XBreakIterator` de `SwCursor::GoNextCell`.
 */
export function stepGrapheme(text: string, offset: number, direction: Direction): number {
  const bounds = graphemeBoundaries(text);
  const at = clamp(offset, 0, text.length);

  if (direction > 0) {
    for (const bound of bounds) if (bound > at) return bound;
    return text.length;
  }
  for (let i = bounds.length - 1; i >= 0; i -= 1) {
    const bound = bounds[i]!;
    if (bound < at) return bound;
  }
  return 0;
}

/** Une position tombe-t-elle sur une frontière de grappe ? */
export function isGraphemeBoundary(text: string, offset: number): boolean {
  return graphemeBoundaries(text).includes(clamp(offset, 0, text.length));
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

/**
 * Début du mot suivant / précédent (`SwCursor::GoNextWord`, `GoPrevWord`).
 *
 * Vers la droite : franchir le mot courant puis les blancs, pour se poser au
 * **début** du mot suivant. Vers la gauche : franchir les blancs puis le mot,
 * pour se poser au début du mot courant. C'est asymétrique à dessein — c'est
 * le comportement attendu de `Ctrl+→` / `Ctrl+←`.
 */
export function stepWord(text: string, offset: number, direction: Direction): number {
  let position = clamp(offset, 0, text.length);

  if (direction > 0) {
    while (position < text.length && isWordChar(text[position]!)) {
      position = stepGrapheme(text, position, 1);
    }
    while (position < text.length && !isWordChar(text[position]!)) {
      position = stepGrapheme(text, position, 1);
    }
    return position;
  }

  while (position > 0 && !isWordChar(text[position - 1]!)) {
    position = stepGrapheme(text, position, -1);
  }
  while (position > 0 && isWordChar(text[position - 1]!)) {
    position = stepGrapheme(text, position, -1);
  }
  return position;
}

/** Bornes du mot sous le curseur — pour le double-clic. */
export function wordRangeAt(text: string, offset: number): { start: number; end: number } {
  const at = clamp(offset, 0, text.length);
  if (text.length === 0) return { start: 0, end: 0 };

  // Sur un blanc, sélectionner la plage de blancs : c'est ce que fait Writer,
  // et cela évite qu'un double-clic entre deux mots n'attrape rien.
  const probe = text[at] ?? text[at - 1] ?? '';
  const inWord = isWordChar(probe);

  let start = at;
  while (start > 0 && isWordChar(text[start - 1]!) === inWord && (text[start - 1] !== '\n')) {
    start = stepGrapheme(text, start, -1);
  }
  let end = at;
  while (end < text.length && isWordChar(text[end]!) === inWord && text[end] !== '\n') {
    end = stepGrapheme(text, end, 1);
  }
  return { start, end };
}

/**
 * Déplacement horizontal, franchissement de paragraphe compris.
 *
 * Le passage d'un paragraphe à l'autre coûte **un** pas : la frontière entre
 * deux nœuds de texte est une position à part entière, exactement comme dans
 * `SwNodes` où `nContent == 0` du nœud suivant est distinct de `nContent ==
 * Len()` du précédent.
 */
export function moveHorizontal(
  doc: WriterDocumentState,
  position: DocumentPosition,
  direction: Direction,
  granularity: HorizontalGranularity = 'character',
): DocumentPosition {
  const { order, byId } = paragraphIndex(doc);
  const found = byId.get(position.blockId);
  if (!found) return position;

  const text = paragraphText(found.paragraph);
  const offset = clamp(position.offset, 0, text.length);

  if (direction > 0 && offset >= text.length) {
    const at = order.indexOf(position.blockId);
    const nextId = at >= 0 ? order[at + 1] : undefined;
    return nextId ? { blockId: nextId, offset: 0 } : position;
  }
  if (direction < 0 && offset <= 0) {
    const at = order.indexOf(position.blockId);
    const previousId = at > 0 ? order[at - 1] : undefined;
    if (!previousId) return position;
    const previous = byId.get(previousId)!;
    return { blockId: previousId, offset: paragraphText(previous.paragraph).length };
  }

  // Franchissement atomique des formules mathématiques (SwpHints / objets insécables)
  let runStart = 0;
  for (const run of found.paragraph.runs) {
    const runEnd = runStart + run.text.length;
    if (run.mathLatex) {
      if (direction < 0) {
        if (offset > runStart && offset <= runEnd) {
          return { blockId: position.blockId, offset: runStart };
        }
      } else {
        if (offset >= runStart && offset < runEnd) {
          return { blockId: position.blockId, offset: runEnd };
        }
      }
    }
    runStart = runEnd;
  }

  const next =
    granularity === 'word'
      ? stepWord(text, offset, direction)
      : stepGrapheme(text, offset, direction);
  return { blockId: position.blockId, offset: next };
}

/* --------------------------------------------------------- géométrie visuelle */

/** Ligne d'un paragraphe contenant l'offset donné. */
export function lineIndexAt(layout: ParagraphLayout, offset: number): number {
  const lines = layout.lines;
  if (lines.length === 0) return 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (offset >= lines[i]!.startOffset) return i;
  }
  return 0;
}

/** Abscisse du curseur sur sa ligne, relative au bord gauche du contenu. */
export function caretXOnLine(
  line: LayoutLine,
  offset: number,
  measurer: TextMeasurer,
): number {
  // Au-delà du contenu peint (espaces finales avalées), le curseur se pose au
  // bord droit : ces espaces débordent dans la marge et n'avancent plus.
  if (offset >= line.endOffset) return line.leftPx + line.widthPx;
  if (offset <= line.startOffset) return line.leftPx;

  for (const segment of line.segments) {
    if (offset >= segment.endOffset) continue;
    if (offset <= segment.startOffset) return segment.leftPx;
    if (segment.isTab) return segment.leftPx;
    if (segment.formatting.mathLatex) {
      return offset <= segment.startOffset ? segment.leftPx : segment.leftPx + segment.widthPx;
    }

    const inner = offset - segment.startOffset;
    const prefix = measurer.prefixWidths(segment.text, segment.font);
    const blanks = countBlanksIn(segment.text, 0, inner);
    return segment.leftPx + (prefix[inner] ?? 0) + blanks * line.wordSpacingPx;
  }

  return line.leftPx + line.widthPx;
}

function countBlanksIn(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to && i < text.length; i += 1) if (isBlank(text[i]!)) count += 1;
  return count;
}

export interface CaretGeometry {
  pageIndex: number;
  /** Coordonnées relatives à la zone de contenu de la page. */
  xPx: number;
  topPx: number;
  heightPx: number;
  lineIndex: number;
}

/**
 * Où peindre le curseur.
 *
 * Renvoie `null` quand la position ne correspond à rien de posé — cas d'une
 * mise en page périmée d'une image de rendu à l'autre ; l'appelant s'abstient
 * alors de peindre plutôt que d'afficher un curseur au mauvais endroit.
 */
export function caretGeometry(
  layout: DocumentLayout,
  position: DocumentPosition,
  measurer: TextMeasurer,
): CaretGeometry | null {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  const placements = layout.placements.get(position.blockId);
  if (!paragraphLayout || !placements || placements.length === 0) return null;

  const lineIndex = lineIndexAt(paragraphLayout, position.offset);
  const entry =
    placements.find(({ placed }) => lineIndex >= placed.fromLine && lineIndex < placed.toLine) ??
    placements[placements.length - 1]!;

  const line = paragraphLayout.lines[lineIndex];
  if (!line) return null;

  let caretHeight = line.heightPx;
  let caretTopOffset = 0;

  // Si la ligne contient une formule mais que le curseur est dans du texte ordinaire,
  // adapter la hauteur du curseur à la fonte du texte et l'aligner sur la ligne de base.
  let activeSegment = line.segments.find(
    (s) => position.offset >= s.startOffset && position.offset <= s.endOffset,
  );
  if (!activeSegment && line.segments.length > 0) {
    activeSegment = line.segments[line.segments.length - 1];
  }

  if (activeSegment && !activeSegment.formatting.mathLatex) {
    const textCaretHeight = activeSegment.font.fontSizePx * 1.2;
    if (textCaretHeight < line.heightPx) {
      caretHeight = textCaretHeight;
      caretTopOffset = Math.max(0, line.ascentPx - activeSegment.font.fontSizePx * 0.95);
    }
  }

  return {
    pageIndex: entry.pageIndex,
    xPx: entry.placed.leftPx + caretXOnLine(line, position.offset, measurer),
    topPx: paragraphTop(entry.placed) + lineTopWithin(paragraphLayout, entry.placed, lineIndex) + caretTopOffset,
    heightPx: caretHeight,
    lineIndex,
  };
}

function paragraphTop(placed: PlacedParagraph): number {
  return placed.topPx + (placed.isContinuation ? 0 : placed.layout.marginTopPx);
}

/** Ordonnée d'une ligne dans le morceau de paragraphe posé sur cette page. */
function lineTopWithin(
  layout: ParagraphLayout,
  placed: PlacedParagraph,
  lineIndex: number,
): number {
  let top = 0;
  for (let i = placed.fromLine; i < lineIndex; i += 1) top += layout.lines[i]?.heightPx ?? 0;
  return top;
}

/**
 * Position documentaire correspondant à un point de la page — le clic souris.
 *
 * Cherche la ligne dont la bande verticale contient `y`, à défaut la plus
 * proche : cliquer dans la marge basse d'une page doit poser le curseur en fin
 * de texte, pas échouer.
 */
export function positionFromPoint(
  layout: DocumentLayout,
  pageIndex: number,
  xPx: number,
  yPx: number,
  measurer: TextMeasurer,
): DocumentPosition | null {
  // Une cellule est une **boîte**, pas un voisinage de texte.
  //
  // La recherche ci-dessous prend la ligne la plus proche, toutes cellules
  // confondues. Or le texte d'une cellule est court et cadré à gauche : cliquer
  // dans la moitié droite d'une cellule large mettait le curseur plus près de la
  // ligne de la cellule **suivante** que de la sienne, et le curseur sautait
  // d'une case. Quand le point tombe dans une cellule, on ne considère donc que
  // les paragraphes de cette cellule — sa boîte fait autorité.
  const cellIds = paragraphsOfCellAt(layout, pageIndex, xPx, yPx);

  let best: { distance: number; position: DocumentPosition } | null = null;

  for (const [blockId, entries] of layout.placements) {
    if (cellIds && !cellIds.has(blockId)) continue;
    for (const entry of entries) {
      if (entry.pageIndex !== pageIndex) continue;
      const placed = entry.placed;
      const paragraphLayout = placed.layout;
      let top = paragraphTop(placed);

      for (let i = placed.fromLine; i < placed.toLine; i += 1) {
        const line = paragraphLayout.lines[i];
        if (!line) continue;
        const bottom = top + line.heightPx;
        // Distance verticale au ruban de la ligne : nulle si le point y tombe.
        const vertical = yPx < top ? top - yPx : yPx > bottom ? yPx - bottom : 0;
        // À égalité verticale, on départage horizontalement — sinon, sur une
        // page à deux cellules côte à côte, le clic irait toujours à la première.
        const localX = xPx - placed.leftPx;
        const horizontal =
          localX < line.leftPx
            ? line.leftPx - localX
            : localX > line.leftPx + line.widthPx
              ? localX - line.leftPx - line.widthPx
              : 0;
        const distance = vertical * 1000 + horizontal;

        if (!best || distance < best.distance) {
          best = {
            distance,
            position: {
              blockId: placed.blockId,
              offset: offsetFromX(line, localX, measurer),
            },
          };
        }
        top = bottom;
      }
    }
  }

  return best?.position ?? null;
}

/**
 * Identifiants des paragraphes de la cellule qui contient le point, ou `null`.
 *
 * `null` — le point n'est dans aucune cellule — laisse la recherche balayer
 * toute la page, ce qui reste le bon comportement pour le fil du texte et pour
 * un clic dans la marge.
 */
function paragraphsOfCellAt(
  layout: DocumentLayout,
  pageIndex: number,
  xPx: number,
  yPx: number,
): Set<string> | null {
  const page = layout.pages[pageIndex];
  if (!page) return null;

  for (const block of page.blocks) {
    if (block.kind !== 'table') continue;
    const table = block as PlacedTable;

    for (const row of table.rows) {
      const top = table.topPx + row.topPx;
      if (yPx < top || yPx > top + row.heightPx) continue;

      for (const cell of row.cells) {
        // Une cellule recouverte n'a ni surface ni curseur : c'est sa maîtresse
        // qui couvre le point, et elle est déjà passée dans cette boucle.
        if (cell.covered || cell.widthPx <= 0) continue;
        if (xPx < cell.leftPx || xPx > cell.leftPx + cell.widthPx) continue;

        const ids = new Set(cell.paragraphs.map((paragraph) => paragraph.id));
        // Une cellule sans paragraphe ne peut rien accueillir : mieux vaut
        // rendre la main à la recherche générale que de bloquer le clic.
        return ids.size > 0 ? ids : null;
      }
    }
  }

  return null;
}

/** Offset le plus proche de l'abscisse `xPx` sur une ligne donnée. */
export function offsetFromX(
  line: LayoutLine,
  xPx: number,
  measurer: TextMeasurer,
): number {
  if (xPx <= line.leftPx) return line.startOffset;
  if (xPx >= line.leftPx + line.widthPx) return line.endOffset;

  for (const segment of line.segments) {
    const right = segment.leftPx + segment.widthPx;
    if (xPx > right) continue;

    if (segment.isTab || segment.formatting.mathLatex) {
      // Une tabulation ou une formule est indivisible : on se range du côté le plus proche.
      return xPx - segment.leftPx < segment.widthPx / 2
        ? segment.startOffset
        : segment.endOffset;
    }

    const prefix = measurer.prefixWidths(segment.text, segment.font);
    const local = xPx - segment.leftPx;
    let bestOffset = segment.startOffset;
    let bestDistance = Number.POSITIVE_INFINITY;
    let consumed = 0;

    // On teste les deux bords de chaque grappe et on retient le plus proche :
    // le curseur se pose ainsi toujours **entre** deux graphèmes, jamais dedans.
    for (const grapheme of graphemes(segment.text)) {
      for (const candidate of [consumed, consumed + grapheme.length]) {
        const width = (prefix[candidate] ?? 0) +
          countBlanksIn(segment.text, 0, candidate) * line.wordSpacingPx;
        const distance = Math.abs(local - width);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestOffset = segment.startOffset + candidate;
        }
      }
      consumed += grapheme.length;
    }
    return bestOffset;
  }

  return line.endOffset;
}

/**
 * Déplacement vertical d'une ligne. `desiredX` mémorise l'abscisse d'origine
 * pour que plusieurs `↓` successifs ne dérivent pas vers la gauche en
 * traversant des lignes courtes (`SwCrsrShell` conserve la même abscisse).
 */
export function moveVertical(
  layout: DocumentLayout,
  position: DocumentPosition,
  direction: Direction,
  desiredX: number | null,
  measurer: TextMeasurer,
): { position: DocumentPosition; desiredX: number } | null {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  if (!paragraphLayout) return null;

  const lineIndex = lineIndexAt(paragraphLayout, position.offset);
  const currentLine = paragraphLayout.lines[lineIndex];
  if (!currentLine) return null;

  const here = lineBox(layout, position.blockId, lineIndex);
  if (!here) return null;

  /*
   * `targetX` est une abscisse **de page**, pas de paragraphe.
   *
   * Le repère du paragraphe suffisait tant que le voisin se déduisait de
   * l'ordre du document. Il ne suffit plus dès qu'on cherche le voisin par la
   * géométrie : deux cellules d'une même ligne ont la même abscisse relative et
   * ne se distinguent que par l'origine de leur boîte. Mesurer en coordonnées
   * de page corrige du même coup la dérive du curseur entre deux paragraphes de
   * retraits différents.
   */
  const targetX = desiredX ?? here.leftPx + caretXOnLine(currentLine, position.offset, measurer);
  const targetLineIndex = lineIndex + direction;

  if (targetLineIndex >= 0 && targetLineIndex < paragraphLayout.lines.length) {
    const line = paragraphLayout.lines[targetLineIndex]!;
    return {
      position: {
        blockId: position.blockId,
        offset: offsetFromX(line, targetX - here.leftPx, measurer),
      },
      desiredX: targetX,
    };
  }

  // Sortie du paragraphe : on cherche la ligne voisine **par la géométrie**.
  //
  // L'ordre du document ne convient pas. `paragraphIndex` aplatit les cellules
  // dans l'ordre de lecture, si bien que le paragraphe « suivant » d'une cellule
  // est celui de la cellule **à sa droite** : `Bas` déplaçait le curseur
  // latéralement dans un tableau, et `Haut` le ramenait vers la gauche. C'est
  // la géométrie, et elle seule, qui dit ce qui se trouve sous le curseur.
  const found = nearestLineVertically(layout, here, direction, targetX, position.blockId);
  if (!found) return null;

  return {
    position: { blockId: found.blockId, offset: offsetFromX(found.line, targetX - found.leftPx, measurer) },
    desiredX: targetX,
  };
}

/** Où se trouve une ligne sur sa page : bande verticale et origine horizontale. */
function lineBox(
  layout: DocumentLayout,
  blockId: string,
  lineIndex: number,
): { pageIndex: number; top: number; bottom: number; leftPx: number } | null {
  for (const entry of layout.placements.get(blockId) ?? []) {
    const placed = entry.placed;
    if (lineIndex < placed.fromLine || lineIndex >= placed.toLine) continue;
    const top = paragraphTop(placed) + lineTopWithin(placed.layout, placed, lineIndex);
    return {
      pageIndex: entry.pageIndex,
      top,
      bottom: top + (placed.layout.lines[lineIndex]?.heightPx ?? 0),
      leftPx: placed.leftPx,
    };
  }
  return null;
}

/**
 * Ligne la plus proche verticalement, dans la direction demandée.
 *
 * On retient d'abord la **bande** la plus proche — le plus petit `top` situé
 * sous la ligne courante, ou le plus grand `bottom` situé au-dessus — puis, à
 * l'intérieur de cette bande, la ligne la plus proche horizontalement. C'est ce
 * second départage qui fait tomber le curseur dans la bonne colonne d'un
 * tableau : les cellules d'une même ligne partagent la même bande, et seule
 * l'abscisse les distingue.
 *
 * La recherche déborde sur la page voisine quand la page courante n'offre rien,
 * pour que `Bas` en fin de page passe à la suivante.
 */
function nearestLineVertically(
  layout: DocumentLayout,
  from: { pageIndex: number; top: number; bottom: number },
  direction: Direction,
  targetX: number,
  fromBlockId: string,
): { blockId: string; line: LayoutLine; leftPx: number } | null {
  // Tolérance d'un demi-pixel : deux cellules voisines calculent leur ordonnée
  // par des sommes différentes et peuvent différer d'un arrondi.
  const EPSILON = 0.5;

  const scan = (
    pageIndex: number,
    limit: number | null,
  ): { blockId: string; line: LayoutLine; leftPx: number } | null => {
    let best: {
      band: number;
      distance: number;
      blockId: string;
      line: LayoutLine;
      leftPx: number;
    } | null = null;

    for (const [blockId, entries] of layout.placements) {
      for (const entry of entries) {
        if (entry.pageIndex !== pageIndex) continue;
        const placed = entry.placed;
        let top = paragraphTop(placed);

        for (let i = placed.fromLine; i < placed.toLine; i += 1) {
          const line = placed.layout.lines[i];
          if (!line) continue;
          const bottom = top + line.heightPx;
          const lineTop = top;
          top = bottom;

          // La ligne d'où l'on part ne peut pas être sa propre voisine.
          if (blockId === fromBlockId && lineTop >= from.top - EPSILON && bottom <= from.bottom + EPSILON) {
            continue;
          }

          if (direction > 0) {
            if (limit !== null && lineTop < limit - EPSILON) continue;
          } else if (limit !== null && bottom > limit + EPSILON) {
            continue;
          }

          // Bande : on préfère toujours la plus proche, quelle que soit l'abscisse.
          const band = direction > 0 ? lineTop : -bottom;
          const left = placed.leftPx + line.leftPx;
          const right = left + line.widthPx;
          const distance = targetX < left ? left - targetX : targetX > right ? targetX - right : 0;

          const closerBand = !best || band < best.band - EPSILON;
          const sameBandCloserX = best !== null && band <= best.band + EPSILON && distance < best.distance;
          if (closerBand || sameBandCloserX) {
            best = { band, distance, blockId, line, leftPx: placed.leftPx };
          }
        }
      }
    }

    return best ? { blockId: best.blockId, line: best.line, leftPx: best.leftPx } : null;
  };

  const onPage = scan(from.pageIndex, direction > 0 ? from.bottom : from.top);
  if (onPage) return onPage;

  // Rien sur cette page : on passe à la suivante, sans contrainte de bande.
  return scan(from.pageIndex + direction, null);
}

/** Début / fin de la ligne visuelle — les touches `Origine` et `Fin`. */
export function lineBounds(
  layout: DocumentLayout,
  position: DocumentPosition,
): { start: number; end: number } | null {
  const paragraphLayout = layout.paragraphLayouts.get(position.blockId);
  if (!paragraphLayout) return null;
  const line = paragraphLayout.lines[lineIndexAt(paragraphLayout, position.offset)];
  if (!line) return null;
  return { start: line.startOffset, end: line.endOffset };
}

/** Rectangles à peindre pour une sélection, page par page. */
export interface SelectionRect {
  pageIndex: number;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

export function selectionRects(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  selection: DocumentSelection,
  measurer: TextMeasurer,
): SelectionRect[] {
  if (selection.isCollapsed) return [];
  const { start, end } = normalizeSelection(doc, selection);
  return rangeRects(layout, start, end, measurer);
}

/**
 * Rectangles couvrant une plage quelconque du document.
 *
 * Sélection et surlignage de recherche partagent cette géométrie : ce sont deux
 * plages à peindre, seule leur couleur diffère. Les calculer deux fois de deux
 * façons finirait par produire deux résultats.
 *
 * Le parcours suit l'**ordre de pose** (`layout.readingOrder`) et non l'index
 * du document. L'index écarte les sommaires — un curseur ne doit pas pouvoir
 * s'y poser — et s'en servir ici revenait à ne jamais peindre leurs lignes :
 * `Ctrl+A` laissait le sommaire en blanc au milieu d'un document surligné, et
 * une page qui n'en portait que des lignes restait entièrement vierge. La
 * protection d'un `SwTOXBase` porte sur l'écriture, pas sur la sélection.
 */
export function rangeRects(
  layout: DocumentLayout,
  start: DocumentPosition,
  end: DocumentPosition,
  measurer: TextMeasurer,
): SelectionRect[] {
  const order = layout.readingOrder;
  const startRank = order.indexOf(start.blockId);
  const endRank = order.indexOf(end.blockId);
  if (startRank === -1 || endRank === -1) return [];

  const rects: SelectionRect[] = [];

  for (let rank = startRank; rank <= endRank; rank += 1) {
    const blockId = order[rank]!;
    const paragraphLayout = layout.paragraphLayouts.get(blockId);
    const placements = layout.placements.get(blockId);
    if (!paragraphLayout || !placements) continue;

    const from = rank === startRank ? start.offset : 0;
    const to = rank === endRank ? end.offset : Number.MAX_SAFE_INTEGER;

    for (const { pageIndex, placed } of placements) {
      let top = paragraphTop(placed);

      for (let i = placed.fromLine; i < placed.toLine; i += 1) {
        const line = paragraphLayout.lines[i]!;
        const lineFrom = Math.max(from, line.startOffset);
        const lineTo = Math.min(to, Math.max(line.endOffset, line.startOffset));

        if (lineFrom <= lineTo && !(lineTo < line.startOffset || lineFrom > line.endOffset)) {
          const left = caretXOnLine(line, lineFrom, measurer);
          const right = caretXOnLine(line, lineTo, measurer);
          // Une ligne entièrement sélectionnée mais vide doit rester visible :
          // on lui donne la largeur d'un demi-cadratin, comme le fait Writer
          // pour marquer le saut de paragraphe sélectionné.
          const emptyMark = rank < endRank && line.isLast ? line.heightPx * 0.25 : 0;
          rects.push({
            pageIndex,
            leftPx: placed.leftPx + left,
            topPx: top,
            widthPx: Math.max(right - left, 0) + emptyMark,
            heightPx: line.heightPx,
          });
        }
        top += line.heightPx;
      }
    }
  }

  return rects.filter((rect) => rect.widthPx > 0);
}
