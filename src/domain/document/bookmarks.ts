/**
 * Signets et renvois internes. Transposition de `SwBookmark` / `IDocumentMarkAccess`
 * (`sw/source/core/doc/docbm.cxx`, `sw/inc/bookmrk.hxx`).
 *
 * Un signet de Writer est un **repère de position**, pas un nœud : `MarkBase`
 * tient un `SwPosition` de début et, pour un signet de plage, un `SwPosition`
 * de fin. Le repère est mis à jour par le moteur à chaque édition, ce qui lui
 * permet de suivre son texte.
 *
 * On obtient le même comportement sans machinerie de mise à jour : le nom du
 * signet est un **attribut de run**, il voyage donc avec le texte par
 * construction. Une insertion au milieu d'un signet l'étend, une suppression le
 * raccourcit, et l'effacement complet du texte ancré le fait disparaître — les
 * trois comportements de `docbm.cxx` sans une ligne de code de maintenance.
 *
 * La contrepartie assumée : deux signets ne peuvent pas se chevaucher sur un
 * même run, car `bookmarkName` est scalaire (cf. l'invariant `sameFormatting`
 * documenté dans types.ts). L'interface de Writer ne permet pas non plus de
 * créer un tel chevauchement.
 *
 * Module pur : aucun import de React, aucun accès au DOM.
 */

import { paragraphIndex, replaceParagraph, touch } from './document';
import { makeRun, mapRunsInRange, normalizeRuns, runFormatting } from './runs';
import { isParagraph, type HeadingLevel, type TextRun, type WriterDocumentState } from './types';

/** Un signet posé dans le document. */
export interface Bookmark {
  /** Nom unique, celui que vise un lien `#nom` (`::sw::mark::MarkBase::GetName`). */
  name: string;
  blockId: string;
  /** Offsets dans la chaîne brute du paragraphe. Égaux pour un signet ponctuel. */
  startOffset: number;
  endOffset: number;
  /** Texte couvert, vide pour un signet ponctuel. */
  text: string;
}

/** Cible atteignable par un renvoi interne : signet **ou** titre. */
export interface LinkTarget {
  kind: 'bookmark' | 'heading';
  name: string;
  blockId: string;
  /** Libellé affichable — le nom du signet, ou le texte du titre. */
  label: string;
  headingLevel?: HeadingLevel;
}

/**
 * Caractères refusés dans un nom de signet : contrôles et délimiteurs XML.
 *
 * Construit par `new RegExp` à partir d'échappements : un intervalle de
 * caractères de contrôle écrit littéralement dans le source serait invisible à
 * la relecture, et une relecture qui ne voit pas ce qu'elle valide ne vaut rien.
 */
const INVALID_BOOKMARK_CHARS = new RegExp('[\\u0000-\\u001F\\u007F"\'<>&]', 'g');

/**
 * Normalise un nom de signet.
 *
 * ODF impose un nom non vide et l'utilise tel quel dans `text:name` ; les
 * espaces y sont légales mais rendent les renvois `#nom` fragiles une fois
 * l'ODT converti. On applique donc la même normalisation que Writer à l'export
 * HTML : espaces en tirets bas, caractères de contrôle retirés.
 */
export function normalizeBookmarkName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '_')
    .replace(INVALID_BOOKMARK_CHARS, '')
    .slice(0, 120);
}

/* ----------------------------------------------------------------- lecture */

/** Tous les signets, dans l'ordre du flux. */
export function listBookmarks(doc: WriterDocumentState): Bookmark[] {
  const out: Bookmark[] = [];
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;

    let offset = 0;
    let open: { name: string; start: number; text: string } | null = null;

    for (const run of paragraph.runs) {
      const name = run.bookmarkName;
      if (open && open.name !== name) {
        out.push({
          name: open.name,
          blockId,
          startOffset: open.start,
          endOffset: offset,
          text: open.text,
        });
        open = null;
      }
      if (name) {
        if (open) open.text += run.text;
        else open = { name, start: offset, text: run.text };
      }
      offset += run.text.length;
    }

    if (open) {
      out.push({
        name: open.name,
        blockId,
        startOffset: open.start,
        endOffset: offset,
        text: open.text,
      });
    }
  }

  return out;
}

