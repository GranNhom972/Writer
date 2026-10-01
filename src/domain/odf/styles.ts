// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * OpenDocument styles. (OpenOffice: `XMLTextStyleContext` and `SvXMLStyleContext`, `xmloff/source/text/`,
 * `xmloff/source/style/`.)
 *
 * ODF separates **named styles** (`styles.xml`, reusable) from **automatic styles** (`content.xml`,
 * generated for each combination of attributes actually used). The native model, for its part, carries the
 * formatting directly on the runs. The conversion is therefore:
 *   - when reading, we **flatten**: the style and its parents become run attributes;
 *   - when writing, we **factor**: each distinct attribute set gets an automatic style, reused wherever it
 *     reappears.
 */

import type {
  Alignment,
  FlyAnchor,
  FlyHoriOrient,
  FlyHoriRelation,
  FlySurround,
  ListKind,
  ParagraphNode,
  RunFormatting,
  TableCellNode,
  TableNode,
} from '../document/types';
import { attr, localName, NS } from './namespaces';
import { formatCm, formatPt, parseLengthPt, parsePercent } from './units';

/** Paragraph attributes a style can carry. */
export type ParagraphAttributes = Partial<
  Pick<
    ParagraphNode,
    | 'alignment'
    | 'lineSpacing'
    | 'marginTopPt'
    | 'marginBottomPt'
    | 'indentLeftPt'
    | 'indentRightPt'
    | 'firstLineIndentPt'
    | 'pageBreakBefore'
    | 'orphans'
    | 'widows'
    | 'keepTogether'
  >
>;

/** Attributes a cell style can carry (`<style:table-cell-properties>`). */
export type CellAttributes = Partial<
  Pick<TableCellNode, 'backgroundColor' | 'borderColor' | 'paddingPt'>
>;

/**
 * Graphic properties of a frame. Only one is carried: `fo:clip`, the crop. The others (wrapping, floating
 * position) assume a frame outside the flow, which the "as a character" anchoring does not have.
 */
export interface GraphicAttributes {
  /** `fo:clip="rect(top right bottom left)"`, as is. */
  clip?: string;
  /** `style:wrap`: wrapping mode of a floating frame (`SwFmtSurround`). */
  surround?: FlySurround;
  /** `fo:margin-left` of the frame: the wrapping margin, in points. */
  wrapMarginPt?: number;
  /** `style:horizontal-pos`: horizontal alignment (`SwFmtHoriOrient`). */
  horiOrient?: FlyHoriOrient;
  /** `style:horizontal-rel`: the reference of that alignment (`text::RelOrientation`). */
  horiRelation?: FlyHoriRelation;
  /** `style:run-through="foreground"`: the frame covers the text (`RES_OPAQUE`). */
  inFront?: boolean;
}

export interface ColumnAttributes {
  widthPt?: number;
  relWidth?: number;
}

export interface OdfStyle {
  name: string;
  family: string;
  parentName: string | null;
  text: RunFormatting;
  paragraph: ParagraphAttributes;
  cell: CellAttributes;
  graphic: GraphicAttributes;
  column: ColumnAttributes;
}

export type StyleTable = Map<string, OdfStyle>;

/* ------------------------------------------------------------------ reading */

/**
 * ODF's `style:wrap` to `SwSurround`.
 *
 * `dynamic` and `biggest` are the two forms of Writer's "wider side", and both are read back as `ideal`
 * (`SURROUND_IDEAL`), which is exactly its rule. Bringing them down to `parallel`, as was done, lost the
 * arbitration: the text insisted on writing on both sides of a wide image rather than choosing its own.
 */
function readSurround(value: string | null): FlySurround | null {
  switch (value) {
    case 'none':
      return 'none';
    case 'run-through':
      return 'through';
    case 'parallel':
      return 'parallel';
    case 'dynamic':
    case 'biggest':
      return 'ideal';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    default:
      return null;
  }
}

