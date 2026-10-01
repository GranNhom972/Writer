// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * The central control hook. (OpenOffice: `SwEditWin`, the window that, in Writer, translates input events into commands on the model.)
 *
 * Architectural principle: **nothing is read from the DOM**. Not the text, not the cursor position, not the line boundaries. The keyboard and the mouse produce commands, the commands transform the state, and the
 * engine recomputes the geometry. The DOM is only the projection.
 *
 * Input goes through an invisible text area rather than `contenteditable`: that is what lets us receive Asian input methods, dictation and the system paste without ever letting the browser modify the document on
 * its own.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {
  createParagraph,
  createTable,
  insertBlockAfter,
  paragraphIndex,
  paragraphText,
  previousParagraphId,
  removeBlocks,
  replaceParagraph,
} from '../../domain/document/document';
import { normalizeUrl } from '../../domain/document/url';
import { isFloatingFly } from '../../domain/engine/flyLayout';
import {
  captionFormatting,
  clampSize,
  defaultFlyPlacement,
  spacingFormatting,
  cropFormatting,
  imageAttributes,
  imageWrapMode,
  isImageRun,
  makeImageRun,
  placementFormatting,
  wrapFormatting,
  WRAP_FORMAT_KEYS,
  type ImageAttributes,
  type ImageWrapMode,
} from '../../domain/document/images';
import type {
  DocumentPosition,
  DocumentSelection,
  ListKind,
  ParagraphNode,
  RunFormatting,
  TextRun,
  TocNode,
  WriterDocumentState,
} from '../../domain/document/types';
import {
  deleteCommentThread,
  editComment,
  replyToComment,
  resolveCommentThread,
} from '../../domain/document/comments';
import { removeBookmark } from '../../domain/document/bookmarks';
import {
  acceptAllRedlines,
  applyRedline,
  rejectAllRedlines,
} from '../../domain/document/redline';
import { updateToc, type TocOptions } from '../../domain/document/tox';
import {
  formattingAt,
  insertTextInRuns,
  makeRun,
  normalizeRuns,
  runFormatting,
  type RunFormatPatch,
} from '../../domain/document/runs';
import {
  caretGeometry,
  collapsedSelection,
  comparePositions,
  lineBounds,
  makeSelection,
  moveHorizontal,
  moveVertical,
  normalizeSelection,
  positionFromPoint,
  selectionRects,
  wordRangeAt,
  type CaretGeometry,
  type SelectionRect,
} from '../../domain/engine/cursor';
import {
  activeFormatting,
  applyParagraphFormat,
  applyRunFormat,
  changeListLevel,
  clearRunFormat,
  createEditorState,
  deleteBackward,
  deleteCurrentTable,
  deleteCurrentTableColumn,
  deleteCurrentTableRow,
  deleteForward,
  deleteSelection,
  distributeTableColumns,
  extractFragment,
  insertBlockPageBreak,
  insertFootnote,
  insertFragment,
  insertLineBreak,
  insertTableColumnLeft,
  insertTableColumnRight,
  insertTableOfContents,
  insertTableRowAbove,
  insertTableRowBelow,
  insertText,
  mergeSelectedCells,
  moveImageRun,
  moveToAdjacentCell,
  resizeTableColumnBoundary,
  selectAll,
  selectionText,
  selectTableColumn,
  selectTableRow,
  selectWholeTable,
  tableContext,
  bookmarkSelection,
  commentSelection,
  setHeading,
  setReviewMode,
  setSelection,
  splitCurrentCell,
  splitParagraph,
  toggleList,
  toggleListChecked,
  toggleRunFormat,
  type DocumentFragment,
  type EditorState,
  type ParagraphPatch,
} from '../../domain/engine/edit';
import {
  canRedo,
  canUndo,
  commit,
  createSession,
  deletionGroup,
  dragGroup,
  redo,
  settingsGroup,
  typingGroup,
  undo,
  type EditorSession,
  type GroupingKey,
} from '../../domain/engine/history';
import { createMeasurer, type TextMeasurer } from '../../domain/engine/measure';
import { paginateDocument, type DocumentLayout, type PlacedParagraph } from '../../domain/engine/paginate';

/**
 * Last fragment copied from this editor.
 *
 * The system clipboard only carries text and HTML; writing our model into it would need a proprietary MIME type, which browsers filter out. So we keep the fragment aside and recognize it on paste by its text: an
 * internal copy and paste therefore keeps all its formatting, and a paste from elsewhere falls back cleanly on plain text.
 */
let lastCopied: { text: string; fragment: DocumentFragment } | null = null;

