// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Projection du modèle Writer dans un document répliqué Yjs.
 *
 * ## Pourquoi un CRDT, et plus un diff de blocs
 *
 * La version précédente comparait deux `WriterDocumentState` et en déduisait des
 * opérations de bloc (`replace-block`, `insert-block`…), qu'un serveur
 * séquenceur ordonnait. Le modèle converge — mais à la **granularité du bloc** :
 * deux personnes qui écrivent dans le même paragraphe produisent chacune un
 * `replace-block`, et le second efface le premier. Sur un paragraphe, c'est une
 * phrase perdue sans le moindre avertissement ; c'est exactement ce que l'on
 * observait.
 *
 * L'application Write n'a pas ce défaut parce qu'elle ne compare rien : son
 * document **est** un CRDT (Yjs), et deux insertions concurrentes dans la même
 * phrase fusionnent caractère par caractère. C'est cette couche-là qui est
 * reprise ici, sans ProseMirror — le moteur de texte reste le nôtre.
 *
 * ## La correspondance
 *
 * ```
 *  writer:meta    Y.Map      titre, auteur, dates            (registre par clé)
 *  writer:setup   Y.Map      pageSetup, defaults, furniture  (valeurs entières)
 *  writer:blocks  Y.Array    un Y.Map par bloc de premier niveau
 *      ├─ id, type          clés simples
 *      ├─ text   Y.Text     le texte du paragraphe ; le **formatage de
 *      │                    caractère est porté par les attributs de Y.Text**,
 *      │                    dont la représentation en delta est exactement une
 *      │                    liste de `TextRun` (`SwpHints` aplati)
 *      ├─ attrs  Y.Map      attributs de paragraphe (alignement, liste, retraits)
 *      └─ rows   Y.Array    tableaux : lignes → cellules → blocs, récursivement
 * ```
 *
 * `Y.Text` et `TextRun[]` disent la même chose : une suite de plages de texte
 * homogènes. La conversion est donc une bijection, et non une approximation —
 * c'est ce qui permet de garder le moteur de rendu intact.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
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

/* ------------------------------------------------------------------ schéma */

/**
 * Noms des racines partagées. Le serveur les connaît aussi
 * (`server/src/content.rs`) : il amorce un document et sait le relire en JSON.
 * Les changer d'un seul côté rendrait tous les partages existants illisibles.
 */
export const BLOCKS_ROOT = 'writer:blocks';
export const META_ROOT = 'writer:meta';
export const SETUP_ROOT = 'writer:setup';

/** Attributs de paragraphe répliqués, un par clé du `Y.Map` `attrs`. */
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
 * Attributs d'une table des matières.
 *
 * Un `TocNode` n'a **ni texte ni lignes** : il ne porte que sa définition, son
 * contenu étant régénéré à la pagination (cf. document/tox.ts). C'est ce qui le
 * rend trivial à répliquer — deux pairs qui modifient la profondeur d'un
 * sommaire ne peuvent pas produire de conflit de texte, seulement une dernière
 * valeur écrite qui gagne, ce qui est le bon comportement pour un réglage.
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
 * Identifiant du paragraphe de secours d'un document vide.
 *
 * Un document sans aucun bloc n'est pas représentable : le curseur n'aurait nulle
 * part où se poser. La valeur est **fixe** et non tirée au hasard, pour que deux
 * pairs qui ouvrent le même document vide ne fabriquent pas deux paragraphes
 * différents qu'il faudrait ensuite réconcilier.
 */
const EMPTY_BLOCK_ID = 'p-vide';

/* ------------------------------------------------- runs ⇄ delta de Y.Text */

interface DeltaOp {
  insert?: string | object;
  attributes?: Record<string, unknown> | undefined;
}

/** Attributs de `Y.Text` correspondant à un run, ou `undefined` s'il n'en a pas. */
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
 * Ne retient que les clés de formatage connues.
 *
 * Les attributs viennent du réseau : un pair d'une version ultérieure peut en
 * poser que ce moteur ne sait pas rendre. Les recopier tels quels dans un run
 * casserait `sameFormatting`, donc la fusion des plages voisines.
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

/** Delta Yjs → runs Writer, invariant de fusion rétabli (`MergePortions`). */
export function deltaToRuns(delta: readonly DeltaOp[]): TextRun[] {
  const runs: TextRun[] = [];
  for (const op of delta) {
    // Les insertions non textuelles (objets embarqués) n'existent pas dans ce
    // schéma : une image est un attribut de run, pas un nœud à part.
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
    runs.push(makeRun(op.insert, formattingFrom(op.attributes)));
  }
  return normalizeRuns(runs);
}

/** Runs Writer → delta Yjs. Les runs vides ne sont pas représentables. */
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
 * Ce qui a changé entre deux chaînes, exprimé comme **une** plage remplacée.
 *
 * La frappe, la suppression et le collage produisent tous exactement cela ; en
 * déduire une insertion et une suppression contiguës plutôt que de réécrire le
 * paragraphe entier est ce qui permet à deux personnes d'écrire dans la même
 * phrase sans s'effacer.
 *
 * Les bornes ne tombent jamais entre les deux moitiés d'une paire de substituts :
 * couper un emoji laisserait un demi-caractère dans le document répliqué.
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

/** Formatage à donner au texte inséré : celui de la plage qui l'accueille. */
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

