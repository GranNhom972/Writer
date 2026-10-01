// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Projection of the Writer model into a replicated Yjs document.
 *
 * ## Why a CRDT, and no longer a block diff
 *
 * The previous version compared two `WriterDocumentState`s and derived block operations from them (`replace-block`,
 * `insert-block`...), which a sequencing server put in order. The model converges, but at **block granularity**: two people
 * writing in the same paragraph each produce a `replace-block`, and the second erases the first. On a paragraph, that is a
 * sentence lost without any warning, which is exactly what was observed.
 *
 * The Write application does not have this flaw because it compares nothing: its document **is** a CRDT (Yjs), and two
 * concurrent insertions in the same sentence merge character by character. This is the layer reused here, without ProseMirror:
 * the text engine stays ours.
 *
 * ## The mapping
 *
 * ```
 *  writer:meta    Y.Map      title, author, dates            (register per key)
 *  writer:setup   Y.Map      pageSetup, defaults, furniture  (whole values)
 *  writer:blocks  Y.Array    one Y.Map per top-level block
 *      ├─ id, type          plain keys
 *      ├─ text   Y.Text     the paragraph's text; the **character formatting is
 *      │                    carried by the Y.Text attributes**, whose delta
 *      │                    representation is exactly a list of `TextRun`
 *      │                    (a flattened `SwpHints`)
 *      ├─ attrs  Y.Map      paragraph attributes (alignment, list, indents)
 *      └─ rows   Y.Array    tables: rows → cells → blocks, recursively
 * ```
 *
 * `Y.Text` and `TextRun[]` say the same thing: a sequence of homogeneous text ranges. The conversion is therefore a bijection
 * and not an approximation, which is what lets the rendering engine stay untouched.
 *
 * Pure module: no React import, no DOM access.
 */

import * as Y from 'yjs';

import {
  isTable,
  isToc,
  RUN_FORMAT_KEYS,
  type Alignment,
  type DocumentBlock,
  type DocumentDefaults,
  type HeadingLevel,
  type ListKind,
  type PageSetup,
  type ParagraphNode,
  type RunFormatting,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
  type TextRun,
  type TocNode,
  type WriterDocumentState,
} from '../document/types';
import { makeRun, normalizeRuns, runFormatting, runsText } from '../document/runs';
import { A4_PORTRAIT } from '../document/pageSetup';
import { DEFAULT_DEFAULTS } from '../document/document';
import { readFurniture, type PageFurniture } from '../document/pageFurniture';
import { DEFAULT_TOC_MAX_LEVEL, DEFAULT_TOC_TITLE } from '../document/tox';

/* ------------------------------------------------------------------ schema */

/**
 * Names of the shared roots. The server knows them too (`server/src/content.rs`): it seeds a document and can read it back as
 * JSON. Changing them on one side only would make every existing share unreadable.
 */
export const BLOCKS_ROOT = 'writer:blocks';
export const META_ROOT = 'writer:meta';
export const SETUP_ROOT = 'writer:setup';

/** Replicated paragraph attributes, one per key of the `attrs` `Y.Map`. */
const PARAGRAPH_ATTRS = [
  'headingLevel',
  'styleName',
  'alignment',
  'lineSpacing',
  'marginTopPt',
  'marginBottomPt',
  'indentLeftPt',
  'indentRightPt',
  'firstLineIndentPt',
  'pageBreakBefore',
  'orphans',
  'widows',
  'keepTogether',
  'listKind',
  'listId',
  'listLevel',
  'listRestart',
  'listStartValue',
  'listChecked',
] as const;

const TABLE_ATTRS = ['pageBreakBefore', 'borderColor', 'borderWidthPt'] as const;

/**
 * Attributes of a table of contents.
 *
 * A `TocNode` has **neither text nor lines**: it only carries its definition, its content being regenerated at pagination time
 * (see document/tox.ts). That is what makes it trivial to replicate: two peers who change the depth of a table of contents
 * cannot produce a text conflict, only a last written value that wins, which is the right behavior for a setting.
 */
