/**
 * Construction et parcours du document. Transposition de `SwDoc` / `SwNodes`.
 *
 * `SwNodes` est un **tableau ordonné** : c'est cet ordre, et non la hiérarchie,
 * qui définit « le paragraphe suivant ». Les cellules d'un tableau contiennent
 * elles-mêmes des nœuds de texte (`SwTableBox` → `SwStartNode` → `SwTxtNode`),
 * si bien qu'un curseur traverse un tableau sans cas particulier. On reproduit
 * cette propriété avec un index plat de tous les paragraphes, cellules comprises.
 */

import { A4_PORTRAIT } from './pageSetup';
import { makeRun, runsText } from './runs';
import {
  isTable,
  type DocumentBlock,
  type DocumentDefaults,
  type HeadingLevel,
  type ParagraphNode,
  type TableCellNode,
  type TableNode,
  type WriterDocumentState,
} from './types';

let idCounter = 0;

/** Identifiant unique de nœud. Équivalent du `SwNodeIndex` stable de Writer. */
export function newId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Remet le compteur à zéro — réservé aux tests, pour des identifiants stables. */
export function resetIdCounter(): void {
  idCounter = 0;
}

export const DEFAULT_DEFAULTS: DocumentDefaults = {
  fontFamily: 'Liberation Serif, Georgia, Times New Roman, serif',
  fontSizePt: 12,
  lineSpacing: 1.15,
  color: '#16191d',
};

export interface ParagraphOptions {
  id?: string;
  headingLevel?: HeadingLevel;
  alignment?: ParagraphNode['alignment'];
  lineSpacing?: number;
  runs?: ParagraphNode['runs'];
}

/** Crée un paragraphe (ou un titre si `headingLevel` est fourni). */
export function createParagraph(text = '', options: ParagraphOptions = {}): ParagraphNode {
  const node: ParagraphNode = {
    id: options.id ?? newId('p'),
    type: options.headingLevel ? 'heading' : 'paragraph',
    runs: options.runs ?? [makeRun(text)],
  };
  if (options.headingLevel !== undefined) node.headingLevel = options.headingLevel;
  if (options.alignment !== undefined) node.alignment = options.alignment;
  if (options.lineSpacing !== undefined) node.lineSpacing = options.lineSpacing;
  return node;
}

/** Crée un tableau vide de `rows` × `cols`, chaque cellule portant un paragraphe. */
export function createTable(rows: number, cols: number): TableNode {
  const widthPercent = 100 / Math.max(1, cols);
  return {
    id: newId('t'),
    type: 'table',
    rows: Array.from({ length: Math.max(1, rows) }, () => ({
      id: newId('tr'),
      cells: Array.from({ length: Math.max(1, cols) }, (): TableCellNode => ({
        id: newId('tc'),
        blocks: [createParagraph('')],
        widthPercent,
      })),
    })),
  };
}

export function createEmptyDocument(title = 'Document sans titre'): WriterDocumentState {
  const now = new Date().toISOString();
  return {
    id: newId('doc'),
    meta: { title, author: '', createdAt: now, updatedAt: now },
    pageSetup: { ...A4_PORTRAIT },
    defaults: { ...DEFAULT_DEFAULTS },
    blocks: [createParagraph('')],
  };
}

/** Où vit un paragraphe : au fil du document, ou dans une cellule. */
export interface ParagraphLocation {
  paragraph: ParagraphNode;
  /** Index du bloc de premier niveau. */
  blockIndex: number;
  /** Chemin dans le tableau, si le paragraphe est dans une cellule. */
  cell?: { rowIndex: number; cellIndex: number; innerIndex: number };
}

/**
 * Index plat de tous les paragraphes, dans l'ordre de lecture.
 *
 * Construit à la demande plutôt que maintenu : le document est immuable, donc
 * un index conservé serait périmé dès la première frappe. Le coût est linéaire
 * et n'est payé qu'une fois par transaction.
 */
export function paragraphIndex(doc: WriterDocumentState): {
  order: string[];
  byId: Map<string, ParagraphLocation>;
} {
  const order: string[] = [];
  const byId = new Map<string, ParagraphLocation>();

  doc.blocks.forEach((block, blockIndex) => {
    if (!isTable(block)) {
      order.push(block.id);
      byId.set(block.id, { paragraph: block, blockIndex });
      return;
    }
    block.rows.forEach((row, rowIndex) => {
      row.cells.forEach((cell, cellIndex) => {
        cell.blocks.forEach((inner, innerIndex) => {
          order.push(inner.id);
          byId.set(inner.id, {
            paragraph: inner,
            blockIndex,
            cell: { rowIndex, cellIndex, innerIndex },
          });
        });
      });
    });
  });

  return { order, byId };
}

export function findParagraph(
  doc: WriterDocumentState,
  blockId: string,
): ParagraphNode | null {
  return paragraphIndex(doc).byId.get(blockId)?.paragraph ?? null;
}

/** Texte brut d'un paragraphe — la chaîne qu'indexent les offsets de curseur. */
export function paragraphText(paragraph: ParagraphNode): string {
  return runsText(paragraph.runs);
}

/**
 * Remplace un paragraphe partout où il se trouve, y compris dans une cellule.
 *
 * Le remplacement recopie uniquement le chemin touché : les blocs voisins
 * gardent leur identité de référence, ce qui laisse React ne re-rendre que ce
 * qui a réellement changé.
 */