/** Retrouve un signet par son nom, ou `null`. */
export function findBookmark(doc: WriterDocumentState, name: string): Bookmark | null {
  const wanted = normalizeBookmarkName(name);
  return listBookmarks(doc).find((mark) => mark.name === wanted) ?? null;
}

/** Préfixe réservé aux ancres de titre, celui qu'emploie Writer à l'export. */
const HEADING_ANCHOR_PREFIX = '__RefHeading__';

/**
 * Identifiant d'ancre d'un titre, pour les renvois d'une table des matières.
 *
 * Writer nomme ces ancres `__RefHeading__<id>` ; on garde le même préfixe
 * réservé, ce qui les distingue à coup sûr d'un signet posé à la main.
 */
export function headingAnchorName(blockId: string): string {
  return `${HEADING_ANCHOR_PREFIX}${blockId}`;
}

/** Le blockId d'origine d'une ancre de titre, ou `null` si ce n'en est pas une. */
export function blockIdFromHeadingAnchor(name: string): string | null {
  return name.startsWith(HEADING_ANCHOR_PREFIX)
    ? name.slice(HEADING_ANCHOR_PREFIX.length)
    : null;
}

/**
 * Toutes les cibles de renvoi : signets posés à la main **et** titres.
 *
 * Writer propose les deux dans son dialogue de renvoi (`SwFldRefPage`), pour la
 * raison évidente qu'un sommaire renvoie à des titres qu'on n'a pas eu à
 * marquer un par un.
 */
export function linkTargets(doc: WriterDocumentState): LinkTarget[] {
  const out: LinkTarget[] = [];

  for (const mark of listBookmarks(doc)) {
    out.push({ kind: 'bookmark', name: mark.name, blockId: mark.blockId, label: mark.name });
  }

  for (const block of doc.blocks) {
    if (!isParagraph(block) || block.type !== 'heading') continue;
    const label = block.runs
      .map((run) => run.text)
      .join('')
      .trim();
    if (!label) continue;
    const target: LinkTarget = {
      kind: 'heading',
      name: headingAnchorName(block.id),
      blockId: block.id,
      label,
    };
    if (block.headingLevel !== undefined) target.headingLevel = block.headingLevel;
    out.push(target);
  }

  return out;
}

/**
 * Résout un `href` de renvoi interne vers le paragraphe visé.
 *
 * Renvoie `null` pour une adresse externe (`http:`, `mailto:` …) : l'appelant
 * doit alors laisser le navigateur faire son travail.
 */
export function resolveInternalLink(
  doc: WriterDocumentState,
  href: string,
): { blockId: string; offset: number } | null {
  if (!href.startsWith('#')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(href.slice(1));
  } catch {
    // Une séquence `%` mal formée n'est pas une raison de faire tomber la
    // résolution : le lien est simplement traité comme cassé.
    decoded = href.slice(1);
  }

  const name = normalizeBookmarkName(decoded);
  if (!name) return null;

  const headingBlockId = blockIdFromHeadingAnchor(name);
  if (headingBlockId) {
    const exists = paragraphIndex(doc).byId.has(headingBlockId);
    return exists ? { blockId: headingBlockId, offset: 0 } : null;
  }

  const mark = findBookmark(doc, name);
  return mark ? { blockId: mark.blockId, offset: mark.startOffset } : null;
}

/** Un lien `#nom` pointant vers une cible qui n'existe plus est cassé. */
export function brokenInternalLinks(doc: WriterDocumentState): string[] {
  const broken = new Set<string>();
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    for (const run of paragraph.runs) {
      const href = run.linkHref;
      if (!href || !href.startsWith('#')) continue;
      if (!resolveInternalLink(doc, href)) broken.add(href);
    }
  }

  return [...broken].sort();
}

/* ---------------------------------------------------------------- écriture */