const TOC_ATTRS = ['title', 'maxLevel', 'showPageNumbers', 'useDotLeader', 'pageBreakBefore'] as const;

const CELL_ATTRS = [
  'colSpan',
  'rowSpan',
  'widthPercent',
  'backgroundColor',
  'borderColor',
  'paddingPt',
] as const;

/**
 * Id of the fallback paragraph of an empty document.
 *
 * A document with no block at all cannot be represented: the cursor would have nowhere to land. The value is **fixed** and not
 * drawn at random, so that two peers opening the same empty document do not make up two different paragraphs that would then
 * have to be reconciled.
 */
const EMPTY_BLOCK_ID = 'p-vide';

/* ------------------------------------------------- runs ⇄ Y.Text delta */

interface DeltaOp {
  insert?: string | object;
  attributes?: Record<string, unknown> | undefined;
}

/** `Y.Text` attributes that correspond to a run, or `undefined` if it has none. */
function attributesOf(run: TextRun): Record<string, unknown> | undefined {
  const formatting = runFormatting(run);
  const out: Record<string, unknown> = {};
  let any = false;
  for (const key of RUN_FORMAT_KEYS) {
    const value = formatting[key];
    if (value !== undefined) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Keeps only the known formatting keys.
 *
 * The attributes come from the network: a peer of a later version can set some that this engine does not know how to render.
 * Copying them as they are into a run would break `sameFormatting`, so the merging of neighboring ranges.
 */
function formattingFrom(attributes: Record<string, unknown> | undefined): RunFormatting {
  const out: Record<string, unknown> = {};
  if (attributes) {
    for (const key of RUN_FORMAT_KEYS) {
      const value = attributes[key];
      if (value !== undefined && value !== null) out[key] = value;
    }
  }
  return out as RunFormatting;
}

/** Yjs delta → Writer runs, merge invariant restored (`MergePortions`). */
export function deltaToRuns(delta: readonly DeltaOp[]): TextRun[] {
  const runs: TextRun[] = [];
  for (const op of delta) {
    // Non-text insertions (embedded objects) do not exist in this schema: an image is a run attribute, not a separate node.
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
    runs.push(makeRun(op.insert, formattingFrom(op.attributes)));
  }
  return normalizeRuns(runs);
}

/** Writer runs → Yjs delta. Empty runs cannot be represented. */
export function runsToDelta(runs: readonly TextRun[]): DeltaOp[] {
  const delta: DeltaOp[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const attributes = attributesOf(run);
    delta.push(attributes ? { insert: run.text, attributes } : { insert: run.text });
  }
  return delta;
}

interface Segment {
  start: number;
  end: number;
  attributes: Record<string, unknown>;
}

function segmentsOf(delta: readonly DeltaOp[]): Segment[] {
  const out: Segment[] = [];
  let position = 0;
  for (const op of delta) {
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
    const end = position + op.insert.length;
    out.push({ start: position, end, attributes: op.attributes ?? {} });
    position = end;
  }
  return out;
}

function textOf(delta: readonly DeltaOp[]): string {
  let out = '';
  for (const op of delta) if (typeof op.insert === 'string') out += op.insert;
  return out;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * What changed between two strings, expressed as **one** replaced range.
 *
 * Typing, deletion and pasting all produce exactly that; deriving a contiguous insertion and deletion from it, rather than
 * rewriting the whole paragraph, is what lets two people write in the same sentence without erasing each other.
 *
 * The bounds never fall between the two halves of a surrogate pair: cutting an emoji would leave half a character in the
 * replicated document.
 */
export function textChange(
  before: string,
  after: string,
): { at: number; removed: number; inserted: string } | null {
  if (before === after) return null;

  const maxCommun = Math.min(before.length, after.length);
  let prefixe = 0;
  while (prefixe < maxCommun && before[prefixe] === after[prefixe]) prefixe += 1;
  if (prefixe > 0 && isHighSurrogate(before.charCodeAt(prefixe - 1))) prefixe -= 1;

  let suffixe = 0;
  while (
    suffixe < maxCommun - prefixe &&
    before[before.length - 1 - suffixe] === after[after.length - 1 - suffixe]
  ) {
    suffixe += 1;
  }
  if (suffixe > 0 && isLowSurrogate(after.charCodeAt(after.length - suffixe))) suffixe -= 1;

  return {
    at: prefixe,
    removed: before.length - prefixe - suffixe,
    inserted: after.slice(prefixe, after.length - suffixe),
  };
}

/** Formatting to give to the inserted text: that of the range that receives it. */
function formattingAtIndex(runs: readonly TextRun[], index: number): Record<string, unknown> {
  let consomme = 0;
  for (const run of runs) {
    const fin = consomme + run.text.length;
    if (index < fin || (index === fin && run === runs[runs.length - 1])) {
      return attributesOf(run) ?? {};
    }
    consomme = fin;
  }
  return {};
}

/** Attribute difference to apply: `null` removes a key, as `Y.Text` requires. */
function attributePatch(
  courant: Record<string, unknown>,
  cible: Record<string, unknown>,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  let change = false;

  for (const key of RUN_FORMAT_KEYS) {
    const avant = courant[key] ?? undefined;
    const apres = cible[key] ?? undefined;
    if (avant === apres) continue;
    patch[key] = apres === undefined ? null : apres;
    change = true;
  }
  return change ? patch : null;
}

/**
 * Aligns a `Y.Text` on a list of runs, touching only what is necessary.
 *
 * Two passes, and the order matters: the text first, the formatting afterwards. A formatting range is expressed in positions,
 * and setting them before moving the text would apply them in the wrong place.
 */
export function syncText(ytext: Y.Text, runs: readonly TextRun[]): void {
  const avant = ytext.toDelta() as DeltaOp[];
  const changement = textChange(textOf(avant), runsText(runs));

  if (changement) {
    if (changement.removed > 0) ytext.delete(changement.at, changement.removed);
    if (changement.inserted.length > 0) {
      ytext.insert(changement.at, changement.inserted, formattingAtIndex(runs, changement.at));
    }
  }

  // Formatting is compared on the state **after** the edit: the positions from before no longer designate the same characters.
  const courant = segmentsOf(ytext.toDelta() as DeltaOp[]);
  let position = 0;
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const debut = position;
    const fin = position + run.text.length;
    position = fin;

    const cible = attributesOf(run) ?? {};
    for (const segment of courant) {
      const de = Math.max(debut, segment.start);
      const a = Math.min(fin, segment.end);
      if (de >= a) continue;
      const patch = attributePatch(segment.attributes, cible);
      if (patch) ytext.format(de, a - de, patch);
    }
  }
}

/* ------------------------------------------------------- reading the document */

/**
 * Reading mirror of the replicated document.
 *
 * It keeps a cache per block: a remote keystroke in one paragraph must not rebuild the forty others, nor break their object
 * identity, since the layout engine uses it to re-paginate only what moved.
 */
export class DocumentMirror {
  private cache = new WeakMap<Y.Map<unknown>, DocumentBlock>();

  constructor(private readonly ydoc: Y.Doc) {}

  get blocks(): Y.Array<Y.Map<unknown>> {
    return this.ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT);
  }

  get meta(): Y.Map<unknown> {
    return this.ydoc.getMap<unknown>(META_ROOT);
  }

  get setup(): Y.Map<unknown> {
    return this.ydoc.getMap<unknown>(SETUP_ROOT);
  }

  /** Does the replicated document already have content? */
  get seeded(): boolean {
    return this.blocks.length > 0;
  }

  /**
   * Forgets what an event has made wrong.
   *
   * We climb the chain of parents rather than interpret `event.path`: the ancestry leads to the block's `Y.Map` however deeply it
   * is buried; in a table cell the path is five levels long.
   */
  invalidate(events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): void {
    for (const event of events) {
      let noeud: Y.AbstractType<unknown> | null = event.target;
      while (noeud) {
        if (noeud instanceof Y.Map) this.cache.delete(noeud as Y.Map<unknown>);
        noeud = noeud.parent;
      }
    }
  }

  /** Empties the cache entirely, after a `snapshot` or a massive catch-up. */
  reset(): void {
    // A `WeakMap` cannot be emptied: we take a new one.
    this.cache = new WeakMap();
  }

  read(): WriterDocumentState {
    const meta = this.meta;
    const setup = this.setup;
    const maintenant = new Date().toISOString();

    const blocks: DocumentBlock[] = [];
    for (const ybloc of this.blocks) blocks.push(this.readBlock(ybloc));

    const furniture = setup.get('furniture');
    const document: WriterDocumentState = {
      id: asString(setup.get('id')) ?? 'doc-partage',
      meta: {
        title: asString(meta.get('title')) ?? 'Document sans titre',
        author: asString(meta.get('author')) ?? '',
        createdAt: asString(meta.get('createdAt')) ?? maintenant,
        updatedAt: asString(meta.get('updatedAt')) ?? maintenant,
      },
      pageSetup: (asObject(setup.get('pageSetup')) as PageSetup | null) ?? { ...A4_PORTRAIT },
      defaults:
        (asObject(setup.get('defaults')) as DocumentDefaults | null) ?? { ...DEFAULT_DEFAULTS },
      // An empty document cannot be represented: the cursor would have nowhere to land.
      blocks: blocks.length > 0 ? blocks : [emptyParagraph()],
    };

    if (furniture !== undefined && furniture !== null) {
      document.furniture = readFurniture(furniture) as PageFurniture;
    }
    return document;
  }

  private readBlock(ybloc: Y.Map<unknown>): DocumentBlock {
    const memorise = this.cache.get(ybloc);
    if (memorise !== undefined) return memorise;

    const kind = ybloc.get('type');
    const bloc =
      kind === 'table'
        ? this.readTable(ybloc)
        : kind === 'toc'
          ? this.readToc(ybloc)
          : this.readParagraph(ybloc);
    this.cache.set(ybloc, bloc);
    return bloc;
  }

  private readToc(ybloc: Y.Map<unknown>): TocNode {
    const node: TocNode = {
      id: asString(ybloc.get('id')) ?? 'toc-inconnu',
      type: 'toc',
      title: DEFAULT_TOC_TITLE,
      maxLevel: DEFAULT_TOC_MAX_LEVEL,
      showPageNumbers: true,
      useDotLeader: true,
    };
    assignAttrs(node, ybloc.get('attrs'), TOC_ATTRS);
    return node;
  }

  private readParagraph(ybloc: Y.Map<unknown>): ParagraphNode {
    const ytext = ybloc.get('text');
    const runs =
      ytext instanceof Y.Text ? deltaToRuns(ytext.toDelta() as DeltaOp[]) : [makeRun('')];

    const node: ParagraphNode = {
      id: asString(ybloc.get('id')) ?? 'p-inconnu',
      type: ybloc.get('type') === 'heading' ? 'heading' : 'paragraph',
      runs,
    };
    assignAttrs(node, ybloc.get('attrs'), PARAGRAPH_ATTRS);
    return node;
  }

  private readTable(ybloc: Y.Map<unknown>): TableNode {
    const yrows = ybloc.get('rows');
    const rows: TableRowNode[] = [];

    if (yrows instanceof Y.Array) {
      for (const yrow of yrows as Y.Array<Y.Map<unknown>>) {
        const cells: TableCellNode[] = [];
        const ycells = yrow.get('cells');
        if (ycells instanceof Y.Array) {
          for (const ycell of ycells as Y.Array<Y.Map<unknown>>) {
            const cellule: TableCellNode = {
              id: asString(ycell.get('id')) ?? 'tc-inconnu',
              blocks: readCellBlocks(ycell.get('blocks')),
            };
            assignAttrs(cellule, ycell.get('attrs'), CELL_ATTRS);
            cells.push(cellule);
          }
        }
        const ligne: TableRowNode = { id: asString(yrow.get('id')) ?? 'tr-inconnu', cells };
        if (yrow.get('isHeader') === true) ligne.isHeader = true;
        rows.push(ligne);
      }
    }

    const table: TableNode = {
      id: asString(ybloc.get('id')) ?? 't-inconnu',
      type: 'table',
      rows,
    };
    assignAttrs(table, ybloc.get('attrs'), TABLE_ATTRS);
    return table;
  }
}

function readCellBlocks(yblocks: unknown): ParagraphNode[] {
  if (!(yblocks instanceof Y.Array)) return [emptyParagraph()];
  const out: ParagraphNode[] = [];
  for (const ybloc of yblocks as Y.Array<Y.Map<unknown>>) {
    const ytext = ybloc.get('text');
    const node: ParagraphNode = {
      id: asString(ybloc.get('id')) ?? 'p-inconnu',
      type: ybloc.get('type') === 'heading' ? 'heading' : 'paragraph',
      runs: ytext instanceof Y.Text ? deltaToRuns(ytext.toDelta() as DeltaOp[]) : [makeRun('')],
    };
    assignAttrs(node, ybloc.get('attrs'), PARAGRAPH_ATTRS);
    out.push(node);
  }
  return out.length > 0 ? out : [emptyParagraph()];
}

function emptyParagraph(): ParagraphNode {
  return { id: EMPTY_BLOCK_ID, type: 'paragraph', runs: [makeRun('')] };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Copies the known attributes of a `Y.Map` onto a node.
 *
 * Unknown keys are ignored: they come from the network, and a later version of the model must not be able to inject anything into
 * a node that the engine believes is typed.
 */
function assignAttrs(
  cible: object,
  attrs: unknown,
  cles: readonly string[],
): void {
  if (!(attrs instanceof Y.Map)) return;
  const sortie = cible as Record<string, unknown>;
  for (const cle of cles) {
    const valeur = (attrs as Y.Map<unknown>).get(cle);
    if (valeur !== undefined && valeur !== null) sortie[cle] = valeur;
  }
}

/* ------------------------------------------------------ writing the document */

/**
 * Aligns the replicated document on a local state, touching only what is necessary.
 *
 * This is **not** a replacement: unchanged paragraphs are not rewritten, and a modified paragraph is only rewritten at the spot of
 * the change. This economy is what makes two concurrent keystrokes converge instead of overwriting each other.
 */
export function reconcile(ydoc: Y.Doc, next: WriterDocumentState, origin: unknown): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap<unknown>(META_ROOT);
    setIfChanged(meta, 'title', next.meta.title);
    setIfChanged(meta, 'author', next.meta.author);
    setIfChanged(meta, 'createdAt', next.meta.createdAt);
    setIfChanged(meta, 'updatedAt', next.meta.updatedAt);

    const setup = ydoc.getMap<unknown>(SETUP_ROOT);
    setIfChanged(setup, 'id', next.id);
    setJsonIfChanged(setup, 'pageSetup', next.pageSetup);
    setJsonIfChanged(setup, 'defaults', next.defaults);
    setJsonIfChanged(setup, 'furniture', next.furniture ?? null);

    reconcileBlocks(ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT), next.blocks);
  }, origin);
}

