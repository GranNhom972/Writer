// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Splitting the flow into physical pages. (OpenOffice: `SwLayAction`
 * (`sw/source/core/layout/layact.cxx`), `SwFlowFrm::MoveFwd` and `WidowsAndOrphans`
 * (`sw/source/core/text/widorp.cxx`).)
 *
 * Writer's principle, kept here: a frame that no longer fits in the remaining height is
 * **moved** to the next page, and a frame too big for a whole page is **cut**: a paragraph
 * between two lines, a table between two table rows (`SwTabFrm::Split`), never in the middle
 * of a line.
 *
 * The widow and orphan rules of `WidowsAndOrphans` are expressed like this:
 *   - orphans: at least N lines stay at the bottom of the page being left;
 *   - widows:  at least N lines go to the top of the next page;
 *   - if neither can be satisfied, the whole paragraph moves over.
 */

import { computeListMarkers } from '../document/lists';
import {
  figureNumbering,
  gridColumnsOf,
  paragraphIndex,
  tableColumnWidths,
} from '../document/document';
import { pageGeometry, type PageGeometry } from '../document/pageSetup';
import { ptToPx } from '../document/units';
import {
  isTable,
  isToc,
  type DocumentDefaults,
  type ParagraphNode,
  type TableNode,
  type WriterDocumentState,
} from '../document/types';
import {
  captionHeightPx,
  CAPTION_FONT_RATIO,
  layoutParagraph,
  type LayoutContext,
  type ParagraphLayout,
} from './lineBreak';
import {
  captionText,
  hasCaption,
  imageCaptionOf,
  imageKey,
} from '../document/images';
import type { TextMeasurer } from './measure';
import { expandToc } from './tox';
import {
  collectFlyFrames,
  projectedExclusions,
  paragraphExclusions,
  type FlyFrame,
  type FlyPlacement,
} from './flyLayout';

/** Default values of Writer's "Standard" style. */
export const DEFAULT_ORPHANS = 2;
export const DEFAULT_WIDOWS = 2;
/** Inner margin of a cell when it does not set one (`SwTableBox`). */
export const DEFAULT_CELL_PADDING_PT = 3;

/*
 * -- Footnote area (`SwFtnContFrm`) -----------------------------------------
 *
 * Writer reduces the usable height of the text body by the height taken by the notes called from
 * this page, separator line included (`SwFtnBossFrm::GetVarSpace`, ftnfrm.cxx). Without this
 * reserve, the last lines of the body would be painted **under** the notes.
 */

/** Font size of a note: Writer goes two steps below the size of the text. */
export const FOOTNOTE_FONT_SIZE_PT = 8;
/** Line spacing of the notes, tighter than that of the body. */
export const FOOTNOTE_LINE_SPACING = 1.15;
/** Separator line and its air: a fixed height above the first note. */
export const FOOTNOTE_SEPARATOR_PX = 12;
/** Air between two consecutive notes. */
export const FOOTNOTE_GAP_PX = 2;

export interface LaidOutFootnote {
  index: number;
  id: string;
  text: string;
  /** Height reserved for this note, separator line excluded. */
  heightPx: number;
}