/**
 * ODF's `style:run-through` to Writer's layer.
 *
 * `foreground` is the `heaven` layer (the frame covers the text), everything else is `hell`. It is a boolean
 * in the model (`imageInFront`) because it is one in `RES_OPAQUE`.
 */
function readRunThrough(value: string | null): boolean | null {
  if (value === 'foreground') return true;
  if (value === 'background') return false;
  return null;
}

/** ODF's `style:horizontal-pos` to `text::HoriOrientation`. */
function readHoriOrient(value: string | null): FlyHoriOrient | null {
  switch (value) {
    case 'left':
    case 'inside':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
    case 'outside':
      return 'right';
    case 'from-left':
    case 'from-inside':
      return 'from-left';
    default:
      return null;
  }
}

/**
 * ODF's `style:horizontal-rel` to `text::RelOrientation`.
 *
 * ODF knows about ten; here only the whole sheet is distinguished from the text column, and anything that is
 * not explicitly the sheet falls back to the column: better a frame in the column than a frame in the margin.
 */
function readHoriRelation(value: string | null): FlyHoriRelation | null {
  switch (value) {
    case 'page':
    case 'page-start-margin':
    case 'page-end-margin':
      return 'page';
    case 'paragraph':
    case 'paragraph-content':
    case 'paragraph-start-margin':
    case 'paragraph-end-margin':
    case 'page-content':
    case 'char':
    case 'frame':
    case 'frame-content':
      return 'text';
    default:
      return null;
  }
}

/** ODF's `fo:text-align` to the model's alignment. */
function readAlignment(value: string | null): Alignment | null {
  switch (value) {
    // `start` / `end` are relative to the writing direction; the model expresses them as left/right, the direction
    // being set at document level.
    case 'start':
    case 'left':
      return 'left';
    case 'end':
    case 'right':
      return 'right';
    case 'center':
      return 'center';
    case 'justify':
    case 'justified':
      return 'justify';
    default:
      return null;
  }
}

function readTextProperties(element: Element): RunFormatting {
  const out: RunFormatting = {};

  const weight = attr(element, NS.fo, 'font-weight');
  // ODF also allows numeric weights: above 600, it is bold.
  if (weight && (weight === 'bold' || Number(weight) >= 600)) out.bold = true;

  const style = attr(element, NS.fo, 'font-style');
  if (style === 'italic' || style === 'oblique') out.italic = true;

  const underline = attr(element, NS.style, 'text-underline-style');
  if (underline && underline !== 'none') out.underline = true;

  const strike = attr(element, NS.style, 'text-line-through-style');
  if (strike && strike !== 'none') out.strikeThrough = true;

  const family =
    attr(element, NS.style, 'font-name') ?? attr(element, NS.fo, 'font-family');
  if (family) out.fontFamily = family.replace(/^'|'$/g, '');

  const size = parseLengthPt(attr(element, NS.fo, 'font-size'));
  if (size !== null && size > 0) out.fontSizePt = size;

  const color = attr(element, NS.fo, 'color');
  if (color && color !== 'transparent') out.color = color;

  const background =
    attr(element, NS.fo, 'background-color') ??
    attr(element, NS.style, 'text-background-color');
  if (background && background !== 'transparent') out.backgroundColor = background;

  return out;
}

