/**
 * Styles OpenDocument. Transposition de `XMLTextStyleContext` et
 * `SvXMLStyleContext` (`xmloff/source/text/`, `xmloff/source/style/`).
 *
 * ODF sépare **styles nommés** (`styles.xml`, réutilisables) et **styles
 * automatiques** (`content.xml`, engendrés pour chaque combinaison d'attributs
 * réellement employée). Le modèle natif, lui, porte le formatage directement
 * sur les runs. La conversion est donc :
 *   – à la lecture, on **aplatit** : le style et ses parents deviennent des
 *     attributs de run ;
 *   – à l'écriture, on **factorise** : chaque jeu d'attributs distinct reçoit un
 *     style automatique, réutilisé partout où il réapparaît.
 */

import type {
  Alignment,
  FlyAnchor,
  FlySurround,
  ListKind,
  ParagraphNode,
  RunFormatting,
  TableCellNode,
  TableNode,
} from '../document/types';
import { attr, localName, NS } from './namespaces';
import { formatCm, formatPt, parseLengthPt, parsePercent } from './units';

/** Attributs de paragraphe qu'un style peut porter. */
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

/** Attributs qu'un style de cellule peut porter (`<style:table-cell-properties>`). */
export type CellAttributes = Partial<
  Pick<TableCellNode, 'backgroundColor' | 'borderColor' | 'paddingPt'>
>;

/**
 * Propriétés graphiques d'un cadre. Une seule est portée : `fo:clip`, le
 * rognage — les autres (habillage, position flottante) supposent un cadre hors
 * flux, que l'ancrage « comme caractère » n'a pas.
 */
