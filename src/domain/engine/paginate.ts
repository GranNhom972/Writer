/**
 * Découpage du flux en pages physiques. Transposition de `SwLayAction`
 * (`sw/source/core/layout/layact.cxx`), `SwFlowFrm::MoveFwd` et
 * `WidowsAndOrphans` (`sw/source/core/text/widorp.cxx`).
 *
 * Le principe de Writer, conservé ici : un cadre qui ne tient plus dans la
 * hauteur restante est **reporté** sur la page suivante, et un cadre trop grand
 * pour une page entière est **coupé** — un paragraphe entre deux lignes, un
 * tableau entre deux lignes de tableau (`SwTabFrm::Split`), jamais au milieu
 * d'une ligne.
 *
 * Les règles de veuves et d'orphelines de `WidowsAndOrphans` s'expriment ainsi :
 *   – orphelines : au moins N lignes restent en bas de la page qu'on quitte ;
 *   – veuves     : au moins N lignes passent en haut de la page suivante ;
 *   – aucune des deux ne peut être satisfaite → le paragraphe entier bascule.
 */

import { computeListMarkers } from '../document/lists';
import { pageGeometry, type PageGeometry } from '../document/pageSetup';
import { ptToPx } from '../document/units';
import { isTable, type ParagraphNode, type TableNode, type WriterDocumentState } from '../document/types';
import { layoutParagraph, type LayoutContext, type ParagraphLayout } from './lineBreak';
import type { TextMeasurer } from './measure';

/** Valeurs par défaut du style « Standard » de Writer. */
export const DEFAULT_ORPHANS = 2;
export const DEFAULT_WIDOWS = 2;
/** Marge intérieure d'une cellule quand elle n'en fixe pas (`SwTableBox`). */
export const DEFAULT_CELL_PADDING_PT = 3;

export interface PlacedParagraph {
  kind: 'paragraph';
  blockId: string;
  paragraph: ParagraphNode;
  layout: ParagraphLayout;
  /** Lignes posées sur cette page : `[fromLine, toLine)`. */
  fromLine: number;
  toLine: number;
  /** Ordonnée du haut, relative au haut de la zone de contenu de la page. */
  topPx: number;
  /**
   * Décalage horizontal du bloc. Nul au fil du document ; à l'intérieur d'un
   * tableau, c'est le bord gauche de la cellule, marge intérieure comprise.
   * Sans lui, le curseur d'une cellule se peindrait dans la marge gauche de la
   * page — le moteur calcule les lignes relativement à leur conteneur.
   */
  leftPx: number;
  heightPx: number;
  /** Le paragraphe commence sur une page précédente. */
  isContinuation: boolean;
  /** Le paragraphe se poursuit sur la page suivante. */
  continues: boolean;
}

export interface PlacedCell {
  cellId: string;
  rowIndex: number;
  cellIndex: number;
  leftPx: number;
  widthPx: number;
  layouts: ParagraphLayout[];
  paragraphs: ParagraphNode[];
  paddingPx: number;
}

export interface PlacedRow {
  rowId: string;
  rowIndex: number;
  topPx: number;
  heightPx: number;
  cells: PlacedCell[];
  isHeader: boolean;
}

export interface PlacedTable {
  kind: 'table';
  blockId: string;
  table: TableNode;
  rows: PlacedRow[];
  topPx: number;
  heightPx: number;
  isContinuation: boolean;
  continues: boolean;
}

export type PlacedBlock = PlacedParagraph | PlacedTable;

export interface LaidOutPage {
  index: number;
  blocks: PlacedBlock[];
  /** Hauteur réellement occupée — sert au banc d'essai de débordement. */
  usedHeightPx: number;
}

export interface DocumentLayout {
  pages: LaidOutPage[];
  geometry: PageGeometry;
  /** Mise en page de chaque paragraphe, cellules comprises, par identifiant. */
  paragraphLayouts: Map<string, ParagraphLayout>;
  /** Où chaque paragraphe a été posé — un élément par page traversée. */
  placements: Map<string, { pageIndex: number; placed: PlacedParagraph }[]>;
}

export interface PaginateOptions {
  measurer: TextMeasurer;
  tabStopPx?: number;
}