/** A floating frame placed on a page, ready to paint. */
export interface LaidOutFly {
  fly: FlyFrame;
  /** Position on the page, relative to the top of the content area. */
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

export interface PlacedParagraph {
  kind: 'paragraph';
  blockId: string;
  paragraph: ParagraphNode;
  layout: ParagraphLayout;
  /** Lines placed on this page: `[fromLine, toLine)`. */
  fromLine: number;
  toLine: number;
  /** Y coordinate of the top, relative to the top of the page's content area. */
  topPx: number;
  /**
   * Horizontal offset of the block. Zero in the document flow; inside a table, it is the left edge of
   * the cell, inner margin included. Without it, the cursor of a cell would be painted in the left
   * margin of the page, since the engine computes lines relative to their container.
   */
  leftPx: number;
  heightPx: number;
  /** The paragraph starts on a previous page. */
  isContinuation: boolean;
  /** The paragraph continues on the next page. */
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
  /** Columns covered by a horizontal merge. */
  colSpan?: number;
  /** Rows covered by a vertical merge. */
  rowSpan?: number;
  /** Cell absorbed by the merge of a neighbor: neither measured nor painted. */
  covered?: boolean;
}

/**
 * Height of a cell's frame, vertical merge included.
 *
 * The vertical counterpart of `colSpan`: a master that covers three rows carries the frame of all
 * three. Painted at the height of its own row only, it left the next two without a border (covered
 * cells paint nothing otherwise), so the grid opened up over the whole merged area.
 *
 * The sum covers the rows **actually placed**: a table split by pagination does not have its later
 * rows on the current page, and the frame then stops at the bottom of the page, which is the expected
 * rendering.
 *
 * It lives here, in the engine, and not in the stylesheet: the screen and the PDF export paint the
 * same grid and must compute it with the same function. Both used to share the same defect, each on
 * its own.
 */
export function cellFrameHeightPx(
  rows: readonly PlacedRow[],
  rowPos: number,
  cell: PlacedCell,
): number {
  const span = cell.rowSpan ?? 1;
  if (span <= 1) return rows[rowPos]?.heightPx ?? 0;
  let total = 0;
  for (let i = rowPos; i < Math.min(rowPos + span, rows.length); i += 1) {
    total += rows[i]?.heightPx ?? 0;
  }
  return total;
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
  /** Height actually used: serves the overflow test bench. */
  usedHeightPx: number;
  /** Footnotes tied to the footnote calls placed on this page (SwFtnFrm). */
  footnotes?: LaidOutFootnote[];
  /** Total height reserved for the footnote area, separator line included. */
  footnoteAreaHeightPx?: number;
  /** Floating frames to paint on this page (`SwFlyFreeFrm`). */
  flies?: LaidOutFly[];
  /**
   * The three partitions that painting consumes, set here once and for all rather than filtered again
   * on every render.
   *
   * `A4Page` used to derive five `filter` calls per sheet and per render: two on the frames to split
   * the `hell` and `heaven` layers, three on the blocks to find the same arrays again. That meant as
   * many new arrays, so as many props with changing identity under a memoized component, and five
   * passes per sheet on the typing path.
   *
   * The engine already knows `imageInFront` and `kind`: the partition is its job.
   */
  fliesHell: readonly LaidOutFly[];
  fliesHeaven: readonly LaidOutFly[];
  tables: readonly PlacedTable[];
}

/** Shared empty partitions: see `LaidOutPage`. */
const AUCUN_FLY: readonly LaidOutFly[] = Object.freeze([]);
const AUCUN_TABLEAU: readonly PlacedTable[] = Object.freeze([]);

/**
 * Computes the painting partitions of a page.
 *
 * Called once the floating frames are attached: `attachFlies` can still add frames after the page has
 * been closed.
 */
function partitionnerPage(page: LaidOutPage): void {
  let hell: LaidOutFly[] | null = null;
  let heaven: LaidOutFly[] | null = null;
  for (const laid of page.flies ?? AUCUN_FLY) {
    if (laid.fly.run.imageInFront) (heaven ??= []).push(laid);
    else (hell ??= []).push(laid);
  }
  let tables: PlacedTable[] | null = null;
  for (const block of page.blocks) {
    if (block.kind === 'table') (tables ??= []).push(block);
  }
  page.fliesHell = hell ?? AUCUN_FLY;
  page.fliesHeaven = heaven ?? AUCUN_FLY;
  page.tables = tables ?? AUCUN_TABLEAU;
}

export interface DocumentLayout {
  pages: LaidOutPage[];
  geometry: PageGeometry;
  /** Layout of each paragraph, cells included, by id. */
  paragraphLayouts: Map<string, ParagraphLayout>;
  /** Where each paragraph was placed: one item per page it crosses. */
  placements: Map<string, { pageIndex: number; placed: PlacedParagraph }[]>;
  /**
   * Generated table-of-contents line → id of the heading it points to.
   *
   * Without this table, a line of a table of contents would just be a paragraph of text: it is what makes
   * it clickable.
   */
  tocTargets: Map<string, string>;
  /**
   * Figure number of each automatically numbered image, by `blockId:offset`.
   *
   * Published by the layout rather than recomputed at render time: both would start from the same
   * document, but two separate derivations would end up diverging, and it is the height measured here that
   * is authoritative.
   */
  figureNumbers: Map<string, number>;
  /** Ids of the paragraphs generated by a table of contents, which are therefore not editable. */
  generatedBlockIds: Set<string>;
  /**
   * Reading order **actually laid out**, generated paragraphs included.
   *
   * Different from `paragraphIndex(doc).order`, and the difference is what matters: the document index
   * leaves out tables of contents, because a cursor must not be able to land in them. That is right for
   * editing and wrong for painting: a selection that crosses a table of contents must show it highlighted,
   * as Writer does, where a `SwTOXBase` is write-protected and not selection-protected.
   *
   * Published by the layout because only it knows this order: the lines of a table of contents only exist
   * here, expanded just before being placed.
   */
  readingOrder: readonly string[];
}

export interface PaginateOptions {
  measurer: TextMeasurer;
  tabStopPx?: number;
}

/**
 * Filling state of the current page.
 *
 * The `y` counter advances with the text body; `footnoteHeight` grows from the bottom as footnote calls
 * are placed. `remaining` is what separates the two. It is a direct transposition of
 * `SwFtnBossFrm::GetVarSpace` (ftnfrm.cxx), where the available height of a page is its usable height
 * minus the height its footnote container already takes.
 */
class PageBuilder {
  readonly pages: LaidOutPage[] = [];
  private blocks: PlacedBlock[] = [];
  private y = 0;
  private footnotes: LaidOutFootnote[] = [];
  private footnoteIds = new Set<string>();
  private footnoteHeight = 0;
  private flies: LaidOutFly[] = [];

  constructor(private readonly contentHeightPx: number) {}

  get top(): number {
    return this.y;
  }