function readParagraphProperties(element: Element): ParagraphAttributes {
  const out: ParagraphAttributes = {};

  const alignment = readAlignment(attr(element, NS.fo, 'text-align'));
  if (alignment) out.alignment = alignment;

  // `fo:line-height` is expressed as a percentage (proportional spacing) or as a length (fixed spacing). The
  // model only knows the factor: a length is therefore converted against the reference 12 pt font size.
  const lineHeight = attr(element, NS.fo, 'line-height');
  const percent = parsePercent(lineHeight);
  if (percent !== null) out.lineSpacing = percent;
  else {
    const fixed = parseLengthPt(lineHeight);
    if (fixed !== null && fixed > 0) out.lineSpacing = fixed / 12;
  }

  const marginTop = parseLengthPt(attr(element, NS.fo, 'margin-top'));
  if (marginTop !== null) out.marginTopPt = marginTop;
  const marginBottom = parseLengthPt(attr(element, NS.fo, 'margin-bottom'));
  if (marginBottom !== null) out.marginBottomPt = marginBottom;
  const marginLeft = parseLengthPt(attr(element, NS.fo, 'margin-left'));
  if (marginLeft !== null) out.indentLeftPt = marginLeft;
  const marginRight = parseLengthPt(attr(element, NS.fo, 'margin-right'));
  if (marginRight !== null) out.indentRightPt = marginRight;
  const textIndent = parseLengthPt(attr(element, NS.fo, 'text-indent'));
  if (textIndent !== null) out.firstLineIndentPt = textIndent;

  if (attr(element, NS.fo, 'break-before') === 'page') out.pageBreakBefore = true;
  if (attr(element, NS.fo, 'keep-together') === 'always') out.keepTogether = true;

  const orphans = Number(attr(element, NS.fo, 'orphans'));
  if (Number.isFinite(orphans) && orphans > 0) out.orphans = orphans;
  const widows = Number(attr(element, NS.fo, 'widows'));
  if (Number.isFinite(widows) && widows > 0) out.widows = widows;

  return out;
}

/**
 * Attributes of a cell.
 *
 * `fo:border` is written "thickness style color" ("0.5pt solid #000000"): only the color interests us, the
 * model carrying the thickness at table level. We also read the four separate borders, which some producers
 * write instead of the grouped form.
 */
function readCellProperties(element: Element): CellAttributes {
  const out: CellAttributes = {};

  const background = attr(element, NS.fo, 'background-color');
  if (background && background !== 'transparent') out.backgroundColor = background;

  const border =
    attr(element, NS.fo, 'border') ??
    attr(element, NS.fo, 'border-left') ??
    attr(element, NS.fo, 'border-top');
  if (border && border !== 'none') {
    const couleur = /#[0-9a-fA-F]{6}/.exec(border);
    if (couleur) out.borderColor = couleur[0];
  }

  const padding = parseLengthPt(attr(element, NS.fo, 'padding'));
  if (padding !== null) out.paddingPt = padding;

  return out;
}

/**
 * Gathers every `<style:style>` of a document, automatic and named styles together: when reading, only the
 * final table counts.
 */
export function collectStyles(root: Element | Document): StyleTable {
  const table: StyleTable = new Map();
  const elements = root.getElementsByTagName('*');

  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i]!;
    if (localName(element) !== 'style') continue;

    const name = attr(element, NS.style, 'name');
    if (!name) continue;

    const style: OdfStyle = {
      name,
      family: attr(element, NS.style, 'family') ?? '',
      parentName: attr(element, NS.style, 'parent-style-name'),
      text: {},
      paragraph: {},
      cell: {},
      graphic: {},
      column: {},
    };

    for (let c = 0; c < element.children.length; c += 1) {
      const child = element.children[c]!;
      const kind = localName(child);
      if (kind === 'text-properties') Object.assign(style.text, readTextProperties(child));
      else if (kind === 'paragraph-properties') {
        Object.assign(style.paragraph, readParagraphProperties(child));
      } else if (kind === 'table-cell-properties') {
        Object.assign(style.cell, readCellProperties(child));
      } else if (kind === 'graphic-properties') {
        const clip = attr(child, NS.fo, 'clip');
        if (clip) style.graphic.clip = clip;

        const wrap = readSurround(attr(child, NS.style, 'wrap'));
        if (wrap) style.graphic.surround = wrap;

        const margin = parseLengthPt(attr(child, NS.fo, 'margin-left'));
        if (margin !== null && margin >= 0) style.graphic.wrapMarginPt = margin;

        const horiOrient = readHoriOrient(attr(child, NS.style, 'horizontal-pos'));
        if (horiOrient) style.graphic.horiOrient = horiOrient;

        const horiRelation = readHoriRelation(attr(child, NS.style, 'horizontal-rel'));
        if (horiRelation) style.graphic.horiRelation = horiRelation;

        const runThrough = readRunThrough(attr(child, NS.style, 'run-through'));
        if (runThrough !== null) style.graphic.inFront = runThrough;
      } else if (kind === 'table-column-properties') {
        const colWidth = parseLengthPt(attr(child, NS.style, 'column-width'));
        if (colWidth !== null && colWidth > 0) style.column.widthPt = colWidth;
        const relWidth = attr(child, NS.style, 'rel-column-width');
        if (relWidth) {
          const num = parseFloat(relWidth);
          if (Number.isFinite(num) && num > 0) style.column.relWidth = num;
        }
      }
    }

    table.set(name, style);
  }

  return table;
}