function setIfChanged(ymap: Y.Map<unknown>, key: string, value: string): void {
  if (ymap.get(key) !== value) ymap.set(key, value);
}

function setJsonIfChanged(ymap: Y.Map<unknown>, key: string, value: unknown): void {
  const courant = ymap.get(key);
  if (JSON.stringify(courant ?? null) === JSON.stringify(value ?? null)) return;
  ymap.set(key, value);
}

function idOf(ybloc: Y.Map<unknown> | undefined): string | null {
  return ybloc ? asString(ybloc.get('id')) : null;
}

function indexOfId(yblocks: Y.Array<Y.Map<unknown>>, id: string, from: number): number {
  for (let i = from; i < yblocks.length; i += 1) {
    if (idOf(yblocks.get(i)) === id) return i;
  }
  return -1;
}

function reconcileBlocks(
  yblocks: Y.Array<Y.Map<unknown>>,
  next: readonly DocumentBlock[],
): void {
  const attendus = new Set(next.map((bloc) => bloc.id));

  // 1. What has disappeared goes first, from the end to the start: deleting backwards leaves the indices on the left valid.
  for (let i = yblocks.length - 1; i >= 0; i -= 1) {
    const id = idOf(yblocks.get(i));
    if (id === null || !attendus.has(id)) yblocks.delete(i, 1);
  }

  // 2. Alignment position by position. The usual case, where nothing moved, only costs one id comparison per block.
  for (let i = 0; i < next.length; i += 1) {
    const cible = next[i]!;
    const courant = i < yblocks.length ? yblocks.get(i) : undefined;

    if (courant && idOf(courant) === cible.id && sameKind(courant, cible)) {
      reconcileBlock(courant, cible);
      continue;
    }

    // The block exists further on: it was moved. A `Y.Array` does not know how to move an element, so we remove it and put it back.
    // Moving remains rare (drag and drop, table operations), unlike typing.
    const ailleurs = indexOfId(yblocks, cible.id, i);
    if (ailleurs >= 0) yblocks.delete(ailleurs, 1);
    yblocks.insert(i, [buildBlock(cible)]);
  }

  // 3. The tail: what a peer inserted beyond what we know.
  if (yblocks.length > next.length) {
    yblocks.delete(next.length, yblocks.length - next.length);
  }
}