export function replaceParagraph(
  doc: WriterDocumentState,
  blockId: string,
  next: ParagraphNode,
): WriterDocumentState {
  let changed = false;

  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block)) {
      if (block.id !== blockId) return block;
      changed = true;
      return next;
    }
    let rowsChanged = false;
    const rows = block.rows.map((row) => {
      let cellsChanged = false;
      const cells = row.cells.map((cell) => {
        if (!cell.blocks.some((inner) => inner.id === blockId)) return cell;
        cellsChanged = true;
        return {
          ...cell,
          blocks: cell.blocks.map((inner) => (inner.id === blockId ? next : inner)),
        };
      });
      if (!cellsChanged) return row;
      rowsChanged = true;
      return { ...row, cells };
    });
    if (!rowsChanged) return block;
    changed = true;
    return { ...block, rows };
  });

  return changed ? touch({ ...doc, blocks }) : doc;
}

/** Horodate la dernière modification (`SwDocShell::SetModified`). */
export function touch(doc: WriterDocumentState): WriterDocumentState {
  return { ...doc, meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

/** Identifiant du paragraphe suivant dans l'ordre de lecture, ou `null`. */
export function nextParagraphId(
  doc: WriterDocumentState,
  blockId: string,
): string | null {
  const { order } = paragraphIndex(doc);
  const at = order.indexOf(blockId);
  return at >= 0 && at + 1 < order.length ? order[at + 1]! : null;
}

export function previousParagraphId(
  doc: WriterDocumentState,
  blockId: string,
): string | null {
  const { order } = paragraphIndex(doc);
  const at = order.indexOf(blockId);
  return at > 0 ? order[at - 1]! : null;
}

/* ------------------------------------------------- manipulation structurelle */

/**
 * Conteneur d'un paragraphe : le fil du document, ou une cellule.
 *
 * Writer interdit de fusionner deux nœuds de texte séparés par une frontière de
 * tableau (`SwNodes::_MoveNodes` refuse de traverser un `SwStartNode`). La clé
 * de conteneur sert exactement à cela : deux paragraphes de conteneurs
 * différents ne se rejoignent jamais.
 */
export const ROOT_CONTAINER = 'root';

export function containerKeyOf(doc: WriterDocumentState, blockId: string): string | null {
  const location = paragraphIndex(doc).byId.get(blockId);
  if (!location) return null;
  if (!location.cell) return ROOT_CONTAINER;
  const block = doc.blocks[location.blockIndex];
  if (!block || !isTable(block)) return ROOT_CONTAINER;
  return block.rows[location.cell.rowIndex]?.cells[location.cell.cellIndex]?.id ?? ROOT_CONTAINER;
}

/**
 * Retire des blocs du document, par identifiant.
 *
 * Accepte aussi bien des paragraphes que des tableaux : une sélection qui
 * enjambe un tableau l'emporte avec elle, comme dans Writer — laisser derrière
 * soi un tableau vidé de son texte ne correspondrait à aucune intention.
 *
 * Un conteneur ne peut pas rester vide : Writer garde toujours un `SwTxtNode`
 * dans une cellule et dans le corps, faute de quoi le curseur n'aurait plus
 * nulle part où se poser. On réinstalle donc un paragraphe vide si besoin.
 */
export function removeBlocks(
  doc: WriterDocumentState,
  ids: ReadonlySet<string>,
): WriterDocumentState {
  if (ids.size === 0) return doc;

  const blocks: DocumentBlock[] = [];
  for (const block of doc.blocks) {
    if (!isTable(block)) {
      if (!ids.has(block.id)) blocks.push(block);
      continue;
    }
    if (ids.has(block.id)) continue;
    blocks.push({
      ...block,
      rows: block.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => {
          const kept = cell.blocks.filter((inner) => !ids.has(inner.id));
          return { ...cell, blocks: kept.length > 0 ? kept : [createParagraph('')] };
        }),
      })),
    });
  }

  if (!blocks.some((block) => !isTable(block))) blocks.push(createParagraph(''));
  return touch({ ...doc, blocks });
}

/** Insère un paragraphe juste après un autre, dans le même conteneur. */
export function insertParagraphAfter(
  doc: WriterDocumentState,
  afterId: string,
  node: ParagraphNode,
): WriterDocumentState {
  const location = paragraphIndex(doc).byId.get(afterId);
  if (!location) return doc;

  if (!location.cell) {
    const blocks = [...doc.blocks];
    blocks.splice(location.blockIndex + 1, 0, node);
    return touch({ ...doc, blocks });
  }

  const { rowIndex, cellIndex, innerIndex } = location.cell;
  const blocks = doc.blocks.map((block, index) => {
    if (index !== location.blockIndex || !isTable(block)) return block;
    return {
      ...block,
      rows: block.rows.map((row, r) => {
        if (r !== rowIndex) return row;
        return {
          ...row,
          cells: row.cells.map((cell, c) => {
            if (c !== cellIndex) return cell;
            const inner = [...cell.blocks];
            inner.splice(innerIndex + 1, 0, node);
            return { ...cell, blocks: inner };
          }),
        };
      }),
    };
  });

  return touch({ ...doc, blocks });
}

/** Insère un bloc de premier niveau (tableau, paragraphe) après un paragraphe. */
export function insertBlockAfter(
  doc: WriterDocumentState,
  afterId: string,
  block: DocumentBlock,
): WriterDocumentState {
  const location = paragraphIndex(doc).byId.get(afterId);
  // Un tableau ne s'imbrique pas dans une cellule ici : Writer le permet, mais
  // la mise en page imbriquée n'est pas traitée (cf. README).
  const at = location && !location.cell ? location.blockIndex + 1 : doc.blocks.length;
  const blocks = [...doc.blocks];
  blocks.splice(at, 0, block);
  return touch({ ...doc, blocks });
}