/** État de remplissage de la page courante. */
class PageBuilder {
  readonly pages: LaidOutPage[] = [];
  private blocks: PlacedBlock[] = [];
  private y = 0;

  constructor(private readonly contentHeightPx: number) {}

  get top(): number {
    return this.y;
  }

  get remaining(): number {
    return this.contentHeightPx - this.y;
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  push(block: PlacedBlock, heightPx: number): void {
    this.blocks.push(block);
    this.y += heightPx;
  }

  /** Ferme la page courante et en ouvre une neuve. */
  break(): void {
    this.pages.push({
      index: this.pages.length,
      blocks: this.blocks,
      usedHeightPx: this.y,
    });
    this.blocks = [];
    this.y = 0;
  }

  finish(): LaidOutPage[] {
    if (this.blocks.length > 0 || this.pages.length === 0) this.break();
    return this.pages;
  }
}

/**
 * Répartit le document en pages.
 *
 * Fonction pure : mêmes entrées, mêmes pages. C'est ce qui permet de la faire
 * tourner dans un Web Worker et de la tester sans navigateur.
 */
export function paginateDocument(
  doc: WriterDocumentState,
  options: PaginateOptions,
): DocumentLayout {
  const geometry = pageGeometry(doc.pageSetup);
  const baseCtx: LayoutContext = {
    measurer: options.measurer,
    defaults: doc.defaults,
    contentWidthPx: geometry.contentWidthPx,
    ...(options.tabStopPx !== undefined ? { tabStopPx: options.tabStopPx } : {}),
  };

  // Les marqueurs de liste sont calculés une fois pour le document entier :
  // le numéro d'un élément dépend de ce qui le précède, il ne peut donc pas se
  // déduire d'un paragraphe pris isolément.
  const markers = computeListMarkers(doc);

  const paragraphLayouts = new Map<string, ParagraphLayout>();
  const placements = new Map<string, { pageIndex: number; placed: PlacedParagraph }[]>();
  const builder = new PageBuilder(geometry.contentHeightPx);

  const layoutOf = (paragraph: ParagraphNode, ctx: LayoutContext): ParagraphLayout => {
    const marker = markers.get(paragraph.id);
    return layoutParagraph(paragraph, marker ? { ...ctx, marker } : ctx);
  };

  const record = (placed: PlacedParagraph): void => {
    const list = placements.get(placed.blockId) ?? [];
    list.push({ pageIndex: builder.pages.length, placed });
    placements.set(placed.blockId, list);
  };

  for (const block of doc.blocks) {
    if (block.pageBreakBefore && !builder.isEmpty) builder.break();

    if (isTable(block)) {
      placeTable(block, builder, baseCtx, geometry, paragraphLayouts, record, layoutOf);
      continue;
    }

    const layout = layoutOf(block, baseCtx);
    paragraphLayouts.set(block.id, layout);
    placeParagraph(block, layout, builder, geometry, record);
  }

  return { pages: builder.finish(), geometry, paragraphLayouts, placements };
}

/** Somme des hauteurs des lignes `[from, to)`. */
function linesHeight(layout: ParagraphLayout, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i += 1) total += layout.lines[i]?.heightPx ?? 0;
  return total;
}

/**
 * Nombre de lignes de `[from, …)` qui tiennent dans `available`.
 *
 * Une ligne ne tient que **complètement** : Writer ne coupe pas une ligne en
 * deux entre deux pages, et une demi-ligne en bas de feuille serait illisible.
 */
function fittingLines(layout: ParagraphLayout, from: number, available: number): number {
  let used = 0;
  let count = 0;
  for (let i = from; i < layout.lines.length; i += 1) {
    const height = layout.lines[i]!.heightPx;
    if (used + height > available) break;
    used += height;
    count += 1;
  }
  return count;
}

