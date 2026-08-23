/**
 * Schéma du document Write (couche 1).
 *
 * Correspondance avec le modèle OpenOffice cartographié dans integration_write.md :
 *   SwTxtNode          -> nœuds `paragraph` / `heading`
 *   SwpHints (plages)  -> marques `strong`, `em`, `underline`, `strike`,
 *                         `textColor`, `highlight`, `fontFamily`, `fontSize`, `link`
 *   SwFmt              -> attributs `align`, `lineHeight`, `indent`
 *   SwGrfNode          -> nœud `image`
 *   ODF <text:p>, <text:h>, <text:list> -> nœuds correspondants
 *
 * Le rendu est **DOM** et non canvas (ADR-003) : le texte reste sélectionnable,
 * traduisible et lisible par les technologies d'assistance.
 */

import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { addListNodes } from 'prosemirror-schema-list';
import { OrderedMap } from './ordered-map';

export type Alignment = 'left' | 'center' | 'right' | 'justify';

const ALIGNMENTS: readonly Alignment[] = ['left', 'center', 'right', 'justify'];

/** Retrait maximal, en niveaux de 1 cm (bouton « Augmenter le retrait »). */
export const MAX_INDENT = 8;
export const INDENT_STEP_CM = 1;

/** Bornes de taille de police, en points. */
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 96;

function readAlign(value: string | null): Alignment | null {
  return value && (ALIGNMENTS as readonly string[]).includes(value) ? (value as Alignment) : null;
}

/** Styles de bloc : alignement, interligne et retrait partagés par p et h1..h6. */
function blockAttrs(): NonNullable<NodeSpec['attrs']> {
  return {
    align: { default: null },
    lineHeight: { default: null },
    indent: { default: 0 },
  };
}

function blockDOMAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const styles: string[] = [];

  const align = attrs['align'] as Alignment | null;
  if (align && align !== 'left') {
    // `end` suit la direction du document (support RTL).
    styles.push(`text-align: ${align === 'right' ? 'end' : align}`);
    out['data-align'] = align;
  }

  const lineHeight = attrs['lineHeight'] as number | null;
  if (lineHeight) {
    styles.push(`line-height: ${lineHeight}`);
    out['data-line-height'] = String(lineHeight);
  }

  const indent = Number(attrs['indent'] ?? 0);
  if (indent > 0) {
    // Propriété logique : le retrait suit la direction d'écriture.
    styles.push(`margin-inline-start: ${indent * INDENT_STEP_CM}cm`);
    out['data-indent'] = String(indent);
  }

  if (styles.length > 0) out['style'] = styles.join('; ');
  return out;
}

function parseBlockAttrs(dom: HTMLElement): Record<string, unknown> {
  return {
    align: readAlign(dom.style.textAlign || dom.dataset['align'] || null),
    lineHeight: dom.dataset['lineHeight'] ? Number(dom.dataset['lineHeight']) : null,
    indent: Number(dom.dataset['indent'] ?? 0),
  };
}

const baseNodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: blockAttrs(),
    parseDOM: [{ tag: 'p', getAttrs: (dom) => parseBlockAttrs(dom as HTMLElement) }],
    toDOM(node): DOMOutputSpec {
      return ['p', blockDOMAttrs(node.attrs), 0];
    },
  },

  heading: {
    group: 'block',
    content: 'inline*',
    defining: true,
    attrs: { level: { default: 1 }, ...blockAttrs() },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      getAttrs: (dom: HTMLElement | string) => ({
        level,
        ...(typeof dom === 'string' ? {} : parseBlockAttrs(dom)),
      }),
    })),
    toDOM(node): DOMOutputSpec {
      const level = Number(node.attrs['level']) || 1;
      return [`h${level}`, blockDOMAttrs(node.attrs), 0];
    },
  },

  text: { group: 'inline' },

  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM(): DOMOutputSpec {
      return ['br'];
    },
  },

  image: {
    group: 'block',
    atom: true,
    draggable: true,
    attrs: {
      src: {},
      alt: { default: '' },
      width: { default: null },
      align: { default: 'center' }, // 'inline' | 'left' | 'center' | 'right' | 'float-left' | 'float-right'
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          const el = dom as HTMLImageElement;
          return {
            src: el.getAttribute('src') ?? '',
            alt: el.getAttribute('alt') ?? '',
            width: el.getAttribute('width'),
            align: el.dataset['align'] ?? 'center',
          };
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const width = node.attrs['width'] as string | null;
      const align = (node.attrs['align'] as string) || 'center';
      return [
        'img',
        {
          src: String(node.attrs['src']),
          alt: String(node.attrs['alt'] ?? ''),
          'data-align': align,
          ...(width ? { width } : {}),
          class: `pm-image pm-image--${align}`,
        },
      ];
    },
  },

  table: {
    group: 'block',
    content: 'table_row+',
    isolating: true,
    attrs: {
      align: { default: 'center' },
      // Le trait est une propriété du TABLEAU, pas de chaque cellule : le modifier
      // doit toucher un seul nœud, sinon changer l'épaisseur d'un tableau de 200
      // cellules produirait 200 modifications à répliquer et à annuler.
      borderWidth: { default: 1 },
      borderColor: { default: null },
      headerRow: { default: true },
    },
    parseDOM: [
      {
        tag: 'table',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const width = Number.parseFloat(el.dataset['borderWidth'] ?? '');
          return {
            borderWidth: Number.isFinite(width) ? width : 1,
            borderColor: el.dataset['borderColor'] ?? null,
            headerRow: el.dataset['headerRow'] !== 'false',
          };
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const width = Number(node.attrs['borderWidth'] ?? 1);
      const color = (node.attrs['borderColor'] as string | null) ?? 'var(--border-strong)';

      // Les cellules héritent par variables CSS : une seule déclaration décrit
      // tout le tableau, et le rendu suit le thème quand aucune couleur n'est fixée.
      return [
        'table',
        {
          class: 'pm-table',
          style: `--pm-table-border-width: ${width}px; --pm-table-border-color: ${color}`,
          'data-border-width': String(width),
          ...(node.attrs['borderColor'] ? { 'data-border-color': String(node.attrs['borderColor']) } : {}),
          'data-header-row': String(node.attrs['headerRow'] !== false),
        },
        ['tbody', 0],
      ];
    },
  },

  table_row: {
    content: '(table_cell | table_header)+',
    parseDOM: [{ tag: 'tr' }],
    toDOM(): DOMOutputSpec {
      return ['tr', 0];
    },
  },

  table_cell: {
    content: 'block+',
    isolating: true,
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      background: { default: null },
    },
    parseDOM: [
      {
        tag: 'td',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return {
            colspan: el.getAttribute('colspan') ? Math.max(1, Number(el.getAttribute('colspan'))) : 1,
            rowspan: el.getAttribute('rowspan') ? Math.max(1, Number(el.getAttribute('rowspan'))) : 1,
            background: el.style.backgroundColor || null,
          };
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const attrs: Record<string, string> = { class: 'pm-table-cell' };
      if (node.attrs['colspan'] > 1) attrs['colspan'] = String(node.attrs['colspan']);
      if (node.attrs['rowspan'] > 1) attrs['rowspan'] = String(node.attrs['rowspan']);
      if (node.attrs['background']) attrs['style'] = `background-color: ${node.attrs['background']}`;
      return ['td', attrs, 0];
    },
  },

  table_header: {
    content: 'block+',
    isolating: true,
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      background: { default: null },
    },
    parseDOM: [
      {
        tag: 'th',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return {
            colspan: el.getAttribute('colspan') ? Math.max(1, Number(el.getAttribute('colspan'))) : 1,
            rowspan: el.getAttribute('rowspan') ? Math.max(1, Number(el.getAttribute('rowspan'))) : 1,
            background: el.style.backgroundColor || null,
          };
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const attrs: Record<string, string> = { class: 'pm-table-header' };
      if (node.attrs['colspan'] > 1) attrs['colspan'] = String(node.attrs['colspan']);
      if (node.attrs['rowspan'] > 1) attrs['rowspan'] = String(node.attrs['rowspan']);
      if (node.attrs['background']) attrs['style'] = `background-color: ${node.attrs['background']}`;
      return ['th', attrs, 0];
    },
  },

  footnote: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      id: { default: '' },
      index: { default: 1 },
      text: { default: '' },
    },
    parseDOM: [
      {
        tag: 'sup[data-footnote]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return {
            id: el.getAttribute('data-footnote') ?? '',
            index: Number(el.getAttribute('data-index') ?? 1),
            text: el.getAttribute('data-text') ?? '',
          };
        },
      },
    ],
    toDOM(node): DOMOutputSpec {
      const idx = node.attrs['index'] ?? 1;
      const text = String(node.attrs['text'] ?? '');
      return [
        'sup',
        {
          'data-footnote': String(node.attrs['id']),
          'data-index': String(idx),
          'data-text': text,
          class: 'pm-footnote-ref',
          title: text || 'Note de bas de page',
          role: 'doc-noteref',
        },
        `[${idx}]`,
      ];
    },
  },

  page_number: {
    group: 'inline',
    inline: true,
    atom: true,
    parseDOM: [{ tag: 'span[data-page-number]' }],
    toDOM(): DOMOutputSpec {
      return ['span', { 'data-page-number': 'true', class: 'pm-page-num' }, '#'];
    },
  },

  math_inline: {
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    attrs: { latex: { default: '' } },
    parseDOM: [
      {
        tag: 'span[data-math]',
        getAttrs: (dom) => ({ latex: (dom as HTMLElement).getAttribute('data-math') ?? '' }),
      },
    ],
    toDOM(node): DOMOutputSpec {
      // Rendu de repli (copier-coller, export brut) : la source LaTeX reste
      // toujours présente dans le DOM, le rendu visuel est ajouté par `MathView`.
      const latex = String(node.attrs['latex'] ?? '');
      return ['span', { 'data-math': latex, class: 'pm-math pm-math--inline' }, `$${latex}$`];
    },
  },

  math_block: {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: { latex: { default: '' } },
    parseDOM: [
      {
        tag: 'div[data-math]',
        getAttrs: (dom) => ({ latex: (dom as HTMLElement).getAttribute('data-math') ?? '' }),
      },
    ],
    toDOM(node): DOMOutputSpec {
      const latex = String(node.attrs['latex'] ?? '');
      return ['div', { 'data-math': latex, class: 'pm-math pm-math--block' }, `$$${latex}$$`];
    },
  },

  page_break: {
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'div[data-page-break]' }],
    toDOM(): DOMOutputSpec {
      // Rôle `separator` : le saut de page est perceptible au lecteur d'écran.
      return [
        'div',
        {
          'data-page-break': 'true',
          class: 'pm-page-break',
          role: 'separator',
          'aria-label': 'Saut de page',
        },
      ];
    },
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    inclusive: false,
    attrs: { href: {}, title: { default: null } },
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => ({
          href: (dom as HTMLElement).getAttribute('href') ?? '',
          title: (dom as HTMLElement).getAttribute('title'),
        }),
      },
    ],
    toDOM(mark): DOMOutputSpec {
      const title = mark.attrs['title'] as string | null;
      return [
        'a',
        {
          href: String(mark.attrs['href']),
          ...(title ? { title } : {}),
          // Lien sortant depuis un document collaboratif : jamais de fuite de referrer.
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
        0,
      ];
    },
  },

  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (dom as HTMLElement).style.fontWeight !== 'normal' && null },
      { style: 'font-weight=bold' },
      { style: 'font-weight=700' },
    ],
    toDOM(): DOMOutputSpec {
      return ['strong', 0];
    },
  },

  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM(): DOMOutputSpec {
      return ['em', 0];
    },
  },

  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
    toDOM(): DOMOutputSpec {
      return ['u', 0];
    },
  },

  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM(): DOMOutputSpec {
      return ['s', 0];
    },
  },

  textColor: {
    attrs: { color: {} },
    parseDOM: [
      {
        style: 'color',
        getAttrs: (value) => (typeof value === 'string' ? { color: value } : false),
      },
    ],
    toDOM(mark): DOMOutputSpec {
      return ['span', { style: `color: ${String(mark.attrs['color'])}`, class: 'pm-color' }, 0];
    },
  },

  highlight: {
    attrs: { color: {} },
    parseDOM: [
      {
        style: 'background-color',
        getAttrs: (value) => (typeof value === 'string' ? { color: value } : false),
      },
    ],
    toDOM(mark): DOMOutputSpec {
      return [
        'span',
        { style: `background-color: ${String(mark.attrs['color'])}`, class: 'pm-highlight' },
        0,
      ];
    },
  },

  fontFamily: {
    attrs: { family: {} },
    parseDOM: [
      {
        style: 'font-family',
        getAttrs: (value) => (typeof value === 'string' ? { family: value } : false),
      },
    ],
    toDOM(mark): DOMOutputSpec {
      return ['span', { style: `font-family: ${String(mark.attrs['family'])}` }, 0];
    },
  },

  fontSize: {
    attrs: { size: {} },
    parseDOM: [
      {
        style: 'font-size',
        getAttrs: (value) => {
          const size = typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
          return Number.isFinite(size) ? { size } : false;
        },
      },
    ],
    toDOM(mark): DOMOutputSpec {
      return ['span', { style: `font-size: ${Number(mark.attrs['size'])}pt` }, 0];
    },
  },
};