export interface WriterCommands {
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrike: () => void;
  setFontFamily: (family: string | null) => void;
  setFontSize: (sizePt: number | null) => void;
  setColor: (color: string | null) => void;
  setHighlight: (color: string | null) => void;
  clearFormatting: () => void;
  setHeadingLevel: (level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => void;
  setAlignment: (alignment: ParagraphNode['alignment']) => void;
  setLineSpacing: (spacing: number) => void;
  setFirstLineIndentPt: (pt: number | null) => void;
  toggleSpaceBefore: () => void;
  toggleSpaceAfter: () => void;
  indent: (direction: 1 | -1) => void;
  insertPageBreak: () => void;
  adjustFontSize: (delta: number) => void;
  toggleList: (kind: ListKind) => void;
  changeListLevel: (direction: 1 | -1) => void;
  toggleTask: (blockId: string) => void;
  /** Returns `false` if the address is refused: the dialog then reports it. */
  setLink: (url: string) => boolean;
  removeLink: () => void;
  insertTable: (rows: number, cols: number) => void;
  insertTableRowAbove: () => void;
  insertTableRowBelow: () => void;
  deleteTableRow: () => void;
  insertTableColumnLeft: () => void;
  insertTableColumnRight: () => void;
  deleteTableColumn: () => void;
  deleteTable: () => void;
  /** Spreads the columns of the current table evenly. */
  distributeColumns: () => void;
  /** Moves the boundary between two columns, with the mouse. */
  resizeColumnBoundary: (tableId: string, boundaryIndex: number, deltaPercent: number) => void;
  selectRow: (tableId: string, rowIndex: number) => void;
  selectColumn: (tableId: string, columnIndex: number) => void;
  selectTable: (tableId: string) => void;
  /** Moves to the next or previous cell (`Tab` / `Shift+Tab`). */
  goToAdjacentCell: (forward: boolean) => void;
  insertFootnote: (text: string) => void;
  /** Merges the selected cells (`SwDoc::MergeTbl`). */
  mergeCells: () => void;
  /** Splits the current cell (`SwDoc::SplitTbl`). */
  splitCell: (direction: 'horizontal' | 'vertical', count?: number) => void;
  /** Inserts a table of contents after the current block (`SwTOXBase`). */
  insertTableOfContents: (options?: TocOptions) => void;
  /** Modifies the definition of a table of contents already placed. */
  updateToc: (tocId: string, patch: Partial<Omit<TocNode, 'id' | 'type'>>) => void;

  /* -- Comments (`SwPostItMgr`) ------------------------------------------ */
  addComment: (author: string, text: string) => void;
  replyToComment: (threadId: string, author: string, text: string) => void;
  resolveComment: (threadId: string, resolved: boolean) => void;
  deleteComment: (threadId: string) => void;
  editComment: (commentId: string, text: string) => void;

  /* -- Bookmarks (`SwBookmark`) ------------------------------------------ */
  setBookmark: (name: string) => void;
  removeBookmark: (name: string) => void;

  /* -- Change tracking (`SwRedline`) ------------------------------------- */
  /** Turns review mode on in an author's name, or off with `null`. */
  setReviewMode: (author: string | null) => void;
  acceptRedline: (redlineId: string) => void;
  rejectRedline: (redlineId: string) => void;
  acceptAllRedlines: () => void;
  rejectAllRedlines: () => void;

  /**
   * How the image frame at this offset fits into the text.
   *
   * A single entry point for the three OpenOffice attributes (anchor, wrapping and layer): setting them separately would let through states that Writer does not have, such as an "in front of the text" frame
   * left in the flow.
   */
  setImageWrap: (blockId: string, offset: number, mode: ImageWrapMode) => void;
  /**
   * Moves a floating frame. The coordinates are in points, in the frame of reference of its anchor (`SwFmtHoriOrient` / `SwFmtVertOrient`).
   *
   * Switches the horizontal alignment to `from-left`: a frame moved by hand has by definition left its alignment, and leaving it aligned would bring the image back to its place at the next computation.
   */
  setImagePosition: (blockId: string, offset: number, xPt: number, yPt: number) => void;
  /**
   * Re-anchors an image to the paragraph where it has just been dropped.
   *
   * This is what `SwFEShell::SetAnchor` does at the end of a drag: a frame stays dependent on its anchor (the anchor decides its page), so dropping it three pages down must change the anchor, not only the y
   * coordinate. Without it, an image dragged far from its paragraph stayed drawn on that paragraph's page, and left the sheet.
   *
   * An image "as a character" has no coordinates: for it, `target` is simply its new place in the text, and `xPt`/`yPt` are ignored.
   */
  moveImageTo: (
    blockId: string,
    offset: number,
    target: DocumentPosition,
    xPt: number,
    yPt: number,
  ) => void;

  insertMath: (latex: string, display: boolean) => void;
  updateMath: (blockId: string, latex: string, display: boolean) => void;
  deleteMath: (blockId: string) => void;
  /** Inserts an image at the cursor, anchored "as a character" (`SwFlyCntFrm`). */
  insertImage: (attributes: ImageAttributes) => void;
  /** Rewrites the source, dimensions and alternative text of the frame at this offset. */
  updateImage: (blockId: string, offset: number, attributes: ImageAttributes) => void;
  /** Resizes an image from the editor, without going through the window. */
  resizeImage: (blockId: string, offset: number, widthPt: number, heightPt: number) => void;
  deleteImage: (blockId: string, offset: number) => void;
  goToBlock: (blockId: string) => void;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  /**
   * Modifies the document's **settings** (page furniture, margins, title) without touching the cursor or the focus.
   *
   * These settings do not belong to the text flow: they are changed from a dialog or the ruler, while the cursor stays where it was. Hence the two differences from an ordinary editing command: nothing is handed
   * back to the invisible input area (the dialog's field would otherwise lose focus every other keystroke), and the session is not rebuilt, otherwise the document's history would be wiped at every character typed in
   * a header.
   *
   * The transformation is applied **inside** the reducer, never on the render's document: two keystrokes batched by React would otherwise start from the same state, and the second would overwrite the first.
   *
   * `settingId` groups the transactions of one continuous gesture into a single undo entry (see `settingsGroup`).
   */
  updateDocument: (
    label: string,
    transform: (doc: WriterDocumentState) => WriterDocumentState,
    settingId?: string,
  ) => void;
  /**
   * Applies a change that came from the network.
   *
   * Distinct from `updateDocument`, which records its change in the history: a change from the network does **not** go in. Undoing your own work after a colleague has written elsewhere must stay possible, and
   * `Ctrl+Z` must never undo someone else's typing.
   *
   * `remapSelection` carries the cursor over: someone writing **before** the point shifts the text under it, and leaving it where it was would make you type in the wrong place. Simply clamping to the document's
   * bounds is not enough: the offset stays valid there, it just no longer designates the same character.
   */
  applyRemote: (
    transform: (doc: WriterDocumentState) => WriterDocumentState,
    remapSelection?: (selection: DocumentSelection) => DocumentSelection,
  ) => void;
}

export interface WriterController {
  session: EditorSession;
  layout: DocumentLayout;
  measurer: TextMeasurer;
  activeFormat: RunFormatting;
  currentParagraph: ParagraphNode | null;
  /** Table under the cursor, or `null`: used to grey out the inert commands. */
  table: ReturnType<typeof tableContext>;
  caret: CaretGeometry | null;
  rects: SelectionRect[];
  /**
   * Selection rectangles **grouped by page**, and only for the pages that carry some.
   *
   * The grouping is done here, once, and not by a `filter` in the sheet render loop: a filter there would return a new array on every render for every page, which is enough to make the shallow comparison of
   * `React.memo(A4Page)` fail, so the whole document would be reconciled on every keystroke.
   *
   * A sparse table and not an array indexed by page: a selection only touches one page or two, and a dense array would recreate a new `[]` for all the others on every keystroke, the same defect moved elsewhere.
   * The absent pages fall back on the frozen constant `AUCUN_RECT`.
   */
  rectsByPage: ReadonlyMap<number, readonly SelectionRect[]>;
  /** Placed paragraphs, grouped by page: what each sheet has to paint. */
  placementsByPage: { blockId: string; placed: PlacedParagraph }[][];
  isFocused: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  focus: () => void;
  run: (label: string, transform: (state: EditorState) => EditorState) => void;
  commands: WriterCommands;
  handlers: {
    onKeyDown: (event: React.KeyboardEvent) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
    onCopy: (event: React.ClipboardEvent) => void;
    onCut: (event: React.ClipboardEvent) => void;
    onPaste: (event: React.ClipboardEvent) => void;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>, pageIndex: number) => void;
  };
}

/**
 * Image frame covering this offset.
 *
 * We accept the offset of the **start** of the frame as well as that of its end: the rendering announces the first, whereas a cursor placed right after the image gives the second. Requiring either one would make
 * the retouch fail one time in two.
 */
function imageRunAt(
  runs: readonly TextRun[],
  offset: number,
): { index: number; offset: number } | null {
  let consumed = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    const start = consumed;
    const end = consumed + run.text.length;
    if (isImageRun(run) && offset >= start && offset <= end) return { index, offset: start };
    consumed = end;
  }
  return null;
}

/** Attributes of the first image frame of the paragraph, to open the workshop. */
export function imageDraftAt(
  runs: readonly TextRun[],
  offset: number,
): (ImageAttributes & { offset: number }) | null {
  const cible = imageRunAt(runs, offset);
  if (!cible) return null;
  const attributs = imageAttributes(runs[cible.index]!);
  return attributs ? { ...attributs, offset: cible.offset } : null;
}

/**
 * Brings a selection back within the limits of a document that has changed under it.
 *
 * A remote participant can delete the paragraph where our cursor is, or shorten one. Without this reframing, the engine would look for a block that no longer exists and the cursor would vanish from the screen.
 */
function clampSelection(
  doc: WriterDocumentState,
  selection: DocumentSelection,
): DocumentSelection {
  const index = paragraphIndex(doc);

  const recadrer = (position: DocumentPosition): DocumentPosition => {
    const node = index.byId.get(position.blockId);
    if (!node) {
      // Block gone: we fall back on the first paragraph, the only point that is always valid in a non-empty document.
      const premier = index.order[0];
      return premier ? { blockId: premier, offset: 0 } : position;
    }
    const longueur = paragraphText(node.paragraph).length;
    if (position.offset <= longueur) return position;
    return { ...position, offset: longueur };
  };

  const anchor = recadrer(selection.anchor);
  const focus = recadrer(selection.focus);
  return {
    ...selection,
    anchor,
    focus,
    isCollapsed: anchor.blockId === focus.blockId && anchor.offset === focus.offset,
  };
}

const INDENT_STEP_PT = 36; // 1.27 cm: Writer's default tab step.
/** Font size bounds, taken from the Write application. */
export const MIN_FONT_SIZE_PT = 6;
export const MAX_FONT_SIZE_PT = 96;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

/**
 * Actions that the controller triggers but does not implement: they open a browser window or a dialog, which is not its job.
 */
/**
 * Is a transaction allowed to go through?
 *
 * The single read-only rule, isolated here to be verifiable without mounting an editor: what leaves the document identical (moving the cursor, selecting to copy) always passes; what changes it only passes if
 * writing is allowed.
 *
 * The decision is taken on the document itself, never on the name of the command: a command forgotten in a list would be a change that gets through, and nobody would notice before the server silently rejected it.
 */
