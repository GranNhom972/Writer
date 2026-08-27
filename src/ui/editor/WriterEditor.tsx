/**
 * L'éditeur complet assemblé : Barre de menus, Ruban avec icônes vectorielles,
 * Règle graduée, Plan du document (DocumentOutline), Recherche/Remplacement,
 * Palette de commandes (Ctrl+K), Éditeur de formules mathématiques (MathDialog),
 * En-têtes et pieds de page ergonomiques (PageFurnitureDialog),
 * Dialogues de styles/marges et feuilles A4 physiques.
 *
 * Moteur 100 % natif OpenOffice Writer (sw) sans aucune bibliothèque de rich-text externe.
 */

import {
  useCallback,
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
import { locateOffset } from '../../domain/document/runs';
import { pxToPt } from '../../domain/document/units';
import { fitToContentWidth } from '../../domain/document/images';
import { probeImageSize, readFileAsDataUrl } from '../../domain/image/raster';
import { DEFAULT_FURNITURE, type FurnitureBand } from '../../domain/document/pageFurniture';
import { A4Page } from './A4Page';
import { useWriterInput, imageDraftAt } from './useWriterInput';
import { Ribbon } from '../components/Ribbon';
import { MenuBar, type MenuDefinition } from '../components/MenuBar';
import { DocumentTitle } from '../components/DocumentTitle';
import { Ruler } from '../components/Ruler';
import { DocumentOutline } from '../components/DocumentOutline';
import { FindReplacePanel, type FindReplaceState } from '../dialogs/FindReplacePanel';
import { CommandPalette, type PaletteCommand } from '../dialogs/CommandPalette';
import { StylesAndMarginsDialog } from '../dialogs/StylesAndMarginsDialog';
import { FootnoteDialog } from '../dialogs/FootnoteDialog';
import { BookmarkDialog, CommentDialog } from '../dialogs/AnnotationDialog';
import { CommentBand } from './CommentBand';
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
import { normalizeSelection, rangeRects } from '../../domain/engine/cursor';
import { downloadPdfWithImages, printDocument } from '../../domain/pdf';
import { shortcutLabel } from '../shortcuts';
import { PresenceAvatars } from '../../design/components/PresenceAvatars';
import { Icon } from '../../design/icons/Icon';
import type { ConnectionStatus, PeerPresence } from '../../domain/collab/session';
import './editor.css';

const PAGE_GAP_PX = 16;

/**
 * Trois états de connexion, pas plus.
 *
 * « Reconnexion en cours » et « tentative 4 sur 7 » disent la même chose à qui
 * rédige : que ça ne passe pas encore. Le détail appartient aux journaux.
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
  onPrint?: () => void;
  onExportPdf?: () => void;
  onTitleChange?: (title: string) => void;
  /**
   * Partage. Absent, l'éditeur fonctionne exactement comme avant : le document
   * vit dans cet onglet, et rien ne part sur le réseau.
   */
  collab?: CollabBinding;
}

/** Ce que l'éditeur attend de la couche de partage, et rien de plus. */
export interface CollabBinding {
  status: ConnectionStatus;
  peers: readonly PeerPresence[];
  self: { userId: string; displayName: string; color: string } | null;
  pending: number;
  rejection: string | null;
  canWrite: boolean;
  /** Vrai quand le document est effectivement partagé. */
  shared: boolean;
  /** Un nouvel état local à publier. */
  publish: (doc: WriterDocumentState) => void;
  setCursor: (cursor: { blockId: string; offset: number } | null) => void;
  clearRejection: () => void;
  onOpenShare: () => void;
  /**
   * Dépose une image sur le serveur et rend son adresse.
   *
   * Rend `null` quand le document n'est pas partagé ou que le dépôt échoue :
   * l'image reste alors en `data:`, ce qui marche, mais alourdit chaque
   * synchronisation du paragraphe qui la porte.
   */
  uploadImage: (dataUrl: string) => Promise<string | null>;
  /**
   * Reçoit la commande d'application d'une modification distante. L'éditeur
   * l'appelle **une fois**, à l'ouverture : c'est ainsi que la couche de
   * partage obtient de quoi écrire dans le document sans le posséder.
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

  // Partagé sans droit d'écriture : l'éditeur devient une visionneuse. On
  // n'attend pas le refus du serveur pour le dire — voir `WriterHooks.readOnly`.
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
  });
  const {
    layout,
    caret,
    rects,
    placementsByPage,
    session,
    currentParagraph,
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
   * Auteur des commentaires et des révisions.
   *
   * Le nom affiché en session partagée l'emporte : c'est celui que voient les
   * autres participants, et signer d'un nom différent dans la gouttière rendrait
   * un fil de discussion illisible.
   */
  const authorName = collab?.self?.displayName || doc.meta.author || 'Moi';

