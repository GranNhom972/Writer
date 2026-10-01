// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

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
import { hasCaption, imageKey, isImageRun } from './images';
import { makeRun, runsText } from './runs';
import {
  isParagraph,
  isTable,
  isToc,
  type DocumentBlock,
  type DocumentDefaults,
  type HeadingLevel,
  type ParagraphNode,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
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

/** Résultat de `paragraphIndex` — mémoïsé par document. */
export interface ParagraphIndex {
  order: string[];
  byId: Map<string, ParagraphLocation>;
}

/**
 * Index mémoïsé, une entrée par version du document.
 *
 * Un `WeakMap` et non une `Map` : la clé est l'état du document lui-même, et
 * chaque frappe en produit un nouveau. Une `Map` retiendrait indéfiniment tous
 * les états traversés depuis l'ouverture — l'historique complet du document en
 * mémoire. Le `WeakMap` laisse le ramasse-miettes reprendre chaque entrée dès
 * que plus personne ne tient l'état correspondant ; en pratique il ne reste
 * que l'état courant et ceux que la pile d'annulation retient encore.
 */
const indexParDocument = new WeakMap<WriterDocumentState, ParagraphIndex>();

/**
 * Index plat de tous les paragraphes, dans l'ordre de lecture.
 *
 * Construit à la demande plutôt que maintenu : le document est immuable, donc
 * un index conservé serait périmé dès la première frappe.
 *
 * Le résultat est en revanche **mémoïsé sur l'état du document**, et c'est
 * l'immuabilité qui rend ce cache exact : tant que l'objet `doc` est le même,
 * son index l'est aussi, sans invalidation à écrire. La correction compte —
 * l'index est reconstruit depuis près de quatre-vingts sites d'appel, dont
 * plusieurs sur le chemin de la frappe (`currentParagraph`, les statistiques,
 * la plupart des commandes d'édition), où le coût linéaire était payé
 * plusieurs fois par caractère saisi et non « une fois par transaction ».
 */
export function paragraphIndex(doc: WriterDocumentState): ParagraphIndex {
  const memoise = indexParDocument.get(doc);
  if (memoise) return memoise;

  const order: string[] = [];
  const byId = new Map<string, ParagraphLocation>();

  doc.blocks.forEach((block, blockIndex) => {
    // Un sommaire n'entre pas dans l'index : ses lignes n'existent qu'à la
    // pagination, et un curseur ne doit pas pouvoir s'y poser — comme dans
    // Writer, où le contenu d'un `SwTOXBase` est protégé en écriture.
    if (isToc(block)) return;

    if (isParagraph(block)) {
      order.push(block.id);
      byId.set(block.id, { paragraph: block, blockIndex });
      return;
    }
    if (!isTable(block)) return;
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

  const index: ParagraphIndex = { order, byId };
  indexParDocument.set(doc, index);
  return index;
}

/**
 * Numéro de figure de chaque image à numérotation automatique.
 *
 * Dérivé de l'**ordre de lecture** du document — cellules de tableau comprises,
 * puisque `paragraphIndex` les y range — et recalculé à chaque appel. C'est ce
 * qui rend la numérotation juste par construction : ajouter, supprimer ou
 * déplacer une image change l'ordre, donc les numéros, sans qu'aucun code n'ait
 * à renuméroter quoi que ce soit. Aucun doublon n'est possible, un compteur
 * unique attribuant les valeurs.
 *
 * Les images en mode **manuel** ne consomment pas de numéro : elles sont hors
 * séquence, comme un `SwSetExpField` que l'on aurait ôté de sa suite.
 *
 * La clé est `blockId:offset` — l'identité d'une image dans un document
 * immuable, valable le temps d'un rendu, qui part du même état.
 */
const figuresParDocument = new WeakMap<WriterDocumentState, Map<string, number>>();

/**
 * Dernière table de numéros produite, tous documents confondus.
 *
 * Sert à **canoniser** : une frappe produit un nouvel état de document, donc
 * une nouvelle table — de contenu identique dans l'immense majorité des cas,
 * puisque les numéros de figure ne bougent qu'à l'insertion ou au retrait d'une
 * image légendée. Rendre l'ancienne table quand la nouvelle lui est égale rend
 * son identité stable, et avec elle celle du contexte d'images transmis aux
 * paragraphes — sans quoi chaque frappe ferait échouer leur mémoïsation.
 */
let dernieresFigures: Map<string, number> | null = null;

function memesFigures(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [cle, valeur] of a) {
    if (b.get(cle) !== valeur) return false;
  }
  return true;
}

export function figureNumbering(doc: WriterDocumentState): Map<string, number> {
  const memoise = figuresParDocument.get(doc);
  if (memoise) return memoise;

  const numbers = new Map<string, number>();
  let counter = 0;

  const { order, byId } = paragraphIndex(doc);
  for (const id of order) {
    const paragraph = byId.get(id)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    for (const run of paragraph.runs) {
      if (isImageRun(run) && hasCaption(run) && run.imageCaptionManual !== true) {
        counter += 1;
        numbers.set(imageKey(id, offset), counter);
      }
      offset += run.text.length;
    }
  }

  const canonique =
    dernieresFigures && memesFigures(dernieresFigures, numbers) ? dernieresFigures : numbers;
  dernieresFigures = canonique;
  figuresParDocument.set(doc, canonique);
  return canonique;
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

/**
 * Insère une ligne dans un tableau, au-dessus ou au-dessous de `rowIndex`.
 * Transposition de `SwDoc::InsertRow`.
 */
export function insertTableRow(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
  position: 'above' | 'below',
): WriterDocumentState {
  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;
    const targetRow = block.rows[rowIndex] ?? block.rows[0];
    if (!targetRow) return block;

    // Les largeurs viennent de la **grille**, pas de la ligne modèle : celle-ci
    // peut porter une fusion, auquel cas ses `widthPercent` valent deux colonnes
    // pour l'une et rien pour l'autre. La nouvelle ligne, elle, est simple, et
    // ses bords doivent tomber sur ceux des lignes voisines.
    const columns = tableColumnWidths(block);
    const newCells: TableCellNode[] = targetRow.cells.map((cell, index) => ({
      id: newId('tc'),
      blocks: [createParagraph('')],
      widthPercent: columns[index] ?? 100 / Math.max(1, targetRow.cells.length),
      ...(cell.paddingPt !== undefined ? { paddingPt: cell.paddingPt } : {}),
      ...(cell.borderColor !== undefined ? { borderColor: cell.borderColor } : {}),
    }));

    const newRow: TableRowNode = {
      id: newId('tr'),
      cells: newCells,
    };

    const insertIndex = position === 'above' ? Math.max(0, rowIndex) : rowIndex + 1;
    const rows = [...block.rows];
    rows.splice(insertIndex, 0, newRow);
    return { ...block, rows };
  });

  return touch({ ...doc, blocks });
}

/**
 * Supprime une ligne d'un tableau.
 * Transposition de `SwDoc::DeleteRow`.
 */
export function deleteTableRow(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
): WriterDocumentState {
  let tableRemoved = false;
  const blocks: DocumentBlock[] = [];

  for (const block of doc.blocks) {
    if (!isTable(block) || block.id !== tableId) {
      blocks.push(block);
      continue;
    }
    if (block.rows.length <= 1) {
      tableRemoved = true;
      continue;
    }
    const rows = block.rows.filter((_, idx) => idx !== rowIndex);
    blocks.push({ ...block, rows });
  }

  if (tableRemoved && !blocks.some((b) => !isTable(b))) {
    blocks.push(createParagraph(''));
  }

  return touch({ ...doc, blocks });
}

/**
 * Insère une colonne dans un tableau, à gauche ou à droite de `colIndex`.
 * Transposition de `SwDoc::InsertCol`.
 */
export function insertTableColumn(
  doc: WriterDocumentState,
  tableId: string,
  colIndex: number,
  position: 'left' | 'right',
): WriterDocumentState {
  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;
    if (block.rows.length === 0) return block;

    const oldCols = Math.max(1, block.rows[0]?.cells.length ?? 1);
    const newCols = oldCols + 1;

    // La nouvelle colonne prend la part d'une colonne moyenne, et les
    // anciennes se resserrent **proportionnellement** pour lui faire place.
    // Les réinitialiser toutes à `100 / newCols` effacerait les largeurs du
    // document importé comme celles réglées à la souris : ajouter une colonne
    // ne doit pas être une remise à plat de la grille.
    const share = 100 / newCols;
    const shrink = (100 - share) / 100;

    const rows = block.rows.map((row) => {
      const insertAt = position === 'left' ? Math.max(0, colIndex) : colIndex + 1;
      const fallback = 100 / Math.max(1, row.cells.length);
      const newCell: TableCellNode = {
        id: newId('tc'),
        blocks: [createParagraph('')],
        widthPercent: share,
      };
      const cells: TableCellNode[] = row.cells.map((c) => ({
        ...c,
        widthPercent: (c.widthPercent ?? fallback) * shrink,
      }));
      cells.splice(insertAt, 0, newCell);
      return { ...row, cells };
    });

    return { ...block, rows };
  });

  return touch({ ...doc, blocks });
}