function placeParagraph(
  paragraph: ParagraphNode,
  layout: ParagraphLayout,
  builder: PageBuilder,
  geometry: PageGeometry,
  record: (placed: PlacedParagraph) => void,
): void {
  const orphans = Math.max(0, paragraph.orphans ?? DEFAULT_ORPHANS);
  const widows = Math.max(0, paragraph.widows ?? DEFAULT_WIDOWS);
  const totalLines = layout.lines.length;

  let cursor = 0;
  let isContinuation = false;

  while (cursor < totalLines) {
    const marginTop = isContinuation ? 0 : layout.marginTopPx;
    const available = builder.remaining - marginTop;

    // Tout le reste tient, marge basse comprise : cas nominal.
    const restHeight = linesHeight(layout, cursor, totalLines);
    if (available >= restHeight + layout.marginBottomPx) {
      const placed = makePlaced(paragraph, layout, cursor, totalLines, builder.top, {
        marginTop,
        marginBottom: layout.marginBottomPx,
        isContinuation,
        continues: false,
      });
      record(placed);
      builder.push(placed, placed.heightPx);
      return;
    }

    let fit = fittingLines(layout, cursor, Math.max(0, available));
    const wouldRemain = totalLines - cursor - fit;

    // Veuves : trop peu de lignes partiraient sur la page suivante — on en
    // retient davantage ici pour que le report atteigne le seuil.
    if (fit > 0 && wouldRemain > 0 && wouldRemain < widows) {
      fit = Math.max(0, totalLines - cursor - widows);
    }

    // Orphelines : trop peu de lignes resteraient ici, ou le paragraphe refuse
    // d'être coupé — il bascule en entier sur la page suivante.
    const refusesSplit = paragraph.keepTogether === true;
    if ((refusesSplit || fit < orphans || fit === 0) && !builder.isEmpty) {
      builder.break();
      continue;
    }

    // Page déjà vide et le paragraphe déborde quand même : on pose ce qui tient,
    // au moins une ligne. Sans cette garde — la même que `bHasToFit` dans
    // `WidowsAndOrphans::FindBreak` — la boucle n'avancerait jamais.
    if (fit === 0) fit = 1;

    const placed = makePlaced(paragraph, layout, cursor, cursor + fit, builder.top, {
      marginTop,
      marginBottom: 0,
      isContinuation,
      continues: true,
    });
    record(placed);
    builder.push(placed, placed.heightPx);
    builder.break();

    cursor += fit;
    isContinuation = true;
  }

  // Paragraphe vide de lignes : impossible en pratique (une ligne existe
  // toujours, même vide), mais la boucle ci-dessus ne poserait rien.
  if (totalLines === 0) {
    const placed = makePlaced(paragraph, layout, 0, 0, builder.top, {
      marginTop: layout.marginTopPx,
      marginBottom: layout.marginBottomPx,
      isContinuation: false,
      continues: false,
    });
    record(placed);
    builder.push(placed, placed.heightPx);
  }

  void geometry;
}

function makePlaced(
  paragraph: ParagraphNode,
  layout: ParagraphLayout,
  fromLine: number,
  toLine: number,
  topPx: number,
  spacing: {
    marginTop: number;
    marginBottom: number;
    isContinuation: boolean;
    continues: boolean;
  },
): PlacedParagraph {
  return {
    kind: 'paragraph',
    blockId: paragraph.id,
    paragraph,
    layout,
    fromLine,
    toLine,
    topPx,
    leftPx: 0,
    heightPx:
      spacing.marginTop + linesHeight(layout, fromLine, toLine) + spacing.marginBottom,
    isContinuation: spacing.isContinuation,
    continues: spacing.continues,
  };
}

/* ------------------------------------------------------------------ tableaux */

/**
 * Pose un tableau, en le coupant au besoin **entre deux lignes**.
 *
 * `SwTabFrm::Split` procède ainsi, et répète les lignes d'en-tête en haut de
 * chaque morceau (`SwTable::GetRowsToRepeat`) : sans elles, la suite d'un
 * tableau sur la page suivante devient une grille de chiffres sans légende.
 */