/**
 * A paragraph does not become a table: changing nature means being born again.
 *
 * The comparison is made on the block's **family** (text, table, table of contents) and not on its exact `type`: switching
 * `paragraph` to `heading` must reconcile in place, without destroying the `Y.Text` and therefore the collaborative history of the
 * paragraph.
 */
function sameKind(ybloc: Y.Map<unknown>, bloc: DocumentBlock): boolean {
  return familyOf(asString(ybloc.get('type')) ?? '') === familyOf(bloc.type);
}

function familyOf(type: string): 'table' | 'toc' | 'text' {
  if (type === 'table') return 'table';
  if (type === 'toc') return 'toc';
  return 'text';
}

function reconcileBlock(ybloc: Y.Map<unknown>, bloc: DocumentBlock): void {
  if (isTable(bloc)) {
    reconcileAttrs(attrsOf(ybloc), bloc as unknown as Record<string, unknown>, TABLE_ATTRS);
    reconcileRows(rowsOf(ybloc), bloc.rows);
    return;
  }

  if (isToc(bloc)) {
    reconcileAttrs(attrsOf(ybloc), bloc as unknown as Record<string, unknown>, TOC_ATTRS);
    return;
  }

  // `paragraph` ⇄ `heading`: a heading is a paragraph with a level, not another node. Switching one to the other must therefore
  // rebuild nothing.
  if (ybloc.get('type') !== bloc.type) ybloc.set('type', bloc.type);

  const ytext = ybloc.get('text');
  if (ytext instanceof Y.Text) syncText(ytext, bloc.runs);
  reconcileAttrs(attrsOf(ybloc), bloc as unknown as Record<string, unknown>, PARAGRAPH_ATTRS);
}