/**
 * Supprime une colonne d'un tableau.
 * Transposition de `SwDoc::DeleteCol`.
 */
export function deleteTableColumn(
  doc: WriterDocumentState,
  tableId: string,
  colIndex: number,
): WriterDocumentState {
  let tableRemoved = false;
  const blocks: DocumentBlock[] = [];

  for (const block of doc.blocks) {
    if (!isTable(block) || block.id !== tableId) {
      blocks.push(block);
      continue;
    }
    const firstRow = block.rows[0];
    if (!firstRow || firstRow.cells.length <= 1) {
      tableRemoved = true;
      continue;
    }

    const rows = block.rows.map((row) => {
      const fallback = 100 / Math.max(1, row.cells.length);
      const cells = row.cells.filter((_, idx) => idx !== colIndex);
      // La largeur libérée se redistribue **au prorata** sur les colonnes qui
      // restent, plutôt que de les égaliser : supprimer une colonne étroite ne
      // doit pas défaire la mise en page des autres.
      const total = cells.reduce((sum, c) => sum + (c.widthPercent ?? fallback), 0);
      const scale = total > 0 ? 100 / total : 1;
      return {
        ...row,
        cells: cells.map((c) => ({ ...c, widthPercent: (c.widthPercent ?? fallback) * scale })),
      };
    });

    blocks.push({ ...block, rows });
  }

  if (tableRemoved && !blocks.some((b) => !isTable(b))) {
    blocks.push(createParagraph(''));
  }

  return touch({ ...doc, blocks });
}