  get remaining(): number {
    return this.contentHeightPx - this.y - this.footnoteHeight;
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  push(block: PlacedBlock, heightPx: number): void {
    this.blocks.push(block);
    this.y += heightPx;
  }

  addFly(fly: LaidOutFly): void {
    this.flies.push(fly);
  }

  /**
   * Height that taking on these notes would add, without taking them on.
   *
   * Used by the convergence loop of `placeParagraph`: keeping one more line can make a note come down onto
   * this page, so reduce the available room, so keep one line fewer.
   */
  peekFootnoteHeight(entries: readonly LaidOutFootnote[]): number {
    let extra = 0;
    let first = this.footnoteIds.size === 0;
    for (const entry of entries) {
      if (this.footnoteIds.has(entry.id)) continue;
      if (first) {
        extra += FOOTNOTE_SEPARATOR_PX;
        first = false;
      }
      extra += entry.heightPx + FOOTNOTE_GAP_PX;
    }
    return extra;
  }

  /** Takes on these notes on the current page (`SwFtnBossFrm::AppendFtn`). */
  reserveFootnotes(entries: readonly LaidOutFootnote[]): void {
    for (const entry of entries) {
      if (this.footnoteIds.has(entry.id)) continue;
      if (this.footnoteIds.size === 0) this.footnoteHeight += FOOTNOTE_SEPARATOR_PX;
      this.footnoteIds.add(entry.id);
      this.footnotes.push(entry);
      this.footnoteHeight += entry.heightPx + FOOTNOTE_GAP_PX;
    }
  }

  /** Closes the current page and opens a new one. */
  break(): void {
    const page: LaidOutPage = {
      index: this.pages.length,
      blocks: this.blocks,
      usedHeightPx: this.y,
      fliesHell: AUCUN_FLY,
      fliesHeaven: AUCUN_FLY,
      tables: AUCUN_TABLEAU,
    };
    if (this.footnotes.length > 0) {
      page.footnotes = [...this.footnotes].sort((a, b) => a.index - b.index);
      page.footnoteAreaHeightPx = this.footnoteHeight;
    }
    if (this.flies.length > 0) page.flies = this.flies;

    this.pages.push(page);
    this.blocks = [];
    this.y = 0;
    this.footnotes = [];
    this.footnoteIds = new Set();
    this.footnoteHeight = 0;
    this.flies = [];
  }

  finish(): LaidOutPage[] {
    if (this.blocks.length > 0 || this.pages.length === 0) this.break();
    return this.pages;
  }
}

/**
 * Splits the document into pages.
 *
 * A pure function: same inputs, same pages. This is what allows it to run in a Web Worker and be tested
 * without a browser.
 *
 * ## Two passes, and why exactly two
 *
 * Two pieces of information are only known **after** layout, while layout depends on them:
 *
 *   - the page number of a heading, which a table of contents needs;
 *   - the anchor page of a `to-page` frame, which the wrapping needs.
 *
 * Writer settles the same circularity by regenerating and then laying out again (`SwDoc::UpdateTOX`
 * followed by `SwLayAction`). We do the same, and the loop stops after two passes **by construction**:
 * neither the number of lines of a table of contents nor the geometry of a frame depends on the injected
 * values. The second pass therefore only changes digits, never heights, and a third would be identical to
 * the second.
 *
 * A document with no table of contents and no page frame only makes one pass.
 */
export function paginateDocument(
  doc: WriterDocumentState,
  options: PaginateOptions,
): DocumentLayout {
  // The caption of a floating frame counts in its height: the text goes around it as it goes around the
  // image.
  const figureNumbersForFlies = figureNumbering(doc);
  // Frames are placed **before** the first pass: their alignment resolves on the geometry of the sheet,
  // which does not depend on any placement.
  const flyGeometry = pageGeometry(doc.pageSetup);
  const flies = collectFlyFrames(doc, flyGeometry, (run, blockId, offset, widthPx) =>
    hasCaption(run)
      ? captionHeightPx(
          captionText(
            imageCaptionOf(run),
            figureNumbersForFlies.get(imageKey(blockId, offset)) ?? null,
          ),
          widthPx,
          ptToPx(doc.defaults.fontSizePt) * CAPTION_FONT_RATIO,
          options.measurer,
        )
      : 0,
  );
  const hasToc = doc.blocks.some(isToc);

  const first = layoutPass(doc, options, flies, new Map(), new Map());
  /*
   * A second pass as soon as there is any frame, and no longer only for those anchored to the page.
   *
   * A frame almost always extends past its anchor (an eight-centimeter image in a two-line paragraph
   * necessarily overflows onto what follows), and the following text can only go around it if we know where
   * the frame **landed**. That is what the first pass finds out.
   */
  if (!hasToc && flies.length === 0) return first;

  return layoutPass(doc, options, flies, headingPages(doc, first), flyPlacements(first));
}

/** 1-indexed page of each heading of the main flow, from a pass already made. */
function headingPages(
  doc: WriterDocumentState,
  layout: DocumentLayout,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const block of doc.blocks) {
    if (isTable(block) || isToc(block) || block.type !== 'heading') continue;
    const placement = layout.placements.get(block.id)?.[0];
    if (placement) out.set(block.id, placement.pageIndex + 1);
  }
  return out;
}

/**
 * Page and y coordinate of the anchor of each paragraph, from a pass already made.
 *
 * Only the **first** occurrence: a paragraph split between two pages anchors its frames where it starts,
 * as `SwFlyFrm::AnchorFrm` anchors them to the master `SwTxtFrm` and not to its follow.
 */
function flyPlacements(layout: DocumentLayout): Map<string, FlyPlacement> {
  const out = new Map<string, FlyPlacement>();
  for (const [blockId, entries] of layout.placements) {
    const first = entries[0];
    if (first) out.set(blockId, { pageIndex: first.pageIndex, topPx: first.placed.topPx });
  }
  return out;
}

/* ------------------------------------------- sharing of layouts */

/**
 * A paragraph layout that has already been computed, and the context that produced it.
 */
interface VarianteLayout {
  /** Compared by identity: these are immutable objects of the document. */
  defaults: DocumentDefaults;
  signature: string;
  layout: ParagraphLayout;
}

/**
 * Layouts kept from one pagination to the next.
 *
 * The first level is the **measurer**, which lives as long as the editing session: changing the measurer,
 * and so the metrics, must start from zero. The second is the **paragraph node**, which is immutable: a
 * keystroke replaces the modified node and leaves all the others intact, so membership in the cache says
 * exactly "this paragraph has not changed".
 *
 * Two nested `WeakMap`s: nothing here keeps a document or a paragraph alive, and the undo stack naturally
 * keeps warm the versions it still references.
 */
const layoutsMemoises = new WeakMap<TextMeasurer, WeakMap<ParagraphNode, VarianteLayout[]>>();

/**
 * Number of distinct contexts kept for the same paragraph.
 *
 * A paragraph is laid out once per pass, and `paginateDocument` makes at most two (table of contents and
 * floating frames); inside a table cell the width still differs. Four covers these cases with room to
 * spare, and bounds the cache to a constant size per paragraph.
 */
const MAX_VARIANTES = 4;

/**
 * Fingerprint of the context inputs that are not stable identities.
 *
 * `marker`, `exclusions` and `figureNumbers` are rebuilt on every pass: comparing them by identity would
 * always reject the cache. They are, however, flat and short values, which a string can describe fully.
 */
function signatureContexte(ctx: LayoutContext, figures: string): string {
  const m = ctx.marker;
  const marqueur = m ? `${m.kind}/${m.level}/${m.text}/${m.checked ? 1 : 0}/${m.value}` : '';
  let exclusions = '';
  for (const e of ctx.exclusions ?? []) {
    exclusions += `${e.topPx},${e.bottomPx},${e.leftPx},${e.rightPx};`;
  }
  return `${ctx.contentWidthPx}|${ctx.tabStopPx ?? ''}|${marqueur}|${exclusions}|${figures}`;
}

/**
 * The figure numbers that concern this paragraph, and only those.
 *
 * `layoutParagraph` only consults the table through `imageKey(blockId, offset)`: the numbers of the other
 * paragraphs therefore do not enter the result, and putting them into the fingerprint would invalidate the
 * whole document whenever an image is inserted anywhere.
 */
function figuresDuParagraphe(ctx: LayoutContext): string {
  if (!ctx.figureNumbers || !ctx.blockId) return '';
  const prefixe = `${ctx.blockId}:`;
  let out = '';
  for (const [cle, valeur] of ctx.figureNumbers) {
    if (cle.startsWith(prefixe)) out += `${cle}=${valeur};`;
  }
  return out;
}

/**
 * Lays out a paragraph, reusing the result if it is already known.
 *
 * Two gains, of different kinds:
 *
 *  - **the computation**: splitting into lines and measuring the clusters is the dominant cost of a
 *    pagination. A keystroke only modifies one paragraph; recomposing the others identically was pure lost
 *    work, paid on every character and proportional to the length of the document.
 *  - **the identity**: the result handed back is the **previous** object, not an equivalent one. This is
 *    what makes `React.memo(ParagraphView)` effective: a new object on every pass, even with identical
 *    content, fails the shallow comparison and forces the whole document to render.
 *
 * Correctness rests on immutability: the paragraph node is never modified in place, and the fingerprint
 * covers everything the result depends on.
 */
function layoutParagraphMemoise(
  paragraph: ParagraphNode,
  ctx: LayoutContext,
): ParagraphLayout {
  let parParagraphe = layoutsMemoises.get(ctx.measurer);
  if (!parParagraphe) {
    parParagraphe = new WeakMap<ParagraphNode, VarianteLayout[]>();
    layoutsMemoises.set(ctx.measurer, parParagraphe);
  }

  const signature = signatureContexte(ctx, figuresDuParagraphe(ctx));
  const variantes = parParagraphe.get(paragraph);
  if (variantes) {
    for (const variante of variantes) {
      if (variante.defaults === ctx.defaults && variante.signature === signature) {
        return variante.layout;
      }
    }
  }

  const layout = layoutParagraph(paragraph, ctx);
  const entree: VarianteLayout = { defaults: ctx.defaults, signature, layout };
  if (!variantes) {
    parParagraphe.set(paragraph, [entree]);
  } else {
    // The most recent variants first: the most useful one is the last placed, and the oldest goes when the
    // ceiling is reached.
    variantes.unshift(entree);
    if (variantes.length > MAX_VARIANTES) variantes.length = MAX_VARIANTES;
  }
  return layout;
}

/** One complete layout pass. */
function layoutPass(
  doc: WriterDocumentState,
  options: PaginateOptions,
  flies: readonly FlyFrame[],
  headingPageNumbers: ReadonlyMap<string, number>,
  flyAnchorPlacements: ReadonlyMap<string, FlyPlacement>,
): DocumentLayout {
  const geometry = pageGeometry(doc.pageSetup);
  const baseCtx: LayoutContext = {
    measurer: options.measurer,
    defaults: doc.defaults,
    contentWidthPx: geometry.contentWidthPx,
    ...(options.tabStopPx !== undefined ? { tabStopPx: options.tabStopPx } : {}),
  };

  // List markers are computed once for the whole document: the number of an item depends on what precedes
  // it, so it cannot be deduced from a paragraph taken in isolation.
  const markers = computeListMarkers(doc);
  // Figure numbers: derived once per layout pass, never kept in the document (see `figureNumbering`).
  const figureNumbers = figureNumbering(doc);

  const paragraphLayouts = new Map<string, ParagraphLayout>();
  const placements = new Map<string, { pageIndex: number; placed: PlacedParagraph }[]>();
  const tocTargets = new Map<string, string>();
  const generatedBlockIds = new Set<string>();
  const builder = new PageBuilder(geometry.contentHeightPx);

  const footnotes: FootnoteContext = {
    refs: collectDocumentFootnotes(doc),
    heights: new Map(),
  };
  footnotes.heights = measureFootnotes(footnotes.refs, options.measurer, doc, geometry);

  const layoutOf = (paragraph: ParagraphNode, ctx: LayoutContext): ParagraphLayout => {
    const marker = markers.get(paragraph.id);
    const own = paragraphExclusions(flies, paragraph, ctx.contentWidthPx);
    // Frames that come from elsewhere (anchored to the page, or to a neighboring paragraph that they overflow)
    // only have a known position after a first pass.
    const ailleurs = flyAnchorPlacements.size
      ? projectedExclusions(
          flies,
          builder.pages.length,
          flyAnchorPlacements,
          builder.top,
          ctx.contentWidthPx,
          paragraph.id,
        )
      : [];
    const exclusions = own.length + ailleurs.length > 0 ? [...own, ...ailleurs] : undefined;

    let effective = ctx;
    if (marker) effective = { ...effective, marker };
    if (exclusions) effective = { ...effective, exclusions };
    // The paragraph and the numbering table: measuring a caption needs both to know the text it has to wrap.
    effective = { ...effective, blockId: paragraph.id, figureNumbers };
    return layoutParagraphMemoise(paragraph, effective);
  };

  const record = (placed: PlacedParagraph): void => {
    const list = placements.get(placed.blockId) ?? [];
    list.push({ pageIndex: builder.pages.length, placed });
    placements.set(placed.blockId, list);
  };

  // A table of contents is not a text node: it expands into concrete paragraphs just before layout, as
  // `SwDoc::UpdateTOX` fills the `SwSection` of a `SwTOXBase` before `SwLayAction` lays it out.
  const stream = expandBlocks(doc, baseCtx, headingPageNumbers, tocTargets, generatedBlockIds);

  for (const block of stream) {
    if (block.pageBreakBefore && !builder.isEmpty) builder.break();

    if (isTable(block)) {
      placeTable(block, builder, baseCtx, geometry, paragraphLayouts, record, layoutOf, footnotes);
      continue;
    }

    const layout = layoutOf(block, baseCtx);
    paragraphLayouts.set(block.id, layout);
    placeParagraph(block, layout, builder, geometry, record, footnotes);
  }

  const pages = builder.finish();

  // Floating frames are placed once the pages are closed: their page is that of their anchor, information
  // that only exists after placement.
  attachFlies(pages, flies, placements, geometry);

  for (const page of pages) partitionnerPage(page);

  return {
    pages,
    geometry,
    paragraphLayouts,
    placements,
    tocTargets,
    generatedBlockIds,
    figureNumbers,
    /*
     * The placement order, read from the layout table.
     *
     * `paragraphLayouts` is filled as the expanded flow is walked (a paragraph when it is reached, the
     * paragraphs of a table when its rows are measured) and a `Map` keeps insertion order. Its keys are
     * therefore already the reading order, expanded table of contents included.
     */
    readingOrder: [...paragraphLayouts.keys()],
  };
}

/**
 * Expands the table-of-contents blocks, leaves the others untouched.
 *
 * The document itself is not modified: the table of contents stays a compact `TocNode` in the AST, and
 * only the layout sees paragraphs. This is what guarantees it cannot get out of sync with the body.
 */
function expandBlocks(
  doc: WriterDocumentState,
  ctx: LayoutContext,
  headingPageNumbers: ReadonlyMap<string, number>,
  tocTargets: Map<string, string>,
  generatedBlockIds: Set<string>,
): (ParagraphNode | TableNode)[] {
  // The return type excludes `TocNode`: after this function, no table-of-contents block remains, so the rest
  // of the pagination has no extra case to know about.
  if (!doc.blocks.some(isToc)) return doc.blocks as (ParagraphNode | TableNode)[];

  const out: (ParagraphNode | TableNode)[] = [];
  for (const block of doc.blocks) {
    if (!isToc(block)) {
      out.push(block);
      continue;
    }

    const { paragraphs, targets } = expandToc(doc, block, headingPageNumbers, ctx);
    for (const [lineId, targetId] of targets) tocTargets.set(lineId, targetId);

    paragraphs.forEach((paragraph, index) => {
      generatedBlockIds.add(paragraph.id);
      // The table of contents' own page break, if any, is carried by its first line: it is the one that will open
      // the new page.
      out.push(index === 0 && block.pageBreakBefore ? { ...paragraph, pageBreakBefore: true } : paragraph);
    });
  }
  return out;
}

/** Places each floating frame on the page of its anchor. */
function attachFlies(
  pages: LaidOutPage[],
  flies: readonly FlyFrame[],
  placements: ReadonlyMap<string, { pageIndex: number; placed: PlacedParagraph }[]>,
  geometry: PageGeometry,
): void {
  if (flies.length === 0) return;

  for (const fly of flies) {
    const placement = placements.get(fly.anchorBlockId)?.[0];
    if (!placement) continue;
    const page = pages[placement.pageIndex];
    if (!page) continue;

    // A frame anchored to the paragraph is placed relative to it; a frame anchored to the page is placed
    // relative to the top of the content area.
    const topPx =
      fly.anchor === 'to-para' ? placement.placed.topPx + fly.topPx : fly.topPx;

    /*
     * The frame is kept on the **sheet**, not in the text column.
     *
     * `SwFlyFreeFrm::CheckClip` bounds it the same way: it keeps a frame from leaving the page, and lets it
     * overflow into the margin. Clamping to the column here would make `imageHoriRelation: 'page'` ineffective:
     * a frame aligned to the edge of the sheet would immediately come back against the text.
     */
    const minLeftPx = -geometry.contentLeftPx;
    const maxLeftPx = minLeftPx + geometry.pageWidthPx - fly.widthPx;

    const laid: LaidOutFly = {
      fly,
      leftPx: Math.max(minLeftPx, Math.min(fly.leftPx, Math.max(minLeftPx, maxLeftPx))),
      topPx,
      widthPx: fly.widthPx,
      heightPx: fly.heightPx,
    };
    // `push` and not a copy: recreating the array for every frame made attachment quadratic in the number of
    // frames on one page.
    if (page.flies) page.flies.push(laid);
    else page.flies = [laid];
  }
}

/**
 * Height reserved by each footnote.
 *
 * A note is a paragraph in its own right, laid out in a column the width of the page and in a smaller font
 * (`SwFtnFrm` uses the "Footnote" style). So we really lay it out rather than estimate: a three-line note
 * counted as one would overflow the sheet.
 */
function measureFootnotes(
  refs: ReadonlyMap<string, FootnoteReference>,
  measurer: TextMeasurer,
  doc: WriterDocumentState,
  geometry: PageGeometry,
): Map<string, number> {
  const out = new Map<string, number>();
  if (refs.size === 0) return out;

  const ctx: LayoutContext = {
    measurer,
    defaults: { ...doc.defaults, fontSizePt: FOOTNOTE_FONT_SIZE_PT, lineSpacing: FOOTNOTE_LINE_SPACING },
    contentWidthPx: geometry.contentWidthPx,
  };

  for (const ref of refs.values()) {
    // The superscript number comes before the text and counts toward the width.
    const paragraph: ParagraphNode = {
      id: `__ftn_${ref.id}`,
      type: 'paragraph',
      runs: [{ text: `${ref.index}. ${ref.text}` }],
      marginTopPt: 0,
      marginBottomPt: 0,
    };
    out.set(ref.id, layoutParagraph(paragraph, ctx).contentHeightPx);
  }

  return out;
}

export interface FootnoteReference {
  id: string;
  index: number;
  text: string;
}

/** What pagination needs to know about the notes: their number and their height. */
interface FootnoteContext {
  refs: ReadonlyMap<string, FootnoteReference>;
  heights: ReadonlyMap<string, number>;
}

/**
 * Numbers the document's notes in reading order.
 *
 * The numbering is **global and continuous** (`FTNNUM_DOC`), Writer's default choice: it therefore does not
 * depend on pagination, which makes it stable from one pass to the next. Numbering per page (`FTNNUM_PAGE`)
 * would on the contrary force a renumbering after every layout change, and so a re-pagination after the
 * renumbering.
 */
export function collectDocumentFootnotes(doc: WriterDocumentState): Map<string, FootnoteReference> {
  const map = new Map<string, FootnoteReference>();
  const { order, byId } = paragraphIndex(doc);
  let counter = 1;
  for (const id of order) {
    const node = byId.get(id)?.paragraph;
    if (!node) continue;
    for (const run of node.runs) {
      if (run.footnoteText && run.footnoteId && !map.has(run.footnoteId)) {
        map.set(run.footnoteId, {
          id: run.footnoteId,
          index: counter,
          text: run.footnoteText,
        });
        counter += 1;
      }
    }
  }
  return map;
}

/**
 * Notes called by the lines `[from, to)` of a paragraph.
 *
 * This is the granularity that matters: a page only owes a note if **the line carrying its call** was placed
 * there. Counting the whole paragraph would reserve, on the first page, the space of notes called three pages
 * further on.
 */
function footnotesInLines(
  layout: ParagraphLayout,
  from: number,
  to: number,
  refs: ReadonlyMap<string, FootnoteReference>,
  heights: ReadonlyMap<string, number>,
): LaidOutFootnote[] {
  const out: LaidOutFootnote[] = [];
  const seen = new Set<string>();

  for (let i = from; i < to; i += 1) {
    const line = layout.lines[i];
    if (!line) continue;
    for (const segment of line.segments) {
      const id = segment.formatting.footnoteId;
      if (!id || seen.has(id)) continue;
      const ref = refs.get(id);
      if (!ref) continue;
      seen.add(id);
      out.push({ id: ref.id, index: ref.index, text: ref.text, heightPx: heights.get(id) ?? 0 });
    }
  }

  return out;
}

/** Sum of the heights of lines `[from, to)`. */
function linesHeight(layout: ParagraphLayout, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i += 1) total += layout.lines[i]?.heightPx ?? 0;
  return total;
}