function reconcileRows(yrows: Y.Array<Y.Map<unknown>>, rows: readonly TableRowNode[]): void {
  const attendues = new Set(rows.map((row) => row.id));
  for (let i = yrows.length - 1; i >= 0; i -= 1) {
    const id = idOf(yrows.get(i));
    if (id === null || !attendues.has(id)) yrows.delete(i, 1);
  }

  for (let i = 0; i < rows.length; i += 1) {
    const cible = rows[i]!;
    const courant = i < yrows.length ? yrows.get(i) : undefined;

    if (courant && idOf(courant) === cible.id) {
      if ((courant.get('isHeader') === true) !== (cible.isHeader === true)) {
        courant.set('isHeader', cible.isHeader === true);
      }
      reconcileCells(cellsOf(courant), cible.cells);
      continue;
    }

    const ailleurs = indexOfId(yrows, cible.id, i);
    if (ailleurs >= 0) yrows.delete(ailleurs, 1);
    yrows.insert(i, [buildRow(cible)]);
  }

  if (yrows.length > rows.length) yrows.delete(rows.length, yrows.length - rows.length);
}

function reconcileCells(ycells: Y.Array<Y.Map<unknown>>, cells: readonly TableCellNode[]): void {
  const attendues = new Set(cells.map((cell) => cell.id));
  for (let i = ycells.length - 1; i >= 0; i -= 1) {
    const id = idOf(ycells.get(i));
    if (id === null || !attendues.has(id)) ycells.delete(i, 1);
  }

  for (let i = 0; i < cells.length; i += 1) {
    const cible = cells[i]!;
    const courant = i < ycells.length ? ycells.get(i) : undefined;

    if (courant && idOf(courant) === cible.id) {
      reconcileAttrs(attrsOf(courant), cible as unknown as Record<string, unknown>, CELL_ATTRS);
      reconcileBlocks(blocksOf(courant), cible.blocks);
      continue;
    }

    const ailleurs = indexOfId(ycells, cible.id, i);
    if (ailleurs >= 0) ycells.delete(ailleurs, 1);
    ycells.insert(i, [buildCell(cible)]);
  }

  if (ycells.length > cells.length) ycells.delete(cells.length, ycells.length - cells.length);
}