/* ------------------------------------------------- fusion et scission de cellules */

/**
 * Rectangle de cellules, exprimé en indices de ligne et de colonne.
 *
 * Les colonnes sont comptées en **colonnes de grille** et non en positions dans
 * `row.cells` : ces deux repères divergent dès qu'une fusion a eu lieu, et
 * confondre les deux est la source d'erreur classique de tout code de tableau.
 */
export interface CellRect {
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
}

/**
 * Colonne de grille où commence chaque cellule d'une ligne.
 *
 * ## L'invariant de grille, et pourquoi il tient
 *
 * Une fusion **conserve** les cellules absorbées sous forme de porteuses du
 * drapeau `covered` (cf. `mergeTableCells`, transposition de `SwDoc::MergeTbl`).
 * Chaque cellule du tableau — recouverte ou non — occupe donc exactement une
 * colonne de grille, et `row.cells[i]` est la colonne `i`.
 *
 * `colSpan` ne sert alors qu'à la **largeur** peinte, jamais à l'arithmétique
 * de grille. Compter les `colSpan` ici doublerait chaque colonne fusionnée :
 * une fois pour la maîtresse, une fois pour sa porteuse.
 *
 * La fonction existe malgré sa simplicité parce que c'est le seul endroit où
 * cet invariant est énoncé : tout code de tableau qui a besoin d'une colonne
 * passe par elle, et la lit du même coup.
 */