/** Maximum depth of the style chain: a guard against a cycle. */
const MAX_STYLE_DEPTH = 16;

/**
 * Resolves a style by climbing its parents.
 *
 * The child wins over the parent (`SvXMLStyleContext::GetParentStyle`), so we start from the most distant
 * parent and overwrite on the way back down.
 */
export function resolveStyle(
  table: StyleTable,
  name: string | null | undefined,
): {
  text: RunFormatting;
  paragraph: ParagraphAttributes;
  cell: CellAttributes;
  graphic: GraphicAttributes;
  column: ColumnAttributes;
} {
  const chain: OdfStyle[] = [];
  let current = name ? table.get(name) : undefined;
  const seen = new Set<string>();

  while (current && chain.length < MAX_STYLE_DEPTH && !seen.has(current.name)) {
    seen.add(current.name);
    chain.unshift(current);
    current = current.parentName ? table.get(current.parentName) : undefined;
  }

  const text: RunFormatting = {};
  const paragraph: ParagraphAttributes = {};
  const cell: CellAttributes = {};
  const graphic: GraphicAttributes = {};
  const column: ColumnAttributes = {};
  for (const style of chain) {
    Object.assign(text, style.text);
    Object.assign(paragraph, style.paragraph);
    Object.assign(cell, style.cell);
    Object.assign(graphic, style.graphic);
    Object.assign(column, style.column);
  }
  return { text, paragraph, cell, graphic, column };
}

/* ----------------------------------------------------------------- writing */

/**
 * Factory of automatic styles.
 *
 * Two runs with the same formatting must share **one** style: without this deduplication, a document of a
 * thousand bold words would produce a thousand styles, which Writer refuses to open past a certain volume.
 */
/** Depth declared in a list style: `MAXLEVEL` of `swtypes.hxx`. */
const MAX_ODF_LIST_LEVEL = 10;

/** Bullets per level, those of Writer's "List Bullet" style. */
const ODF_BULLETS = ['\u2022', '\u25E6', '\u25AA'] as const;

/** Wrapping geometry to write into the style of a floating frame. */
export interface FrameFlyStyle {
  anchor: FlyAnchor;
  surround: FlySurround;
  marginPt?: number;
  /** `text::HoriOrientation` of the frame. Absent = `from-left`. */
  horiOrient?: FlyHoriOrient;
  /** `text::RelOrientation` of the frame. Absent = the text column. */
  horiRelation?: FlyHoriRelation;
  /** `RES_OPAQUE`: the frame goes in front of the text. */
  inFront?: boolean;
}

/**
 * `SwSurround` → ODF's `style:wrap`.
 *
 * The names differ on two values and the swap is silent: ODF says `run-through` where Writer says `THROUGHT`,
 * and `parallel` covers the C++ `SURROUND_PARALLEL`. The rest translates word for word.
 */
const ODF_WRAP: Record<FlySurround, string> = {
  none: 'none',
  through: 'run-through',
  parallel: 'parallel',
  // `SURROUND_IDEAL` is written `dynamic`: this is the name ODF gives to the "wider side", and the one
  // `readSurround` reads back.
  ideal: 'dynamic',
  left: 'left',
  right: 'right',
};