function reconcileAttrs(
  yattrs: Y.Map<unknown>,
  source: Record<string, unknown>,
  cles: readonly string[],
): void {
  for (const cle of cles) {
    const valeur = source[cle];
    const courant = yattrs.get(cle);
    if (valeur === undefined) {
      if (courant !== undefined) yattrs.delete(cle);
    } else if (courant !== valeur) {
      yattrs.set(cle, valeur);
    }
  }
}

/* ------------------------------------------------------------- construction */

function attrsOf(ybloc: Y.Map<unknown>): Y.Map<unknown> {
  const existant = ybloc.get('attrs');
  if (existant instanceof Y.Map) return existant as Y.Map<unknown>;
  const neuf = new Y.Map<unknown>();
  ybloc.set('attrs', neuf);
  return neuf;
}

function rowsOf(ybloc: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  const existant = ybloc.get('rows');
  if (existant instanceof Y.Array) return existant as Y.Array<Y.Map<unknown>>;
  const neuf = new Y.Array<Y.Map<unknown>>();
  ybloc.set('rows', neuf);
  return neuf;
}

function cellsOf(yrow: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  const existant = yrow.get('cells');
  if (existant instanceof Y.Array) return existant as Y.Array<Y.Map<unknown>>;
  const neuf = new Y.Array<Y.Map<unknown>>();
  yrow.set('cells', neuf);
  return neuf;
}