export function gridColumnsOf(row: TableRowNode): number[] {
  return row.cells.map((_, index) => index);
}

/** Nombre de colonnes de grille du tableau — la plus large de ses lignes. */
export function tableColumnCount(table: TableNode): number {
  let max = 0;
  for (const row of table.rows) max = Math.max(max, row.cells.length);
  return max;
}

/**
 * Largeur de chaque **colonne de grille**, en pourcentage, normalisée à 100.
 *
 * Une largeur est portée par les cellules, mais appartient à la colonne : dans
 * Writer, c'est `SwTable::GetTabCols` qui fait foi, pas la boîte individuelle.
 * Les cellules fusionnées n'en disent rien d'utile — une maîtresse de `colSpan`
 * 2 mesure deux colonnes, une recouverte n'en mesure aucune — donc seules les
 * cellules simples renseignent leur colonne, et le reste retombe sur la part
 * égale. La normalisation finale garantit l'invariant dont dépend le rendu :
 * la somme des colonnes fait la largeur du tableau, jamais 97 % ni 103 %.
 */
export function tableColumnWidths(table: TableNode): number[] {
  const count = Math.max(1, tableColumnCount(table));
  const even = 100 / count;
  const widths = new Array<number>(count).fill(NaN);

  for (const row of table.rows) {
    row.cells.forEach((cell, index) => {
      if (index >= count) return;
      // Une maîtresse de fusion mesure plusieurs colonnes : sa largeur ne dit
      // rien de la sienne propre. Une cellule **recouverte**, en revanche, a
      // conservé celle de sa colonne au moment de la fusion — c'est par elle
      // que les largeurs survivent à un `MergeTbl`, et donc que la scission
      // peut les rendre.
      if ((cell.colSpan ?? 1) > 1) return;
      if (cell.widthPercent === undefined) return;
      if (!Number.isNaN(widths[index]!)) return;
      widths[index] = cell.widthPercent;
    });
  }

  const resolved = widths.map((w) => (Number.isNaN(w) || w <= 0 ? even : w));
  const total = resolved.reduce((sum, w) => sum + w, 0);
  return total > 0 ? resolved.map((w) => (w * 100) / total) : resolved;
}

/**
 * Réécrit les largeurs de colonne d'un tableau (`SwTable::SetTabCols`).
 *
 * Une cellule fusionnée reçoit la **somme** des colonnes qu'elle couvre : c'est
 * ce qui maintient l'alignement de ses bords avec ceux des lignes voisines
 * quand l'utilisateur tire une poignée.
 */
export function setTableColumnWidths(
  doc: WriterDocumentState,
  tableId: string,
  widths: number[],
): WriterDocumentState {
  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;

    const total = widths.reduce((sum, w) => sum + w, 0);
    if (total <= 0) return block;
    const normalized = widths.map((w) => (Math.max(0, w) * 100) / total);

    const rows = block.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell, index) => {
        const span = Math.max(1, cell.colSpan ?? 1);
        let width = 0;
        for (let i = index; i < index + span; i += 1) width += normalized[i] ?? 0;
        return { ...cell, widthPercent: width };
      }),
    }));

    return { ...block, rows };
  });

  return touch({ ...doc, blocks });
}