export interface GraphicAttributes {
  /** `fo:clip="rect(haut droite bas gauche)"`, tel quel. */
  clip?: string;
  /** `style:wrap` — mode d'habillage d'un cadre flottant (`SwFmtSurround`). */
  surround?: FlySurround;
  /** `fo:margin-left` du cadre : la marge d'habillage, en points. */
  wrapMarginPt?: number;
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

/* ------------------------------------------------------------------ lecture */

/**
 * `style:wrap` d'ODF vers `SwSurround`.
 *
 * `dynamic` et `biggest` sont les deux formes du « côté le plus large » de
 * Writer (`SURROUND_IDEAL`) : le modèle les ramène à `parallel`, dont c'est
 * exactement le comportement quand les deux côtés sont libres.
 */
function readSurround(value: string | null): FlySurround | null {
  switch (value) {
    case 'none':
      return 'none';
    case 'run-through':
      return 'through';
    case 'parallel':
    case 'dynamic':
    case 'biggest':
      return 'parallel';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    default:
      return null;
  }
}

/** `fo:text-align` d'ODF vers l'alignement du modèle. */
function readAlignment(value: string | null): Alignment | null {
  switch (value) {
    // `start` / `end` sont relatifs à la direction d'écriture ; le modèle les
    // exprime en gauche/droite, la direction étant fixée au niveau du document.
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
  // ODF admet aussi les poids numériques : au-delà de 600, c'est du gras.
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

  // `fo:line-height` s'exprime en pourcentage (interligne proportionnelle) ou
  // en longueur (interligne fixe). Le modèle ne connaît que le facteur : une
  // longueur est donc convertie par rapport au corps de 12 pt de référence.
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
 * Attributs d'une cellule.
 *
 * `fo:border` s'écrit « épaisseur style couleur » (« 0.5pt solid #000000 ») :
 * seule la couleur nous intéresse, le modèle portant l'épaisseur au niveau du
 * tableau. On lit aussi les quatre bordures séparées, qu'écrivent certains
 * producteurs à la place de la forme groupée.
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
 * Rassemble tous les `<style:style>` d'un document, styles automatiques et
 * styles nommés confondus : à la lecture, seule compte la table finale.
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

/** Profondeur maximale de la chaîne de styles — garde contre un cycle. */
const MAX_STYLE_DEPTH = 16;

/**
 * Résout un style en remontant ses parents.
 *
 * L'enfant l'emporte sur le parent (`SvXMLStyleContext::GetParentStyle`), donc
 * on part du parent le plus lointain et on écrase en redescendant.
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

/* ----------------------------------------------------------------- écriture */

/**
 * Fabrique de styles automatiques.
 *
 * Deux runs de même formatage doivent partager **un** style : sans cette
 * déduplication, un document de mille mots en gras produirait mille styles, ce
 * que Writer refuse d'ouvrir passé un certain volume.
 */
/** Profondeur déclarée dans un style de liste — `MAXLEVEL` de `swtypes.hxx`. */
const MAX_ODF_LIST_LEVEL = 10;

/** Puces par niveau, celles du style « List Bullet » de Writer. */
const ODF_BULLETS = ['\u2022', '\u25E6', '\u25AA'] as const;

/** Géométrie d'habillage à graver dans le style d'un cadre flottant. */
export interface FrameFlyStyle {
  anchor: FlyAnchor;
  surround: FlySurround;
  marginPt?: number;
}

/**
 * `SwSurround` → `style:wrap` d'ODF.
 *
 * Les noms diffèrent sur deux valeurs et l'inversion est silencieuse : ODF dit
 * `run-through` là où Writer dit `THROUGHT`, et `parallel` recouvre le
 * `SURROUND_PARALLEL` du C++. Le reste se traduit mot pour mot.
 */
const ODF_WRAP: Record<FlySurround, string> = {
  none: 'none',
  through: 'run-through',
  parallel: 'parallel',
  left: 'left',
  right: 'right',
};

export class AutomaticStyles {
  private readonly textStyles = new Map<string, string>();
  private readonly paragraphStyles = new Map<string, string>();
  private readonly tableStyles = new Map<string, string>();
  private readonly cellStyles = new Map<string, string>();
  private readonly columnStyles = new Map<number, string>();
  private readonly declarations: string[] = [];
  private readonly frameStyles = new Map<string, string>();

  /** Nom du style de texte pour ce formatage, ou `null` s'il est vide. */
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
   * Style du cadre d'une image ancrée « comme caractère ».
   *
   * Un seul suffit pour tout le document : la géométrie propre à chaque image
   * est portée par `svg:width`/`svg:height` sur le cadre lui-même, et ce style
   * ne dit que le reste — pas d'habillage (`run-through` sans `wrap`), aligné
   * sur la ligne de base, sans bordure.
   */
  private readonly listStyles = new Map<ListKind, string>();

  frame(clip?: string, fly?: FrameFlyStyle): string {
    // Un style par valeur de rognage **et** par mode d'habillage : `fo:clip` et
    // `style:wrap` sont tous deux portés par le style et non par le cadre, donc
    // deux images qui en diffèrent ne peuvent pas partager le leur. Les images
    // simples, elles, se partagent toujours `Fr1`.
    const key = `${clip ?? ''}|${fly ? `${fly.anchor}:${fly.surround}:${fly.marginPt ?? ''}` : ''}`;
    const existing = this.frameStyles.get(key);
    if (existing) return existing;

    const name = `Fr${this.frameStyles.size + 1}`;
    this.frameStyles.set(key, name);

    // Un cadre « comme caractère » s'aligne sur la ligne de base du texte ; un
    // cadre flottant se positionne dans son ancre. Confondre les deux fait
    // rouvrir le document avec les images empilées en haut de page.
    const position = fly
      ? `style:vertical-pos="from-top" style:vertical-rel="${fly.anchor === 'to-page' ? 'page-content' : 'paragraph'}" ` +
        `style:horizontal-pos="from-left" style:horizontal-rel="${fly.anchor === 'to-page' ? 'page-content' : 'paragraph'}"`
      : `style:vertical-pos="baseline" style:vertical-rel="baseline"`;

    const wrap = `style:wrap="${fly ? ODF_WRAP[fly.surround] : 'none'}"`;
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
        margins +
        (clip ? ` fo:clip="${clip}"` : '') +
        `/>` +
        `</style:style>`,
    );
    return name;
  }

  /**
   * Nom d'un style de liste, déclaré à la demande.
   *
   * ODF décrit une liste par un `<text:list-style>` portant **un élément par
   * niveau** : c'est la seule chose qui distingue une puce d'un numéro, la
   * balise `<text:list>` étant identique dans les deux cas. Sans ce style, une
   * liste numérotée se rouvre en liste à puces.
   *
   * Un style par nature suffit — tous les niveaux d'une même liste partagent
   * la sienne, comme dans le style « List Number » de Writer.
   */
  list(kind: ListKind): string {
    const existing = this.listStyles.get(kind);
    if (existing) return existing;

    const name = `L${this.listStyles.size + 1}`;
    this.listStyles.set(kind, name);

    const niveaux: string[] = [];
    for (let level = 1; level <= MAX_ODF_LIST_LEVEL; level += 1) {
      // Le retrait croît d'un cran par niveau, comme `SwNumRule` par défaut.
      const indent = `<style:list-level-properties text:space-before="${(level - 1) * 0.635}cm" text:min-label-width="0.635cm"/>`;

      if (kind === 'ordered') {
        niveaux.push(
          `<text:list-level-style-number text:level="${level}" ` +
            `style:num-suffix="." style:num-format="1">${indent}</text:list-level-style-number>`,
        );
      } else {
        // Une liste de tâches s'exporte en puces : ODF 1.2 ne connaît pas la
        // case à cocher, et une puce reste lisible partout. L'état coché
        // voyage dans le texte du paragraphe.
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

  /** Nom du style de paragraphe, ou `null` si le nœud n'a aucun attribut. */
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
   * Style d'un tableau — largeur et alignement.
   *
   * Writer exige un `table:style-name` sur chaque `<table:table>` : sans lui, le
   * tableau s'ouvre à la largeur d'une colonne au lieu de la pleine justification.
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

  /** Style d'une cellule — fond, bordure et marge intérieure. */
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

  /** Style d'une colonne de tableau — largeur relative. */
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
    // On réécrit en `start` / `end` : la forme logique d'ODF, qui suit la
    // direction d'écriture au lieu de la figer.
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