function blocksOf(ycell: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  const existant = ycell.get('blocks');
  if (existant instanceof Y.Array) return existant as Y.Array<Y.Map<unknown>>;
  const neuf = new Y.Array<Y.Map<unknown>>();
  ycell.set('blocks', neuf);
  return neuf;
}

function buildAttrs(source: Record<string, unknown>, cles: readonly string[]): Y.Map<unknown> {
  const yattrs = new Y.Map<unknown>();
  for (const cle of cles) {
    const valeur = source[cle];
    if (valeur !== undefined) yattrs.set(cle, valeur);
  }
  return yattrs;
}

export function buildBlock(bloc: DocumentBlock): Y.Map<unknown> {
  const ybloc = new Y.Map<unknown>();
  ybloc.set('id', bloc.id);
  ybloc.set('type', bloc.type);

  if (isTable(bloc)) {
    ybloc.set('attrs', buildAttrs(bloc as unknown as Record<string, unknown>, TABLE_ATTRS));
    const yrows = new Y.Array<Y.Map<unknown>>();
    ybloc.set('rows', yrows);
    yrows.push(bloc.rows.map(buildRow));
    return ybloc;
  }

  if (isToc(bloc)) {
    ybloc.set('attrs', buildAttrs(bloc as unknown as Record<string, unknown>, TOC_ATTRS));
    return ybloc;
  }

  const ytext = new Y.Text();
  ybloc.set('text', ytext);
  // `applyDelta` rather than one `insert` per run: a single transformation, so one CRDT item per range instead of one per call.
  const delta = runsToDelta(bloc.runs);
  if (delta.length > 0) ytext.applyDelta(delta);
  ybloc.set('attrs', buildAttrs(bloc as unknown as Record<string, unknown>, PARAGRAPH_ATTRS));
  return ybloc;
}