/** Supprime un tableau entier, et le remplace par un paragraphe s'il était seul. */
export function deleteTable(doc: WriterDocumentState, tableId: string): WriterDocumentState {
  const blocks = doc.blocks.filter((block) => !(isTable(block) && block.id === tableId));
  if (blocks.length === doc.blocks.length) return doc;
  // Un document sans aucun nœud de texte n'a nulle part où poser un curseur :
  // `SwDoc` garde toujours au moins un `SwTxtNode`, on fait de même.
  if (!blocks.some((block) => !isTable(block))) blocks.push(createParagraph(''));
  return touch({ ...doc, blocks });
}

/**
 * Index dans `row.cells` de la cellule occupant une colonne de grille donnée.
 *
 * Identité, par l'invariant de `gridColumnsOf` — la fonction nomme l'intention
 * plutôt que de laisser un `row.cells[column]` nu dont rien ne dirait pourquoi
 * il est correct.
 */
function cellIndexAtColumn(row: TableRowNode, column: number): number {
  return column >= 0 && column < row.cells.length ? column : -1;
}

/**
 * Fusionne un rectangle de cellules. Transposition de `SwDoc::MergeTbl`
 * (`sw/source/core/doc/tblrwcl.cxx`).
 *
 * Writer ne **supprime** pas les cellules absorbées : il les marque
 * « recouvertes » (`SwTableBox` de `RowSpan` négatif, swtable.hxx:475) et les
 * conserve dans leur ligne. La grille reste ainsi rectangulaire, ce dont
 * dépendent la navigation au curseur, l'insertion ultérieure d'une colonne et
 * la scission. On transpose ce choix avec le drapeau `covered`.
 *
 * Le contenu des cellules absorbées est **concaténé** dans la cellule maîtresse,
 * comme le fait `SwDoc::MergeTbl` : fusionner ne doit jamais perdre du texte.
 */
export function mergeTableCells(
  doc: WriterDocumentState,
  tableId: string,
  rect: CellRect,
): WriterDocumentState {
  const fromRow = Math.max(0, Math.min(rect.fromRow, rect.toRow));
  const toRow = Math.max(rect.fromRow, rect.toRow);
  const fromCol = Math.max(0, Math.min(rect.fromCol, rect.toCol));
  const toCol = Math.max(rect.fromCol, rect.toCol);

  // Un rectangle d'une seule cellule n'a rien à fusionner.
  if (fromRow === toRow && fromCol === toCol) return doc;

  let changed = false;

  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;
    if (fromRow >= block.rows.length) return block;

    const lastRow = Math.min(toRow, block.rows.length - 1);
    const masterRow = block.rows[fromRow];
    if (!masterRow) return block;

    const masterIndex = cellIndexAtColumn(masterRow, fromCol);
    if (masterIndex < 0) return block;

    /*
     * Largeur de la cellule maîtresse : la **somme** des colonnes absorbées.
     *
     * `colSpan` ne suffit pas. Le moteur lit `widthPercent` en priorité
     * (`measureRow`), et la maîtresse gardait la sienne : une fusion de trois
     * colonnes produisait un cadre large d'une seule, et la zone libérée
     * restait béante à sa droite. C'est aussi la convention qu'applique
     * `setTableColumnWidths` quand on tire une poignée — les deux chemins
     * doivent écrire la même chose.
     */
    const columns = tableColumnWidths(block);
    let mergedWidth = 0;
    for (let c = fromCol; c <= toCol; c += 1) mergedWidth += columns[c] ?? 0;

    // Contenu absorbé, dans l'ordre de lecture : ligne par ligne, colonne par
    // colonne. Les paragraphes vides sont écartés — une fusion de six cellules
    // vides ne doit pas produire six lignes blanches.
    const absorbed: ParagraphNode[] = [];
    for (let r = fromRow; r <= lastRow; r += 1) {
      const row = block.rows[r];
      if (!row) continue;
      const starts = gridColumnsOf(row);
      row.cells.forEach((cell, index) => {
        const start = starts[index] ?? 0;
        if (start < fromCol || start > toCol) return;
        if (r === fromRow && index === masterIndex) return;
        if (cell.covered) return;
        for (const paragraph of cell.blocks) {
          if (runsText(paragraph.runs).trim().length > 0) absorbed.push(paragraph);
        }
      });
    }

    const rows = block.rows.map((row, r) => {
      if (r < fromRow || r > lastRow) return row;
      const starts = gridColumnsOf(row);

      const cells = row.cells.map((cell, index) => {
        const start = starts[index] ?? 0;
        if (start < fromCol || start > toCol) return cell;

        if (r === fromRow && index === masterIndex) {
          changed = true;
          const merged: TableCellNode = {
            ...cell,
            colSpan: toCol - fromCol + 1,
            rowSpan: lastRow - fromRow + 1,
            widthPercent: mergedWidth,
            blocks: [...cell.blocks, ...absorbed],
          };
          delete merged.covered;
          return merged;
        }

        changed = true;
        // La cellule recouverte garde son identité et un paragraphe vide : le
        // curseur ne s'y rendra plus, mais une scission ultérieure la retrouve.
        const covered: TableCellNode = {
          ...cell,
          covered: true,
          blocks: [createParagraph('')],
        };
        delete covered.colSpan;
        delete covered.rowSpan;
        return covered;
      });

      return { ...row, cells };
    });

    return { ...block, rows };
  });

  return changed ? touch({ ...doc, blocks }) : doc;
}