export function transactionAutorisee(
  lectureSeule: boolean,
  avant: EditorState,
  apres: EditorState,
): boolean {
  return !lectureSeule || apres.doc === avant.doc;
}

export interface WriterHooks {
  /**
   * Forbids any change to the document, without freezing anything else.
   *
   * The "Read only" badge and the refusal to publish were not enough: typing was still accepted locally, displayed, and then disappeared on close, so people believed they had written. Refusing at the source is the
   * only way not to lie to the person typing.
   */
  readOnly?: boolean;
  onPrint?: () => void;
  onOpenFindReplace?: () => void;
  onOpenLink?: () => void;
  onOpenMath?: () => void;
  onEditMath?: (blockId: string, latex: string, display: boolean) => void;
  onOpenImage?: () => void;
  onEditImage?: (blockId: string, offset: number) => void;
  /** Right click in the document, in window coordinates. */
  onOpenContextMenu?: (x: number, y: number) => void;
}

export function useWriterInput(
  initialDocument: WriterDocumentState,
  hooks: WriterHooks = {},
): WriterController {
  const measurer = useMemo(() => createMeasurer(), []);
  const [session, setSession] = useState<EditorSession>(() =>
    createSession(createEditorState(initialDocument)),
  );
  const [isFocused, setFocused] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [fontsTick, setFontsTick] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Read at the time of the call, not when `run` is created: the permission may change during a session (a share being revoked).
  const lectureSeuleRef = useRef(false);
  lectureSeuleRef.current = hooks.readOnly === true;
  const composing = useRef(false);
  const dragging = useRef(false);

  // The application actions live in a ref: the keyboard handler can thus call them without counting them among its dependencies, and stay stable from one render to the next.
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  /**
   * The table where the cursor is, or `null`.
   *
   * It goes through a reference because `onKeyDown` deliberately does not depend on the state: adding `session` to it would rebuild it on every keystroke. The reference is reassigned at render time, so it is
   * always up to date when the key arrives.
   */
  const tableRef = useRef<ReturnType<typeof tableContext>>(null);

  /** Current session, for the handlers that must read it outside a reducer. */
  const sessionRef = useRef<EditorSession | null>(null);

  /**
   * The metrics of a font change at the moment it finishes loading. A document laid out before that moment would be measured with the fallback font, then painted with the real one: the lines would not fall in the
   * right place.
   */
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFontsTick((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const layout = useMemo(
    () => paginateDocument(session.state.doc, { measurer }),
    // `fontsTick` forces a recomputation when the fonts become available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.state.doc, measurer, fontsTick],
  );

  const focus = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Applies a command and records it in the history.
   *
   * The transformation **and** the grouping key are computed inside the reducer, from the current state. Computing them outside would freeze them at the render's state: two keystrokes arriving in the same batch
   * (which React 18 always batches) would then start from the same starting point, and the second would overwrite the first.
   */
  const run = useCallback(
    (
      label: string,
      transform: (state: EditorState) => EditorState,
      groupingOf?: (before: EditorState, after: EditorState) => GroupingKey | null,
    ) => {
      setSession((current) => {
        const next = transform(current.state);
        if (!transactionAutorisee(lectureSeuleRef.current, current.state, next)) {
          return current;
        }
        return commit(current, label, next, groupingOf?.(current.state, next) ?? null);
      });
    },
    [],
  );

  /** Moves the cursor without recording anything in the history. */
  const move = useCallback((transform: (state: EditorState) => EditorState) => {
    setSession((current) => ({ ...current, state: transform(current.state) }));
  }, []);

  const caret = useMemo(
    () => caretGeometry(layout, session.state.selection.focus, measurer),
    [layout, session.state.selection.focus, measurer],
  );

  const rects = useMemo(
    () => selectionRects(session.state.doc, layout, session.state.selection, measurer),
    [session.state.doc, layout, session.state.selection, measurer],
  );

  const rectsByPage = useMemo(() => {
    const pages = new Map<number, SelectionRect[]>();
    for (const rect of rects) {
      const liste = pages.get(rect.pageIndex);
      if (liste) liste.push(rect);
      else pages.set(rect.pageIndex, [rect]);
    }
    return pages;
  }, [rects]);

  const placementsByPage = useMemo(() => {
    const pages: { blockId: string; placed: PlacedParagraph }[][] = layout.pages.map(() => []);
    for (const [blockId, entries] of layout.placements) {
      for (const entry of entries) {
        pages[entry.pageIndex]?.push({ blockId, placed: entry.placed });
      }
    }
    return pages;
  }, [layout]);

  const activeFormat = useMemo(() => activeFormatting(session.state), [session.state]);

  const currentParagraph = useMemo(
    () => paragraphIndex(session.state.doc).byId.get(session.state.selection.focus.blockId)
      ?.paragraph ?? null,
    [session.state.doc, session.state.selection.focus.blockId],
  );

  /**
   * Table under the cursor: `null` outside any grid.
   *
   * Exposed so that menus grey out what does not apply: a table command offered outside a table is a click with no effect, so a UX bug.
   */
  const table = useMemo(() => tableContext(session.state), [session.state]);
  tableRef.current = table;
  sessionRef.current = session;

  /* ------------------------------------------------------------- commands */

  const patchRun = useCallback(
    (label: string, patch: RunFormatPatch) => {
      run(label, (state) => applyRunFormat(state, patch));
      focus();
    },
    [run, focus],
  );

  const patchParagraph = useCallback(
    (label: string, patch: ParagraphPatch) => {
      run(label, (state) => applyParagraphFormat(state, patch));
      focus();
    },
    [run, focus],
  );

  const commands = useMemo<WriterCommands>(
    () => ({
      toggleBold: () => {
        run('Gras', (state) => toggleRunFormat(state, 'bold'));
        focus();
      },
      toggleItalic: () => {
        run('Italique', (state) => toggleRunFormat(state, 'italic'));
        focus();
      },
      toggleUnderline: () => {
        run('Souligné', (state) => toggleRunFormat(state, 'underline'));
        focus();
      },
      toggleStrike: () => {
        run('Barré', (state) => toggleRunFormat(state, 'strikeThrough'));
        focus();
      },
      setFontFamily: (family) => patchRun('Police', { fontFamily: family }),
      setFontSize: (sizePt) => patchRun('Taille', { fontSizePt: sizePt }),
      setColor: (color) => patchRun('Couleur', { color }),
      setHighlight: (color) => patchRun('Surlignage', { backgroundColor: color }),
      clearFormatting: () => {
        run('Effacer la mise en forme', (state) => clearRunFormat(state));
        focus();
      },
      setHeadingLevel: (level) => {
        run('Style de paragraphe', (state) => setHeading(state, level));
        focus();
      },
      setAlignment: (alignment) => patchParagraph('Alignement', { alignment: alignment ?? null }),
      setLineSpacing: (spacing) => patchParagraph('Interligne', { lineSpacing: spacing }),
      setFirstLineIndentPt: (pt) => patchParagraph('Retrait première ligne', { firstLineIndentPt: pt }),

      toggleSpaceBefore: () => {
        setSession((current) => {
          const node = currentNode(current.state);
          const pose = (node?.marginTopPt ?? 0) > 0;
          return commit(
            current,
            'Espacement avant',
            applyParagraphFormat(current.state, {
              marginTopPt: pose ? 0 : current.state.doc.defaults.fontSizePt,
            }),
          );
        });
        focus();
      },

      toggleSpaceAfter: () => {
        setSession((current) => {
          const node = currentNode(current.state);
          const pose = (node?.marginBottomPt ?? 0) > 0;
          return commit(
            current,
            'Espacement après',
            applyParagraphFormat(current.state, {
              marginBottomPt: pose ? 0 : current.state.doc.defaults.fontSizePt,
            }),
          );
        });
        focus();
      },

      indent: (direction) => {
        setSession((current) => {
          const node = currentNode(current.state);
          // In a list, `Tab` changes the **level**: this is what Writer does, and the user does not have to know which of the two cases they are in to get the shift they expect.
          if (node?.listKind !== undefined) {
            return commit(current, 'Niveau de liste', changeListLevel(current.state, direction));
          }
          const now = node?.indentLeftPt ?? 0;
          // The indent does not go below zero: a negative indent would push the text out of the printable area.
          const next = Math.max(0, now + direction * INDENT_STEP_PT);
          return commit(
            current,
            'Retrait',
            applyParagraphFormat(current.state, { indentLeftPt: next === 0 ? null : next }),
          );
        });
        focus();
      },

      adjustFontSize: (delta) => {
        setSession((current) => {
          const actuel = activeFormatting(current.state).fontSizePt
            ?? current.state.doc.defaults.fontSizePt;
          const taille = Math.max(MIN_FONT_SIZE_PT, Math.min(MAX_FONT_SIZE_PT, actuel + delta));
          return commit(current, 'Taille', applyRunFormat(current.state, { fontSizePt: taille }));
        });
        focus();
      },

      toggleList: (kind) => {
        run('Liste', (state) => toggleList(state, kind));
        focus();
      },

      changeListLevel: (direction) => {
        run('Niveau de liste', (state) => changeListLevel(state, direction));
        focus();
      },

      toggleTask: (blockId) => {
        run('Case à cocher', (state) => toggleListChecked(state, blockId));
        focus();
      },

      setLink: (url) => {
        const normalisee = normalizeUrl(url);
        // Address refused: we tell the dialog rather than do nothing. A button that closes its window without placing anything makes people believe it succeeded.
        if (!normalisee) return false;
        setSession((current) => {
          // Without a selection there is nothing to mark: we insert the address as text, then mark it. Arming a link on a collapsed cursor would leave nothing visible, and the user expects to see their link.
          if (current.state.selection.isCollapsed) {
            const avant = current.state.selection.focus;
            const avecTexte = insertText(current.state, url.trim() || normalisee);
            const apres = avecTexte.selection.focus;
            const marque = applyRunFormat(
              {
                ...avecTexte,
                selection: makeSelection(avant, apres),
              },
              { linkHref: normalisee },
            );
            return commit(current, 'Lien', {
              ...marque,
              selection: collapsedSelection(apres),
            });
          }
          return commit(current, 'Lien', applyRunFormat(current.state, { linkHref: normalisee }));
        });
        focus();
        return true;
      },

      removeLink: () => patchRun('Retirer le lien', { linkHref: null }),

      insertTable: (rows, cols) => {
        setSession((current) => {
          const position = current.state.selection.focus;
          const table = createTable(rows, cols);
          let doc = insertBlockAfter(current.state.doc, position.blockId, table);

          // A paragraph always follows the table: without it, a table at the end of the document traps the cursor, which no longer has any position to go to next.
          const at = doc.blocks.findIndex((block) => block.id === table.id);
          if (at >= 0 && at === doc.blocks.length - 1) {
            doc = { ...doc, blocks: [...doc.blocks, createParagraph('')] };
          }

          // The cursor goes into the first cell: that is where you write after placing a table.
          const premiere = table.rows[0]?.cells[0]?.blocks[0];
          const next: EditorState = {
            doc,
            selection: premiere
              ? collapsedSelection({ blockId: premiere.id, offset: 0 })
              : current.state.selection,
            pendingFormat: null,
          };
          return commit(current, 'Insérer un tableau', next);
        });
        focus();
      },

      insertTableRowAbove: () => {
        run('Insérer une ligne au-dessus', (state) => insertTableRowAbove(state));
        focus();
      },

      insertTableRowBelow: () => {
        run('Insérer une ligne au-dessous', (state) => insertTableRowBelow(state));
        focus();
      },

      deleteTableRow: () => {
        run('Supprimer la ligne', (state) => deleteCurrentTableRow(state));
        focus();
      },

      insertTableColumnLeft: () => {
        run('Insérer une colonne à gauche', (state) => insertTableColumnLeft(state));
        focus();
      },

      insertTableColumnRight: () => {
        run('Insérer une colonne à droite', (state) => insertTableColumnRight(state));
        focus();
      },

      deleteTableColumn: () => {
        run('Supprimer la colonne', (state) => deleteCurrentTableColumn(state));
        focus();
      },

      deleteTable: () => {
        run('Supprimer le tableau', (state) => deleteCurrentTable(state));
        focus();
      },

      distributeColumns: () => {
        run('Répartir les colonnes', (state) => distributeTableColumns(state));
        focus();
      },

      resizeColumnBoundary: (tableId, boundaryIndex, deltaPercent) => {
        // Dragging a handle produces dozens of events: they are grouped into **one** history entry, otherwise ten `Ctrl+Z` would be needed to undo a single gesture.
        run(
          'Largeur de colonne',
          (state) => resizeTableColumnBoundary(state, tableId, boundaryIndex, deltaPercent),
          () => dragGroup(`${tableId}:${boundaryIndex}`),
        );
      },

      selectRow: (tableId, rowIndex) => {
        move((state) => selectTableRow(state, tableId, rowIndex));
        focus();
      },

      selectColumn: (tableId, columnIndex) => {
        move((state) => selectTableColumn(state, tableId, columnIndex));
        focus();
      },

      selectTable: (tableId) => {
        move((state) => selectWholeTable(state, tableId));
        focus();
      },

      goToAdjacentCell: (forward) => {
        // `Tab` at the end of a table adds a row: the transaction must therefore go through `run`, not `move`, to be undoable.
        run('Cellule suivante', (state) => moveToAdjacentCell(state, forward));
        focus();
      },

      insertFootnote: (text) => {
        run('Insérer une note de bas de page', (state) => insertFootnote(state, text));
        focus();
      },

      mergeCells: () => {
        run('Fusionner les cellules', (state) => mergeSelectedCells(state));
        focus();
      },

      splitCell: (direction, count = 2) => {
        run('Scinder la cellule', (state) => splitCurrentCell(state, direction, count));
        focus();
      },

      insertTableOfContents: (options) => {
        run('Insérer une table des matières', (state) => insertTableOfContents(state, options));
        focus();
      },

      updateToc: (tocId, patch) => {
        run('Modifier la table des matières', (state) => ({
          ...state,
          doc: updateToc(state.doc, tocId, patch),
        }));
        focus();
      },

      addComment: (author, text) => {
        run('Ajouter un commentaire', (state) => commentSelection(state, author, text).state);
        focus();
      },

      replyToComment: (threadId, author, text) => {
        run('Répondre au commentaire', (state) => ({
          ...state,
          doc: replyToComment(state.doc, threadId, author, text),
        }));
      },

      resolveComment: (threadId, resolved) => {
        run(resolved ? 'Résoudre le commentaire' : 'Rouvrir le commentaire', (state) => ({
          ...state,
          doc: resolveCommentThread(state.doc, threadId, resolved),
        }));
      },

      deleteComment: (threadId) => {
        run('Supprimer le commentaire', (state) => ({
          ...state,
          doc: deleteCommentThread(state.doc, threadId),
        }));
      },

      editComment: (commentId, text) => {
        run('Modifier le commentaire', (state) => ({
          ...state,
          doc: editComment(state.doc, commentId, text),
        }));
      },

      setBookmark: (name) => {
        run('Poser un signet', (state) => bookmarkSelection(state, name));
        focus();
      },

      removeBookmark: (name) => {
        run('Retirer le signet', (state) => ({ ...state, doc: removeBookmark(state.doc, name) }));
        focus();
      },

      setReviewMode: (author) => {
        // The toggle does not touch the document: it therefore does not go through `run`, which would stack an undoable transaction with nothing to undo.
        setSession((current) => ({
          ...current,
          state: setReviewMode(current.state, author ? { author } : null),
        }));
        focus();
      },

      acceptRedline: (redlineId) => {
        run('Accepter la modification', (state) => ({
          ...state,
          doc: applyRedline(state.doc, redlineId, 'accept'),
        }));
      },

      rejectRedline: (redlineId) => {
        run('Rejeter la modification', (state) => ({
          ...state,
          doc: applyRedline(state.doc, redlineId, 'reject'),
        }));
      },

      acceptAllRedlines: () => {
        run('Accepter toutes les modifications', (state) => ({
          ...state,
          doc: acceptAllRedlines(state.doc),
        }));
      },

      rejectAllRedlines: () => {
        run('Rejeter toutes les modifications', (state) => ({
          ...state,
          doc: rejectAllRedlines(state.doc),
        }));
      },

      setImageWrap: (blockId, offset, mode) => {
        run("Intégration de l'image", (state) => {
          const node = paragraphIndex(state.doc).byId.get(blockId)?.paragraph;
          if (!node) return state;
          const cible = imageRunAt(node.runs, offset);
          if (!cible) return state;

          const precedent = runFormatting(node.runs[cible.index]!);
          const formatting = { ...precedent };

          /*
           * The wrapping keys are **erased** before being written again.
           *
           * `wrapFormatting` only returns what the new mode asks for, never the absences: without this erasure, going back into the flow would leave behind an `imageInFront` or an offset, which would come back out at the next
           * switch as if we had never left.
           */
          for (const key of WRAP_FORMAT_KEYS) delete formatting[key];

          if (mode !== 'inline') {
            Object.assign(
              formatting,
              wrapFormatting(mode, precedent.imageAnchor ?? 'to-para'),
              // A frame that is already floating keeps its position; a frame that leaves the text flow is given one, otherwise it would fall at the top-left corner of the paragraph, across its first line.
              imageWrapMode(precedent) === 'inline'
                ? defaultFlyPlacement(mode)
                : {
                    ...(precedent.imageHoriOrient !== undefined
                      ? { imageHoriOrient: precedent.imageHoriOrient }
                      : {}),
                    ...(precedent.imageHoriRelation !== undefined
                      ? { imageHoriRelation: precedent.imageHoriRelation }
                      : {}),
                    imageXPt: precedent.imageXPt ?? 0,
                    imageYPt: precedent.imageYPt ?? 0,
                    ...(precedent.imageWrapMarginPt !== undefined
                      ? { imageWrapMarginPt: precedent.imageWrapMarginPt }
                      : {}),
                  },
            );
          }

          const runs = [...node.runs];
          runs[cible.index] = makeRun(node.runs[cible.index]!.text, formatting);
          return { ...state, doc: replaceParagraph(state.doc, blockId, { ...node, runs }) };
        });
        focus();
      },

      setImagePosition: (blockId, offset, xPt, yPt) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId)?.paragraph;
          if (!node) return current;
          const cible = imageRunAt(node.runs, offset);
          if (!cible) return current;

          const cadre = node.runs[cible.index]!;
          if (!isFloatingFly(cadre)) return current;
          if (cadre.imageXPt === xPt && cadre.imageYPt === yPt) return current;

          const runs = [...node.runs];
          runs[cible.index] = {
            ...cadre,
            // A frame moved by hand has left its alignment: leaving it aligned would bring it back to its place at the next computation, and the gesture would have been for nothing.
            imageHoriOrient: 'from-left',
            imageXPt: xPt,
            imageYPt: yPt,
          };

          const doc = replaceParagraph(current.state.doc, blockId, { ...node, runs });
          const next = { ...current.state, doc };
          if (!transactionAutorisee(lectureSeuleRef.current, current.state, next)) return current;
          // The whole drag forms one history entry.
          return commit(current, 'Déplacer l’image', next, dragGroup(`fly:${blockId}:${offset}`));
        });
      },

      moveImageTo: (blockId, offset, target, xPt, yPt) => {
        run('Déplacer l’image', (state) => ({
          ...state,
          doc: moveImageRun(state.doc, blockId, offset, target, { xPt, yPt }),
        }));
      },

      insertMath: (latex, display) => {
        setSession((current) => {
          const position = current.state.selection.focus;
          const formulaText = latex.trim();
          if (!formulaText) return current;

          if (display) {
            const mathParagraph = createParagraph(formulaText, {
              alignment: 'center',
              runs: [
                makeRun(formulaText, {
                  mathLatex: formulaText,
                  mathDisplay: true,
                }),
              ],
            });
            const doc = insertBlockAfter(current.state.doc, position.blockId, mathParagraph);
            return commit(current, 'Insérer formule', {
              ...current.state,
              doc,
              selection: collapsedSelection({ blockId: mathParagraph.id, offset: formulaText.length }),
            });
          } else {
            const base = current.state.selection.isCollapsed ? current.state : deleteSelection(current.state);
            const pos = base.selection.focus;
            const node = paragraphIndex(base.doc).byId.get(pos.blockId);
            if (!node) return current;

            const inherited = formattingAt(node.paragraph.runs, pos.offset);
            const formatting = {
              ...inherited,
              mathLatex: formulaText,
              mathDisplay: false,
            };
            const runs = insertTextInRuns(node.paragraph.runs, pos.offset, formulaText, formatting);
            const doc = replaceParagraph(base.doc, pos.blockId, { ...node.paragraph, runs });

            return commit(current, 'Insérer formule', {
              ...base,
              doc,
              selection: collapsedSelection({
                blockId: pos.blockId,
                offset: pos.offset + formulaText.length,
              }),
              pendingFormat: null,
            });
          }
        });
        focus();
      },

      updateMath: (blockId, latex, display) => {
        setSession((current) => {
          const formulaText = latex.trim();
          if (!formulaText) return current;

          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          let targetOffset = 0;
          let foundMath = false;
          let offsetAccum = 0;

          const newRuns: TextRun[] = [];
          for (const run of node.paragraph.runs) {
            if (!foundMath && run.mathLatex) {
              foundMath = true;
              targetOffset = offsetAccum + formulaText.length;
              newRuns.push(
                makeRun(formulaText, {
                  ...runFormatting(run),
                  mathLatex: formulaText,
                  mathDisplay: display,
                }),
              );
            } else {
              newRuns.push(run);
            }
            offsetAccum += run.text.length;
          }

          if (!foundMath) {
            targetOffset = formulaText.length;
            newRuns.push(
              makeRun(formulaText, {
                mathLatex: formulaText,
                mathDisplay: display,
              }),
            );
          }

          const updatedParagraph: ParagraphNode = {
            ...node.paragraph,
            runs: normalizeRuns(newRuns),
          };
          if (display) {
            updatedParagraph.alignment = 'center';
          } else if (updatedParagraph.alignment === 'center') {
            delete updatedParagraph.alignment;
          }

          const doc = replaceParagraph(current.state.doc, blockId, updatedParagraph);
          return commit(current, 'Modifier formule', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: targetOffset }),
          });
        });
        focus();
      },

      deleteMath: (blockId) => {
        setSession((current) => {
          const index = paragraphIndex(current.state.doc);
          const node = index.byId.get(blockId);
          if (!node) return current;

          // If the paragraph contains ONLY the formula (display block or dedicated paragraph):
          if (node.paragraph.runs.length <= 1 || node.paragraph.runs.every((r) => r.mathLatex || !r.text)) {
            const prevId = previousParagraphId(current.state.doc, blockId);
            const doc = removeBlocks(current.state.doc, new Set([blockId]));
            const nextIndex = paragraphIndex(doc);
            const fallbackId = prevId ?? nextIndex.order[0] ?? '';
            return commit(current, 'Supprimer formule', {
              ...current.state,
              doc,
              selection: collapsedSelection({ blockId: fallbackId, offset: 0 }),
            });
          }

          // If the formula is inline in the middle of other text: remove only the math run
          let targetOffset = 0;
          let offsetAccum = 0;
          const remainingRuns: TextRun[] = [];
          for (const run of node.paragraph.runs) {
            if (run.mathLatex) {
              targetOffset = offsetAccum;
            } else {
              remainingRuns.push(run);
              offsetAccum += run.text.length;
            }
          }

          const updatedParagraph: ParagraphNode = {
            ...node.paragraph,
            runs: normalizeRuns(remainingRuns.length > 0 ? remainingRuns : [makeRun('')]),
          };

          const doc = replaceParagraph(current.state.doc, blockId, updatedParagraph);
          return commit(current, 'Supprimer formule', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: targetOffset }),
          });
        });
        focus();
      },

      /* ------------------------------------------------------------ images */

      insertImage: (attributes) => {
        setSession((current) => {
          if (!attributes.src) return current;

          // An image replaces the selection, as a keystroke would: this is what `SwFEShell::Insert` does when a `SwPaM` is not collapsed.
          const base = current.state.selection.isCollapsed
            ? current.state
            : deleteSelection(current.state);
          const position = base.selection.focus;
          const node = paragraphIndex(base.doc).byId.get(position.blockId);
          if (!node) return current;

          const cadre = makeImageRun(attributes);
          const runs = insertTextInRuns(
            node.paragraph.runs,
            position.offset,
            cadre.text,
            runFormatting(cadre),
          );
          const doc = replaceParagraph(base.doc, position.blockId, { ...node.paragraph, runs });

          return commit(current, 'Insérer une image', {
            ...base,
            doc,
            selection: collapsedSelection({
              blockId: position.blockId,
              offset: position.offset + cadre.text.length,
            }),
            // Without this reset, the next keystroke would inherit the frame and produce a second image.
            pendingFormat: null,
          });
        });
        focus();
      },

      updateImage: (blockId, offset, attributes) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          const cible = imageRunAt(node.paragraph.runs, offset);
          if (!cible) return current;

          // The frame is **rebuilt** rather than corrected key by key: a removed crop must see its four values disappear, and a merge of the old formatting would leave them in place.
          const runs = [...node.paragraph.runs];
          const conserve = runFormatting(runs[cible.index]!);
          for (const cle of [
            'imageAlt',
            'imageCropTopPct',
            'imageCropRightPct',
            'imageCropBottomPct',
            'imageCropLeftPct',
            'imageCaption',
            'imageCaptionPosition',
            'imageCaptionAlign',
            'imageCaptionManual',
            'imageMarginPt',
            'imageCaptionGapPt',
            // The wrapping follows the same rule: going back into the text flow must make the floating geometry disappear, and a merge of the old formatting would leave it in place.
            ...WRAP_FORMAT_KEYS,
          ] as const) {
            delete conserve[cle];
          }
          runs[cible.index] = makeRun(runs[cible.index]!.text, {
            ...conserve,
            imageSrc: attributes.src,
            imageWidthPt: clampSize(attributes.widthPt),
            imageHeightPt: clampSize(attributes.heightPt),
            ...(attributes.alt ? { imageAlt: attributes.alt } : {}),
            ...cropFormatting(attributes.crop),
            ...captionFormatting(attributes.caption),
            ...spacingFormatting(attributes.marginPt, attributes.captionGapPt),
            ...placementFormatting(attributes.wrap),
          });

          const doc = replaceParagraph(current.state.doc, blockId, {
            ...node.paragraph,
            runs: normalizeRuns(runs),
          });
          return commit(current, 'Modifier l’image', {
            ...current.state,
            doc,
            selection: collapsedSelection({
              blockId,
              offset: cible.offset + runs[cible.index]!.text.length,
            }),
          });
        });
        focus();
      },

      /**
       * Resizes an image in place.
       *
       * Touches **only** the two dimensions: all the rest of the formatting is kept as it is. Rebuilding the run as `updateImage` does would erase the caption and the crop on every mouse movement.
       */
      resizeImage: (blockId, offset, widthPt, heightPt) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;
          const cible = imageRunAt(node.paragraph.runs, offset);
          if (!cible) return current;

          const run = node.paragraph.runs[cible.index]!;
          const largeur = clampSize(widthPt);
          const hauteur = clampSize(heightPt);
          if (run.imageWidthPt === largeur && run.imageHeightPt === hauteur) return current;

          const runs = [...node.paragraph.runs];
          runs[cible.index] = { ...run, imageWidthPt: largeur, imageHeightPt: hauteur };

          const doc = replaceParagraph(current.state.doc, blockId, {
            ...node.paragraph,
            runs,
          });
          const next = { ...current.state, doc };
          if (!transactionAutorisee(lectureSeuleRef.current, current.state, next)) return current;
          // The whole drag forms one history entry.
          return commit(current, 'Redimensionner l’image', next, dragGroup(`img:${blockId}:${offset}`));
        });
      },

      deleteImage: (blockId, offset) => {
        setSession((current) => {
          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          const cible = imageRunAt(node.paragraph.runs, offset);
          if (!cible) return current;

          const runs = node.paragraph.runs.filter((_, index) => index !== cible.index);
          const doc = replaceParagraph(current.state.doc, blockId, {
            ...node.paragraph,
            runs: normalizeRuns(runs, formattingAt(node.paragraph.runs, cible.offset)),
          });
          return commit(current, 'Supprimer l’image', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: cible.offset }),
          });
        });
        focus();
      },

      goToBlock: (blockId) => {
        move((state) => setSelection(state, collapsedSelection({ blockId, offset: 0 })));
        focus();
      },
      insertPageBreak: () => {
        run('Saut de page', (state) => insertBlockPageBreak(state));
        focus();
      },
      undo: () => {
        setSession((current) => undo(current));
        focus();
      },
      redo: () => {
        setSession((current) => redo(current));
        focus();
      },
      selectAll: () => {
        move((state) => selectAll(state));
        focus();
      },
      updateDocument: (label, transform, settingId) => {
        run(
          label,
          (state) => {
            const doc = transform(state.doc);
            if (doc === state.doc) return state;
            // The cursor stays where it is; the reframing is only for the case where the setting would have shortened the document under it.
            return { ...state, doc, selection: clampSelection(doc, state.selection) };
          },
          settingId ? () => settingsGroup(settingId) : undefined,
        );
      },
      applyRemote: (transform, remapSelection) => {
        setSession((current) => {
          const doc = transform(current.state.doc);
          if (doc === current.state.doc) return current;

          const selection = remapSelection
            ? remapSelection(current.state.selection)
            : current.state.selection;

          // The remote change does **not** go into the local history: `Ctrl+Z` undoes what we did ourselves, never what somebody else wrote. This is also why we write `state` directly rather than going through `commit`.
          return {
            ...current,
            state: {
              ...current.state,
              doc,
              selection: clampSelection(doc, selection),
            },
          };
        });
      },
    }),
    [run, move, patchRun, patchParagraph, focus],
  );

  /* --------------------------------------------------------------- keyboard */

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const { key, shiftKey, altKey } = event;
      const meta = event.ctrlKey || event.metaKey;
      const granularity = meta || altKey ? 'word' : 'character';

      /**
       * Places the cursor, extending the selection if `Shift` is held.
       *
       * The target is a **function** of the current state, not a value: that is what makes a held arrow key correct, whose repeats can arrive in the same render batch.
       */
      const goTo = (
        target: (current: EditorState) => { position: DocumentPosition; desiredX: number | null } | null,
      ): void => {
        event.preventDefault();
        move((current) => {
          const next = target(current);
          if (!next) return current;
          return setSelection(
            current,
            shiftKey
              ? makeSelection(current.selection.anchor, next.position, next.desiredX)
              : collapsedSelection(next.position),
          );
        });
      };

      if (meta && !shiftKey) {
        switch (key.toLowerCase()) {
          case 'b': event.preventDefault(); commands.toggleBold(); return;
          case 'i': event.preventDefault(); commands.toggleItalic(); return;
          case 'u': event.preventDefault(); commands.toggleUnderline(); return;
          case 'a': event.preventDefault(); commands.selectAll(); return;
          case 'z': event.preventDefault(); commands.undo(); return;
          case 'y': event.preventDefault(); commands.redo(); return;
          case 'm': event.preventDefault(); commands.clearFormatting(); return;
          case 'l': event.preventDefault(); commands.setAlignment('left'); return;
          case 'e': event.preventDefault(); commands.setAlignment('center'); return;
          case 'r': event.preventDefault(); commands.setAlignment('right'); return;
          case 'j': event.preventDefault(); commands.setAlignment('justify'); return;
          case 'k': event.preventDefault(); hooksRef.current.onOpenLink?.(); return;
          case 'f': event.preventDefault(); hooksRef.current.onOpenFindReplace?.(); return;
          case 'p': event.preventDefault(); hooksRef.current.onPrint?.(); return;
          case ']': event.preventDefault(); commands.indent(1); return;
          case '[': event.preventDefault(); commands.indent(-1); return;
          case '\\': event.preventDefault(); commands.clearFormatting(); return;
          default: break;
        }
      }

      if (meta && shiftKey) {
        switch (key.toLowerCase()) {
          // `Ctrl+Shift+Z` redoes, like `Ctrl+Y`: the two conventions coexist depending on the platform, and refusing either would surprise half of the users.
          case 'z': event.preventDefault(); commands.redo(); return;
          case 'x': event.preventDefault(); commands.toggleStrike(); return;
          case 'e': event.preventDefault(); hooksRef.current.onOpenMath?.(); return;
          case '&': case '7': event.preventDefault(); commands.toggleList('ordered'); return;
          case 'é': case '8': event.preventDefault(); commands.toggleList('bullet'); return;
          case '"': case '9': event.preventDefault(); commands.toggleList('task'); return;
          case '<': event.preventDefault(); commands.adjustFontSize(-1); return;
          case '>': event.preventDefault(); commands.adjustFontSize(1); return;
          default: break;
        }
      }

      if (meta && key >= '1' && key <= '6' && !shiftKey) {
        event.preventDefault();
        commands.setHeadingLevel(Number(key) as 1 | 2 | 3 | 4 | 5 | 6);
        return;
      }

      switch (key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          event.preventDefault();
          const direction = key === 'ArrowLeft' ? -1 : 1;
          goTo((current) => {
            // A non-empty selection collapses to the edge we are moving toward, rather than taking a step from the head: it is the behavior expected everywhere, and it avoids losing a character on the way.
            if (!current.selection.isCollapsed && !shiftKey) {
              const { start, end } = normalizeSelection(current.doc, current.selection);
              return { position: direction < 0 ? start : end, desiredX: null };
            }
            return {
              position: moveHorizontal(
                current.doc,
                current.selection.focus,
                direction,
                granularity,
              ),
              desiredX: null,
            };
          });
          return;
        }

        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const direction = key === 'ArrowUp' ? -1 : 1;
          goTo((current) =>
            moveVertical(
              layout,
              current.selection.focus,
              direction,
              current.selection.desiredX ?? null,
              measurer,
            ),
          );
          return;
        }

        case 'Home':
        case 'End': {
          event.preventDefault();
          goTo((current) => {
            // `Ctrl+Home` / `Ctrl+End` target the document; without `Ctrl`, the **visual** line, not the paragraph: on a paragraph wrapped into five lines, `End` stops at the end of the line we are on.
            if (meta) {
              const edge = documentEdgeOffset(current.doc, key === 'Home' ? 'start' : 'end');
              return edge ? { position: edge, desiredX: null } : null;
            }
            const bounds = lineBounds(layout, current.selection.focus);
            if (!bounds) return null;
            return {
              position: {
                blockId: current.selection.focus.blockId,
                offset: key === 'Home' ? bounds.start : bounds.end,
              },
              desiredX: null,
            };
          });
          return;
        }

        case 'Backspace':
        case 'Delete': {
          event.preventDefault();
          const direction = key === 'Backspace' ? -1 : 1;
          run(
            'Suppression',
            (current) =>
              direction < 0
                ? deleteBackward(current, granularity)
                : deleteForward(current, granularity),
            (before, after) => {
              const removed = removedCharacter(before, direction);
              if (!removed) return null;
              return deletionGroup(
                before.selection.focus.blockId,
                before.selection.focus.offset,
                after.selection.focus.offset,
                removed,
              );
            },
          );
          return;
        }

        case 'Enter': {
          event.preventDefault();
          if (meta) commands.insertPageBreak();
          else if (shiftKey) run('Saut de ligne', (current) => insertLineBreak(current));
          else run('Nouveau paragraphe', (current) => splitParagraph(current));
          return;
        }

        // `Shift+F10` and the Menu key open the context menu. Without them, the table commands could only be reached with the mouse. The invisible input area follows the cursor: its rectangle **is** the cursor's position on
        // screen.
        case 'ContextMenu': {
          event.preventDefault();
          const box = inputRef.current?.getBoundingClientRect();
          hooksRef.current.onOpenContextMenu?.(box?.left ?? 0, box?.bottom ?? 0);
          return;
        }

        case 'F10': {
          if (!shiftKey) break;
          event.preventDefault();
          const box = inputRef.current?.getBoundingClientRect();
          hooksRef.current.onOpenContextMenu?.(box?.left ?? 0, box?.bottom ?? 0);
          return;
        }

        case 'Tab': {
          // The tab character stays in the document: leaving the editor with the keyboard is done with `Escape` and then `Tab`, otherwise you could never insert one.
          event.preventDefault();

          // In a table, `Tab` moves from cell to cell, a convention shared by Word, Google Docs and Writer. It takes priority over the two other uses: it is the only way to fill a grid with the keyboard, and a tab in a narrow
          // cell makes little sense.
          if (tableRef.current) {
            commands.goToAdjacentCell(!shiftKey);
            return;
          }

          if (shiftKey) {
            commands.indent(-1);
            return;
          }
          // At the start of a list item, `Tab` nests; elsewhere, it inserts a real tab. This is Writer's rule: the indent takes priority where it has a structural meaning.
          setSession((current) => {
            const node = currentNode(current.state);
            if (node?.listKind !== undefined && current.state.selection.focus.offset === 0) {
              return commit(current, 'Niveau de liste', changeListLevel(current.state, 1));
            }
            return commit(current, 'Tabulation', insertText(current.state, '\t'));
          });
          return;
        }

        case 'Escape':
          event.preventDefault();
          inputRef.current?.blur();
          return;

        default:
          break;
      }
    },
    // No dependency on the state any more: the handler only reads `current`, supplied by the reducer. It therefore stays stable from one render to the next.
    [layout, measurer, move, run, commands],
  );

  /* ------------------------------------------------------- text input */

  /**
   * Text input, wired to the **native** `beforeinput` event.
   *
   * React does expose an `onBeforeInput`, but it is an emulator built on `keypress` and `textInput`: it does not carry `inputType`. Yet it is precisely through `inputType` that virtual keyboards announce their deletions
   * (`deleteContentBackward`), dictation its insertion and the browser its autocompletion: all cases that, without this, would modify the buffer area without ever reaching the model.
   */
  const handleBeforeInput = useCallback(
    (event: InputEvent) => {
      // During a composition (Asian input method, dictation), we let the browser work: the text only arrives at the end.
      if (composing.current) return;

      // Nothing the browser does in the buffer area must remain: the document is the only source of truth.
      event.preventDefault();

      const data = event.data ?? '';

      switch (event.inputType) {
        case 'insertText':
        case 'insertFromPaste':
        case 'insertFromDrop':
        case 'insertReplacementText':
        case 'insertFromYank':
          if (!data) return;
          run(
            'Saisie',
            (state) => insertText(state, data),
            (before, after) =>
              typingGroup(
                before.selection.focus.blockId,
                before.selection.focus.offset,
                after.selection.focus.offset,
                data,
              ),
          );
          return;

        case 'insertLineBreak':
          run('Saut de ligne', (state) => insertLineBreak(state));
          return;

        case 'insertParagraph':
          run('Nouveau paragraphe', (state) => splitParagraph(state));
          return;

        case 'deleteContentBackward':
        case 'deleteByCut':
          run('Suppression', (state) => deleteBackward(state));
          return;

        case 'deleteContentForward':
          run('Suppression', (state) => deleteForward(state));
          return;

        case 'deleteWordBackward':
          run('Suppression', (state) => deleteBackward(state, 'word'));
          return;

        case 'deleteWordForward':
          run('Suppression', (state) => deleteForward(state, 'word'));
          return;

        case 'historyUndo':
          setSession((current) => undo(current));
          return;

        case 'historyRedo':
          setSession((current) => redo(current));
          return;

        default:
          // Unknown type: we have already prevented the default effect, so nothing happens, which is better than a silent change of the buffer area that the model would ignore.
          return;
      }
    },
    [run],
  );

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.addEventListener('beforeinput', handleBeforeInput);
    return () => node.removeEventListener('beforeinput', handleBeforeInput);
  }, [handleBeforeInput]);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      composing.current = false;
      const data = event.data;
      // The buffer area is emptied: it only serves to collect the composition, the text now lives in the model.
      if (inputRef.current) inputRef.current.value = '';
      if (!data) return;
      run('Saisie', (state) => insertText(state, data));
    },
    [run],
  );

  /* --------------------------------------------------------- clipboard */

  const onCopy = useCallback(
    (event: React.ClipboardEvent) => {
      const text = selectionText(session.state);
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      lastCopied = { text, fragment: extractFragment(session.state) };
    },
    [session.state],
  );

  const onCut = useCallback(
    (event: React.ClipboardEvent) => {
      const text = selectionText(session.state);
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      lastCopied = { text, fragment: extractFragment(session.state) };
      run('Couper', (state) => deleteBackward(state));
    },
    [session.state, run],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;

      if (lastCopied && lastCopied.text === text) {
        const fragment = lastCopied.fragment;
        run('Coller', (state) => insertFragment(state, fragment));
        return;
      }
      // Paste from elsewhere: we respect at least the line ends, turning them into real paragraphs.
      const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
      run('Coller', (state) =>
        insertFragment(state, {
          paragraphs: paragraphs.map((line) => ({
            runs: [{ text: line }],
            attributes: { type: 'paragraph' as const },
          })),
        }),
      );
    },
    [run],
  );

  /* ---------------------------------------------------------------- mouse */

  /** Pointer coordinates in the content area of a page. */
  const pointToContent = useCallback(
    // A `MouseEvent` is enough: the function only reads `currentTarget` and the window coordinates, which are common to all pointer events.
    (event: React.MouseEvent<HTMLDivElement>): { x: number; y: number } => {
      const rect = event.currentTarget.getBoundingClientRect();
      // The rectangle is already scaled by the zoom: we divide to get back to the model's coordinates, which knows nothing about the zoom.
      const x = (event.clientX - rect.left) / zoom - layout.geometry.contentLeftPx;
      const y = (event.clientY - rect.top) / zoom - layout.geometry.contentTopPx;
      return { x, y };
    },
    [zoom, layout.geometry],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      if (event.button !== 0) return;
      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      if (!position) return;

      event.preventDefault();
      focus();

      const paragraph = paragraphIndex(session.state.doc).byId.get(position.blockId)?.paragraph;

      if (event.detail >= 3 && paragraph) {
        // Triple click: the whole paragraph.
        const length = paragraphText(paragraph).length;
        move((state) =>
          setSelection(
            state,
            makeSelection(
              { blockId: position.blockId, offset: 0 },
              { blockId: position.blockId, offset: length },
            ),
          ),
        );
        return;
      }

      if (event.detail === 2 && paragraph) {
        const mathRun = paragraph.runs.find((r) => r.mathLatex);
        if (mathRun?.mathLatex) {
          hooksRef.current.onEditMath?.(
            position.blockId,
            mathRun.mathLatex,
            Boolean(mathRun.mathDisplay),
          );
          return;
        }

        const { start, end } = wordRangeAt(paragraphText(paragraph), position.offset);
        move((state) =>
          setSelection(
            state,
            makeSelection(
              { blockId: position.blockId, offset: start },
              { blockId: position.blockId, offset: end },
            ),
          ),
        );
        return;
      }

      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      move((state) =>
        setSelection(
          state,
          event.shiftKey
            ? makeSelection(state.selection.anchor, position)
            : collapsedSelection(position),
        ),
      );
    },
    [layout, measurer, pointToContent, focus, move, session.state.doc],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      if (!dragging.current) return;
      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      if (!position) return;
      move((state) => setSelection(state, makeSelection(state.selection.anchor, position)));
    },
    [layout, measurer, pointToContent, move],
  );

  /**
   * Right click: places the cursor, then lets the caller open the menu.
   *
   * The cursor does **not** move if the click falls inside the current selection. It is the rule of all editors, and it is essential here: without it, a right click on a line selected to delete it would first collapse
   * the selection, and the command would act on nothing.
   */
  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, pageIndex: number) => {
      event.preventDefault();
      focus();

      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      // The reference is assigned at render time: it is therefore already set by the time a pointer event can arrive.
      const state = sessionRef.current?.state;

      if (position && state) {
        const { start, end } = normalizeSelection(state.doc, state.selection);
        const inside =
          !state.selection.isCollapsed &&
          comparePositions(state.doc, position, start) >= 0 &&
          comparePositions(state.doc, position, end) <= 0;
        if (!inside) move((current) => setSelection(current, collapsedSelection(position)));
      }

      hooksRef.current.onOpenContextMenu?.(event.clientX, event.clientY);
    },
    [layout, measurer, pointToContent, focus, move],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, _pageIndex: number) => {
      if (!dragging.current) return;
      dragging.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const setZoom = useCallback((next: number) => {
    setZoomState(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  const onFocusInput = useCallback(() => setFocused(true), []);
  const onBlurInput = useCallback(() => setFocused(false), []);

  /**
   * Bundle of handlers, with a stable identity.
   *
   * Each handler is already held by a `useCallback`; what was missing was the identity of the **object** that carries them. Rebuilt on every render, it spread its instability to everything that depends on it, first of
   * all `onPagePointerDown`, passed down to the sheets.
   */
  const handlers = useMemo(
    () => ({
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onFocus: onFocusInput,
      onBlur: onBlurInput,
      onCopy,
      onCut,
      onPaste,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onContextMenu,
    }),
    [
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onFocusInput,
      onBlurInput,
      onCopy,
      onCut,
      onPaste,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onContextMenu,
    ],
  );

  return {
    session,
    layout,
    measurer,
    activeFormat,
    currentParagraph,
    table,
    caret,
    rects,
    rectsByPage,
    placementsByPage,
    isFocused,
    canUndo: canUndo(session),
    canRedo: canRedo(session),
    zoom,
    setZoom,
    inputRef,
    focus,
    run,
    commands,
    handlers,
  };
}

/* ------------------------------------------------------------------ tools */

/** Paragraph where the cursor's head is. */
function currentNode(state: EditorState): ParagraphNode | null {
  return paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)?.paragraph ?? null;
}

/** Character that a deletion is about to remove, for undo grouping. */
function removedCharacter(state: EditorState, direction: -1 | 1): string | null {
  if (!state.selection.isCollapsed) return null;
  const position = state.selection.focus;
  const paragraph = paragraphIndex(state.doc).byId.get(position.blockId)?.paragraph;
  if (!paragraph) return null;

  const text = paragraphText(paragraph);
  const other = moveHorizontal(state.doc, position, direction, 'character');
  if (other.blockId !== position.blockId) return null;

  const from = Math.min(position.offset, other.offset);
  const to = Math.max(position.offset, other.offset);
  return to > from ? text.slice(from, to) : null;
}

/** First or last position of the document (`Ctrl+Home` / `Ctrl+End`). */
function documentEdgeOffset(
  doc: WriterDocumentState,
  edge: 'start' | 'end',
): { blockId: string; offset: number } | null {
  const { order, byId } = paragraphIndex(doc);
  const id = edge === 'start' ? order[0] : order[order.length - 1];
  if (!id) return null;
  const paragraph = byId.get(id)?.paragraph;
  if (!paragraph) return null;
  return { blockId: id, offset: edge === 'start' ? 0 : paragraphText(paragraph).length };
}