const withLists = addListNodes(OrderedMap.from(baseNodes) as never, 'paragraph block*', 'block');

/** Liste à cocher (`checklist` du ruban) — absente de prosemirror-schema-list. */
const taskNodes: Record<string, NodeSpec> = {
  task_list: {
    group: 'block',
    content: 'task_item+',
    parseDOM: [{ tag: 'ul[data-task-list]' }],
    toDOM(): DOMOutputSpec {
      return ['ul', { 'data-task-list': 'true', class: 'pm-task-list', role: 'list' }, 0];
    },
  },
  task_item: {
    content: 'paragraph block*',
    defining: true,
    attrs: { checked: { default: false } },
    parseDOM: [
      {
        tag: 'li[data-task-item]',
        getAttrs: (dom) => ({ checked: (dom as HTMLElement).dataset['checked'] === 'true' }),
      },
    ],
    toDOM(node): DOMOutputSpec {
      // La case est rendue par `TaskItemView` (nodeview) : un vrai <input> focusable.
      return ['li', { 'data-task-item': 'true', 'data-checked': String(node.attrs['checked']) }, 0];
    },
  },
};

export const writeSchema = new Schema({
  nodes: (withLists as never as import('./ordered-map').OrderedMapType<NodeSpec>).append(taskNodes),
  marks,
});

/** Polices proposées dans le ruban (portage du sélecteur de `SvxFontNameBox`). */
export const FONT_FAMILIES = [
  'Arial',
  'Georgia',
  'Liberation Serif',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
] as const;

/** Tailles proposées, en points. */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72] as const;

/** Interlignes proposés. */
export const LINE_HEIGHTS = [1, 1.15, 1.5, 2] as const;