/** `text::HoriOrientation` → `style:horizontal-pos`. */
const ODF_HORI_POS: Record<FlyHoriOrient, string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  'from-left': 'from-left',
};

/** `text::RelOrientation` → `style:horizontal-rel`. */
const ODF_HORI_REL: Record<FlyHoriRelation, string> = {
  page: 'page',
  text: 'paragraph',
};

export class AutomaticStyles {
  private readonly textStyles = new Map<string, string>();
  private readonly paragraphStyles = new Map<string, string>();
  private readonly tableStyles = new Map<string, string>();
  private readonly cellStyles = new Map<string, string>();
  private readonly columnStyles = new Map<number, string>();
  private readonly declarations: string[] = [];
  private readonly frameStyles = new Map<string, string>();

  /** Name of the text style for this formatting, or `null` if it is empty. */
  text(formatting: RunFormatting): string | null {
    const properties = textProperties(formatting);
    if (properties.length === 0) return null;

    const key = properties.join(' ');
    const existing = this.textStyles.get(key);
    if (existing) return existing;

    const name = `T${this.textStyles.size + 1}`;
    this.textStyles.set(key, name);
    this.declarations.push(
      `<style:style style:name="${name}" style:family="text">` +
        `<style:text-properties ${key}/>` +
        `</style:style>`,
    );
    return name;
  }

  /**
   * Style of the frame of an image anchored "as a character".
   *
   * One is enough for the whole document: the geometry specific to each image is carried by
   * `svg:width`/`svg:height` on the frame itself, and this style says only the rest: no wrapping (`run-through`
   * without `wrap`), aligned on the baseline, no border.
   */
  private readonly listStyles = new Map<ListKind, string>();

  frame(clip?: string, fly?: FrameFlyStyle): string {
    // One style per crop value **and** per wrapping mode: `fo:clip` and `style:wrap` are both carried by the style
    // and not by the frame, so two images that differ in them cannot share theirs. Simple images always share
    // `Fr1`.
    const key = `${clip ?? ''}|${
      fly
        ? [
            fly.anchor,
            fly.surround,
            fly.marginPt ?? '',
            fly.horiOrient ?? '',
            fly.horiRelation ?? '',
            fly.inFront ? 'front' : '',
          ].join(':')
        : ''
    }`;
    const existing = this.frameStyles.get(key);
    if (existing) return existing;

    const name = `Fr${this.frameStyles.size + 1}`;
    this.frameStyles.set(key, name);

    // An "as a character" frame aligns on the baseline of the text; a floating frame is positioned within its
    // anchor. Mixing the two makes the document reopen with the images stacked at the top of the page.
    // The "text column" reference does not have the same name on both sides: ODF calls it `paragraph` under a
    // paragraph anchor and `page-content` under a page anchor. Writing `paragraph` on a frame anchored to the
    // page makes the style invalid, and Writer then puts the image back at the top left.
    const relColonne = fly?.anchor === 'to-page' ? 'page-content' : 'paragraph';
    const position = fly
      ? `style:vertical-pos="from-top" style:vertical-rel="${relColonne}" ` +
        `style:horizontal-pos="${ODF_HORI_POS[fly.horiOrient ?? 'from-left']}" ` +
        `style:horizontal-rel="${
          (fly.horiRelation ?? 'text') === 'page' ? ODF_HORI_REL.page : relColonne
        }"`
      : `style:vertical-pos="baseline" style:vertical-rel="baseline"`;

    const wrap = `style:wrap="${fly ? ODF_WRAP[fly.surround] : 'none'}"`;
    // `style:run-through` is only written on a floating frame: a frame inside the line has no layer, it is the
    // text.
    const runThrough = fly
      ? ` style:run-through="${fly.inFront ? 'foreground' : 'background'}"`
      : '';
    const margins =
      fly && fly.marginPt !== undefined
        ? ` fo:margin-left="${formatPt(fly.marginPt)}" fo:margin-right="${formatPt(fly.marginPt)}"` +
          ` fo:margin-top="${formatPt(fly.marginPt)}" fo:margin-bottom="${formatPt(fly.marginPt)}"`
        : '';

    this.declarations.push(
      `<style:style style:name="${name}" style:family="graphic">` +
        `<style:graphic-properties ` +
        `${position} ` +
        `fo:padding="0cm" fo:border="none" ${wrap}` +
        runThrough +
        margins +
        (clip ? ` fo:clip="${clip}"` : '') +
        `/>` +
        `</style:style>`,
    );
    return name;
  }