/**
 * Number of lines of `[from, …)` that fit in `available`.
 *
 * A line only fits **completely**: Writer does not cut a line in two between two pages, and half a line at the
 * bottom of a sheet would be unreadable.
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
  footnotes: FootnoteContext,
): void {
  const orphans = Math.max(0, paragraph.orphans ?? DEFAULT_ORPHANS);
  const widows = Math.max(0, paragraph.widows ?? DEFAULT_WIDOWS);
  const totalLines = layout.lines.length;

  let cursor = 0;
  let isContinuation = false;

  while (cursor < totalLines) {
    const marginTop = isContinuation ? 0 : layout.marginTopPx;
    const available = builder.remaining - marginTop;

    // Everything that is left fits, bottom margin and called notes included.
    const restHeight = linesHeight(layout, cursor, totalLines);
    const restFootnotes = footnotesInLines(layout, cursor, totalLines, footnotes.refs, footnotes.heights);
    const restFootnoteHeight = builder.peekFootnoteHeight(restFootnotes);

    if (available >= restHeight + layout.marginBottomPx + restFootnoteHeight) {
      const placed = makePlaced(paragraph, layout, cursor, totalLines, builder.top, {
        marginTop,
        marginBottom: layout.marginBottomPx,
        isContinuation,
        continues: false,
      });
      builder.reserveFootnotes(restFootnotes);
      record(placed);
      builder.push(placed, placed.heightPx);
      return;
    }

    let fit = fitWithFootnotes(layout, cursor, Math.max(0, available), builder, footnotes);
    const wouldRemain = totalLines - cursor - fit;

    // Widows: too few lines would go to the next page, so we keep more here for the carry-over to reach the
    // threshold.
    if (fit > 0 && wouldRemain > 0 && wouldRemain < widows) {
      fit = Math.max(0, totalLines - cursor - widows);
    }

    // Orphans: too few lines would stay here, or the paragraph refuses to be split: it moves to the next page
    // whole.
    const refusesSplit = paragraph.keepTogether === true;
    if ((refusesSplit || fit < orphans || fit === 0) && !builder.isEmpty) {
      builder.break();
      continue;
    }

    // Page already empty and the paragraph overflows anyway: we place what fits, at least one line. Without this
    // guard (the same as `bHasToFit` in `WidowsAndOrphans::FindBreak`) the loop would never advance.
    if (fit === 0) fit = 1;

    const placed = makePlaced(paragraph, layout, cursor, cursor + fit, builder.top, {
      marginTop,
      marginBottom: 0,
      isContinuation,
      continues: true,
    });
    builder.reserveFootnotes(
      footnotesInLines(layout, cursor, cursor + fit, footnotes.refs, footnotes.heights),
    );
    record(placed);
    builder.push(placed, placed.heightPx);
    builder.break();

    cursor += fit;
    isContinuation = true;
  }

  // A paragraph with no lines: impossible in practice (a line always exists, even an empty one), but the loop
  // above would place nothing.
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

/**
 * Number of lines kept, with the room taken by their notes deducted.
 *
 * The computation is **circular**: keeping one more line can make a note come down onto this page, which
 * reduces the available room, which can force keeping one line fewer. `SwTxtFrm::CalcFtnFlag` and
 * `SwFtnBossFrm::MoveFtns` loop the same way.
 *
 * It converges: the number of lines kept strictly decreases on every turn, and it is bounded below by zero.
 * The guard therefore counts turns to protect against a pathological case, not against a real divergence.
 */
