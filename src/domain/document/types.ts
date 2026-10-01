// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Layer 1: the document model.
 *
 * A document is an ordered list of blocks (paragraphs, headings, tables, tables
 * of contents). Each paragraph holds its text as a list of "runs": stretches of
 * text that share the same character formatting. The cursor and the selection are
 * expressed as positions in those paragraphs.
 *
 * This is a direct transposition of the StarWriter model (`aoo-4.1.16/main/sw`).
 * Names on the left are the OpenOffice classes, on the right what they became here:
 *
 *   SwDoc        → WriterDocumentState  (ordered array of content nodes)
 *   SwNodes      → WriterDocumentState.blocks
 *   SwTxtNode    → ParagraphNode        (raw string + list of attributes)
 *   SwpHints     → ParagraphNode.runs   (character-formatting ranges)
 *   SwAttrSet    → paragraph attributes (alignment, lineSpacing, indents)
 *   SwTable*     → TableNode / TableCellNode
 *   SwPaM        → DocumentSelection    (Point and Mark)
 *   SwPageDesc   → PageSetup
 *
 * A deliberate difference from the C++: where `SwpHints` keeps *overlapping*
 * ranges (`[start,end)` per attribute), we store **disjoint runs** that are
 * already flattened. The two representations are equivalent; the second renders
 * straight into the DOM with no flattening step, which is its only use here. The
 * matching invariant (`SwpHints::MergePortions`, thints.cxx:2684) is kept:
 * **two adjacent runs with identical formatting are always merged**.
 *
 * Pure module: no React import, no DOM access.
 */