  /**
   * Name of a list style, declared on demand.
   *
   * ODF describes a list with a `<text:list-style>` carrying **one element per level**: it is the only thing
   * that tells a bullet from a number, the `<text:list>` tag being identical in both cases. Without this style,
   * a numbered list reopens as a bulleted list.
   *
   * One style per kind is enough: all the levels of a list share theirs, as in Writer's "List Number" style.
   */
  list(kind: ListKind): string {
    const existing = this.listStyles.get(kind);
    if (existing) return existing;

    const name = `L${this.listStyles.size + 1}`;
    this.listStyles.set(kind, name);

    const niveaux: string[] = [];
    for (let level = 1; level <= MAX_ODF_LIST_LEVEL; level += 1) {
      // The indent grows by one step per level, like the default `SwNumRule`.
      const indent = `<style:list-level-properties text:space-before="${(level - 1) * 0.635}cm" text:min-label-width="0.635cm"/>`;

      if (kind === 'ordered') {
        niveaux.push(
          `<text:list-level-style-number text:level="${level}" ` +
            `style:num-suffix="." style:num-format="1">${indent}</text:list-level-style-number>`,
        );
      } else {
        // A task list is exported as bullets: ODF 1.2 has no checkbox, and a bullet stays readable everywhere. The
        // checked state travels in the paragraph's text.
        const puce = ODF_BULLETS[(level - 1) % ODF_BULLETS.length];
        niveaux.push(
          `<text:list-level-style-bullet text:level="${level}" ` +
            `text:bullet-char="${puce}">${indent}</text:list-level-style-bullet>`,
        );
      }
    }

    this.declarations.push(`<text:list-style style:name="${name}">${niveaux.join('')}</text:list-style>`);
    return name;
  }

  /** Name of the paragraph style, or `null` if the node has no attribute. */
  paragraph(node: ParagraphNode): string | null {
    const properties = paragraphProperties(node);
    if (properties.length === 0) return null;

    const key = properties.join(' ');
    const existing = this.paragraphStyles.get(key);
    if (existing) return existing;

    const name = `P${this.paragraphStyles.size + 1}`;
    this.paragraphStyles.set(key, name);
    this.declarations.push(
      `<style:style style:name="${name}" style:family="paragraph" ` +
        `style:parent-style-name="${node.type === 'heading' ? 'Heading' : 'Standard'}">` +
        `<style:paragraph-properties ${key}/>` +
        `</style:style>`,
    );
    return name;
  }

  /**
   * Style of a table: width and alignment.
   *
   * Writer requires a `table:style-name` on every `<table:table>`: without it, the table opens at the width of a
   * single column instead of fully justified.
   */
  table(node: TableNode): string {
    const properties = [
      'style:width="17cm"',
      'table:align="margins"',
      ...(node.borderColor ? [`fo:border-color="${node.borderColor}"`] : []),
    ].join(' ');

    const existing = this.tableStyles.get(properties);
    if (existing) return existing;

    const name = `Ta${this.tableStyles.size + 1}`;
    this.tableStyles.set(properties, name);
    this.declarations.push(
      `<style:style style:name="${name}" style:family="table">` +
        `<style:table-properties ${properties}/>` +
        `</style:style>`,
    );
    return name;
  }

