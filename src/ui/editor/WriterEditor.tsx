// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * The complete assembled editor: menu bar, ribbon with vector icons, graduated ruler, document outline (DocumentOutline), find/replace, command palette (Ctrl+K), math formula editor (MathDialog),
 * ergonomic page headers and footers (PageFurnitureDialog), styles/margins dialogs and physical A4 sheets.
 *
 * A 100 % native OpenOffice Writer (sw) engine with no external rich-text library.
 */

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  DocumentDefaults,
  DocumentSelection,
  PageSetup,
  WriterDocumentState,
} from '../../domain/document/types';
import { paragraphIndex, paragraphText } from '../../domain/document/document';
import { imageKey } from '../../domain/document/images';
import { locateOffset } from '../../domain/document/runs';
import { mmToPt, ptToMm, ptToPx, pxToPt } from '../../domain/document/units';
import { fitToContentWidth, type ImageWrapPlacement } from '../../domain/document/images';
import { probeImageSize, readFileAsDataUrl } from '../../domain/image/raster';
import { DEFAULT_FURNITURE, type FurnitureBand } from '../../domain/document/pageFurniture';
import { A4Page, AUCUN_RECT, AUCUNE_OCCURRENCE, AUCUN_PLACEMENT, type SearchRect } from './A4Page';
import type { ImageContext } from './ParagraphView';
import { useWriterInput, imageDraftAt } from './useWriterInput';
import { Ribbon } from '../components/Ribbon';
import { MenuBar, type MenuDefinition } from '../components/MenuBar';
import { ContextMenu } from '../components/ContextMenu';
import { DocumentTitle } from '../components/DocumentTitle';
import { Ruler } from '../components/Ruler';
import { DocumentOutline } from '../components/DocumentOutline';
import { FindReplacePanel, type FindReplaceState } from '../dialogs/FindReplacePanel';
import { CommandPalette, type PaletteCommand } from '../dialogs/CommandPalette';
import { StylesAndMarginsDialog } from '../dialogs/StylesAndMarginsDialog';
import { FootnoteDialog } from '../dialogs/FootnoteDialog';
import { BookmarkDialog, CommentDialog } from '../dialogs/AnnotationDialog';
import { CommentBand, COMMENT_BAND_WIDTH_PX } from './CommentBand';
import { commentAnchors, commentThreads } from '../../domain/document/comments';
import { listBookmarks } from '../../domain/document/bookmarks';
import { listRedlineRanges } from '../../domain/document/redline';
import { selectionText } from '../../domain/engine/edit';
import { LiveRegion } from '../components/LiveRegion';
import { MathDialog, type MathDraft } from '../dialogs/MathDialog';
import { ImageDialog, type ImageDraft } from '../dialogs/ImageDialog';
import { PageFurnitureDialog } from '../dialogs/PageFurnitureDialog';
import { HelpDialog } from '../dialogs/HelpDialog';
import {
  findMatches,
  matchNearest,
  matchRange,
  replaceAll,
  replaceMatch,
  selectMatch,
} from '../../domain/engine/search';
import { normalizeSelection, positionFromPoint, rangeRects } from '../../domain/engine/cursor';
import { downloadPdfWithImages, printDocument } from '../../domain/pdf';
import { shortcutLabel } from '../shortcuts';
import { PresenceAvatars } from '../../design/components/PresenceAvatars';
import { Icon } from '../../design/icons/Icon';
import type { ConnectionStatus, PeerPresence } from '../../domain/collab/session';
import './editor.css';

const PAGE_GAP_PX = 16;
/** Horizontal padding of the page surface, gutters included. */
const SURFACE_GUTTER_PX = 24;

/** Gap between the right edge of the sheet and the comment band. */
const COMMENT_GUTTER_GAP_PX = 16;

/**
 * Three connection states, no more.
 *
 * "Reconnecting" and "attempt 4 of 7" tell the writer the same thing: that it is not getting through yet. The detail belongs in the logs.
 */
const CONNEXION_LIBELLE: Record<ConnectionStatus, string> = {
  local: 'Local',
  connecting: 'Connexion…',
  connected: 'Synchronisé',
  offline: 'Hors ligne',
};

const CONNEXION_AIDE: Record<ConnectionStatus, string> = {
  local: 'Document non partagé : il vit dans cet onglet.',
  connecting: 'Connexion au serveur de partage…',
  connected: 'Vos modifications sont enregistrées et partagées.',
  offline:
    'Serveur injoignable. Vous pouvez continuer à écrire : tout repartira au retour du réseau.',
};

export interface WriterEditorProps {
  initialDocument: WriterDocumentState;
  showMargins?: boolean;
  onSave?: (doc?: WriterDocumentState) => void;
  onOpen?: () => void;
  onLoadSample?: () => void;
  onPrint?: () => void;
  onExportPdf?: () => void;
  onTitleChange?: (title: string) => void;
  /**
   * Sharing. When absent, the editor works exactly as before: the document lives in this tab, and nothing goes out on the network.
   */
  collab?: CollabBinding;
}

/** What the editor expects from the sharing layer, and nothing more. */
export interface CollabBinding {
  status: ConnectionStatus;
  peers: readonly PeerPresence[];
  self: { userId: string; displayName: string; color: string } | null;
  pending: number;
  rejection: string | null;
  canWrite: boolean;
  /** True when the document is actually shared. */
  shared: boolean;
  /** A new local state to publish. */
  publish: (doc: WriterDocumentState) => void;
  setCursor: (cursor: { blockId: string; offset: number } | null) => void;
  clearRejection: () => void;
  onOpenShare: () => void;
  /**
   * Uploads an image to the server and returns its address.
   *
   * Returns `null` when the document is not shared or when the upload fails: the image then stays as a `data:` URL, which works but makes every synchronization of the paragraph that carries it heavier.
   */
  uploadImage: (dataUrl: string) => Promise<string | null>;
  /**
   * Receives the command that applies a remote change. The editor calls it **once**, on opening: that is how the sharing layer gets something to write into the document with, without owning it.
   */
  bindApplyRemote: (
    apply: (
      transform: (doc: WriterDocumentState) => WriterDocumentState,
      remapSelection?: (selection: DocumentSelection) => DocumentSelection,
    ) => void,
  ) => void;
}