/**
 * A run: a stretch of text that has the same formatting all the way through.
 * (Counterpart of OpenOffice's `SwTxtAttr` / `SwpHints`.)
 */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeThrough?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  backgroundColor?: string;
  linkHref?: string;
  /** LaTeX source of the formula, when this run stands for a math object. */
  mathLatex?: string;
  /** True if the formula is shown centered on its own line (display mode). */
  mathDisplay?: boolean;

  /** Text of the footnote, when this run is a footnote call (OpenOffice: `SwFtnFrm`). */
  footnoteText?: string;
  /** Unique id of the footnote. */
  footnoteId?: string;

  /*
   * -- Image anchored "as a character" -----------------------------------
   *
   * Writer keeps an image inside a frame (`SwFlyFrm`, layout/fly.cxx). Four anchoring
   * modes exist, and only one flows **inside** the line: `FLY_AS_CHAR`, whose frame is
   * a `SwFlyCntFrm` (layout/flycnt.cxx) that the text formatter treats as a portion
   * of fixed width and height.
   *
   * That is the mode supported here, and so it is stored as an attribute of the run,
   * not as a separate node. The consequence is the same as in the C++: an image is
   * selected, copied, deleted and justified exactly like a character, so neither the
   * cursor nor the pagination needs one more special case. The other three anchoring
   * modes (to the page, to the paragraph, to a character with text wrapping) need a
   * floating frame outside the text flow: they are not supported, see the README.
   */

  /** Source of the image: a `data:` URL while local, a relative address once uploaded. */
  imageSrc?: string;
  /** Width of the frame, in typographic points (`SwFmtFrmSize`). */
  imageWidthPt?: number;
  imageHeightPt?: number;
  /** Alternative text (`SdrObject::SetTitle`), read by assistive technologies. */
  imageAlt?: string;

  /*
   * -- Cropping (`SvxGrfCrop`, svx/inc/svx/grfcrop.hxx) --------------------
   *
   * Writer keeps four **insets**, one per edge, that are cut from the original image
   * (not a crop rectangle). The difference matters: cropping twice then composes
   * naturally, and the image stays intact, only its framing changes. So it is always
   * possible to go back.
   *
   * Where the C++ counts in 1/100 mm, we count as a **fraction of the original**
   * (0 to 1). Layer 1 does not know the image's size in pixels (only its address),
   * and a fraction stays correct whatever that size is. The conversion to absolute
   * lengths only happens in the ODF export, where `fo:clip` requires them.
   *
   * The four values are **separate** keys and not an object: formatting comparison
   * (`sameFormatting`) uses `!==`, and two objects with identical content would never
   * be equal there, so two neighboring runs would stop merging.
   */

  imageCropTopPct?: number;
  imageCropRightPct?: number;
  imageCropBottomPct?: number;
  imageCropLeftPct?: number;

  /*
   * -- Floating frame (free `SwFlyFrm`, layout/fly.cxx) --------------------
   *
   * `FLY_AS_CHAR` above flows inside the line. The three other Writer anchoring modes
   * (`RndStdIds`, fmtanchr.hxx) take the frame out of the flow: it sits at a
   * coordinate and the text flows *around* it. This is `SwFlyFreeFrm`, whose geometry
   * is computed by `SwFlyFrm::MakeAll` and then subtracted from the usable width of
   * every line it crosses.
   *
   * The wrapping mode is the one of `SwFmtSurround` (fmtsrndenum.hxx:27): `none`
   * reserves the whole band, `through` reserves nothing (the text passes underneath),
   * `parallel` avoids the frame on both sides, and `left`/`right` only keep the text
   * on the named side.
   *
   * A run carrying an `imageAnchor` other than `as-char` stays a U+FFFC character in
   * the string: it is its **anchor point**. It takes no width in the line, because
   * its geometry is given by imageX/imageY.
   */

  /**
   * How the image is anchored (`RndStdIds`): `as-char` flows inside the line, the
   * others float.
   */
  /*
   * -- Figure caption ----------------------------------------------------
   *
   * The **number is not stored**, only the text and the mode.
   *
   * This is the choice Writer made for its sequence fields (`SwSetExpField` of type
   * `SwGetSetExpType::Sequence`): the value is recomputed when displayed and never
   * kept. A number written into the document would be wrong as soon as something is
   * inserted above it, and everything after it would have to be renumbered on every
   * edit, which is precisely how duplicates appear. Here, `figureNumbering` derives
   * it from the document order, and the question goes away.
   */
  /** Text typed by the user, without the "Figure n°X:" prefix. */
  imageCaption?: string;
  /** Above or below the image. Below by default. */
  imageCaptionPosition?: 'above' | 'below';
  imageCaptionAlign?: 'left' | 'center' | 'right';
  /**
   * Automatic numbering. `undefined` means **on**: it is the requested default mode,
   * so it also applies to images that are already in the document.
   */
  imageCaptionManual?: boolean;

  /**
   * Margin around the frame (image and caption included), in points.
   *
   * The engine adds it to the four sides of the measured box, so it really pushes the
   * text away, instead of being a decorative indent that lines would simply run over.
   */
  imageMarginPt?: number;
  /** Space between the image and its caption, in points. */
  imageCaptionGapPt?: number;

  imageAnchor?: FlyAnchor;
  /** How the text wraps around the floating frame (`SwFmtSurround`). */
  imageSurround?: FlySurround;
  /**
   * Horizontal position of the frame, in points, relative to its anchor
   * (`SwFmtHoriOrient`).
   */
  imageXPt?: number;
  /**
   * Vertical position of the frame, in points, relative to its anchor
   * (`SwFmtVertOrient`).
   */
  imageYPt?: number;
  /** Wrapping margin around the frame (the frame's `SvxLRSpaceItem`), in points. */
  imageWrapMarginPt?: number;

  /*
   * -- Position of the frame (`SwFmtHoriOrient`, sw/inc/fmtornt.hxx) -------
   *
   * `imageXPt` alone is not enough to place a frame: an x coordinate frozen in points
   * stops being right as soon as the page margin changes, and "stuck to the right
   * edge" turns into "12.3 cm from the left edge".
   *
   * So Writer separates the **orientation** from its **reference**: `SwFmtHoriOrient`
   * carries `text::HoriOrientation` (LEFT, CENTER, RIGHT, NONE) and
   * `text::RelOrientation` (PRINT_AREA, PAGE_FRAME, PAGE_PRINT_AREA). Only `NONE`
   * (here `from-left`) looks at the x coordinate; the other three recompute it at
   * every layout.
   */

  /** `text::HoriOrientation`: horizontal alignment, or `from-left` for a free offset. */
  imageHoriOrient?: FlyHoriOrient;
  /** `text::RelOrientation`: what that alignment is measured against. */
  imageHoriRelation?: FlyHoriRelation;

  /**
   * `RES_OPAQUE` (`SvxOpaqueItem`): the frame goes **in front of** the text.
   *
   * In Writer it is the layer that decides: `hell` below the text, `heaven` above it
   * (`SwDrawView`, `SdrLayerID`), and this is what the ODF format writes as
   * `style:run-through="foreground"`. The distinction only means something with
   * `through` wrapping, the only case where frame and text overlap.
   */
  imageInFront?: boolean;

  /*
   * -- Comment, bookmark and tracked-change anchors -----------------------
   *
   * These three follow the same rule as the cropping above: **a scalar key, never an
   * object or an array**. `sameFormatting` compares with `!==`, and two arrays with
   * identical content would never be equal there: neighboring runs would stop
   * merging, and the `MergePortions` invariant would fall. When several comments cover
   * the same run, their ids are therefore joined into one **sorted** string (see
   * `commentIdsOf`).
   */

  /**
   * Ids of the comments covering this run, sorted and joined by `,`
   * (`SwPostItField`).
   */
  commentIds?: string;
  /** Name of the bookmark whose range covers this run (`SwBookmark`). */
  bookmarkName?: string;
  /** Id of the tracked change covering this run (`SwRangeRedline`). */
  redlineId?: string;
  /**
   * Kind of tracked change: insertion, deletion or formatting
   * (`RedlineType_t`, IDocumentRedlineAccess.hxx:73).
   */
  redlineType?: RedlineType;
}