/**
 * Scinde une cellule fusionnée, ou une cellule simple, en `count` parts.
 * Transposition de `SwDoc::SplitTbl` (`tblrwcl.cxx`).
 *
 * Scinder une cellule **fusionnée** revient à rendre leur autonomie aux
 * cellules recouvertes : aucune cellule n'est créée, on retire seulement le
 * drapeau. Scinder une cellule **simple** en demande de nouvelles.
 *
 * Le contenu reste dans la première part, comme dans Writer : le répartir
 * demanderait de deviner où l'utilisateur voulait couper.
 */
export function splitTableCell(
  doc: WriterDocumentState,
  tableId: string,
  rowIndex: number,
  cellIndex: number,
  direction: 'horizontal' | 'vertical',
  count = 2,
): WriterDocumentState {
  const parts = Math.max(2, Math.floor(count));
  let changed = false;

  const blocks = doc.blocks.map((block): DocumentBlock => {
    if (!isTable(block) || block.id !== tableId) return block;

    const row = block.rows[rowIndex];
    const cell = row?.cells[cellIndex];
    if (!row || !cell) return block;

    const colSpan = Math.max(1, cell.colSpan ?? 1);
    const rowSpan = Math.max(1, cell.rowSpan ?? 1);
    const isMerged = colSpan > 1 || rowSpan > 1;

    if (isMerged) {
      changed = true;
      const startColumn = gridColumnsOf(row)[cellIndex] ?? 0;
      const endColumn = startColumn + colSpan - 1;
      const lastRow = Math.min(rowIndex + rowSpan - 1, block.rows.length - 1);

      /*
       * Rendre à la maîtresse la largeur de **sa** colonne, et non celle de
       * toutes celles qu'elle couvrait.
       *
       * La fusion lui donne la somme des colonnes absorbées ; sans cette
       * restitution, elle gardait ce total après scission. Redevenue simple aux
       * yeux de `tableColumnWidths`, elle imposait alors sa largeur à sa seule
       * colonne, et la normalisation écrasait toutes les autres : scinder une
       * cellule fusionnée sur trois colonnes faisait passer une grille
       * régulière à 60 / 20 / 20. Une opération locale ne doit pas redessiner
       * le tableau entier.
       */
      const columns = tableColumnWidths(block);

      const rows = block.rows.map((current, r) => {
        if (r < rowIndex || r > lastRow) return current;
        const starts = gridColumnsOf(current);
        const cells = current.cells.map((candidate, index) => {
          const start = starts[index] ?? 0;

          if (r === rowIndex && index === cellIndex) {
            const restored: TableCellNode = { ...candidate };
            delete restored.colSpan;
            delete restored.rowSpan;
            const own = columns[start];
            if (own !== undefined) restored.widthPercent = own;
            return restored;
          }

          if (start < startColumn || start > endColumn) return candidate;
          if (!candidate.covered) return candidate;
          const freed: TableCellNode = { ...candidate };
          delete freed.covered;
          const own = columns[start];
          if (own !== undefined) freed.widthPercent = own;
          return freed;
        });
        return { ...current, cells };
      });

      return { ...block, rows };
    }

    changed = true;

    if (direction === 'horizontal') {
      // Scission verticale du trait : la largeur de la cellule se partage entre
      // les parts, les autres colonnes ne bougent pas.
      const shareWidth = (cell.widthPercent ?? 100 / Math.max(1, row.cells.length)) / parts;
      const rows = block.rows.map((current, r) => {
        if (r !== rowIndex) {
          // Les autres lignes gagnent autant de colonnes que la scission en
          // crée. Elles reçoivent des **porteuses recouvertes** et non un
          // `colSpan` étendu : sans elles, `row.cells[i]` cesserait d'être la
          // colonne `i`, et tout le calcul de grille tomberait (cf.
          // `gridColumnsOf`).
          const target = current.cells[cellIndex];
          if (!target) return current;

          const porteuses: TableCellNode[] = Array.from({ length: parts - 1 }, () => ({
            id: newId('tc'),
            blocks: [createParagraph('')],
            covered: true,
          }));

          const cells = current.cells.map((candidate, index) =>
            index === cellIndex
              ? { ...candidate, colSpan: Math.max(1, candidate.colSpan ?? 1) + parts - 1 }
              : candidate,
          );
          cells.splice(cellIndex + 1, 0, ...porteuses);
          return { ...current, cells };
        }

        const replacements: TableCellNode[] = [{ ...cell, widthPercent: shareWidth }];
        for (let i = 1; i < parts; i += 1) {
          replacements.push({
            id: newId('tc'),
            blocks: [createParagraph('')],
            widthPercent: shareWidth,
            ...(cell.paddingPt !== undefined ? { paddingPt: cell.paddingPt } : {}),
            ...(cell.borderColor !== undefined ? { borderColor: cell.borderColor } : {}),
          });
        }

        const cells = [...current.cells];
        cells.splice(cellIndex, 1, ...replacements);
        return { ...current, cells };
      });

      return { ...block, rows };
    }

    // Scission horizontale du trait : de nouvelles lignes s'intercalent, et
    // toutes les autres cellules de la ligne d'origine s'étendent vers le bas
    // pour ne pas laisser de trous.
    const newRows: TableRowNode[] = [];
    for (let i = 1; i < parts; i += 1) {
      newRows.push({
        id: newId('tr'),
        cells: row.cells.map((candidate, index) => {
          if (index === cellIndex) {
            return {
              id: newId('tc'),
              blocks: [createParagraph('')],
              ...(candidate.widthPercent !== undefined
                ? { widthPercent: candidate.widthPercent }
                : {}),
              ...(candidate.paddingPt !== undefined ? { paddingPt: candidate.paddingPt } : {}),
            };
          }
          return {
            id: newId('tc'),
            blocks: [createParagraph('')],
            covered: true,
            ...(candidate.widthPercent !== undefined
              ? { widthPercent: candidate.widthPercent }
              : {}),
          };
        }),
      });
    }

    const rows = block.rows.map((current, r) => {
      if (r !== rowIndex) return current;
      const cells = current.cells.map((candidate, index) =>
        index === cellIndex ? candidate : { ...candidate, rowSpan: parts },
      );
      return { ...current, cells };
    });
    rows.splice(rowIndex + 1, 0, ...newRows);

    return { ...block, rows };
  });

  return changed ? touch({ ...doc, blocks }) : doc;
}