export function WriterEditor({
  initialDocument,
  showMargins = true,
  onSave,
  onOpen,
  onLoadSample,
  onPrint,
  onExportPdf,
  onTitleChange,
  collab,
}: WriterEditorProps): JSX.Element {
  const openMathDialogRef = useRef<() => void>(() => {});
  const editMathRef = useRef<(blockId: string, latex: string, display: boolean) => void>(() => {});
  const openImageDialogRef = useRef<() => void>(() => {});
  const editImageRef = useRef<(blockId: string, offset: number) => void>(() => {});
  const printRef = useRef<() => void>(() => {});
  const findReplaceRef = useRef<() => void>(() => {});

  // Shared without write permission: the editor becomes a viewer. We do not wait for the server's refusal to say so; see `WriterHooks.readOnly`.
  const lectureSeule = collab?.shared === true && !collab.canWrite;

  const controller = useWriterInput(initialDocument, {
    readOnly: lectureSeule,
    onPrint: () => printRef.current(),
    onOpenFindReplace: () => findReplaceRef.current(),
    onOpenLink: () => linkButtonRef.current?.click(),
    onOpenMath: () => openMathDialogRef.current(),
    onEditMath: (blockId, latex, display) => editMathRef.current(blockId, latex, display),
    onOpenImage: () => openImageDialogRef.current(),
    onEditImage: (blockId, offset) => editImageRef.current(blockId, offset),
    onOpenContextMenu: (x, y) => setContextMenuAt({ x, y }),
  });
  const {
    layout,
    caret,
    rectsByPage,
    placementsByPage,
    session,
    currentParagraph,
    table,
    zoom,
    setZoom,
    inputRef,
    handlers,
    focus,
    run,
    measurer,
    commands,
    canUndo,
    canRedo,
  } = controller;

  const doc = session.state.doc;
  const geometry = layout.geometry;

  /**
   * The current document, reachable without depending on it.
   *
   * Some callbacks need to read it at the moment the user acts, but they go down to memoized components. Making it a `useCallback` dependency would recreate them on every keystroke and spread the render to the whole
   * document; a ref gives the same reading without the instability.
   */
  const docRef = useRef(doc);
  docRef.current = doc;

  /**
   * What the table handles have to paint.
   *
   * Takes the context computed by the controller and only keeps the geometry: the sheets do not need to know the number of rows, and a reduced object saves them a render on every cursor move within the same cell.
   */
  const activeTable = useMemo(
    () =>
      table
        ? {
            tableId: table.tableId,
            rowIndex: table.rowIndex,
            cellIndex: table.cellIndex,
            rect: table.rect,
          }
        : null,
    [table],
  );

  /**
   * Author of the comments and revisions.
   *
   * The name displayed in a shared session wins: it is the one the other participants see, and signing with a different name in the gutter would make a discussion thread unreadable.
   */
  const authorName = collab?.self?.displayName || doc.meta.author || 'Moi';

  /** Text currently selected: what a comment or a bookmark would anchor. */
  const selectedText = useMemo(() => selectionText(session.state), [session.state]);

  /** Thread whose anchor contains the cursor: it is the one the gutter puts forward. */
  const activeThreadId = useMemo(() => {
    const focusPos = session.state.selection.focus;
    const anchor = commentAnchors(doc).find(
      (candidate) =>
        candidate.blockId === focusPos.blockId &&
        focusPos.offset >= candidate.startOffset &&
        focusPos.offset <= candidate.endOffset,
    );
    return anchor?.threadId ?? null;
  }, [doc, session.state.selection.focus]);

  const bookmarkNames = useMemo(() => listBookmarks(doc).map((mark) => mark.name), [doc]);

  const redlineRanges = useMemo(() => listRedlineRanges(doc), [doc]);
  /** Review mode (`REDLINE_ON`): a local mirror of the state carried by the session. */
  const [reviewing, setReviewing] = useState(false);

  const hasComments = useMemo(() => commentThreads(doc).length > 0, [doc]);

  /**
   * Size of the page stack **before** zoom, gutter included.
   *
   * `transform: scale()` does not resize the layout box: an element that is scaled always takes its original size in the flow. The surface therefore computed its scrollbars on the stack at 100 % whatever the zoom:
   * empty space under the last page below 100 %, cropped and unreachable pages above. These two measurements give the zoom frame a real height and width, equal to what the eye sees.
   */
  const pileHeightPx =
    layout.pages.length * geometry.pageHeightPx +
    Math.max(0, layout.pages.length - 1) * PAGE_GAP_PX;
  const pileWidthPx =
    geometry.pageWidthPx +
    (hasComments ? COMMENT_GUTTER_GAP_PX + COMMENT_BAND_WIDTH_PX : 0);

  /**
   * Fit to width, on opening only.
   *
   * An A4 page is 794 px: on a 412 px phone, the document opened shifted onto its left half and dragged the whole window into horizontal scrolling. So we reduce the opening zoom so that the page fits, and never to
   * enlarge it: a wide screen keeps its 100 %.
   *
   * Only once: after opening, the zoom belongs to the person writing, and rotating the screen must not undo their setting.
   */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const zoomAjusteRef = useRef(false);
  useEffect(() => {
    if (zoomAjusteRef.current || pileWidthPx <= 0) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const disponible = surface.clientWidth - SURFACE_GUTTER_PX;
    if (disponible <= 0) return;
    zoomAjusteRef.current = true;
    if (pileWidthPx <= disponible) return;
    // `setZoom` clamps to [MIN_ZOOM, MAX_ZOOM] by itself.
    setZoom(disponible / pileWidthPx);
  }, [pileWidthPx, setZoom]);

  /**
   * Message announced to screen readers.
   *
   * **Structural** changes (pagination, review mode, number of open threads) cannot be seen with the keyboard: they produce no cursor movement, and without an announcement a blind user never learns that a page has just
   * appeared. Keystrokes, on the other hand, are not announced: the screen reader already reads them, and doubling them would make typing inaudible.
   */
  const announcement = useMemo(() => {
    const parts = [`${layout.pages.length} page${layout.pages.length > 1 ? 's' : ''}`];
    if (reviewing) parts.push('suivi des modifications actif');
    if (redlineRanges.length > 0) parts.push(`${redlineRanges.length} modification(s) en attente`);
    if (lectureSeule) parts.push('document en lecture seule');
    return parts.join(', ');
  }, [layout.pages.length, reviewing, redlineRanges.length, lectureSeule]);

  // UI panel and dialog states
  /** Opening point of the context menu, or `null` if it is closed. */
  const [contextMenuAt, setContextMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [showRuler, setShowRuler] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [stylesMarginsOpen, setStylesMarginsOpen] = useState(false);
  const [footnoteDialogOpen, setFootnoteDialogOpen] = useState(false);
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * The "link" button of the ribbon.
   *
   * The menu and `Ctrl+K` trigger **this** button rather than open a second dialog: one component to maintain, and the panel is anchored where the user expects to see it appear.
   */
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  /** Image grabbed in the editor: handles and action bar. */
  const [imageSelection, setImageSelection] = useState<{ blockId: string; offset: number } | null>(
    null,
  );
  const [furnitureBandToEdit, setFurnitureBandToEdit] = useState<FurnitureBand | null>(null);

  const [findReplaceState, setFindReplaceState] = useState<FindReplaceState>({
    query: '',
    replacement: '',
    options: { matchCase: false, wholeWord: false },
    showReplace: false,
  });

  const handleTitleCommit = useCallback(
    (newTitle: string) => {
      commands.updateDocument('Titre du document', (current) => ({
        ...current,
        meta: {
          ...current.meta,
          title: newTitle,
          updatedAt: new Date().toISOString(),
        },
      }));
      onTitleChange?.(newTitle);
    },
    [commands, doc, onTitleChange],
  );

  const openMathDialog = useCallback(() => {
    const focusPos = session.state.selection.focus;
    const node = paragraphIndex(session.state.doc).byId.get(focusPos.blockId);
    if (node) {
      const { runIndex } = locateOffset(node.paragraph.runs, focusPos.offset);
      const run = node.paragraph.runs[runIndex] ?? node.paragraph.runs[0];
      if (run?.mathLatex) {
        setMathDraft({
          blockId: node.paragraph.id,
          latex: run.mathLatex,
          display: Boolean(run.mathDisplay),
        });
        return;
      }
      const mathRun = node.paragraph.runs.find((r) => r.mathLatex);
      if (mathRun?.mathLatex) {
        setMathDraft({
          blockId: node.paragraph.id,
          latex: mathRun.mathLatex,
          display: Boolean(mathRun.mathDisplay),
        });
        return;
      }
    }
    setMathDraft({ latex: '', display: false });
  }, [session.state]);

  const handleEditMath = useCallback((blockId: string, latex: string, display: boolean) => {
    setMathDraft({ blockId, latex, display });
  }, []);

  /** Width of the printable area: the insertion ceiling for an image. */
  const contentWidthPt = useMemo(() => pxToPt(geometry.contentWidthPx), [geometry.contentWidthPx]);

/**
 * Placement of a frame, flattened for the window's draft.
 *
 * `ImageDraft` is flat because a form is: each field has its own state. The model, for its part, gathers the placement into one object, the only level at which "inline" can make the five other values pointless
 * in one go. This function is the hinge between the two shapes.
 */
function placementDraft(placement: ImageWrapPlacement | undefined): Partial<ImageDraft> {
  if (!placement) return {};
  if (placement.mode === 'inline') return { wrap: 'inline' };
  return {
    wrap: placement.mode,
    ...(placement.horiOrient !== undefined ? { horiOrient: placement.horiOrient } : {}),
    ...(placement.horiRelation !== undefined ? { horiRelation: placement.horiRelation } : {}),
    ...(placement.xPt !== undefined ? { xPt: placement.xPt } : {}),
    ...(placement.yPt !== undefined ? { yPt: placement.yPt } : {}),
    ...(placement.wrapMarginPt !== undefined ? { wrapMarginPt: placement.wrapMarginPt } : {}),
  };
}

  /**
   * Opens the image workshop.
   *
   * If the cursor already touches a frame, we open it **on that frame** rather than offer a new one: it is the expected gesture when you want to resize the image you are on, and it avoids stacking two by accident.
   */
  const openImageDialog = useCallback(() => {
    const position = session.state.selection.focus;
    const node = paragraphIndex(session.state.doc).byId.get(position.blockId);
    const existante = node ? imageDraftAt(node.paragraph.runs, position.offset) : null;

    if (existante) {
      setImageDraft({
        blockId: position.blockId,
        offset: existante.offset,
        src: existante.src,
        widthPt: existante.widthPt,
        heightPt: existante.heightPt,
        alt: existante.alt ?? '',
        ...(existante.crop ? { crop: existante.crop } : {}),
        ...(existante.caption ? { caption: existante.caption } : {}),
        ...(existante.marginPt !== undefined ? { marginPt: existante.marginPt } : {}),
        ...(existante.captionGapPt !== undefined
          ? { captionGapPt: existante.captionGapPt }
          : {}),
        ...placementDraft(existante.wrap),
        figureNumber:
          layout.figureNumbers.get(imageKey(position.blockId, existante.offset)) ??
          layout.figureNumbers.size + 1,
      });
      return;
    }

    setImageDraft({
      src: '',
      widthPt: contentWidthPt / 2,
      heightPt: contentWidthPt / 3,
      alt: '',
      figureNumber: layout.figureNumbers.size + 1,
    });
  }, [session.state, contentWidthPt, layout.figureNumbers]);

  /**
   * Final address of an image, once uploaded where applicable.
   *
   * In a share, a `data:` URL goes to the server **before** entering the document: putting it there first would make the heavy version travel once to every participant, before being replaced by its address.
   *
   * Outside a share, or if the upload fails, the `data:` URL is kept: it displays, exports and saves, only more heavily.
   */
  const uploadImage = collab?.uploadImage;
  const adresseFinale = useCallback(
    async (src: string): Promise<string> => {
      if (!uploadImage || !src.startsWith('data:')) return src;
      return (await uploadImage(src)) ?? src;
    },
    [uploadImage],
  );

  const handleEditImage = useCallback(
    (blockId: string, offset: number) => {
      const node = paragraphIndex(docRef.current).byId.get(blockId);
      const cadre = node ? imageDraftAt(node.paragraph.runs, offset) : null;
      if (!cadre) return;
      setImageDraft({
        blockId,
        offset: cadre.offset,
        src: cadre.src,
        widthPt: cadre.widthPt,
        heightPt: cadre.heightPt,
        alt: cadre.alt ?? '',
        ...(cadre.crop ? { crop: cadre.crop } : {}),
        ...(cadre.caption ? { caption: cadre.caption } : {}),
        // Without these two, reopening the window to change something else reset the spacings to their default value: a margin set to zero went back to 4 px with nothing having asked for it.
        ...(cadre.marginPt !== undefined ? { marginPt: cadre.marginPt } : {}),
        ...(cadre.captionGapPt !== undefined ? { captionGapPt: cadre.captionGapPt } : {}),
        // How the image fits into the text: the window must reopen on the current mode, otherwise validating a simple caption change would bring the image back into the text flow.
        ...placementDraft(cadre.wrap),
        figureNumber:
          layout.figureNumbers.get(imageKey(blockId, cadre.offset)) ??
          layout.figureNumbers.size + 1,
      });
    },
    /*
     * `layout.figureNumbers` is now canonicalized and only changes with the numbers themselves; the document, for its part, changes on every keystroke. It is therefore read by reference: this callback goes down to the
     * memoized paragraphs, and depending on it would have made all of them render at every character typed.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docRef, layout.figureNumbers],
  );

  /**
   * Inserting an image dropped onto the page.
   *
   * Drag and drop bypasses the dialog: the size is that of the image, brought down to the printable width, exactly as `SwFEShell::Insert` would. A dialog at that moment would lose the gesture.
   */
  const handleDropImage = useCallback(
    async (dataUrl: string) => {
      try {
        const naturelle = await probeImageSize(dataUrl);
        const taille = fitToContentWidth(naturelle.widthPx, naturelle.heightPx, contentWidthPt);
        commands.insertImage({ src: await adresseFinale(dataUrl), ...taille });
      } catch {
        // Undecodable image: we open the workshop, which will say why.
        setImageDraft({ src: dataUrl, widthPt: contentWidthPt / 2, heightPt: contentWidthPt / 3, alt: '' });
      }
    },
    [commands, contentWidthPt, adresseFinale],
  );

  /**
   * PDF export through the binary engine (`vcl::PDFWriter`).
   *
   * The engine of `domain/pdf/export.ts` writes the PDF 1.4 structure from the **same** layout as the screen: same line breaks, same pages, same notes. `window.print()` on the contrary goes back through the browser's
   * rendering engine, which paginates in its own way: two different documents for one content.
   *
   * Printing, for its part, keeps the browser's dialog: it is the system driver that must be reached, not a file.
   */
  const handleExportPdf = useCallback(() => {
    if (onExportPdf) {
      onExportPdf();
      return;
    }
    void downloadPdfWithImages(doc, layout, `${doc.meta.title || 'document'}.pdf`).catch(() => {
      // The binary engine gave up (font not found, undecodable image). The print dialog remains a complete path to a PDF, and it takes over rather than leave the user with no export.
      printDocument(doc.meta.title);
    });
  }, [onExportPdf, doc, layout]);

  const handlePrint = useCallback(() => {
    if (onPrint) {
      onPrint();
    } else {
      printDocument(doc.meta.title);
    }
  }, [onPrint, doc]);

  openMathDialogRef.current = openMathDialog;
  editMathRef.current = handleEditMath;
  openImageDialogRef.current = openImageDialog;
  editImageRef.current = handleEditImage;
  printRef.current = handlePrint;
  findReplaceRef.current = () => setFindReplaceOpen(true);

  /* ------------------------------------------------------------- sharing */

  // The remote-apply command is handed **once** to the sharing layer. Giving it again on every render would recreate the WebSocket session, so reconnect on every keystroke.
  const bindApplyRemote = collab?.bindApplyRemote;
  const applyRemote = commands.applyRemote;
  useEffect(() => {
    bindApplyRemote?.(applyRemote);
  }, [bindApplyRemote, applyRemote]);

  /**
   * Publication of the local state.
   *
   * We publish the document **after** rendering, not in the command: a command that emitted by itself would have to know about the network, and the editor would stop working in isolation. Here, sharing is just one more
   * observer.
   */
  const publish = collab?.publish;
  // `useLayoutEffect` and not `useEffect`: the publication must happen in the same task as the keystroke that produced it. A passive effect is pushed to a later task, and a remote frame received in between would make us
  // read back a replicated document where the keystroke is not there yet, so it would be lost in favor of the state that came from the network.
  useLayoutEffect(() => {
    publish?.(doc);
  }, [publish, doc]);

  // The cursor follows, but is not published on typing: it is the session that announces it at regular intervals, otherwise every move would produce a frame.
  const setCursor = collab?.setCursor;
  useEffect(() => {
    const position = session.state.selection.focus;
    setCursor?.({ blockId: position.blockId, offset: position.offset });
  }, [setCursor, session.state.selection.focus]);

  // Initial focus
  useEffect(() => {
    focus();
  }, [focus]);

  /**
   * Shortcuts that must work even when the focus has left the document: in a dialog, the ruler or the outline.
   *
   * `Ctrl+K` and `Ctrl+F` are deliberately **absent**: the controller already handles them. Handling them here too would trigger them twice, since `preventDefault` does not stop propagation: `Ctrl+K` opened the link
   * *and* the palette.
   */
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === 'p') {
        // Convention of command palettes, shared with code editors: `Ctrl+K` stays with the hyperlink, as in Writer and Word.
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        openMathDialog();
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        openImageDialog();
      } else if (meta && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handlePrint();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handlePrint, openMathDialog, openImageDialog]);

  /**
   * Statistics of the status bar.
   *
   * Deferred, and not computed in real time: the count walks the whole document, and it used to be redone at every character typed, on the critical path of typing, for a display that nobody expects to be synchronous.
   * `useDeferredValue` lets React lay out the page and the cursor first, then catch up on the count when typing pauses. The figure shown may lag by a keystroke or two; typing latency, for its part, no longer depends on
   * the size of the document.
   */
  const docPourStatistiques = useDeferredValue(doc);
  const statistics = useMemo(
    () => computeStatistics(docPourStatistiques),
    [docPourStatistiques],
  );

  // Find & Replace
  const matches = useMemo(
    () => (findReplaceOpen && findReplaceState.query ? findMatches(doc, findReplaceState.query, findReplaceState.options) : []),
    [doc, findReplaceOpen, findReplaceState.query, findReplaceState.options],
  );

  /**
   * Rank of the current match.
   *
   * We locate from the **start** of the selection, not from its head: a selected match has its head at its own end, so starting from the head would already designate the next match, and `Enter` would skip every other
   * one.
   */
  const currentMatchIndex = useMemo(() => {
    if (matches.length === 0) return -1;
    const { start } = normalizeSelection(doc, session.state.selection);
    return matchNearest(doc, matches, start);
  }, [doc, matches, session.state.selection]);

  /**
   * Rectangles of all the matches.
   *
   * Highlighting **all** the matches, and not only the current one, lets you judge at a glance whether the searched word is the right one: a counter alone forces you to go through the document to make sure.
   *
   * The geometry comes from the engine (`rangeRects`), the same as the selection's: two separate computations would end up diverging.
   */
  const searchRects = useMemo(() => {
    if (matches.length === 0) return [];
    return matches.flatMap((match, index) => {
      const { start, end } = matchRange(match);
      return rangeRects(layout, start, end, measurer).map((rect) => ({
        rect,
        current: index === currentMatchIndex,
      }));
    });
  }, [matches, currentMatchIndex, doc, layout, measurer]);

  /**
   * Matches grouped by page.
   *
   * Sparse like `rectsByPage`, and for the same reason: with the search closed, the table is empty and **all** the sheets receive the same frozen constant, so none sees its prop change identity.
   */
  const searchRectsByPage = useMemo(() => {
    const pages = new Map<number, SearchRect[]>();
    for (const entree of searchRects) {
      const liste = pages.get(entree.rect.pageIndex);
      if (liste) liste.push(entree);
      else pages.set(entree.rect.pageIndex, [entree]);
    }
    return pages;
  }, [searchRects]);

  const handleSearchNavigate = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const nextIndex = (currentMatchIndex + direction + matches.length) % matches.length;
      const targetMatch = matches[nextIndex];
      if (targetMatch) {
        run('Sélectionner occurrence', (state) => selectMatch(state, targetMatch));
      }
    },
    [matches, currentMatchIndex, run],
  );

  const handleSearchReplace = useCallback(() => {
    if (matches.length === 0 || currentMatchIndex < 0) return;
    const targetMatch = matches[currentMatchIndex];
    if (targetMatch) {
      run('Remplacer', (state) =>
        replaceMatch(state, targetMatch, findReplaceState.replacement),
      );
    }
  }, [matches, currentMatchIndex, findReplaceState.replacement, run]);

  const handleSearchReplaceAll = useCallback(() => {
    if (!findReplaceState.query) return;
    run('Tout remplacer', (state) =>
      replaceAll(state, findReplaceState.query, findReplaceState.options, findReplaceState.replacement).state,
    );
  }, [findReplaceState, run]);

  // Selecting a heading from the document outline
  const handleSelectHeading = useCallback(
    (blockId: string) => {
      commands.goToBlock(blockId);
      focus();
    },
    [commands, focus],
  );

  // Updating the default margins and styles
  const handleSavePageSetupAndDefaults = useCallback(
    (nextPageSetup: PageSetup, nextDefaults: DocumentDefaults) => {
      commands.updateDocument('Mise en page', (current) => ({
        ...current,
        pageSetup: nextPageSetup,
        defaults: nextDefaults,
      }));
      focus();
    },
    [commands, doc, focus],
  );

  // Changing the margins from the ruler
  const handleRulerMarginChange = useCallback(
    (margins: { leftMm?: number; rightMm?: number }) => {
      commands.updateDocument(
        'Marges',
        (current) => ({
          ...current,
          pageSetup: {
            ...current.pageSetup,
            ...(margins.leftMm !== undefined ? { marginLeftMm: margins.leftMm } : {}),
            ...(margins.rightMm !== undefined ? { marginRightMm: margins.rightMm } : {}),
          },
        }),
        'marges-regle',
      );
    },
    [commands],
  );

  // Positioning of the invisible input area
  const inputStyle = caret
    ? {
        left: `${geometry.contentLeftPx + caret.xPx}px`,
        top: `${
          caret.pageIndex * (geometry.pageHeightPx + PAGE_GAP_PX) +
          geometry.contentTopPx +
          caret.topPx
        }px`,
        height: `${caret.heightPx}px`,
      }
    : { left: '-9999px', top: '0px' };

  /**
   * What the editor can do with an image without reopening the window.
   *
   * All these gestures go through the history: resizing, moving and changing the wrapping can be undone like the rest. Drags (size handle as well as moved frame) are grouped into a single entry (`dragGroup` on the
   * command side), otherwise undoing a resized image would take thirty `Ctrl+Z`.
   */
  /**
   * End of an image drag: re-anchoring at the drop point.
   *
   * The drag listens on the **window** (it has to follow a pointer that leaves the frame), and therefore only has screen coordinates. Here we find the targeted sheet through its `data-page-index`, then the paragraph by
   * the same lookup as the ordinary click (`positionFromPoint`).
   *
   * Without this re-anchoring, an image dragged far from its paragraph stayed drawn on that paragraph's page: the frame did follow the pointer, but dropped two pages further down it came out outside the original sheet.
   */
  const handleImageRelocated = useCallback(
    (blockId: string, offset: number, clientX: number, clientY: number) => {
      const feuille = document
        .elementsFromPoint(clientX, clientY)
        .find((element): element is HTMLElement =>
          element instanceof HTMLElement && element.dataset.pageIndex !== undefined,
        );
      if (!feuille) return;

      const pageIndex = Number(feuille.dataset.pageIndex);
      if (!Number.isInteger(pageIndex)) return;

      // Coordinates in the content area, zoom undone: the model knows nothing about it.
      const rect = feuille.getBoundingClientRect();
      const xPx = (clientX - rect.left) / zoom - layout.geometry.contentLeftPx;
      const yPx = (clientY - rect.top) / zoom - layout.geometry.contentTopPx;

      const cible = positionFromPoint(layout, pageIndex, xPx, yPx, measurer);
      if (!cible) return;

      /*
       * Position of the frame relative to its **new** anchor.
       *
       * The receiving paragraph has not moved since the previous pass: we therefore read its y coordinate as it is. The few pixels of gap that the layout recomputation will introduce afterwards are invisible, whereas keeping
       * the old origin would make the image jump by a paragraph.
       */
      const accueil = layout.placements.get(cible.blockId)?.[0]?.placed.topPx ?? 0;
      const cadre = paragraphIndex(session.state.doc).byId.get(blockId)?.paragraph;
      const largeurPx = cadre
        ? ptToPx(imageDraftAt(cadre.runs, offset)?.widthPt ?? 0)
        : 0;

      commands.moveImageTo(
        blockId,
        offset,
        cible,
        // The grabbed point becomes the **center** of the frame: that is where the eye believes it is holding the image, and putting its corner under the pointer would shift it by half a width at every drop.
        pxToPt(xPx - largeurPx / 2),
        pxToPt(yPx - accueil),
      );
    },
    [layout, measurer, zoom, session.state.doc, commands],
  );

  const imageContext = useMemo<ImageContext>(
    () => ({
      figureNumbers: layout.figureNumbers,
      bodyFontSizePt: doc.defaults.fontSizePt,
      selected: imageSelection,
      zoom,
      readOnly: lectureSeule,
      onSelect: (blockId, offset) => setImageSelection({ blockId, offset }),
      onOpenDialog: () => {
        /* opening goes through `onEditImage`, already wired on the page */
      },
      onResize: (blockId, offset, widthPt, heightPt) =>
        commands.resizeImage(blockId, offset, widthPt, heightPt),
      onWrapChange: (blockId, offset, mode) => commands.setImageWrap(blockId, offset, mode),
      onMove: (blockId, offset, xPt, yPt) => commands.setImagePosition(blockId, offset, xPt, yPt),
      onDrop: handleImageRelocated,
    }),
    [
      layout.figureNumbers,
      doc.defaults.fontSizePt,
      imageSelection,
      zoom,
      lectureSeule,
      commands,
      handleImageRelocated,
    ],
  );

  /**
   * Deselects the image as soon as you click elsewhere.
   *
   * `ImageFrame` stops the propagation of its own `pointerdown`: only the clicks that reach the sheet come through here, and they are exactly the ones that must clear the selection. Without this, the action bar stayed
   * displayed indefinitely, even after clicking in the text: it looked frozen on screen.
   */
  const onPagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      setImageSelection(null);
      handlers.onPointerDown(event, pageIndex);
    },
    [handlers],
  );

  // `Escape` also clears the selection: it is the expected gesture, and it saves having to aim at the text to get rid of the handles.
  useEffect(() => {
    if (!imageSelection) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setImageSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [imageSelection]);

  // Definition of the menus of the MenuBar
  const menus = useMemo<MenuDefinition[]>(
    () => [
      {
        label: 'Fichier',
        entries: [
          ...(onOpen ? [{ label: 'Ouvrir un document (.odt)…', shortcut: shortcutLabel('Mod-o'), run: onOpen }] : []),
          ...(onLoadSample ? [{ label: 'Charger le document d’exemple OpenOffice (.odt)', run: onLoadSample }] : []),
          ...(onSave ? [{ label: 'Enregistrer (.odt)', shortcut: shortcutLabel('Mod-s'), run: () => onSave(doc) }] : []),
          {
            label: 'Exporter au format PDF…',
            run: handleExportPdf,
            separatorBefore: true,
          },
          {
            label: 'Imprimer…',
            shortcut: shortcutLabel('Mod-p'),
            run: handlePrint,
          },
          {
            label: 'Mise en page et marges…',
            run: () => setStylesMarginsOpen(true),
            separatorBefore: true,
          },
        ],
      },
      {
        label: 'Édition',
        entries: [
          { label: 'Annuler', shortcut: shortcutLabel('Mod-z'), run: commands.undo, disabled: !canUndo },
          { label: 'Rétablir', shortcut: shortcutLabel('Mod-y'), run: commands.redo, disabled: !canRedo },
          { label: 'Tout sélectionner', shortcut: shortcutLabel('Mod-a'), run: commands.selectAll, separatorBefore: true },
          { label: 'Effacer la mise en forme', shortcut: shortcutLabel('Mod-\\'), run: commands.clearFormatting },
          { label: 'Rechercher et remplacer…', shortcut: shortcutLabel('Mod-f'), run: () => setFindReplaceOpen(true), separatorBefore: true },
          { label: 'Palette de commandes…', shortcut: shortcutLabel('Mod-Shift-p'), run: () => setCommandPaletteOpen(true) },
        ],
      },
      {
        label: 'Affichage',
        entries: [
          {
            label: 'Plan du document',
            checked: outlineOpen,
            run: () => setOutlineOpen((open) => !open),
          },
          {
            label: 'Règle graduée',
            checked: showRuler,
            run: () => setShowRuler((ruler) => !ruler),
          },
          {
            label: 'Zoom avant',
            shortcut: '+',
            run: () => setZoom(zoom + 0.1),
            separatorBefore: true,
          },
          {
            label: 'Zoom arrière',
            shortcut: '−',
            run: () => setZoom(zoom - 0.1),
          },
          {
            label: 'Zoom 100 %',
            run: () => setZoom(1),
          },
        ],
      },
      {
        label: 'Insertion',
        entries: [
          { label: 'En-tête…', run: () => setFurnitureBandToEdit('header') },
          { label: 'Pied de page…', run: () => setFurnitureBandToEdit('footer') },
          { label: 'Numéro de page…', run: () => setFurnitureBandToEdit('footer') },
          { label: 'Image…', shortcut: shortcutLabel('Mod-Shift-i'), run: openImageDialog, separatorBefore: true },
          { label: 'Formule mathématique…', shortcut: shortcutLabel('Mod-Shift-e'), run: openMathDialog },
          { label: 'Tableau (3×3)', run: () => commands.insertTable(3, 3) },
          { label: 'Saut de page', shortcut: shortcutLabel('Mod-Entrée'), run: commands.insertPageBreak, separatorBefore: true },
          { label: 'Note de bas de page…', run: () => setFootnoteDialogOpen(true) },
          {
            label: 'Table des matières',
            run: () => commands.insertTableOfContents(),
            separatorBefore: true,
          },
          { label: 'Commentaire…', run: () => setCommentDialogOpen(true) },
          { label: 'Signet…', run: () => setBookmarkDialogOpen(true) },
          {
            label: 'Lien hypertexte…',
            shortcut: shortcutLabel('Mod-k'),
            run: () => linkButtonRef.current?.click(),
          },
        ],
      },
      {
        label: 'Format',
        entries: [
          { label: 'Gras', shortcut: shortcutLabel('Mod-b'), run: commands.toggleBold },
          { label: 'Italique', shortcut: shortcutLabel('Mod-i'), run: commands.toggleItalic },
          { label: 'Souligné', shortcut: shortcutLabel('Mod-u'), run: commands.toggleUnderline },
          { label: 'Barré', shortcut: shortcutLabel('Mod-Shift-x'), run: commands.toggleStrike },
          { label: 'Aligner à gauche', shortcut: shortcutLabel('Mod-l'), run: () => commands.setAlignment('left'), separatorBefore: true },
          { label: 'Centrer', shortcut: shortcutLabel('Mod-e'), run: () => commands.setAlignment('center') },
          { label: 'Aligner à droite', shortcut: shortcutLabel('Mod-r'), run: () => commands.setAlignment('right') },
          { label: 'Justifier', shortcut: shortcutLabel('Mod-j'), run: () => commands.setAlignment('justify') },
          { label: 'En-tête et pied de page…', run: () => setFurnitureBandToEdit('header'), separatorBefore: true },
          { label: 'Paramètres des marges et styles…', run: () => setStylesMarginsOpen(true) },
        ],
      },
      {
        label: 'Tableau',
        /*
         * Every entry that acts on a grid is greyed out outside a grid. The underlying commands are inert in that case (they return the state unchanged), and an active entry with no effect is the worst kind of
         * feedback: the user thinks they missed their click.
         */
        entries: [
          { label: 'Insérer un tableau (3×3)', run: () => commands.insertTable(3, 3) },
          { label: 'Insérer une ligne au-dessus', run: commands.insertTableRowAbove, separatorBefore: true, disabled: !table },
          { label: 'Insérer une ligne au-dessous', run: commands.insertTableRowBelow, disabled: !table },
          {
            label: 'Supprimer la ligne',
            run: commands.deleteTableRow,
            // Deleting the last row takes the table with it: the dedicated entry says so, and this one must not do it by surprise.
            disabled: !table || table.rowCount <= 1,
          },
          { label: 'Insérer une colonne à gauche', run: commands.insertTableColumnLeft, separatorBefore: true, disabled: !table },
          { label: 'Insérer une colonne à droite', run: commands.insertTableColumnRight, disabled: !table },
          {
            label: 'Supprimer la colonne',
            run: commands.deleteTableColumn,
            disabled: !table || table.columnCount <= 1,
          },
          {
            label: 'Répartir les colonnes également',
            run: commands.distributeColumns,
            separatorBefore: true,
            disabled: !table || table.columnCount <= 1,
          },
          {
            label: 'Fusionner les cellules',
            run: commands.mergeCells,
            separatorBefore: true,
            // Merging needs at least two cells: without a rectangle, the command has no object.
            disabled: !table?.rect,
          },
          /*
           * On a merged cell, `splitTableCell` does not cut: it gives the grid back by freeing the absorbed cells. Offering "split into 2 columns" then would promise a split that will not happen, hence a single entry, with its
           * real name.
           */
          ...(table?.merged
            ? [
                {
                  label: 'Séparer les cellules fusionnées',
                  run: () => commands.splitCell('horizontal', 2),
                },
              ]
            : [
                {
                  label: 'Scinder en 2 colonnes',
                  run: () => commands.splitCell('horizontal', 2),
                  disabled: !table,
                },
                {
                  label: 'Scinder en 2 lignes',
                  run: () => commands.splitCell('vertical', 2),
                  disabled: !table,
                },
              ]),
          {
            label: 'Supprimer le tableau',
            run: commands.deleteTable,
            separatorBefore: true,
            disabled: !table,
          },
        ],
      },
      {
        label: 'Révision',
        entries: [
          {
            label: reviewing ? 'Désactiver le suivi des modifications' : 'Suivre les modifications',
            checked: reviewing,
            run: () => {
              const next = !reviewing;
              setReviewing(next);
              commands.setReviewMode(next ? authorName : null);
            },
          },
          {
            label: `Accepter toutes les modifications (${redlineRanges.length})`,
            run: commands.acceptAllRedlines,
            separatorBefore: true,
            disabled: redlineRanges.length === 0,
          },
          {
            label: 'Rejeter toutes les modifications',
            run: commands.rejectAllRedlines,
            disabled: redlineRanges.length === 0,
          },
          {
            label: 'Ajouter un commentaire…',
            run: () => setCommentDialogOpen(true),
            separatorBefore: true,
          },
        ],
      },
      {
        label: 'Aide',
        entries: [
          { label: 'Raccourcis clavier…', run: () => setHelpOpen(true) },
          {
            label: 'Statistiques du document',
            run: () =>
              alert(
                `Statistiques du document :\n\n• Pages : ${layout.pages.length}\n• Mots : ${statistics.words}\n• Caractères : ${statistics.characters}`,
              ),
          },
          {
            label: 'Guide de référence CloudAntille Writer…',
            run: () => setHelpOpen(true),
            separatorBefore: true,
          },
          {
            label: 'À propos de CloudAntille Writer',
            run: () => setHelpOpen(true),
          },
        ],
      },
    ],
    [
      onOpen,
      onSave,
      doc,
      handleExportPdf,
      handlePrint,
      commands,
      canUndo,
      canRedo,
      outlineOpen,
      showRuler,
      zoom,
      setZoom,
      layout.pages.length,
      statistics,
      openMathDialog,
      openImageDialog,
      // The Table menu greys its entries according to the cursor's context, and the Revision menu shows the state of the tracking: without these dependencies, both stay frozen on what they were worth at the last change of
      // document.
      table,
      reviewing,
      authorName,
      redlineRanges.length,
    ],
  );

  /**
   * Content of the context menu.
   *
   * It is composed instead of duplicated: the table entries only appear in a grid, and they are exactly those of the "Table" menu, separators included. The same label always designates the same command there, which is
   * what lets you learn one by using the other.
   */
  const contextMenu = useMemo<MenuDefinition>(() => {
    const tableEntries = menus.find((menu) => menu.label === 'Tableau')?.entries ?? [];

    return {
      label: 'Actions',
      entries: [
        {
          label: 'Couper',
          shortcut: shortcutLabel('Mod-x'),
          run: () => document.execCommand('cut'),
          disabled: !selectedText || lectureSeule,
        },
        {
          label: 'Copier',
          shortcut: shortcutLabel('Mod-c'),
          run: () => document.execCommand('copy'),
          disabled: !selectedText,
        },
        {
          label: 'Coller',
          shortcut: shortcutLabel('Mod-v'),
          // The system clipboard cannot be read without a user gesture in the document: we give the focus back, and `Ctrl+V` does the rest.
          run: () => controller.focus(),
          disabled: lectureSeule,
        },
        {
          label: 'Ajouter un commentaire…',
          run: () => setCommentDialogOpen(true),
          separatorBefore: true,
          disabled: lectureSeule,
        },
        {
          label: 'Lien hypertexte…',
          shortcut: shortcutLabel('Mod-k'),
          run: () => linkButtonRef.current?.click(),
          disabled: lectureSeule,
        },
        // Outside a table, nothing is added: a whole block of greyed-out entries teaches nothing and lengthens the menu for everybody.
        ...(table
          ? tableEntries
              .filter((entry) => entry.label !== 'Insérer un tableau (3×3)')
              .map((entry, index) => (index === 0 ? { ...entry, separatorBefore: true } : entry))
          : []),
      ],
    };
  }, [menus, selectedText, lectureSeule, table, controller]);

  // Commands for the Ctrl+K palette
  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'furniture-header', title: 'En-tête de page…', category: 'Insertion', perform: () => setFurnitureBandToEdit('header') },
      { id: 'furniture-footer', title: 'Pied de page…', category: 'Insertion', perform: () => setFurnitureBandToEdit('footer') },
      { id: 'furniture-page-number', title: 'Numéro de page…', category: 'Insertion', perform: () => setFurnitureBandToEdit('footer') },
      { id: 'furniture', title: 'En-tête et pied de page…', category: 'Format', perform: () => setFurnitureBandToEdit('header') },
      { id: 'image', title: 'Insérer une image…', category: 'Insertion', shortcut: shortcutLabel('Mod-Shift-i'), perform: openImageDialog },
      { id: 'math', title: 'Insérer une formule mathématique', category: 'Insertion', shortcut: shortcutLabel('Mod-Shift-e'), perform: openMathDialog },
      { id: 'bold', title: 'Gras', category: 'Format', shortcut: shortcutLabel('Mod-b'), perform: commands.toggleBold },
      { id: 'italic', title: 'Italique', category: 'Format', shortcut: shortcutLabel('Mod-i'), perform: commands.toggleItalic },
      { id: 'underline', title: 'Souligné', category: 'Format', shortcut: shortcutLabel('Mod-u'), perform: commands.toggleUnderline },
      { id: 'strike', title: 'Barré', category: 'Format', shortcut: shortcutLabel('Mod-Shift-x'), perform: commands.toggleStrike },
      { id: 'clear_format', title: 'Effacer la mise en forme', category: 'Format', shortcut: shortcutLabel('Mod-\\'), perform: commands.clearFormatting },
      { id: 'h1', title: 'Titre 1', category: 'Styles', perform: () => commands.setHeadingLevel(1) },
      { id: 'h2', title: 'Titre 2', category: 'Styles', perform: () => commands.setHeadingLevel(2) },
      { id: 'h3', title: 'Titre 3', category: 'Styles', perform: () => commands.setHeadingLevel(3) },
      { id: 'p', title: 'Texte normal (paragraphe)', category: 'Styles', perform: () => commands.setHeadingLevel(0) },
      { id: 'align_left', title: 'Aligner à gauche', category: 'Paragraphe', shortcut: shortcutLabel('Mod-l'), perform: () => commands.setAlignment('left') },
      { id: 'align_center', title: 'Centrer', category: 'Paragraphe', shortcut: shortcutLabel('Mod-e'), perform: () => commands.setAlignment('center') },
      { id: 'align_right', title: 'Aligner à droite', category: 'Paragraphe', shortcut: shortcutLabel('Mod-r'), perform: () => commands.setAlignment('right') },
      { id: 'align_justify', title: 'Justifier', category: 'Paragraphe', shortcut: shortcutLabel('Mod-j'), perform: () => commands.setAlignment('justify') },
      { id: 'bullet_list', title: 'Liste à puces', category: 'Listes', shortcut: shortcutLabel('Mod-Shift-8'), perform: () => commands.toggleList('bullet') },
      { id: 'ordered_list', title: 'Liste numérotée', category: 'Listes', shortcut: shortcutLabel('Mod-Shift-7'), perform: () => commands.toggleList('ordered') },
      { id: 'task_list', title: 'Liste à cocher', category: 'Listes', shortcut: shortcutLabel('Mod-Shift-9'), perform: () => commands.toggleList('task') },
      { id: 'page_break', title: 'Insérer un saut de page', category: 'Insertion', shortcut: shortcutLabel('Mod-Entrée'), perform: commands.insertPageBreak },
      { id: 'table', title: 'Insérer un tableau (3×3)', category: 'Insertion', perform: () => commands.insertTable(3, 3) },
      { id: 'find', title: 'Rechercher et remplacer', category: 'Édition', shortcut: shortcutLabel('Mod-f'), perform: () => setFindReplaceOpen(true) },
      { id: 'outline', title: 'Afficher / Masquer le plan', category: 'Affichage', perform: () => setOutlineOpen((o) => !o) },
      { id: 'ruler', title: 'Afficher / Masquer la règle', category: 'Affichage', perform: () => setShowRuler((r) => !r) },
      { id: 'margins', title: 'Paramètres des marges et styles', category: 'Format', perform: () => setStylesMarginsOpen(true) },
      { id: 'export_pdf', title: 'Exporter au format PDF (.pdf)', category: 'Fichier', perform: handleExportPdf },
      { id: 'print', title: 'Imprimer le document', category: 'Fichier', shortcut: shortcutLabel('Mod-p'), perform: handlePrint },
      ...(onSave ? [{ id: 'save', title: 'Enregistrer au format .odt', category: 'Fichier', shortcut: shortcutLabel('Mod-s'), perform: () => onSave(doc) }] : []),
    ],
    [commands, onSave, doc, handleExportPdf, handlePrint, openMathDialog, openImageDialog],
  );

  // Tab title = document title: a screen reader announces it when coming back to the tab, and printing to PDF suggests it as the file name.
  const documentTitle = doc.meta.title || 'Sans titre';
  useEffect(() => {
    document.title = `${documentTitle} – Writer`;
  }, [documentTitle]);

  return (
    <div className="writer">
      {/* Main title bar with the title and the menu stacked on the left, and the actions on the right */}
      <header className="titlebar">
        <div className="titlebar__identity">
          <DocumentTitle
            title={doc.meta.title || 'Guide de Référence CloudAntille Writer'}
            disabled={false}
            onCommit={handleTitleCommit}
          />
          <MenuBar menus={menus} />
        </div>
        <span className="titlebar__spacer" />
        <div className="titlebar__actions">
          {collab?.shared && collab.self && (
            <PresenceAvatars peers={collab.peers} self={collab.self} />
          )}
          {collab && (
            <button
              type="button"
              className={collab.shared ? 'btn' : 'btn btn--primary'}
              onClick={collab.onOpenShare}
              title={collab.shared ? 'Voir et modifier le partage' : 'Partager ce document'}
            >
              <Icon name="share" />
              <span>{collab.shared ? 'Partagé' : 'Partager'}</span>
            </button>
          )}
          {/* Open, Save, Export PDF and Print live in the File menu, and Print also in the ribbon. Repeating them here cluttered the header without offering anything more. What remains is sharing, which has no other entry point. */}
        </div>
      </header>

      {/* Full ribbon with the system's vector icons */}
      <Ribbon
        controller={controller}
        onPrint={handlePrint}
        onOpenFindReplace={() => setFindReplaceOpen(true)}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        outlineOpen={outlineOpen}
        onOpenPageSetup={() => setStylesMarginsOpen(true)}
        onOpenMath={openMathDialog}
        onOpenImage={openImageDialog}
        onOpenFurniture={(band) => setFurnitureBandToEdit(band ?? 'header')}
        linkButtonRef={linkButtonRef}
      />

      {/* Anchored search panel */}
      {findReplaceOpen && (
        <FindReplacePanel
          state={findReplaceState}
          onChange={setFindReplaceState}
          total={matches.length}
          current={currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0}
          onNavigate={handleSearchNavigate}
          onReplace={handleSearchReplace}
          onReplaceAll={handleSearchReplaceAll}
          onClose={() => setFindReplaceOpen(false)}
          readOnly={false}
        />
      )}

      {/* Interactive graduated ruler */}
      {showRuler && (
        <Ruler
          zoom={zoom}
          pageWidthCm={doc.pageSetup.widthMm / 10}
          leftMarginCm={doc.pageSetup.marginLeftMm / 10}
          rightMarginCm={doc.pageSetup.marginRightMm / 10}
          firstLineIndentCm={ptToMm(currentParagraph?.firstLineIndentPt ?? 0) / 10}
          onMarginChange={handleRulerMarginChange}
          onFirstLineIndentChange={(indentCm) => {
            const pt = mmToPt(indentCm * 10);
            commands.setFirstLineIndentPt(Math.abs(pt) > 0.5 ? Math.round(pt * 10) / 10 : null);
          }}
          onOpenMarginsDialog={() => setStylesMarginsOpen(true)}
        />
      )}

      {/* Main work area with the side outline and the A4 surface. The class is indispensable: `overflow: hidden` suits the screen, but would crop the pages when printing. Only a class lets the `@media print` stylesheet neutralize this container. */}
      <div
        className="writer-workspace"
        // Main landmark: the screen readers' "skip to content" shortcut leads to the document rather than to the ribbon.
        role="main"
        aria-label="Document"
        style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
      >
        {/* Document outline (DocumentOutline) */}
        <DocumentOutline
          documentState={doc}
          open={outlineOpen}
          onClose={() => setOutlineOpen(false)}
          onSelectHeading={handleSelectHeading}
        />

        {/* Surface of the physical pages */}
        <div ref={surfaceRef} className="writer-surface" style={{ flex: 1 }}>
          {/* Zoom frame. It contains nothing itself: its only reason for existing is to carry, in pixels, the **scaled** size of the content. The scaling is done on its child, which keeps its original size in the flow, and it is this frame, sized to what the eye sees, that decides the scrollbars of the surface. */}
          <div
            className="writer-zoom"
            style={{ width: `${pileWidthPx * zoom}px`, height: `${pileHeightPx * zoom}px` }}
          >
            {/* The child keeps its **original** size: without an explicit width it stretched to that of the frame, already multiplied by the zoom, and got scaled a second time: 2,408 px wide at 150 % instead of 1,605. */}
            <div
              className="writer-zoom__contenu"
              style={{
                width: `${pileWidthPx}px`,
                height: `${pileHeightPx}px`,
                transform: `scale(${zoom})`,
              }}
            >
              <div
                className="writer-pages"
                style={{
                  width: `${geometry.pageWidthPx}px`,
                  gap: `${PAGE_GAP_PX}px`,
                }}
                // Dropping an image on the page inserts it at the cursor. `preventDefault` on the hover is mandatory: without it the browser refuses the drop and opens the file instead, leaving the document.
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                }}
                onDrop={(event) => {
                  const fichier = Array.from(event.dataTransfer.files).find((f) =>
                    f.type.startsWith('image/'),
                  );
                  if (!fichier) return;
                  event.preventDefault();
                  void readFileAsDataUrl(fichier)
                    .then(handleDropImage)
                    .catch(() => {
                      /* unreadable file: nothing dropped, nothing broken */
                    });
                }}
              >
                {layout.pages.map((page) => (
                  <A4Page
                    key={page.index}
                    page={page}
                    totalPages={layout.pages.length}
                    documentTitle={doc.meta.title || 'Sans titre'}
                    furniture={doc.furniture ?? DEFAULT_FURNITURE}
                    geometry={geometry}
                    paragraphLayouts={layout.paragraphLayouts}
                    placements={placementsByPage[page.index] ?? AUCUN_PLACEMENT}
                    selectionRects={rectsByPage.get(page.index) ?? AUCUN_RECT}
                    searchRects={searchRectsByPage.get(page.index) ?? AUCUNE_OCCURRENCE}
                    caret={caret?.pageIndex === page.index ? caret : null}
                    caretIdle={!controller.isFocused}
                    showMargins={showMargins}
                    zoom={zoom}
                    activeTable={activeTable}
                    onResizeColumn={commands.resizeColumnBoundary}
                    onSelectRow={commands.selectRow}
                    onSelectColumn={commands.selectColumn}
                    onSelectTable={commands.selectTable}
                    readOnly={lectureSeule}
                    images={imageContext}
                    onToggleTask={controller.commands.toggleTask}
                    onOpenFurniture={setFurnitureBandToEdit}
                    onEditMath={handleEditMath}
                    onEditImage={handleEditImage}
                    onPointerDown={onPagePointerDown}
                    onPointerMove={handlers.onPointerMove}
                    onPointerUp={handlers.onPointerUp}
                    onContextMenu={handlers.onContextMenu}
                  />
                ))}

                {/* Invisible but controlled typing area */}
                <textarea
                  ref={inputRef}
                  className="writer-input"
                  style={inputStyle}
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  // Target of the formatting bar's `aria-controls`: without this id, the reference led nowhere.
                  id="document-body"
                  aria-label="Document Writer"
                  aria-multiline="true"
                  role="textbox"
                  onKeyDown={handlers.onKeyDown}
                  onCompositionStart={handlers.onCompositionStart}
                  onCompositionEnd={handlers.onCompositionEnd}
                  onFocus={handlers.onFocus}
                  onBlur={handlers.onBlur}
                  onCopy={handlers.onCopy}
                  onCut={handlers.onCut}
                  onPaste={handlers.onPaste}
                />
              </div>

              {/* Comment gutter (`SwPostItMgr`). Outside the sheet, and not in its margin: a comment is a review object, it must not be printed.  It is **inside** the scaled frame, and not beside it: it is the same transformation as the pages, so every bubble stays opposite its anchor at all zoom levels without carrying its own `scale`. Its height is that of the stack: the bubbles are placed absolutely in it, and without an explicit height the band was flat. */}
              {hasComments && (
                <div
                  className="writer-comment-gutter"
                  style={{
                    height: `${pileHeightPx}px`,
                    marginLeft: `${COMMENT_GUTTER_GAP_PX}px`,
                  }}
                >
                  <CommentBand
                    doc={doc}
                    layout={layout}
                    pageStridePx={geometry.pageHeightPx + PAGE_GAP_PX}
                    contentTopPx={geometry.contentTopPx}
                    author={authorName}
                    activeThreadId={activeThreadId}
                    readOnly={lectureSeule}
                    onReply={(threadId, text) => commands.replyToComment(threadId, authorName, text)}
                    onResolve={commands.resolveComment}
                    onDelete={commands.deleteComment}
                    onEdit={commands.editComment}
                    onGoToAnchor={handleSelectHeading}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <LiveRegion message={announcement} />

      {/* Status bar at the bottom */}
      <div className="writer-status">
        <span>{`${layout.pages.length} page${layout.pages.length > 1 ? 's' : ''}`}</span>
        <span>{`${statistics.words} mot${statistics.words > 1 ? 's' : ''}`}</span>
        <span>{`${statistics.characters} caractères`}</span>
        <span className="writer-status__spacer" />
        {collab?.shared && (
          <span
            className={`writer-status__lien writer-status__lien--${collab.status}`}
            title={CONNEXION_AIDE[collab.status]}
          >
            {CONNEXION_LIBELLE[collab.status]}
            {collab.pending > 0 && ` · ${collab.pending} en attente`}
          </span>
        )}
        {collab?.shared && !collab.canWrite && (
          <span className="writer-status__lecture">Lecture seule</span>
        )}
        <span>
          {caret ? `Page ${caret.pageIndex + 1}, ligne ${caret.lineIndex + 1}` : 'Curseur'}
        </span>
        <span>{`${Math.round(zoom * 100)} %`}</span>
      </div>

      {/* Dialogs and modals */}
      {collab?.rejection && (
        <div className="writer-refus" role="alert">
          <span>{collab.rejection}</span>
          <button type="button" className="btn btn--ghost" onClick={collab.clearRejection}>
            Fermer
          </button>
        </div>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={paletteCommands}
      />

      <StylesAndMarginsDialog
        open={stylesMarginsOpen}
        pageSetup={doc.pageSetup}
        defaults={doc.defaults}
        onSave={handleSavePageSetupAndDefaults}
        onClose={() => setStylesMarginsOpen(false)}
      />

      <CommentDialog
        open={commentDialogOpen}
        quotedText={selectedText}
        author={authorName}
        onClose={() => setCommentDialogOpen(false)}
        onInsert={(text) => commands.addComment(authorName, text)}
      />

      <BookmarkDialog
        open={bookmarkDialogOpen}
        quotedText={selectedText}
        existingNames={bookmarkNames}
        onClose={() => setBookmarkDialogOpen(false)}
        onInsert={(name) => commands.setBookmark(name)}
      />

      <FootnoteDialog
        open={footnoteDialogOpen}
        onClose={() => setFootnoteDialogOpen(false)}
        onInsert={(text) => {
          commands.insertFootnote(text);
        }}
      />

      {mathDraft && (
        <MathDialog
          draft={mathDraft}
          onCancel={() => setMathDraft(null)}
          onSubmit={(latex, display) => {
            if (mathDraft.blockId) {
              commands.updateMath(mathDraft.blockId, latex, display);
            } else {
              commands.insertMath(latex, display);
            }
            setMathDraft(null);
          }}
          onDelete={
            mathDraft.blockId
              ? () => {
                  commands.deleteMath(mathDraft.blockId!);
                  setMathDraft(null);
                }
              : undefined
          }
        />
      )}

      {imageDraft && (
        <ImageDialog
          draft={imageDraft}
          contentWidthPt={contentWidthPt}
          onCancel={() => setImageDraft(null)}
          onSubmit={(resultat) => {
            // The dialog closes right away: waiting for the upload behind a window that is still open would give the impression of a freeze.
            setImageDraft(null);
            void adresseFinale(resultat.src).then((src) => {
              const attributs = {
                src,
                widthPt: resultat.widthPt,
                heightPt: resultat.heightPt,
                alt: resultat.alt,
                ...(resultat.crop ? { crop: resultat.crop } : {}),
                ...(resultat.caption ? { caption: resultat.caption } : {}),
                // `0` is a value: we test for presence, never for truthiness, otherwise a margin reset to zero would never reach the run.
                ...(resultat.marginPt !== undefined ? { marginPt: resultat.marginPt } : {}),
                ...(resultat.captionGapPt !== undefined
                  ? { captionGapPt: resultat.captionGapPt }
                  : {}),
                ...(resultat.wrap
                  ? {
                      wrap: {
                        mode: resultat.wrap,
                        ...(resultat.horiOrient !== undefined
                          ? { horiOrient: resultat.horiOrient }
                          : {}),
                        ...(resultat.horiRelation !== undefined
                          ? { horiRelation: resultat.horiRelation }
                          : {}),
                        ...(resultat.xPt !== undefined ? { xPt: resultat.xPt } : {}),
                        ...(resultat.yPt !== undefined ? { yPt: resultat.yPt } : {}),
                        ...(resultat.wrapMarginPt !== undefined
                          ? { wrapMarginPt: resultat.wrapMarginPt }
                          : {}),
                      },
                    }
                  : {}),
              };
              if (resultat.blockId !== undefined && resultat.offset !== undefined) {
                commands.updateImage(resultat.blockId, resultat.offset, attributs);
              } else {
                commands.insertImage(attributs);
              }
            });
          }}
          onDelete={
            imageDraft.blockId !== undefined && imageDraft.offset !== undefined
              ? () => {
                  commands.deleteImage(imageDraft.blockId!, imageDraft.offset!);
                  setImageDraft(null);
                }
              : undefined
          }
        />
      )}

      {furnitureBandToEdit !== null && (
        <PageFurnitureDialog
          valeur={doc.furniture ?? DEFAULT_FURNITURE}
          titreDocument={doc.meta.title || 'Sans titre'}
          pages={layout.pages.length}
          bandeInitiale={furnitureBandToEdit}
          onChange={(updatedFurniture) => {
            /*
             * The dialog publishes on every keystroke, so that the page behind it shows the header being written. The command must therefore neither take the focus back (the field would lose it every other keystroke) nor
             * rebuild the session, which would take the document's history with it. `'mobilier'` (furniture) groups the typing into a single undo.
             */
            commands.updateDocument(
              'En-tête et pied de page',
              (current) => ({ ...current, furniture: updatedFurniture }),
              'mobilier',
            );
          }}
          onClose={() => setFurnitureBandToEdit(null)}
        />
      )}

      {contextMenuAt && (
        <ContextMenu
          x={contextMenuAt.x}
          y={contextMenuAt.y}
          menu={contextMenu}
          onClose={() => setContextMenuAt(null)}
        />
      )}

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

    </div>
  );
}

/** Document statistics */
/** A whitespace character in the `Intl` sense: the word separator. */
function estEspace(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // line feed
    code === 0x0d || // carriage return
    code === 0x0c || // form feed
    code === 0x0b || // vertical tab
    code === 0xa0 || // non-breaking space
    code === 0x1680 ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/**
 * Words and characters of the document.
 *
 * Counting is done character by character rather than with `text.match(/\S+/g)`: the regular expression allocates the array of **all** the words of the paragraph only to read its length, then throws it away
 * immediately. On a long document, that is free garbage-collector pressure, repeated on every count.
 */
function computeStatistics(doc: WriterDocumentState): { words: number; characters: number } {
  let words = 0;
  let characters = 0;

  const { order, byId } = paragraphIndex(doc);
  for (const id of order) {
    const paragraph = byId.get(id)?.paragraph;
    if (!paragraph) continue;
    const text = paragraphText(paragraph);
    characters += text.length;

    let dansUnMot = false;
    for (let i = 0; i < text.length; i += 1) {
      const espace = estEspace(text.charCodeAt(i));
      if (!espace && !dansUnMot) words += 1;
      dansUnMot = !espace;
    }
  }

  return { words, characters };
}