  /** Texte actuellement sélectionné — ce qu'un commentaire ou un signet ancrerait. */
  const selectedText = useMemo(() => selectionText(session.state), [session.state]);

  /** Fil dont l'ancre contient le curseur : c'est lui que la gouttière met en avant. */
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
  /** Mode révision (`REDLINE_ON`) : miroir local de l'état porté par la session. */
  const [reviewing, setReviewing] = useState(false);

  const hasComments = useMemo(() => commentThreads(doc).length > 0, [doc]);

  /**
   * Message annoncé aux lecteurs d'écran.
   *
   * Les changements **structurels** — pagination, mode révision, nombre de fils
   * ouverts — ne se voient pas au clavier : ils ne produisent aucun mouvement de
   * curseur, et sans annonce un utilisateur non voyant n'apprend jamais qu'une
   * page vient d'apparaître. Les frappes, elles, ne sont pas annoncées : le
   * lecteur d'écran les lit déjà, et les doubler rendrait la saisie inaudible.
   */
  const announcement = useMemo(() => {
    const parts = [`${layout.pages.length} page${layout.pages.length > 1 ? 's' : ''}`];
    if (reviewing) parts.push('suivi des modifications actif');
    if (redlineRanges.length > 0) parts.push(`${redlineRanges.length} modification(s) en attente`);
    if (lectureSeule) parts.push('document en lecture seule');
    return parts.join(', ');
  }, [layout.pages.length, reviewing, redlineRanges.length, lectureSeule]);

  // États des panneaux et dialogues UI
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
   * Bouton « lien » du ruban.
   *
   * Le menu et `Ctrl+K` déclenchent **ce** bouton plutôt que d'ouvrir un second
   * dialogue : un seul composant à tenir, et le panneau s'ancre là où l'usager
   * s'attend à le voir apparaître.
   */
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  const [furnitureBandToEdit, setFurnitureBandToEdit] = useState<FurnitureBand | null>(null);

  const [findReplaceState, setFindReplaceState] = useState<FindReplaceState>({
    query: '',
    replacement: '',
    options: { matchCase: false, wholeWord: false },
    showReplace: false,
  });