  /** Style of a cell: background, border and inner margin. */
  cell(node: TableCellNode): string {
    const couleur = node.borderColor ?? '#c4c8ce';
    const properties = [
      `fo:border="0.5pt solid ${couleur}"`,
      `fo:padding="${formatCm(node.paddingPt ?? 3)}"`,
      ...(node.backgroundColor ? [`fo:background-color="${node.backgroundColor}"`] : []),
    ].join(' ');

    const existing = this.cellStyles.get(properties);
    if (existing) return existing;

    const name = `Tb${this.cellStyles.size + 1}`;
    this.cellStyles.set(properties, name);
    this.declarations.push(
      `<style:style style:name="${name}" style:family="table-cell">` +
        `<style:table-cell-properties ${properties}/>` +
        `</style:style>`,
    );
    return name;
  }

  /** Style of a table column: relative width. */
  column(relWidth: number): string {
    const rounded = Math.round(relWidth * 100) / 100;
    const existing = this.columnStyles.get(rounded);
    if (existing) return existing;

    const name = `Tc${this.columnStyles.size + 1}`;
    this.columnStyles.set(rounded, name);
    this.declarations.push(
      `<style:style style:name="${name}" style:family="table-column">` +
        `<style:table-column-properties style:rel-column-width="${Math.round(rounded * 655)}*"/>` +
        `</style:style>`,
    );
    return name;
  }

  toXml(): string {
    return this.declarations.join('');
  }
}

function textProperties(formatting: RunFormatting): string[] {
  const out: string[] = [];
  if (formatting.bold) out.push('fo:font-weight="bold"', 'style:font-weight-asian="bold"');
  if (formatting.italic) out.push('fo:font-style="italic"', 'style:font-style-asian="italic"');
  if (formatting.underline) {
    out.push(
      'style:text-underline-style="solid"',
      'style:text-underline-width="auto"',
      'style:text-underline-color="font-color"',
    );
  }
  if (formatting.strikeThrough) {
    out.push('style:text-line-through-style="solid"', 'style:text-line-through-type="single"');
  }
  if (formatting.fontFamily) {
    const family = formatting.fontFamily.replace(/"/g, '');
    out.push(`style:font-name="${family}"`, `fo:font-family="${family}"`);
  }
  if (formatting.fontSizePt) {
    const size = formatPt(formatting.fontSizePt);
    out.push(`fo:font-size="${size}"`, `style:font-size-asian="${size}"`);
  }
  if (formatting.color) out.push(`fo:color="${formatting.color}"`);
  if (formatting.backgroundColor) out.push(`fo:background-color="${formatting.backgroundColor}"`);
  return out;
}

function paragraphProperties(node: ParagraphNode): string[] {
  const out: string[] = [];

  if (node.alignment) {
    // We write back as `start` / `end`: ODF's logical form, which follows the writing direction instead of fixing
    // it.
    const value =
      node.alignment === 'left' ? 'start' : node.alignment === 'right' ? 'end' : node.alignment;
    out.push(`fo:text-align="${value}"`, 'style:justify-single-word="false"');
  }
  if (node.lineSpacing) out.push(`fo:line-height="${Math.round(node.lineSpacing * 100)}%"`);
  if (node.marginTopPt !== undefined) out.push(`fo:margin-top="${formatCm(node.marginTopPt)}"`);
  if (node.marginBottomPt !== undefined) {
    out.push(`fo:margin-bottom="${formatCm(node.marginBottomPt)}"`);
  }
  if (node.indentLeftPt !== undefined) out.push(`fo:margin-left="${formatCm(node.indentLeftPt)}"`);
  if (node.indentRightPt !== undefined) {
    out.push(`fo:margin-right="${formatCm(node.indentRightPt)}"`);
  }
  if (node.firstLineIndentPt !== undefined) {
    out.push(`fo:text-indent="${formatCm(node.firstLineIndentPt)}"`);
  }
  if (node.pageBreakBefore) out.push('fo:break-before="page"');
  if (node.keepTogether) out.push('fo:keep-together="always"');
  if (node.orphans !== undefined) out.push(`fo:orphans="${node.orphans}"`);
  if (node.widows !== undefined) out.push(`fo:widows="${node.widows}"`);

  return out;
}