export interface BookmarkRange {
  blockId: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Pose un signet sur une plage. Transposition de `IDocumentMarkAccess::makeMark`.
 *
 * Un nom déjà pris est d'abord libéré : Writer refuse deux signets homonymes,
 * et un renvoi `#nom` ambigu ne pourrait de toute façon viser qu'une des deux
 * positions.
 */
export function setBookmark(
  doc: WriterDocumentState,
  range: BookmarkRange,
  rawName: string,
): WriterDocumentState {
  const name = normalizeBookmarkName(rawName);
  if (!name) return doc;
  // Un nom réservé aux ancres de titre ne peut pas être posé à la main : il
  // serait écrasé à la prochaine régénération du sommaire.
  if (blockIdFromHeadingAnchor(name)) return doc;

  const cleared = removeBookmark(doc, name);
  const node = paragraphIndex(cleared).byId.get(range.blockId)?.paragraph;
  if (!node) return doc;

  const length = node.runs.reduce((sum, run) => sum + run.text.length, 0);
  const start = Math.max(0, Math.min(range.startOffset, range.endOffset, length));
  const end = Math.min(length, Math.max(range.startOffset, range.endOffset));

  // Signet ponctuel sur un paragraphe non vide : Writer l'attache au caractère
  // qui suit, faute de quoi il n'aurait aucun porteur et disparaîtrait.
  const from = start;
  const to = end > start ? end : Math.min(length, start + 1);

  const runs =
    length === 0
      ? node.runs.map((run) => withBookmarkName(run, name))
      : normalizeRuns(
          mapRunsInRange(node.runs, from, to, (run) => withBookmarkName(run, name)),
          runFormatting(node.runs[0] ?? makeRun('')),
        );

  return touch(replaceParagraph(cleared, range.blockId, { ...node, runs }));
}

/** Retire un signet par son nom (`IDocumentMarkAccess::deleteMark`). */
export function removeBookmark(doc: WriterDocumentState, rawName: string): WriterDocumentState {
  const name = normalizeBookmarkName(rawName);
  if (!name) return doc;

  let next = doc;
  let changed = false;
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    if (!paragraph.runs.some((run) => run.bookmarkName === name)) continue;
    changed = true;
    const runs = paragraph.runs.map((run) =>
      run.bookmarkName === name ? withBookmarkName(run, undefined) : run,
    );
    next = replaceParagraph(next, blockId, { ...paragraph, runs });
  }

  return changed ? touch(next) : doc;
}

/** Renomme un signet en reportant les renvois `#ancien` qui le visaient. */
export function renameBookmark(
  doc: WriterDocumentState,
  fromRaw: string,
  toRaw: string,
): WriterDocumentState {
  const from = normalizeBookmarkName(fromRaw);
  const to = normalizeBookmarkName(toRaw);
  if (!from || !to || from === to) return doc;
  if (!findBookmark(doc, from) || findBookmark(doc, to)) return doc;

  let next = doc;
  const { order, byId } = paragraphIndex(doc);

  for (const blockId of order) {
    const paragraph = byId.get(blockId)?.paragraph;
    if (!paragraph) continue;
    const affected = paragraph.runs.some(
      (run) => run.bookmarkName === from || run.linkHref === `#${from}`,
    );
    if (!affected) continue;

    const runs = paragraph.runs.map((run) => {
      let out = run;
      if (out.bookmarkName === from) out = withBookmarkName(out, to);
      if (out.linkHref === `#${from}`) {
        const copy = makeRun(out.text, runFormatting(out));
        copy.linkHref = `#${to}`;
        out = copy;
      }
      return out;
    });
    next = replaceParagraph(next, blockId, { ...paragraph, runs });
  }

  return touch(next);
}

/* ------------------------------------------------------------- utilitaires */

function withBookmarkName(run: TextRun, name: string | undefined): TextRun {
  const out = makeRun(run.text, runFormatting(run));
  if (name !== undefined) out.bookmarkName = name;
  else delete out.bookmarkName;
  return out;
}