  const handleTitleCommit = useCallback(
    (newTitle: string) => {
      commands.replaceDocument({
        ...doc,
        meta: {
          ...doc.meta,
          title: newTitle,
          updatedAt: new Date().toISOString(),
        },
      });
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

  /** Largeur de la zone imprimable — plafond d'insertion d'une image. */
  const contentWidthPt = useMemo(() => pxToPt(geometry.contentWidthPx), [geometry.contentWidthPx]);

  /**
   * Ouvre l'atelier d'image.
   *
   * Si le curseur touche déjà un cadre, on l'ouvre **sur ce cadre** plutôt que
   * d'en proposer un nouveau : c'est le geste attendu quand on veut redimensionner
   * l'image où l'on se trouve, et il évite d'en empiler deux par mégarde.
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
      });
      return;
    }

    setImageDraft({ src: '', widthPt: contentWidthPt / 2, heightPt: contentWidthPt / 3, alt: '' });
  }, [session.state, contentWidthPt]);

  /**
   * Adresse définitive d'une image, une fois déposée s'il y a lieu.
   *
   * En partage, une `data:` part sur le serveur **avant** d'entrer dans le
   * document : l'y poser d'abord ferait transiter la version lourde une fois
   * chez chaque participant, avant de la remplacer par son adresse.
   *
   * Hors partage, ou si le dépôt échoue, la `data:` est conservée : elle
   * s'affiche, s'exporte et s'enregistre — seulement plus lourdement.
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
      const node = paragraphIndex(session.state.doc).byId.get(blockId);
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
      });
    },
    [session.state.doc],
  );

  /**
   * Insertion d'une image déposée sur la page.
   *
   * Le glisser-déposer court-circuite le dialogue : la taille est celle de
   * l'image, ramenée à la largeur imprimable, exactement comme le ferait
   * `SwFEShell::Insert`. Un dialogue à ce moment-là ferait perdre le geste.
   */
  const handleDropImage = useCallback(
    async (dataUrl: string) => {
      try {
        const naturelle = await probeImageSize(dataUrl);
        const taille = fitToContentWidth(naturelle.widthPx, naturelle.heightPx, contentWidthPt);
        commands.insertImage({ src: await adresseFinale(dataUrl), ...taille });
      } catch {
        // Image indécodable : on ouvre l'atelier, qui dira pourquoi.
        setImageDraft({ src: dataUrl, widthPt: contentWidthPt / 2, heightPt: contentWidthPt / 3, alt: '' });
      }
    },
    [commands, contentWidthPt, adresseFinale],
  );

  /**
   * Export PDF par le moteur binaire (`vcl::PDFWriter`).
   *
   * Le moteur de `domain/pdf/export.ts` écrit la structure PDF 1.4 à partir de
   * la **même** mise en page que l'écran : mêmes ruptures de ligne, mêmes
   * pages, mêmes notes. `window.print()` repasse au contraire par le moteur de
   * rendu du navigateur, qui repagine à sa façon — deux documents différents
   * pour un seul contenu.
   *
   * L'impression, elle, garde la boîte du navigateur : c'est le pilote système
   * qu'il faut atteindre, pas un fichier.
   */
  const handleExportPdf = useCallback(() => {
    if (onExportPdf) {
      onExportPdf();
      return;
    }
    void downloadPdfWithImages(doc, layout, `${doc.meta.title || 'document'}.pdf`).catch(() => {
      // Le moteur binaire a renoncé — police introuvable, image indécodable.
      // La boîte d'impression reste un chemin complet vers un PDF, elle prend
      // le relais plutôt que de laisser l'utilisateur sans export.
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

  /* ------------------------------------------------------------- partage */

  // La commande d'application distante est remise **une fois** à la couche de
  // partage. La redonner à chaque rendu recréerait la session WebSocket, donc
  // reconnecterait à chaque frappe.
  const bindApplyRemote = collab?.bindApplyRemote;
  const applyRemote = commands.applyRemote;
  useEffect(() => {
    bindApplyRemote?.(applyRemote);
  }, [bindApplyRemote, applyRemote]);

  /**
   * Publication de l'état local.
   *
   * On publie le document **après** rendu, pas dans la commande : une commande
   * qui émettrait elle-même devrait connaître le réseau, et l'éditeur cesserait
   * de fonctionner isolé. Ici, le partage n'est qu'un observateur de plus.
   */
  const publish = collab?.publish;
  // `useLayoutEffect` et non `useEffect` : la publication doit avoir lieu dans
  // la même tâche que la frappe qui l'a produite. Un effet passif est rejeté à
  // une tâche ultérieure, et une trame distante reçue entre les deux ferait
  // relire un document répliqué où la frappe ne figure pas encore — elle serait
  // alors perdue au profit de l'état venu du réseau.
  useLayoutEffect(() => {
    publish?.(doc);
  }, [publish, doc]);

  // Le curseur suit, mais n'est pas publié à la frappe : c'est la session qui
  // l'annonce à intervalle régulier, sinon chaque déplacement produirait une trame.
  const setCursor = collab?.setCursor;
  useEffect(() => {
    const position = session.state.selection.focus;
    setCursor?.({ blockId: position.blockId, offset: position.offset });
  }, [setCursor, session.state.selection.focus]);

  // Focus initial
  useEffect(() => {
    focus();
  }, [focus]);

  /**
   * Raccourcis qui doivent fonctionner même quand le focus a quitté le document
   * — dans un dialogue, la règle ou le plan.
   *
   * `Ctrl+K` et `Ctrl+F` en sont **absents** volontairement : le contrôleur les
   * traite déjà. Les gérer ici aussi les déclencherait deux fois, `preventDefault`
   * n'arrêtant pas la propagation — `Ctrl+K` ouvrait le lien *et* la palette.
   */
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === 'p') {
        // Convention des palettes de commandes, partagée avec les éditeurs de
        // code : `Ctrl+K` reste au lien hypertexte, comme dans Writer et Word.
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

  // Statistiques en temps réel
  const statistics = useMemo(() => computeStatistics(doc), [doc]);

  // Recherche & Remplacement
  const matches = useMemo(
    () => (findReplaceOpen && findReplaceState.query ? findMatches(doc, findReplaceState.query, findReplaceState.options) : []),
    [doc, findReplaceOpen, findReplaceState.query, findReplaceState.options],
  );

  /**
   * Rang de l'occurrence courante.
   *
   * On repère depuis le **début** de la sélection, pas depuis sa tête : une
   * occurrence sélectionnée a sa tête à sa propre fin, si bien que partir de la
   * tête désignerait déjà l'occurrence suivante — et `Entrée` en sauterait une
   * sur deux.
   */
  const currentMatchIndex = useMemo(() => {
    if (matches.length === 0) return -1;
    const { start } = normalizeSelection(doc, session.state.selection);
    return matchNearest(doc, matches, start);
  }, [doc, matches, session.state.selection]);

  /**
   * Rectangles de toutes les occurrences.
   *
   * Surligner **toutes** les occurrences, et pas seulement la courante, permet
   * de juger d'un coup d'œil si le mot cherché est le bon : un compteur seul
   * oblige à parcourir le document pour s'en assurer.
   *
   * La géométrie vient du moteur (`rangeRects`), la même que celle de la
   * sélection — deux calculs distincts finiraient par diverger.
   */
  const searchRects = useMemo(() => {
    if (matches.length === 0) return [];
    return matches.flatMap((match, index) => {
      const { start, end } = matchRange(match);
      return rangeRects(doc, layout, start, end, measurer).map((rect) => ({
        rect,
        current: index === currentMatchIndex,
      }));
    });
  }, [matches, currentMatchIndex, doc, layout, measurer]);

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

  // Sélection d'un titre depuis le plan du document
  const handleSelectHeading = useCallback(
    (blockId: string) => {
      commands.goToBlock(blockId);
      focus();
    },
    [commands, focus],
  );

  // Mise à jour des marges et styles par défaut
  const handleSavePageSetupAndDefaults = useCallback(
    (nextPageSetup: PageSetup, nextDefaults: DocumentDefaults) => {
      commands.replaceDocument({
        ...doc,
        pageSetup: nextPageSetup,
        defaults: nextDefaults,
      });
      focus();
    },
    [commands, doc, focus],
  );

  // Modification des marges depuis la règle
  const handleRulerMarginChange = useCallback(
    (margins: { leftMm?: number; rightMm?: number }) => {
      commands.replaceDocument({
        ...doc,
        pageSetup: {
          ...doc.pageSetup,
          ...(margins.leftMm !== undefined ? { marginLeftMm: margins.leftMm } : {}),
          ...(margins.rightMm !== undefined ? { marginRightMm: margins.rightMm } : {}),
        },
      });
    },
    [commands, doc],
  );

  // Positionnement de la zone de saisie invisible
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

  // Définition des menus de la MenuBar
  const menus = useMemo<MenuDefinition[]>(
    () => [
      {
        label: 'Fichier',
        entries: [
          ...(onOpen ? [{ label: 'Ouvrir un document (.odt)…', shortcut: shortcutLabel('Mod-o'), run: onOpen }] : []),
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
        entries: [
          { label: 'Insérer un tableau (3×3)', run: () => commands.insertTable(3, 3) },
          { label: 'Insérer une ligne au-dessus', run: commands.insertTableRowAbove, separatorBefore: true },
          { label: 'Insérer une ligne au-dessous', run: commands.insertTableRowBelow },
          { label: 'Supprimer la ligne', run: commands.deleteTableRow },
          { label: 'Insérer une colonne à gauche', run: commands.insertTableColumnLeft, separatorBefore: true },
          { label: 'Insérer une colonne à droite', run: commands.insertTableColumnRight },
          { label: 'Supprimer la colonne', run: commands.deleteTableColumn },
          { label: 'Fusionner les cellules', run: commands.mergeCells, separatorBefore: true },
          { label: 'Scinder en colonnes', run: () => commands.splitCell('horizontal', 2) },
          { label: 'Scinder en lignes', run: () => commands.splitCell('vertical', 2) },
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
    ],
  );

  // Commandes pour la palette Ctrl+K
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

  return (
    <div className="writer">
      {/* Barre de titre principale avec le titre et le menu empilés à gauche, et les actions à droite */}
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
          {/* Ouvrir, Enregistrer, Exporter PDF et Imprimer vivent dans le menu
              Fichier, et Imprimer aussi dans le ruban. Les répéter ici encombrait
              l'en-tête sans rien offrir de plus. Reste le partage, qui n'a pas
              d'autre point d'entrée. */}
        </div>
      </header>

      {/* Ruban complet avec les icônes vectorielles du système */}
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

      {/* Panneau de recherche ancré */}
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

      {/* Règle graduée interactive */}
      {showRuler && (
        <Ruler
          zoom={zoom}
          pageWidthCm={doc.pageSetup.widthMm / 10}
          leftMarginCm={doc.pageSetup.marginLeftMm / 10}
          rightMarginCm={doc.pageSetup.marginRightMm / 10}
          firstLineIndentCm={((currentParagraph?.firstLineIndentPt ?? 0) * 2.54) / 72}
          onMarginChange={handleRulerMarginChange}
          onFirstLineIndentChange={(indentCm) => {
            const pt = (indentCm * 72) / 2.54;
            commands.setFirstLineIndentPt(Math.abs(pt) > 0.5 ? Math.round(pt * 10) / 10 : null);
          }}
          onOpenMarginsDialog={() => setStylesMarginsOpen(true)}
        />
      )}

      {/* Espace de travail principal avec plan latéral et surface A4.
          La classe est indispensable : `overflow: hidden` convient à l'écran,
          mais rognerait les pages à l'impression. Seule une classe permet à la
          feuille `@media print` de neutraliser ce conteneur. */}
      <div
        className="writer-workspace"
        style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
      >
        {/* Plan du document (DocumentOutline) */}
        <DocumentOutline
          documentState={doc}
          open={outlineOpen}
          onClose={() => setOutlineOpen(false)}
          onSelectHeading={handleSelectHeading}
        />

        {/* Surface des pages physiques */}
        <div className="writer-surface" style={{ flex: 1 }}>
          <div
            className="writer-pages"
            style={{
              transform: `scale(${zoom})`,
              width: `${geometry.pageWidthPx}px`,
              gap: `${PAGE_GAP_PX}px`,
            }}
            // Déposer une image sur la page l'insère au curseur. `preventDefault`
            // sur le survol est obligatoire : sans lui le navigateur refuse le
            // dépôt et ouvre le fichier à la place, en quittant le document.
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
                  /* fichier illisible : rien de déposé, rien de cassé */
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
                placements={placementsByPage[page.index] ?? []}
                selectionRects={rects.filter((rect) => rect.pageIndex === page.index)}
                searchRects={searchRects.filter((entry) => entry.rect.pageIndex === page.index)}
                caret={caret?.pageIndex === page.index ? caret : null}
                caretIdle={!controller.isFocused}
                showMargins={showMargins}
                onToggleTask={controller.commands.toggleTask}
                onOpenFurniture={(band) => setFurnitureBandToEdit(band)}
                onEditMath={handleEditMath}
                onEditImage={handleEditImage}
                onPointerDown={handlers.onPointerDown}
                onPointerMove={handlers.onPointerMove}
                onPointerUp={handlers.onPointerUp}
              />
            ))}

            {/* Zone de frappe invisible mais contrôlée */}
            <textarea
              ref={inputRef}
              className="writer-input"
              style={inputStyle}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
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

          {/*
            Gouttière de commentaires (`SwPostItMgr`). Hors de la feuille, et
            non dans sa marge : un commentaire est un objet de relecture, il ne
            doit pas s'imprimer. Elle se met à l'échelle avec les pages pour que
            chaque bulle reste en face de son ancre à tous les niveaux de zoom.
          */}
          {hasComments && (
            <div
              className="writer-comment-gutter"
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
                marginLeft: '16px',
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

      <LiveRegion message={announcement} />

      {/* Barre d'état en bas */}
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

      {/* Dialogues et modales */}
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
            // Le dialogue se ferme tout de suite : attendre le dépôt derrière
            // une fenêtre encore ouverte donnerait l'impression d'un blocage.
            setImageDraft(null);
            void adresseFinale(resultat.src).then((src) => {
              const attributs = {
                src,
                widthPt: resultat.widthPt,
                heightPt: resultat.heightPt,
                alt: resultat.alt,
                ...(resultat.crop ? { crop: resultat.crop } : {}),
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
            commands.replaceDocument({
              ...doc,
              furniture: updatedFurniture,
            });
          }}
          onClose={() => setFurnitureBandToEdit(null)}
        />
      )}

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

    </div>
  );
}

/** Statistiques du document */
function computeStatistics(doc: WriterDocumentState): { words: number; characters: number } {
  let words = 0;
  let characters = 0;

  const { order, byId } = paragraphIndex(doc);
  for (const id of order) {
    const paragraph = byId.get(id)?.paragraph;
    if (!paragraph) continue;
    const text = paragraphText(paragraph);
    characters += text.length;
    const matches = text.match(/\S+/g);
    if (matches) words += matches.length;
  }

  return { words, characters };
}