/**
 * How a frame is anchored (OpenOffice: `RndStdIds`, `sw/inc/fmtanchr.hxx`).
 *
 * `as-char` (`FLY_AS_CHAR`) is the only one that flows inside the line; the others
 * make the frame a `SwFlyFreeFrm` placed outside the flow.
 */
export type FlyAnchor = 'as-char' | 'to-para' | 'to-page';

/**
 * How text wraps around a frame (OpenOffice: `SwSurround`,
 * `sw/inc/fmtsrndenum.hxx:27`).
 *
 * `ideal` is `SURROUND_IDEAL`, the "optimal" wrapping: it does not describe a
 * geometry but a **rule for choosing**, resolved line by line by
 * `SwTxtFly::GetSurroundForTextWrap` from the room left on each side of the frame
 * (see `resolveIdealSurround`). The other five mean what they say.
 */
export type FlySurround = 'none' | 'through' | 'parallel' | 'ideal' | 'left' | 'right';

/**
 * Horizontal alignment of a frame (OpenOffice: `text::HoriOrientation`,
 * `offapi/com/sun/star/text/HoriOrientation.idl`).
 *
 * `from-left` is `HoriOrientation::NONE`: no alignment, the position comes from the
 * `imageXPt` offset. It is the mode a frame falls into when it is dragged with the
 * mouse.
 */
export type FlyHoriOrient = 'left' | 'center' | 'right' | 'from-left';

/**
 * What a horizontal alignment is measured against (OpenOffice:
 * `text::RelOrientation`, `offapi/com/sun/star/text/RelOrientation.idl`).
 *
 * OpenOffice has ten; two are enough for a single-column layout, and naming them
 * after what they measure is better than copying ten of which eight would coincide:
 *
 *  - `text` covers `PRINT_AREA` and `PAGE_PRINT_AREA`: the text column, with the page
 *    margins taken off. Both give the same band here;
 *  - `page` is `PAGE_FRAME`: the whole sheet, margins included. It is the only
 *    reference that lets a frame overflow into the margin.
 */
export type FlyHoriRelation = 'text' | 'page';

/** Kind of a tracked change (`IDocumentRedlineAccess.hxx:73-75`). */
export type RedlineType = 'insert' | 'delete' | 'format';

/**
 * The character attributes of a run, without its text.
 *
 * `SwAttrSet` separates content from its attribute set in the same way: that is
 * what makes it possible to compare two ranges and merge them.
 */
export type RunFormatting = Omit<TextRun, 'text'>;

/** The character-formatting keys, in comparison order. */
export const RUN_FORMAT_KEYS = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'fontFamily',
  'fontSizePt',
  'color',
  'backgroundColor',
  'linkHref',
  'mathLatex',
  'mathDisplay',
  'footnoteText',
  'footnoteId',
  'imageSrc',
  'imageWidthPt',
  'imageHeightPt',
  'imageAlt',
  'imageCropTopPct',
  'imageCropRightPct',
  'imageCropBottomPct',
  'imageCropLeftPct',
  'imageMarginPt',
  'imageCaptionGapPt',
  'imageCaption',
  'imageCaptionPosition',
  'imageCaptionAlign',
  'imageCaptionManual',
  'imageAnchor',
  'imageSurround',
  'imageXPt',
  'imageYPt',
  'imageWrapMarginPt',
  'imageHoriOrient',
  'imageHoriRelation',
  'imageInFront',
  'commentIds',
  'bookmarkName',
  'redlineId',
  'redlineType',
] as const satisfies readonly (keyof RunFormatting)[];

export type RunFormatKey = (typeof RUN_FORMAT_KEYS)[number];