function placeTable(
  table: TableNode,
  builder: PageBuilder,
  ctx: LayoutContext,
  geometry: PageGeometry,
  paragraphLayouts: Map<string, ParagraphLayout>,
  record: (placed: PlacedParagraph) => void,
  layoutOf: (paragraph: ParagraphNode, ctx: LayoutContext) => ParagraphLayout,
): void {
  const measured = table.rows.map((row, rowIndex) =>
    measureRow(table, row.id, rowIndex, ctx, geometry, paragraphLayouts, layoutOf),
  );
  const headerRows = measured.filter((row) => row.isHeader);
  const headerHeight = headerRows.reduce((sum, row) => sum + row.heightPx, 0);

  let cursor = 0;
  let isContinuation = false;

  while (cursor < measured.length) {
    // Sur une suite de tableau, les lignes d'en-tête sont réémises en tête de
    // morceau et occupent la hauteur d'autant.
    const rows: PlacedRow[] = isContinuation ? headerRows.map((row) => ({ ...row })) : [];
    let used = isContinuation ? headerHeight : 0;
    let taken = 0;

    for (let i = cursor; i < measured.length; i += 1) {
      const row = measured[i]!;
      // Une ligne d'en-tête déjà répétée ne se pose pas une seconde fois.
      if (isContinuation && row.isHeader) {
        taken += 1;
        continue;
      }
      const fits = used + row.heightPx <= builder.remaining;
      // Page vide : poser au moins une ligne, sinon rien ne progresse. La
      // coupure d'une ligne de tableau à cheval sur deux pages n'est pas
      // traitée (cf. README, jalon J1).
      if (!fits && !(taken === 0 && builder.isEmpty)) break;
      rows.push({ ...row });
      used += row.heightPx;
      taken += 1;
      if (!fits) break;
    }

    if (taken === 0) {
      builder.break();
      continue;
    }

    let y = 0;
    for (const row of rows) {
      row.topPx = y;
      y += row.heightPx;
    }

    const continues = cursor + taken < measured.length;
    const placed: PlacedTable = {
      kind: 'table',
      blockId: table.id,
      table,
      rows,
      topPx: builder.top,
      heightPx: y,
      isContinuation,
      continues,
    };
    // Chaque paragraphe de cellule est enregistré à sa position absolue sur la
    // page : c'est ce qui permet au curseur et à la sélection de fonctionner
    // dans un tableau sans code particulier.
    for (const row of rows) {
      for (const cell of row.cells) {
        let cellY = builder.top + row.topPx + cell.paddingPx;
        cell.layouts.forEach((layout, index) => {
          const paragraph = cell.paragraphs[index];
          if (!paragraph) return;
          record({
            kind: 'paragraph',
            blockId: paragraph.id,
            paragraph,
            layout,
            fromLine: 0,
            toLine: layout.lines.length,
            topPx: cellY,
            leftPx: cell.leftPx + cell.paddingPx,
            heightPx: layout.heightPx,
            isContinuation: false,
            continues: false,
          });
          cellY += layout.heightPx;
        });
      }
    }

    builder.push(placed, y);
    cursor += taken;
    isContinuation = true;
    if (continues) builder.break();
  }
}

function measureRow(
  table: TableNode,
  rowId: string,
  rowIndex: number,
  ctx: LayoutContext,
  geometry: PageGeometry,
  paragraphLayouts: Map<string, ParagraphLayout>,
  layoutOf: (paragraph: ParagraphNode, ctx: LayoutContext) => ParagraphLayout,
): PlacedRow {
  const row = table.rows[rowIndex]!;
  const cells: PlacedCell[] = [];
  let left = 0;
  let height = 0;

  const defaultPercent = 100 / Math.max(1, row.cells.length);

  row.cells.forEach((cell, cellIndex) => {
    const paddingPx = ptToPx(cell.paddingPt ?? DEFAULT_CELL_PADDING_PT);
    const widthPx = (geometry.contentWidthPx * (cell.widthPercent ?? defaultPercent)) / 100;
    const innerCtx: LayoutContext = {
      ...ctx,
      contentWidthPx: Math.max(1, widthPx - paddingPx * 2),
    };

    const layouts = cell.blocks.map((paragraph) => {
      const layout = layoutOf(paragraph, innerCtx);
      paragraphLayouts.set(paragraph.id, layout);
      return layout;
    });

    const contentHeight = layouts.reduce((sum, layout) => sum + layout.heightPx, 0);
    height = Math.max(height, contentHeight + paddingPx * 2);

    cells.push({
      cellId: cell.id,
      rowIndex,
      cellIndex,
      leftPx: left,
      widthPx,
      layouts,
      paragraphs: cell.blocks,
      paddingPx,
    });
    left += widthPx;
  });

  return {
    rowId,
    rowIndex,
    topPx: 0,
    heightPx: height,
    cells,
    isHeader: row.isHeader === true,
  };
}