/** Écart d'attributs à appliquer : `null` retire une clé, comme le veut `Y.Text`. */
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
 * Aligne un `Y.Text` sur une liste de runs, en ne touchant qu'au nécessaire.
 *
 * Deux passes, et l'ordre compte : le texte d'abord, le formatage ensuite. Une
 * plage de formatage s'exprime en positions, et les poser avant de déplacer le
 * texte les appliquerait à côté.
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

  // Le formatage se compare sur l'état **d'après** l'édition : les positions
  // d'avant ne désignent plus les mêmes caractères.
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

/* ------------------------------------------------------- lecture du document */

/**
 * Miroir en lecture du document répliqué.
 *
 * Il tient un cache par bloc : une frappe distante dans un paragraphe ne doit
 * pas reconstruire les quarante autres, ni casser leur identité d'objet — le
 * moteur de mise en page s'en sert pour ne repaginer que ce qui a bougé.
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

  /** Le document répliqué a-t-il déjà un contenu ? */
  get seeded(): boolean {
    return this.blocks.length > 0;
  }

  /**
   * Oublie ce qu'un événement a rendu faux.
   *
   * On remonte la chaîne des parents plutôt que d'interpréter `event.path` :
   * l'ascendance mène au `Y.Map` du bloc quel que soit son enfouissement — dans
   * une cellule d'un tableau, le chemin fait cinq niveaux.
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

  /** Vide entièrement le cache — après un `snapshot` ou un rattrapage massif. */
  reset(): void {
    // Un `WeakMap` ne se vide pas : on en prend un neuf.
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
      // Un document vide n'est pas représentable : le curseur n'aurait nulle
      // part où se poser.
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
 * Recopie les attributs connus d'un `Y.Map` sur un nœud.
 *
 * Les clés inconnues sont ignorées : elles viennent du réseau, et une version
 * ultérieure du modèle ne doit pas pouvoir injecter n'importe quoi dans un nœud
 * que le moteur croit typé.
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

/* ------------------------------------------------------ écriture du document */

/**
 * Aligne le document répliqué sur un état local, en ne touchant qu'au nécessaire.
 *
 * Ce n'est **pas** un remplacement : les paragraphes inchangés ne sont pas
 * réécrits, et un paragraphe modifié ne l'est qu'à l'endroit de la modification.
 * C'est cette économie qui fait converger deux frappes concurrentes au lieu de
 * les faire s'écraser.
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

  // 1. Ce qui a disparu s'en va d'abord, de la fin vers le début : supprimer en
  //    remontant laisse les index de gauche valides.
  for (let i = yblocks.length - 1; i >= 0; i -= 1) {
    const id = idOf(yblocks.get(i));
    if (id === null || !attendus.has(id)) yblocks.delete(i, 1);
  }

  // 2. Alignement position par position. Le cas courant — rien n'a bougé —
  //    ne coûte qu'une comparaison d'identifiant par bloc.
  for (let i = 0; i < next.length; i += 1) {
    const cible = next[i]!;
    const courant = i < yblocks.length ? yblocks.get(i) : undefined;

    if (courant && idOf(courant) === cible.id && sameKind(courant, cible)) {
      reconcileBlock(courant, cible);
      continue;
    }

    // Le bloc existe plus loin : il a été déplacé. Un `Y.Array` ne sait pas
    // déplacer un élément — on le retire et on le repose. Le déplacement reste
    // rare (glisser-déposer, opérations de tableau), contrairement à la frappe.
    const ailleurs = indexOfId(yblocks, cible.id, i);
    if (ailleurs >= 0) yblocks.delete(ailleurs, 1);
    yblocks.insert(i, [buildBlock(cible)]);
  }

  // 3. La queue : ce qu'un pair a inséré au-delà de ce que l'on connaît.
  if (yblocks.length > next.length) {
    yblocks.delete(next.length, yblocks.length - next.length);
  }
}

/**
 * Un paragraphe ne devient pas un tableau : changer de nature, c'est renaître.
 *
 * La comparaison se fait sur la **famille** du bloc — texte, tableau, sommaire —
 * et non sur son `type` exact : basculer `paragraph` en `heading` doit se
 * réconcilier sur place, sans détruire le `Y.Text` et donc l'historique
 * collaboratif du paragraphe.
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

  // `paragraph` ⇄ `heading` : un titre est un paragraphe avec un niveau, pas un
  // autre nœud. Basculer l'un en l'autre ne doit donc rien reconstruire.
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
  // `applyDelta` plutôt qu'un `insert` par run : une seule transformation, donc
  // un seul élément CRDT par plage au lieu d'un par appel.
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

/* ------------------------------------------------------------------ amorçage */

/**
 * Installe un document dans un `Y.Doc` **vide**.
 *
 * Réservé à l'ouverture d'un partage : celui qui partage y dépose ce qu'il a
 * sous les yeux. Sur un document déjà amorcé, `reconcile` est la bonne porte —
 * amorcer deux fois dupliquerait tout le contenu, un CRDT ne remplaçant jamais,
 * il ajoute.
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

/* --------------------------------------------------------- report du curseur */

/**
 * Où se retrouve un offset de curseur après une modification distante.
 *
 * Sans ce report, écrire au-dessus de quelqu'un lui décale son texte sous le
 * curseur : il croit taper à un endroit et les lettres tombent ailleurs. La
 * règle est celle de `SwIndexReg` — une insertion **avant** le point le pousse,
 * une insertion après ne le concerne pas, et une suppression qui l'englobe le
 * ramène à son début.
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

/** Ce que `remapOffset` a besoin de savoir, extrait d'un événement `Y.Text`. */
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