function fitWithFootnotes(
  layout: ParagraphLayout,
  from: number,
  available: number,
  builder: PageBuilder,
  footnotes: FootnoteContext,
): number {
  let fit = fittingLines(layout, from, available);

  if (footnotes.refs.size === 0) return fit;

  for (let guard = 0; guard < 8 && fit > 0; guard += 1) {
    const reserve = builder.peekFootnoteHeight(
      footnotesInLines(layout, from, from + fit, footnotes.refs, footnotes.heights),
    );
    if (reserve === 0) return fit;

    const next = fittingLines(layout, from, Math.max(0, available - reserve));
    if (next >= fit) return next;
    fit = next;
  }

  return fit;
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

/* ------------------------------------------------------------------ tables */

/**
 * Column boundaries, in pixels, accumulated **then** rounded.
 *
 * The rendered table has `n + 1` boundaries for `n` columns: `bounds[i]` is the left edge of column `i`,
 * `bounds[i + 1]` its right edge.
 *
 * The order of the two operations is the whole point of the function. Rounding each width and then adding
 * them makes the error drift from one column to the next, up to a whole pixel of difference on the last one,
 * which then no longer falls on the edge of the text area. Accumulating first and then rounding the total
 * bounds the error to half a pixel **on each boundary taken in isolation**, without ever accumulating it:
 * `X_n = round(sum of W_i)`.
 *
 * Widths are then read as the **difference of two boundaries**, never as an independent sum. That is what
 * guarantees `left_i + width_i` equals `left_{i+1}` to the pixel: cells are painted as `border-box` with a
 * one-pixel border, and the slightest sub-pixel gap between the right edge of one cell and the left edge of
 * its neighbor opens a light seam or doubles the line depending on the zoom level.
 */
function columnBoundariesPx(table: TableNode, contentWidthPx: number): number[] {
  const pourcentages = tableColumnWidths(table);
  const bornes: number[] = [0];
  let cumul = 0;
  for (const pct of pourcentages) {
    cumul += pct;
    bornes.push(Math.round((contentWidthPx * cumul) / 100));
  }
  return bornes;
}

/**
 * Places a table, cutting it if needed **between two rows**.
 *
 * `SwTabFrm::Split` does the same, and repeats the header rows at the top of every piece
 * (`SwTable::GetRowsToRepeat`): without them, the continuation of a table on the next page becomes a grid
 * of numbers with no captions.
 */
function placeTable(
  table: TableNode,
  builder: PageBuilder,
  ctx: LayoutContext,
  geometry: PageGeometry,
  paragraphLayouts: Map<string, ParagraphLayout>,
  record: (placed: PlacedParagraph) => void,
  layoutOf: (paragraph: ParagraphNode, ctx: LayoutContext) => ParagraphLayout,
  footnotes: FootnoteContext,
): void {
  // The grid is a property of the table, not of the row: computing it in `measureRow` rebuilt it (two arrays of
  // numbers included) for every row, so on every pagination, so on every keystroke.
  const bornesPx = columnBoundariesPx(table, geometry.contentWidthPx);
  const measured = table.rows.map((row, rowIndex) =>
    measureRow(table, row.id, rowIndex, bornesPx, ctx, geometry, paragraphLayouts, layoutOf),
  );
  const headerRows = measured.filter((row) => row.isHeader);
  const headerHeight = headerRows.reduce((sum, row) => sum + row.heightPx, 0);

  let cursor = 0;
  let isContinuation = false;

  while (cursor < measured.length) {
    // On a continuation of a table, the header rows are re-emitted at the top of the piece and take up height
    // accordingly.
    const rows: PlacedRow[] = isContinuation ? headerRows.map((row) => ({ ...row })) : [];
    let used = isContinuation ? headerHeight : 0;
    let taken = 0;

    for (let i = cursor; i < measured.length; i += 1) {
      const row = measured[i]!;
      // A header row that has already been repeated is not placed a second time.
      if (isContinuation && row.isHeader) {
        taken += 1;
        continue;
      }
      const fits = used + row.heightPx <= builder.remaining;
      // Empty page: place at least one row, otherwise nothing makes progress. Splitting a table row that straddles
      // two pages is not handled (see the README, milestone J1).
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
    // Each cell paragraph is recorded at its absolute position on the page: this is what lets the cursor and the
    // selection work inside a table with no special code.
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

    // A note called from a cell is owed by the page that carries that table row, just like a note called from the
    // body.
    if (footnotes.refs.size > 0) {
      for (const row of rows) {
        for (const cell of row.cells) {
          for (const layout of cell.layouts) {
            builder.reserveFootnotes(
              footnotesInLines(layout, 0, layout.lines.length, footnotes.refs, footnotes.heights),
            );
          }
        }
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
  /** Column bounds of the table: see `columnBoundariesPx`. */
  bornesPx: readonly number[],
  ctx: LayoutContext,
  geometry: PageGeometry,
  paragraphLayouts: Map<string, ParagraphLayout>,
  layoutOf: (paragraph: ParagraphNode, ctx: LayoutContext) => ParagraphLayout,
): PlacedRow {
  const row = table.rows[rowIndex]!;
  const cells: PlacedCell[] = [];
  let height = 0;

  const derniereBorne = bornesPx[bornesPx.length - 1] ?? 0;
  const gridCols = gridColumnsOf(row);

  row.cells.forEach((cell, cellIndex) => {
    const gridCol = gridCols[cellIndex] ?? cellIndex;
    const span = Math.max(1, cell.colSpan ?? 1);
    const leftPx = bornesPx[gridCol] ?? 0;

    // Cell covered by a merge (a `SwTableBox` with a negative RowSpan): it keeps its place in the grid but is
    // neither measured nor painted.
    if (cell.covered) {
      cells.push({
        cellId: cell.id,
        rowIndex,
        cellIndex,
        leftPx,
        widthPx: 0,
        layouts: [],
        paragraphs: [],
        paddingPx: 0,
        covered: true,
      });
      return;
    }

    // The difference of two boundaries, and not the sum of the widths crossed: it is the only form that closes
    // the grid exactly on the next boundary.
    let widthPx = (bornesPx[Math.min(gridCol + span, bornesPx.length - 1)] ?? derniereBorne) - leftPx;
    if (widthPx <= 0) {
      widthPx = Math.round((geometry.contentWidthPx * (cell.widthPercent ?? 100)) / 100);
    }

    const paddingPx = ptToPx(cell.paddingPt ?? DEFAULT_CELL_PADDING_PT);
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

    // A vertically merged cell spreads its height over the rows it covers: charging it entirely to the first row
    // would inflate that row and leave the following ones empty.
    const rowSpan = Math.max(1, cell.rowSpan ?? 1);
    height = Math.max(height, (contentHeight + paddingPx * 2) / rowSpan);

    cells.push({
      cellId: cell.id,
      rowIndex,
      cellIndex,
      leftPx,
      widthPx,
      layouts,
      paragraphs: cell.blocks,
      paddingPx,
      ...(span > 1 ? { colSpan: span } : {}),
      ...(rowSpan > 1 ? { rowSpan } : {}),
    });
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