export type Alignment = 'left' | 'center' | 'right' | 'justify';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Kind of list. `task` adds a checkbox, as in Write. */
export type ListKind = 'bullet' | 'ordered' | 'task';

/** Maximum nesting depth (`MAXLEVEL` in `sw/inc/swtypes.hxx`). */
export const MAX_LIST_LEVEL = 10;

/**
 * A paragraph or heading node (OpenOffice: `SwTxtNode`).
 *
 * `runs` holds the text; the concatenation of the `text` fields is the node's raw
 * string, and a cursor offset is expressed in that string (never inside one
 * particular run), exactly as `SwIndex` indexes `SwTxtNode::m_Text`.
 */
export interface ParagraphNode {
  id: string;
  type: 'paragraph' | 'heading';
  headingLevel?: HeadingLevel;
  styleName?: string;
  runs: TextRun[];
  alignment?: Alignment;
  /** Line spacing factor: 1.0, 1.15, 1.5, 2.0. */
  lineSpacing?: number;
  marginTopPt?: number;
  marginBottomPt?: number;
  indentLeftPt?: number;
  indentRightPt?: number;
  firstLineIndentPt?: number;
  /**
   * Explicit page break **before** this block (`SwFmtPageDesc` /
   * `SVX_BREAK_PAGE_BEFORE`).
   */
  pageBreakBefore?: boolean;
  /**
   * Minimum number of lines kept at the bottom of a page when a paragraph is split
   * (orphan control; `SvxOrphansItem`, widorp.cxx). 0 or 1 turns the rule off.
   */
  orphans?: number;
  /**
   * Minimum number of lines carried over to the top of the next page (widow control;
   * `SvxWidowsItem`).
   */
  widows?: number;
  /** Forbids splitting the paragraph between two pages (`SvxFmtSplitItem`). */
  keepTogether?: boolean;

  /*
   * -- Numbering ---------------------------------------------------------
   *
   * Writer has no "list" node: a list is a **paragraph attribute**
   * (`RES_PARATR_LIST_*`, hintids.hxx:178), and it is the numbering rule that decides
   * the bullet or the number. We transpose it as is, which has a concrete advantage
   * over a nested structure: changing an item's level moves no node, it is just one
   * more attribute.
   */

  /**
   * The kind of list the paragraph belongs to (`SwTxtNode::GetNumRule()`), absent
   * outside a list.
   */
  listKind?: ListKind;
  /**
   * Id of the list (`RES_PARATR_LIST_ID`): two lists separated by text do not share
   * their counter. Without this id, the second one would resume at 4 after a first
   * one that stopped at 3.
   */
  listId?: string;
  /** Nesting level, from 0 to `MAX_LIST_LEVEL - 1` (`RES_PARATR_LIST_LEVEL`). */
  listLevel?: number;
  /** Restarts the counter at this item (`RES_PARATR_LIST_ISRESTART`). */
  listRestart?: boolean;
  /** The value to restart from (`RES_PARATR_LIST_RESTARTVALUE`). */
  listStartValue?: number;
  /** Whether the box is ticked, for a checklist. */
  listChecked?: boolean;
}

/** A table cell (OpenOffice: `SwTableBox`). */
export interface TableCellNode {
  id: string;
  blocks: ParagraphNode[];
  /**
   * Number of columns covered, to the right (`SwTableBox::getRowSpan`, horizontal
   * side).
   */
  colSpan?: number;
  /** Number of rows covered, downwards. */
  rowSpan?: number;
  /**
   * A cell that is **covered** by the merge of a neighbor.
   *
   * Writer does not delete the cells swallowed by a `SwDoc::MergeTbl`: it gives them
   * a negative `RowSpan` (`swtable.hxx:475`, "covered cell") and keeps them in the
   * row. The grid therefore stays rectangular, which cursor navigation, column
   * insertion and later splitting all depend on. We transpose that choice: a covered
   * cell stays present, but is neither measured nor painted.
   */
  covered?: boolean;
  widthPercent?: number;
  backgroundColor?: string;
  borderColor?: string;
  paddingPt?: number;
}

/** A table row (OpenOffice: `SwTableLine`). */
export interface TableRowNode {
  id: string;
  cells: TableCellNode[];
  /** Header row repeated at the top of every page (`SwTable::SetRowsToRepeat`). */
  isHeader?: boolean;
}

/** A table (OpenOffice: `SwTable`). */
export interface TableNode {
  id: string;
  type: 'table';
  rows: TableRowNode[];
  pageBreakBefore?: boolean;
  borderColor?: string;
  borderWidthPt?: number;
}