function buildRow(row: TableRowNode): Y.Map<unknown> {
  const yrow = new Y.Map<unknown>();
  yrow.set('id', row.id);
  if (row.isHeader === true) yrow.set('isHeader', true);
  const ycells = new Y.Array<Y.Map<unknown>>();
  yrow.set('cells', ycells);
  ycells.push(row.cells.map(buildCell));
  return yrow;
}

function buildCell(cell: TableCellNode): Y.Map<unknown> {
  const ycell = new Y.Map<unknown>();
  ycell.set('id', cell.id);
  ycell.set('attrs', buildAttrs(cell as unknown as Record<string, unknown>, CELL_ATTRS));
  const yblocks = new Y.Array<Y.Map<unknown>>();
  ycell.set('blocks', yblocks);
  yblocks.push(cell.blocks.map(buildBlock));
  return ycell;
}

/* ------------------------------------------------------------------ seeding */

/**
 * Installs a document in an **empty** `Y.Doc`.
 *
 * Reserved for opening a share: the person sharing puts in what they have in front of them. On an already seeded document,
 * `reconcile` is the right door: seeding twice would duplicate all the content, since a CRDT never replaces, it adds.
 */
export function seed(ydoc: Y.Doc, document: WriterDocumentState, origin: unknown): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap<unknown>(META_ROOT);
    meta.set('title', document.meta.title);
    meta.set('author', document.meta.author);
    meta.set('createdAt', document.meta.createdAt);
    meta.set('updatedAt', document.meta.updatedAt);

    const setup = ydoc.getMap<unknown>(SETUP_ROOT);
    setup.set('id', document.id);
    setup.set('pageSetup', document.pageSetup);
    setup.set('defaults', document.defaults);
    setup.set('furniture', document.furniture ?? null);

    const yblocks = ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT);
    const blocs = document.blocks.length > 0 ? document.blocks : [emptyParagraph()];
    yblocks.push(blocs.map(buildBlock));
  }, origin);
}

/* --------------------------------------------------------- cursor carry-over */

/**
 * Where a cursor offset ends up after a remote change.
 *
 * Without this carry-over, writing above someone shifts their text under their cursor: they believe they are typing in one place
 * and the letters land elsewhere. The rule is that of `SwIndexReg`: an insertion **before** the point pushes it, an insertion after
 * does not concern it, and a deletion that encloses it brings it back to its start.
 */
export function remapOffset(
  offset: number,
  changement: { at: number; removed: number; inserted: string },
): number {
  const { at, removed, inserted } = changement;
  if (offset <= at) return offset;
  if (offset <= at + removed) return at + inserted.length;
  return offset - removed + inserted.length;
}

/** What `remapOffset` needs to know, extracted from a `Y.Text` event. */
export function changeOfTextEvent(event: Y.YTextEvent): {
  at: number;
  removed: number;
  inserted: string;
} | null {
  let at = 0;
  let removed = 0;
  let inserted = '';
  let touche = false;

  for (const op of event.delta as { retain?: number; delete?: number; insert?: string | object }[]) {
    if (typeof op.retain === 'number') {
      if (touche) break;
      at += op.retain;
      continue;
    }
    if (typeof op.delete === 'number') {
      removed += op.delete;
      touche = true;
      continue;
    }
    if (typeof op.insert === 'string') {
      inserted += op.insert;
      touche = true;
    }
  }

  return touche ? { at, removed, inserted } : null;
}

export type { Alignment, HeadingLevel, ListKind };