/**
 * A "table of contents" block (OpenOffice: `SwTOXBase`, `sw/inc/tox.hxx`).
 *
 * Writer does not store the entries: it keeps the table's **definition** (which
 * heading levels to include, with or without page numbers) and regenerates its
 * content on demand (`SwDoc::UpdateTOX`). We transpose this choice for the same
 * reason: frozen entries would drift out of sync with the body of the document at
 * the first keystroke. The entries are therefore derived at pagination time, the
 * only moment when the page number of a heading is known.
 */
export interface TocNode {
  id: string;
  type: 'toc';
  /** Title printed above the table. */
  title: string;
  /** Heading levels included, from 1 to `maxLevel` (`SwTOXBase::GetLevel`). */
  maxLevel: HeadingLevel;
  /** Show the page number at the end of the line (`SwForm` with `TOKEN_PAGE_NUMS`). */
  showPageNumbers: boolean;
  /** Dot leader between the title and the number (dotted `TOKEN_TAB_STOP`). */
  useDotLeader: boolean;
  pageBreakBefore?: boolean;
}

export type DocumentBlock = ParagraphNode | TableNode | TocNode;

/** Safe discriminant: a block is either a table or a text node. */
export function isTable(block: DocumentBlock): block is TableNode {
  return block.type === 'table';
}

export function isToc(block: DocumentBlock): block is TocNode {
  return block.type === 'toc';
}

export function isParagraph(block: DocumentBlock): block is ParagraphNode {
  return block.type !== 'table' && block.type !== 'toc';
}

/**
 * A position in the document (OpenOffice: `SwPosition`, i.e. nNode + nContent).
 *
 * `offset` counts **UTF-16 code units** in the paragraph's raw string, as
 * `SwIndex` counts `sal_Unicode`. The navigation functions, however, move by
 * **grapheme cluster** so that they never cut an emoji or a decomposed accented
 * letter in half.
 */
export interface DocumentPosition {
  blockId: string;
  offset: number;
  /** Path to the cell when the position is inside a table. */
  cell?: { rowIndex: number; cellIndex: number };
}

/** Cursor and selection (OpenOffice: `SwPaM`). Mark = anchor, Point = head. */
export interface DocumentSelection {
  /** Mark: the fixed end, set at the start of the gesture. */
  anchor: DocumentPosition;
  /** Point: the moving end, the one the arrow keys move. */
  focus: DocumentPosition;
  isCollapsed: boolean;
  /**
   * Remembered x coordinate for successive vertical moves
   * (`SwCrsrShell::m_aCharRect`, the "sticky x"). In CSS pixels, or null.
   */
  desiredX?: number | null;
}

/** Geometry of the physical page (OpenOffice: `SwPageDesc` / `SwPageFrm`). */
export interface PageSetup {
  format: 'A4' | 'Letter';
  widthMm: number;
  heightMm: number;
  orientation: 'portrait' | 'landscape';
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  headerHeightMm?: number;
  footerHeightMm?: number;
}

/** Default style of the document, applied to every run that does not override it. */
export interface DocumentDefaults {
  fontFamily: string;
  fontSizePt: number;
  lineSpacing: number;
  color: string;
}

import type { PageFurniture } from './pageFurniture';
import type { DocumentComment } from './comments';
import type { Redline } from './redline';

/** The complete root state of a document (OpenOffice: `SwDoc`). */
export interface WriterDocumentState {
  id: string;
  meta: {
    title: string;
    author: string;
    createdAt: string;
    updatedAt: string;
  };
  pageSetup: PageSetup;
  defaults: DocumentDefaults;
  furniture?: PageFurniture;
  blocks: DocumentBlock[];

  /*
   * -- Side tables --------------------------------------------------------
   *
   * Three subsystems anchor their *marker* in the runs and keep their *content* here.
   * The rule that decides which goes where is constant: whatever must follow the text
   * when it is edited is a run attribute; whatever has no position (an author, a
   * date, a discussion thread) lives in a table indexed by id.
   *
   * Bookmarks are the exception and have no table: a bookmark is *only* its position,
   * so it can be read entirely from the runs (see bookmarks.ts).
   */

  /** Content of the comments (`SwPostItField`), anchored by `TextRun.commentIds`. */
  comments?: DocumentComment[];
  /** Metadata of the tracked changes (`SwRedlineTbl`), anchored by `TextRun.redlineId`. */
  redlines?: Redline[];
}
