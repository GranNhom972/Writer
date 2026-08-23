/**
 * Coquille applicative Write (couche 4).
 *
 * Traite les sept états d'interface obligatoires (01_DIRECTIVE_UX_ERGONOMIE.md §4) :
 * vide, chargement, partiel, erreur, hors ligne, lecture seule, reconnexion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { ApiError, createDocument, getDocument, joinSession, renameDocument } from './collab/api';
import {
  createCollabSession,
  readPeers,
  toConnectionStatus,
  type CollabSession,
  type ConnectionStatus,
  type RemotePeer,
} from './collab/session';
import { Button } from './design/components/Button';
import { Icon } from './design/icons/Icon';
import { PresenceAvatars } from './design/components/PresenceAvatars';
import { DocumentSkeleton, EmptyState, ErrorState } from './design/components/States';
import { presenceColorVar } from './domain/presence';
import {
  changeIndent,
  clearFormatting,
  insertFootnote,
  insertMath,
  insertPageBreak,
  insertPageNumber,
  deleteColumnAt,
  deleteRowAt,
  deleteTable,
  insertColumnAt,
  insertRowAt,
  insertTable,
  resizeTable,
  setTableAttrs,
  tableInfo,
  mathAtSelection,
  removeMath,
  updateMath,
  setAlignment,
  setHeading,
  setParagraph,
  toggleBold,
  toggleItalic,
  toggleList,
  toggleStrike,
  toggleUnderline,
} from './editor/commands';
import { shortcutLabel } from './editor/keymap';
import { redo as redoCommand, undo as undoCommand } from 'y-prosemirror';
import { WriteEditor } from './editor/WriteEditor';
import { MathDialog, type MathDraft } from './ui/MathDialog';
import { PageFurnitureDialog } from './ui/PageFurnitureDialog';
import {
  DEFAULT_FURNITURE,
  readFurniture,
  type FurnitureBand,
  type PageFurniture,
} from './document/pageFurniture';
import { TableProperties } from './ui/TableProperties';
import { TableOverlay } from './ui/TableOverlay';
import { FootnoteDialog } from './ui/FootnoteDialog';
import { FindReplaceDialog } from './ui/FindReplaceDialog';
import { DocumentOutline } from './ui/DocumentOutline';
import { CommandPalette, type PaletteCommand } from './ui/CommandPalette';
import { Ruler } from './ui/Ruler';
import { exportToOdtBlob, downloadBlob } from './document/odf/export';
import { exportToDocxBlob } from './document/docx/export';
import { DocumentTitle } from './ui/DocumentTitle';
import { LiveRegion } from './ui/LiveRegion';
import { MenuBar, type MenuDefinition } from './ui/MenuBar';
import { Ribbon, ZOOM_LEVELS } from './ui/Ribbon';
import { StatusBar } from './ui/StatusBar';

type Phase =
  | { kind: 'signed-out' }
  | { kind: 'loading'; title: string }
  | { kind: 'ready'; docId: string; canWrite: boolean }
  | { kind: 'error'; title: string; detail: string };

/** Ce qu'il faut pour ouvrir une session ; la session elle-même naît dans un effet. */
interface SessionRequest {
  docId: string;
  scope: 'read' | 'write';
  initialTitle: string;
  local?: boolean;
  /**
   * Jeton délivré en rejoignant une session. Absent, l'application retombe sur un
   * jeton de développement dérivé du nom saisi — ce que le serveur n'accepte
   * qu'en `WRITE_AUTH_MODE=dev`.
   */
  accessToken?: string | undefined;
}

/**
 * ⚠️ Identité de développement. Le serveur n'accepte ces jetons qu'en
 * `WRITE_AUTH_MODE=dev` ; en production il exige un JWT vérifié (auth.rs).
 */
function devToken(user: string, scope: 'read' | 'write'): string {
  return `dev.${user}.${scope}`;
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'signed-out' });
  const [userName, setUserName] = useState('alice');
  const [joinId, setJoinId] = useState(() => new URLSearchParams(window.location.search).get('doc') ?? '');
  const [request, setRequest] = useState<SessionRequest | null>(null);
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [title, setTitle] = useState('Document sans titre');
  const [zoom, setZoom] = useState(1);
  const [readingMode, setReadingMode] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [tablePropsOpen, setTablePropsOpen] = useState(false);
  const [tableAnchor, setTableAnchor] = useState<{ top: number; right: number } | null>(null);
  /** Retour visible pendant et après un téléchargement (le moteur PDF pèse 400 Kio
   *  et n'est chargé qu'au premier usage : l'attente doit se voir). */
  const [exportStatus, setExportStatus] = useState<{ texte: string; enCours: boolean } | null>(null);
  const tableButtonRef = useRef<HTMLButtonElement | null>(null);
  const [documentArea, setDocumentArea] = useState<HTMLElement | null>(null);
  const [footnoteDialogOpen, setFootnoteDialogOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [furniture, setFurniture] = useState<PageFurniture>(DEFAULT_FURNITURE);
  const [furnitureOpen, setFurnitureOpen] = useState(false);
  /** Bande à mettre en avant : celle sur laquelle on a cliqué dans la page. */
  const [furnitureBand, setFurnitureBand] = useState<FurnitureBand>('header');
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const imageButtonRef = useRef<HTMLButtonElement | null>(null);

  // Écouteur de raccourcis globaux : Ctrl+F (Recherche) et Ctrl+Maj+P / F1 (Palette)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindReplaceOpen(true);
      } else if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') || e.key === 'F1') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const selfColor = useMemo(() => presenceColorVar(userName), [userName]);

  const openSession = useCallback(
    (
      docId: string,
      initialTitle: string,
      scope: 'read' | 'write',
      local = false,
      accessToken?: string,
    ) => {
      setTitle(initialTitle);
      setRequest({ docId, scope, initialTitle, local, accessToken });
      setPhase({ kind: 'ready', docId, canWrite: scope === 'write' });
      setAnnouncement(`Document « ${initialTitle} » ouvert.`);
    },
    [],
  );

  /**
   * Lancement direct via paramètres d'URL (API / liens directs) :
   * - Local : ?local=true ou ?mode=local
   * - Session : ?session=<token_session>&email=<adresse> — la permission vient
   *   de la session, jamais de l'URL
   * - Création de session : ?create=true ou ?mode=create (avec &user=alice&title=MonDoc)
   * - Rejoindre par identifiant : ?doc=<id> ou ?join=<id> (avec &user=bob&scope=write)
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const userParam = params.get('user') || params.get('username');
    const effectiveUser = userParam || 'alice';
    if (userParam) setUserName(userParam);

    const titleParam = params.get('title') || 'Document sans titre';
    const scopeParam = (params.get('scope') === 'read' ? 'read' : 'write') as 'read' | 'write';

    // 1. Mode Local direct
    if (params.get('local') === 'true' || params.get('local') === '1' || params.get('mode') === 'local') {
      openSession('local-doc', titleParam, 'write', true);
      return;
    }

    // 2. Session identifiée par sa signature unique.
    //
    // C'est le seul mode où la portée n'est pas lue dans l'URL : elle est celle
    // que la session accorde à cette adresse. Une portée déclarée par le client
    // ne serait qu'un souhait.
    const tokenSession = params.get('session') || params.get('token_session');
    if (tokenSession) {
      const email = params.get('email');
      if (!email) {
        setPhase({
          kind: 'error',
          title: 'Adresse manquante',
          detail:
            'Ajoutez &email=… à l’adresse : une session reconnaît ses participants par leur adresse électronique.',
        });
        return;
      }

      setPhase({ kind: 'loading', title: 'Ouverture de la session' });
      joinSession(tokenSession, email)
        .then((join) => {
          setUserName(join.user_id);
          openSession(
            join.doc_id,
            join.title,
            join.permission === 'write' ? 'write' : 'read',
            false,
            join.access_token ?? undefined,
          );
        })
        .catch((err) => {
          setPhase(describeFailure(err));
        });
      return;
    }

    // 3. Mode Création automatique
    if (params.get('create') === 'true' || params.get('create') === '1' || params.get('mode') === 'create') {
      setPhase({ kind: 'loading', title: titleParam });
      createDocument(devToken(effectiveUser, 'write'), titleParam)
        .then((doc) => {
          openSession(doc.doc_id, doc.title, 'write');
        })
        .catch((err) => {
          setPhase(describeFailure(err));
        });
      return;
    }

    // 4. Mode Rejoindre automatique, par identifiant de document
    const docId = params.get('doc') || params.get('join');
    if (docId) {
      setPhase({ kind: 'loading', title: 'Ouverture du document' });
      getDocument(devToken(effectiveUser, scopeParam), docId)
        .then((doc) => {
          openSession(doc.doc_id, doc.title, scopeParam);
        })
        .catch((err) => {
          setPhase(describeFailure(err));
        });
      return;
    }
  }, [openSession]);

  /**
   * Cycle de vie de la session collaborative.
   */
  useEffect(() => {
    if (!request) {
      setSession(null);
      return;
    }

    if (request.local) {
      const collab = createCollabSession({
        docId: request.docId,
        token: 'local',
        user: { userId: userName, displayName: userName, color: presenceColorVar(userName) },
        local: true,
      });
      setStatus('local');
      setSession(collab);
      return () => {
        collab.destroy();
        setSession(null);
        setPeers([]);
      };
    }

    const collab = createCollabSession({
      docId: request.docId,
      token: request.accessToken ?? devToken(userName, request.scope),
      user: { userId: userName, displayName: userName, color: presenceColorVar(userName) },
    });

    const onStatus = ({ status: next }: { status: 'connected' | 'disconnected' | 'connecting' }): void =>
      setStatus(toConnectionStatus(next));
    const onClose = (): void => setStatus('offline');
    const onAwareness = (): void => setPeers(readPeers(collab.awareness));

    // Le titre vit dans le CRDT : un renommage se voit chez tous immédiatement.
    const syncTitle = (): void => {
      const shared = collab.meta.get('title');
      if (typeof shared === 'string' && shared.length > 0) setTitle(shared);
      // En-tête et pied voyagent avec le titre : ils appartiennent au document,
      // pas au poste de travail.
      setFurniture(readFurniture(collab.meta.get('pageFurniture')));
    };

    collab.provider?.on('status', onStatus);
    collab.provider?.on('connection-close', onClose);
    collab.awareness.on('change', onAwareness);
    collab.meta.observe(syncTitle);
    collab.provider?.once('sync', () => {
      if (typeof collab.meta.get('title') !== 'string' && request.scope === 'write') {
        collab.meta.set('title', request.initialTitle);
      }
      syncTitle();
    });

    setSession(collab);

    return () => {
      collab.provider?.off('status', onStatus);
      collab.provider?.off('connection-close', onClose);
      collab.awareness.off('change', onAwareness);
      collab.meta.unobserve(syncTitle);
      collab.destroy();
      setSession(null);
      setPeers([]);
    };
  }, [request, userName]);

  const handleCreate = useCallback(async () => {
    setPhase({ kind: 'loading', title: 'Nouveau document' });
    try {
      const doc = await createDocument(devToken(userName, 'write'), 'Document sans titre');
      openSession(doc.doc_id, doc.title, 'write');
    } catch (error) {
      setPhase(describeFailure(error));
    }
  }, [openSession, userName]);

  const handleJoin = useCallback(
    async (scope: 'read' | 'write' = 'write') => {
      const docId = joinId.trim();
      if (!docId) return;
      setPhase({ kind: 'loading', title: 'Ouverture du document' });
      try {
        const doc = await getDocument(devToken(userName, scope), docId);
        openSession(doc.doc_id, doc.title, scope);
      } catch (error) {
        setPhase(describeFailure(error));
      }
    },
    [joinId, openSession, userName],
  );

  const handleRename = useCallback(
    (next: string) => {
      if (!session || phase.kind !== 'ready') return;
      session.meta.set('title', next);
      setTitle(next);
      // Durabilité côté serveur : un échec réseau n'annule pas le renommage local,
      // que le CRDT resynchronisera de toute façon.
      void renameDocument(devToken(userName, 'write'), phase.docId, next).catch(() => {
        setAnnouncement('Le nouveau titre sera enregistré au retour de la connexion.');
      });
    },
    [phase, session, userName],
  );

  const runInEditor = useCallback((command: Command) => {
    const view = viewRef.current;
    // Même garde qu'ailleurs : une vue détruite subsiste le temps d'un rendu.
    if (!view || view.isDestroyed) return;
    command(view.state, view.dispatch, view);
    view.focus();
  }, []);

  /**
   * « Imprimer » et « Enregistrer en PDF » empruntent le même chemin : dans les
   * deux cas, ce qu'on met sur le papier, c'est la feuille — pas l'application.
   * Les règles `@media print` de `app.css` restent le filet de sécurité pour un
   * Ctrl+P déclenché par le navigateur lui-même.
   */
  /** Enregistre l'en-tête et le pied dans le document répliqué. */
  const appliquerFurniture = useCallback(
    (suivant: PageFurniture) => {
      setFurniture(suivant);
      // `meta` est une carte répliquée : la modification part chez tous les
      // participants, exactement comme un renommage.
      session?.meta.set('pageFurniture', suivant);
    },
    [session],
  );

  const print = useCallback(() => {
    void telechargerPdfFideleRef.current?.();
  }, []);
  const telechargerPdfFideleRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Téléchargements. Le travail est fait dans le navigateur : aucun envoi du
   * document à un service tiers pour le convertir.
   */
  /**
   * PDF **fidèle** : c'est le moteur de rendu du navigateur qui compose la page,
   * donc le résultat est identique à l'écran par construction. Aucun moteur de
   * mise en page réécrit ne peut garantir cela — polices, césure, veuves et
   * orphelines, tableaux : tout serait une approximation.
   *
   * Contrepartie honnête : l'usager choisit « Enregistrer au format PDF » dans la
   * boîte d'impression. On le lui dit avant de l'ouvrir.
   */
  const telechargerPdfFidele = useCallback(async (): Promise<void> => {
    const contenu = document.querySelector<HTMLElement>('.ProseMirror');
    if (!contenu) return;

    setExportStatus({
      texte: 'La fenêtre d’impression s’ouvre : choisissez « Enregistrer au format PDF ».',
      enCours: false,
    });
    setAnnouncement(
      'Ouverture de la fenêtre d’impression. Choisissez « Enregistrer au format PDF » pour obtenir un fichier identique à la feuille.',
    );

    try {
      const { imprimerDocument } = await import('./document/print/printable');
      const { resolveGeometry } = await import('./document/pageFurniture');
      const geo = resolveGeometry(furniture);
      const contexte = { page: 1, pages: pageCount, titre: title };
      const { renderFurniture, footerLine } = await import('./document/pageFurniture');
      await imprimerDocument(contenu, title, {
        headerMm: furniture.headerMm,
        footerMm: furniture.footerMm,
        headerAlign: furniture.headerAlign,
        footerAlign: furniture.footerAlign,
        fontSizePt: furniture.fontSizePt,
        header: renderFurniture(furniture.header, contexte),
        // Le numéro de page ne peut pas varier d'une feuille à l'autre avec un
        // élément fixé : on l'omet ici et le total reste exact.
        footer: footerLine({ ...furniture, pageNumber: false }, contexte),
        headerContentMm: geo.headerContentMm,
        footerContentMm: geo.footerContentMm,
        // Les jetons sont substitués ici : le module d'impression ne connaît ni
        // le document ni sa pagination.
        blocks: furniture.blocks.map((bloc) => ({
          ...bloc,
          text: renderFurniture(bloc.text, contexte),
        })),
      }, {
        hautMm: geo.marginTopMm,
        basMm: geo.marginBottomMm,
        gaucheMm: geo.marginLeftMm,
        droiteMm: geo.marginRightMm,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erreur inconnue';
      setAnnouncement(`L’aperçu d’impression a échoué : ${message}.`);
      setExportStatus({ texte: `L’aperçu d’impression a échoué : ${message}.`, enCours: false });
    } finally {
      window.setTimeout(() => setExportStatus(null), 4000);
    }
  }, [title, furniture, pageCount]);

  telechargerPdfFideleRef.current = telechargerPdfFidele;

  const telecharger = useCallback(
    async (format: 'docx' | 'odt') => {
      const doc = viewRef.current?.state.doc;
      if (!doc) return;

      const libelle = format.toUpperCase();
      setAnnouncement(`Préparation du fichier ${libelle}…`);
      setExportStatus({ texte: `Préparation du fichier ${libelle}…`, enCours: true });

      const terminer = (message: string): void => {
        setAnnouncement(message);
        setExportStatus({ texte: message, enCours: false });
        window.setTimeout(() => setExportStatus(null), 5000);
      };

      try {
        if (format === 'odt') {
          downloadBlob(await exportToOdtBlob(doc, title), nomDeFichier(title, 'odt'));
          terminer('Document téléchargé au format ODF (.odt).');
          return;
        }

        const { blob, degradations } = await exportToDocxBlob(doc, title);
        downloadBlob(blob, nomDeFichier(title, 'docx'));
        terminer(
          degradations.length > 0
            ? `Document Word téléchargé. À noter : ${degradations.join(' ; ')}.`
            : 'Document Word (.docx) téléchargé.',
        );
      } catch (error) {
        // Un export qui échoue en silence est pire qu'un export absent.
        terminer(
          `Le téléchargement ${libelle} a échoué : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
        );
      }
    },
    [title],
  );

  /**
   * Position du panneau de propriétés : sous le bouton qui l'ouvre, **borné à la
   * fenêtre**. Sans borne, l'écart mesuré depuis le bord droit sur un écran large
   * projette le panneau hors de l'écran dès qu'on réduit la fenêtre.
   */
  const computeTableAnchor = useCallback((): { top: number; right: number } | null => {
    const rect = tableButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const largeurPanneau = 320;
    const marge = 8;
    const rightMax = Math.max(marge, window.innerWidth - largeurPanneau - marge);

    return {
      top: Math.round(Math.min(rect.bottom + marge, window.innerHeight - marge)),
      right: Math.round(Math.min(Math.max(window.innerWidth - rect.right, marge), rightMax)),
    };
  }, []);

  const openTableProperties = useCallback(() => {
    setTableAnchor(computeTableAnchor());
    setTablePropsOpen(true);
  }, [computeTableAnchor]);

  // Le panneau suit la fenêtre : redimensionner ne doit pas l'expulser de l'écran.
  useEffect(() => {
    if (!tablePropsOpen) return;
    const onResize = (): void => setTableAnchor(computeTableAnchor());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [tablePropsOpen, computeTableAnchor]);

  /**
   * Ouvre l'éditeur de formule. Si la sélection porte déjà sur une formule, on la
   * modifie plutôt que d'en insérer une seconde à côté — c'est ce qu'attend
   * l'usager qui clique sur une formule existante.
   */
  const openMathDialog = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const existing = mathAtSelection(view.state);
    setMathDraft(
      existing
        ? { latex: existing.latex, display: existing.display, pos: existing.pos }
        : { latex: '', display: false },
    );
  }, []);

  const editMathAt = useCallback((pos: number) => {
    const view = viewRef.current;
    const node = view?.state.doc.nodeAt(pos);
    if (!node) return;
    setMathDraft({
      latex: String(node.attrs['latex'] ?? ''),
      display: node.type.name === 'math_block',
      pos,
    });
  }, []);

  const submitMath = useCallback(
    (latex: string, display: boolean) => {
      const view = viewRef.current;
      if (!view || !mathDraft) return;

      // Changer la disposition change de type de nœud : on remplace au lieu de
      // modifier l'attribut, sinon une formule « en ligne » resterait en ligne.
      const sameKind = mathDraft.pos !== undefined && display === mathDraft.display;
      if (mathDraft.pos !== undefined && sameKind) {
        updateMath(mathDraft.pos, latex)(view.state, view.dispatch, view);
      } else {
        if (mathDraft.pos !== undefined) {
          removeMath(mathDraft.pos)(view.state, view.dispatch, view);
        }
        insertMath(latex, display)(view.state, view.dispatch, view);
      }

      setMathDraft(null);
      view.focus();
      setAnnouncement(display ? 'Formule centrée insérée.' : 'Formule insérée dans le texte.');
    },
    [mathDraft],
  );

  const deleteMath = useCallback(() => {
    const view = viewRef.current;
    if (!view || mathDraft?.pos === undefined) return;
    removeMath(mathDraft.pos)(view.state, view.dispatch, view);
    setMathDraft(null);
    view.focus();
    setAnnouncement('Formule supprimée.');
  }, [mathDraft]);

  const copyShareLink = useCallback(async () => {
    if (phase.kind !== 'ready') return;
    const url = `${window.location.origin}${window.location.pathname}?doc=${phase.docId}`;
    try {
      await navigator.clipboard.writeText(url);
      setAnnouncement('Lien de partage copié dans le presse-papiers.');
    } catch {
      setAnnouncement(`Lien de partage : ${url}`);
    }
  }, [phase]);

  // Le hors-ligne est un état normal, pas une panne : l'édition continue (CRDT).
  useEffect(() => {
    const goOffline = (): void => setStatus('offline');
    window.addEventListener('offline', goOffline);
    return () => window.removeEventListener('offline', goOffline);
  }, []);

  /** Tableau contenant le curseur, ou `null`. Pilote le bouton du ruban. */
  const currentTable = useMemo(() => (editorState ? tableInfo(editorState) : null), [editorState]);

  // Le panneau se referme dès que le curseur quitte le tableau : le garder ouvert
  // sur un tableau qu'on ne modifie plus induirait en erreur.
  useEffect(() => {
    if (!currentTable) setTablePropsOpen(false);
  }, [currentTable]);

  const wordCount = useMemo(() => countWords(editorState), [editorState]);
  // Le nombre de pages vient du greffon de pagination, pas d'une lecture du DOM :
  // une lecture pendant le rendu renvoyait la valeur de la frappe précédente.

  const menus = useMemo<MenuDefinition[]>(() => {
    if (phase.kind !== 'ready') return [];
    const canWrite = phase.canWrite && !readingMode;

    return [
      {
        label: 'Fichier',
        entries: [
          { label: 'Nouveau document', run: () => void handleCreate() },
          {
            label: 'Télécharger en PDF (.pdf)',
            run: () => void telechargerPdfFidele(),
            separatorBefore: true,
          },
          { label: 'Télécharger en Word (.docx)', run: () => void telecharger('docx') },
          { label: 'Télécharger en ODF (.odt)', run: () => void telecharger('odt') },
          { label: 'Copier le lien de partage', run: () => void copyShareLink(), separatorBefore: true },
          { label: 'Imprimer', shortcut: shortcutLabel('Mod-p'), run: print, separatorBefore: true },
        ],
      },
      {
        label: 'Édition',
        entries: [
          { label: 'Annuler', shortcut: shortcutLabel('Mod-z'), run: () => runInEditor(undoCommand), disabled: !canWrite },
          { label: 'Rétablir', shortcut: shortcutLabel('Mod-y'), run: () => runInEditor(redoCommand), disabled: !canWrite },
          {
            label: 'Rechercher et remplacer…',
            shortcut: 'Ctrl+F',
            run: () => setFindReplaceOpen(true),
            separatorBefore: true,
          },
          {
            label: 'Palette de commandes…',
            shortcut: 'Ctrl+Maj+P',
            run: () => setCommandPaletteOpen(true),
          },
          {
            label: 'Effacer la mise en forme',
            shortcut: shortcutLabel('Mod-\\'),
            run: () => runInEditor(clearFormatting),
            disabled: !canWrite,
            separatorBefore: true,
          },
        ],
      },
      {
        label: 'Affichage',
        entries: [
          {
            label: 'Plan du document',
            run: () => setOutlineOpen((prev) => !prev),
            checked: outlineOpen,
          },
          ...ZOOM_LEVELS.map((level) => ({
            label: `Zoom ${Math.round(level * 100)} %`,
            run: () => setZoom(level),
            checked: zoom === level,
          })),
          {
            label: 'Mode lecture',
            run: () => setReadingMode((previous) => !previous),
            checked: readingMode,
            separatorBefore: true,
          },
        ],
      },
      {
        label: 'Insertion',
        entries: [
          {
            label: 'Tableau…',
            run: () => tableButtonRef.current?.click(),
            disabled: !canWrite,
          },
          {
            label: 'Note de bas de page…',
            run: () => setFootnoteDialogOpen(true),
            disabled: !canWrite,
          },
          {
            label: 'Numéro de page',
            run: () => runInEditor(insertPageNumber),
            disabled: !canWrite,
          },
          {
            label: 'En-tête de page…',
            run: () => {
              setFurnitureBand('header');
              setFurnitureOpen(true);
            },
            disabled: !canWrite,
          },
          {
            label: 'Pied de page…',
            run: () => {
              setFurnitureBand('footer');
              setFurnitureOpen(true);
            },
            disabled: !canWrite,
          },
          {
            label: 'Saut de page',
            shortcut: shortcutLabel('Mod-Enter'),
            run: () => runInEditor(insertPageBreak),
            disabled: !canWrite,
            separatorBefore: true,
          },
          {
            label: 'Image par adresse…',
            run: () => imageButtonRef.current?.click(),
            disabled: !canWrite,
          },
          {
            label: 'Formule mathématique…',
            shortcut: shortcutLabel('Mod-Shift-m'),
            run: openMathDialog,
            disabled: !canWrite,
          },
          {
            label: 'Lien…',
            shortcut: shortcutLabel('Mod-k'),
            run: () => linkButtonRef.current?.click(),
            disabled: !canWrite,
          },
          { label: 'Liste à puces', shortcut: shortcutLabel('Mod-Shift-8'), run: () => runInEditor(toggleList('bullet_list')), disabled: !canWrite, separatorBefore: true },
          { label: 'Liste numérotée', shortcut: shortcutLabel('Mod-Shift-7'), run: () => runInEditor(toggleList('ordered_list')), disabled: !canWrite },
          { label: 'Liste à cocher', shortcut: shortcutLabel('Mod-Shift-9'), run: () => runInEditor(toggleList('task_list')), disabled: !canWrite },
        ],
      },
      {
        label: 'Format',
        entries: [
          { label: 'Gras', shortcut: shortcutLabel('Mod-b'), run: () => runInEditor(toggleBold), disabled: !canWrite },
          { label: 'Italique', shortcut: shortcutLabel('Mod-i'), run: () => runInEditor(toggleItalic), disabled: !canWrite },
          { label: 'Souligné', shortcut: shortcutLabel('Mod-u'), run: () => runInEditor(toggleUnderline), disabled: !canWrite },
          { label: 'Barré', shortcut: shortcutLabel('Mod-Shift-x'), run: () => runInEditor(toggleStrike), disabled: !canWrite },
          { label: 'Texte normal', shortcut: shortcutLabel('Mod-0'), run: () => runInEditor(setParagraph), disabled: !canWrite, separatorBefore: true },
          ...[1, 2, 3].map((level) => ({
            label: `Titre ${level}`,
            shortcut: shortcutLabel(`Mod-${level}`),
            run: () => runInEditor(setHeading(level)),
            disabled: !canWrite,
          })),
          { label: 'Centrer', shortcut: shortcutLabel('Mod-e'), run: () => runInEditor(setAlignment('center')), disabled: !canWrite, separatorBefore: true },
          { label: 'Justifier', shortcut: shortcutLabel('Mod-j'), run: () => runInEditor(setAlignment('justify')), disabled: !canWrite },
          { label: 'Augmenter le retrait', shortcut: shortcutLabel('Mod-]'), run: () => runInEditor(changeIndent(1)), disabled: !canWrite },
          { label: 'Diminuer le retrait', shortcut: shortcutLabel('Mod-['), run: () => runInEditor(changeIndent(-1)), disabled: !canWrite },
        ],
      },
      {
        label: 'Aide',
        entries: [
          {
            label: 'Raccourcis clavier',
            run: () =>
              setAnnouncement(
                'Raccourcis : Ctrl+B gras, Ctrl+I italique, Ctrl+U souligné, Ctrl+1..6 titres, Ctrl+K lien, Ctrl+F recherche, Ctrl+Maj+P palette, Ctrl+Maj+9 liste à cocher, Ctrl+Entrée saut de page.',
              ),
          },
        ],
      },
    ];
    // Dépendances complètes : sans `telecharger`/`telechargerPdfFidele`, les
    // entrées du menu gardaient les toutes premières fonctions — donc l'en-tête
    // vide et le titre d'origine, même après renommage.
  }, [
    copyShareLink,
    handleCreate,
    openMathDialog,
    openTableProperties,
    outlineOpen,
    phase,
    print,
    readingMode,
    runInEditor,
    telecharger,
    telechargerPdfFidele,
    zoom,
  ]);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    return [
      { id: 'undo', title: 'Annuler', category: 'Édition', shortcut: 'Ctrl+Z', perform: () => runInEditor(undoCommand) },
      { id: 'redo', title: 'Rétablir', category: 'Édition', shortcut: 'Ctrl+Y', perform: () => runInEditor(redoCommand) },
      { id: 'find', title: 'Rechercher et remplacer', category: 'Édition', shortcut: 'Ctrl+F', perform: () => setFindReplaceOpen(true) },
      { id: 'outline', title: 'Afficher / Masquer le plan', category: 'Affichage', perform: () => setOutlineOpen((p) => !p) },
      { id: 'table', title: 'Insérer un tableau', category: 'Insertion', perform: () => tableButtonRef.current?.click() },
      { id: 'footnote', title: 'Insérer une note de bas de page', category: 'Insertion', perform: () => setFootnoteDialogOpen(true) },
      { id: 'pagenum', title: 'Insérer le numéro de page', category: 'Insertion', perform: () => runInEditor(insertPageNumber) },
      { id: 'math', title: 'Insérer une formule mathématique', category: 'Insertion', shortcut: 'Ctrl+Maj+E', perform: openMathDialog },
      { id: 'pagebreak', title: 'Insérer un saut de page', category: 'Insertion', shortcut: 'Ctrl+Entrée', perform: () => runInEditor(insertPageBreak) },
      { id: 'h1', title: 'Titre 1', category: 'Format', shortcut: 'Ctrl+1', perform: () => runInEditor(setHeading(1)) },
      { id: 'h2', title: 'Titre 2', category: 'Format', shortcut: 'Ctrl+2', perform: () => runInEditor(setHeading(2)) },
      { id: 'h3', title: 'Titre 3', category: 'Format', shortcut: 'Ctrl+3', perform: () => runInEditor(setHeading(3)) },
      { id: 'bold', title: 'Gras', category: 'Format', shortcut: 'Ctrl+B', perform: () => runInEditor(toggleBold) },
      { id: 'italic', title: 'Italique', category: 'Format', shortcut: 'Ctrl+I', perform: () => runInEditor(toggleItalic) },
      { id: 'underline', title: 'Souligné', category: 'Format', shortcut: 'Ctrl+U', perform: () => runInEditor(toggleUnderline) },
      { id: 'clear', title: 'Effacer la mise en forme', category: 'Format', shortcut: 'Ctrl+\\', perform: () => runInEditor(clearFormatting) },
      { id: 'print', title: 'Imprimer le document', category: 'Fichier', shortcut: 'Ctrl+P', perform: print },
      { id: 'export-pdf', title: 'Télécharger en PDF', category: 'Fichier', perform: () => void telechargerPdfFidele() },
      { id: 'export-docx', title: 'Télécharger en Word (.docx)', category: 'Fichier', perform: () => void telecharger('docx') },
      { id: 'export-odt', title: 'Télécharger au format ODF (.odt)', category: 'Fichier', perform: () => void telecharger('odt') },
    ];
  }, [telecharger, telechargerPdfFidele, openMathDialog, print, runInEditor]);

  if (phase.kind === 'signed-out') {
    return (
      <main className="shell shell--centered">
        <EmptyState
          title="Write — traitement de texte collaboratif"
          description="Créez un document ou rejoignez-en un avec son identifiant. L’édition à plusieurs est immédiate ; hors ligne, vos modifications sont conservées et resynchronisées."
          action={
            <div className="start-form">
              <label className="field">
                <span className="field__label">Votre nom (mode développement)</span>
                <input
                  className="field__input"
                  value={userName}
                  onChange={(event) => setUserName(event.target.value.replace(/[^\w-]/g, ''))}
                  autoComplete="off"
                />
              </label>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="primary" onClick={() => void handleCreate()} disabled={!userName}>
                  Créer un document
                </Button>
                <Button variant="ghost" onClick={() => openSession('local-doc', 'Document local', 'write', true)}>
                  Mode local direct
                </Button>
              </div>
              <div className="start-form__row">
                <label className="field field--inline">
                  <span className="field__label">Identifiant d’un document existant</span>
                  <input
                    className="field__input"
                    value={joinId}
                    onChange={(event) => setJoinId(event.target.value)}
                    placeholder="018f3c2a-…"
                    autoComplete="off"
                  />
                </label>
                <Button onClick={() => void handleJoin('write')} disabled={!joinId.trim() || !userName}>
                  Rejoindre
                </Button>
                <Button onClick={() => void handleJoin('read')} disabled={!joinId.trim() || !userName}>
                  Ouvrir en lecture
                </Button>
              </div>
            </div>
          }
        />
      </main>
    );
  }

  if (phase.kind === 'loading') {
    return (
      <main className="shell shell--centered">
        <DocumentSkeleton />
      </main>
    );
  }

  if (phase.kind === 'error') {
    return (
      <main className="shell shell--centered">
        <ErrorState title={phase.title} detail={phase.detail} onRetry={() => {
            setRequest(null);
            setPhase({ kind: 'signed-out' });
          }} />
      </main>
    );
  }

  const readOnly = !phase.canWrite || readingMode;
  // Deux causes distinctes, deux messages distincts : « je n'ai pas le droit »
  // n'est pas « j'ai choisi de lire ».
  const readOnlyReason = !phase.canWrite ? 'scope' : readingMode ? 'reading-mode' : null;

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="titlebar__identity">
          <DocumentTitle title={title} disabled={!phase.canWrite} onCommit={handleRename} />
          <MenuBar menus={menus} />
        </div>
        <div className="titlebar__spacer" />
        <PresenceAvatars peers={peers} self={{ displayName: userName, color: selfColor }} />
        <Button variant="primary" onClick={() => void copyShareLink()}>
          <Icon name="share" size={16} />
          Partager
        </Button>
      </header>

      {status === 'offline' && (
        // Bandeau persistant non modal : l'édition reste possible.
        <div className="banner banner--offline" role="status">
          Hors ligne — vos modifications sont conservées localement et seront synchronisées
          automatiquement.
        </div>
      )}

      <Ribbon
        view={viewRef.current}
        state={editorState}
        disabled={readOnly}
        zoom={zoom}
        onZoomChange={setZoom}
        onPrint={print}
        onInsertMath={openMathDialog}
        onInsertTable={(rows, cols) => runInEditor(insertTable(rows, cols))}
        onOpenTableProperties={openTableProperties}
        inTable={currentTable !== null}
        tableButtonRef={tableButtonRef}
        onInsertFootnote={() => setFootnoteDialogOpen(true)}
        onToggleOutline={() => setOutlineOpen((p) => !p)}
        onOpenFindReplace={() => setFindReplaceOpen(true)}
        outlineOpen={outlineOpen}
        linkButtonRef={linkButtonRef}
        imageButtonRef={imageButtonRef}
      />

      {/* Marges réelles, et non les 2,5 cm par défaut : la règle donnait la
          même image quelles que soient les marges du document. */}
      <Ruler
        zoom={zoom}
        leftMarginCm={furniture.marginLeftMm / 10}
        rightMarginCm={furniture.marginRightMm / 10}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        <DocumentOutline
          editorState={editorState}
          editorView={viewRef.current}
          open={outlineOpen}
          onClose={() => setOutlineOpen(false)}
        />

        <main
          className="document-area"
          id="document-body"
          ref={setDocumentArea}
          style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
        >
          {session && (
            <WriteEditor
              session={session}
              editable={!readOnly}
              zoom={zoom}
              host={{
                openLinkDialog: () => linkButtonRef.current?.click(),
                openMathDialog,
                print,
              }}
              onEditMath={editMathAt}
            onPageCountChange={setPageCount}
            furniture={furniture}
            documentTitle={title}
            onEditFurniture={(band) => {
              setFurnitureBand(band);
              setFurnitureOpen(true);
            }}
              onStateChange={setEditorState}
              onViewReady={(view) => {
                viewRef.current = view;
                setEditorState(view?.state ?? null);
              }}
            />
          )}

          {/* Poignées posées sur le tableau : la manipulation a lieu là où
              l'usager regarde, pas dans un panneau distant. */}
          <TableOverlay
            view={viewRef.current}
            info={currentTable}
            disabled={readOnly}
            container={documentArea}
            onInsertRow={(index) => runInEditor(insertRowAt(index))}
            onDeleteRow={(index) => runInEditor(deleteRowAt(index))}
            onInsertColumn={(index) => runInEditor(insertColumnAt(index))}
            onDeleteColumn={(index) => runInEditor(deleteColumnAt(index))}
            onResize={(rows, cols) => runInEditor(resizeTable(rows, cols))}
            onOpenProperties={openTableProperties}
          />
        </main>

        <FindReplaceDialog
          open={findReplaceOpen}
          onClose={() => setFindReplaceOpen(false)}
          editorView={viewRef.current}
          canReplace={!readOnly}
        />
      </div>

      <StatusBar
        status={status}
        readOnlyReason={readOnlyReason}
        wordCount={wordCount}
        pageCount={pageCount}
      />
      {tablePropsOpen && currentTable && (
        <TableProperties
          info={currentTable}
          disabled={readOnly}
          triggerRef={tableButtonRef}
          anchor={tableAnchor ?? undefined}
          onResize={(rows, cols) => runInEditor(resizeTable(rows, cols))}
          onBorderWidth={(borderWidth) => runInEditor(setTableAttrs({ borderWidth }))}
          onBorderColor={(borderColor) => runInEditor(setTableAttrs({ borderColor }))}
          onHeaderRow={(headerRow) => runInEditor(setTableAttrs({ headerRow }))}
          onDelete={() => {
            runInEditor(deleteTable());
            setTablePropsOpen(false);
          }}
          onClose={() => setTablePropsOpen(false)}
        />
      )}

      {exportStatus && (
        <div className={`toast${exportStatus.enCours ? ' toast--busy' : ''}`} role="presentation">
          {exportStatus.enCours && <span className="toast__spinner" aria-hidden="true" />}
          {exportStatus.texte}
        </div>
      )}

      <LiveRegion message={announcement} />

      {furnitureOpen && (
        <PageFurnitureDialog
          valeur={furniture}
          titreDocument={title}
          pages={pageCount}
          bandeInitiale={furnitureBand}
          // En mode local il n'y a pas de serveur : le dépôt d'image est alors
          // annoncé indisponible plutôt que d'échouer sur une requête perdue.
          docId={request?.local === true ? null : (request?.docId ?? null)}
          token={request?.accessToken ?? devToken(userName, 'write')}
          onChange={appliquerFurniture}
          onClose={() => setFurnitureOpen(false)}
        />
      )}

      {mathDraft && (
        <MathDialog
          draft={mathDraft}
          onCancel={() => {
            setMathDraft(null);
            viewRef.current?.focus();
          }}
          onSubmit={submitMath}
          onDelete={mathDraft.pos !== undefined ? deleteMath : undefined}
        />
      )}

      <FootnoteDialog
        open={footnoteDialogOpen}
        onClose={() => setFootnoteDialogOpen(false)}
        onInsert={(text) => runInEditor(insertFootnote(text))}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={paletteCommands}
      />
    </div>
  );
}

function describeFailure(error: unknown): Phase {
  if (error instanceof ApiError) {
    if (error.kind === 'offline') {
      return {
        kind: 'error',
        title: 'Serveur injoignable',
        detail:
          'Le service de collaboration ne répond pas. Vérifiez que le serveur Rust est démarré (cargo run) puis réessayez.',
      };
    }
    if (error.status === 404) {
      return {
        kind: 'error',
        title: error.kind === 'session-not-found' ? 'Session introuvable' : 'Document introuvable',
        detail:
          error.kind === 'session-not-found'
            ? 'Aucune session ne porte cette signature. Vérifiez le token_session, ou créez la session d’abord.'
            : 'Aucun document ne correspond à cet identifiant, ou il ne vous est pas accessible.',
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        kind: 'error',
        title: 'Accès refusé',
        detail:
          'Cette adresse ne figure pas parmi les participants de la session, ou votre jeton ne permet pas d’ouvrir ce document.',
      };
    }
    return { kind: 'error', title: 'Erreur du serveur', detail: error.message };
  }
  return {
    kind: 'error',
    title: 'Erreur inattendue',
    detail: "L'application n'a pas pu ouvrir le document.",
  };
}

/**
 * Nom de fichier dérivé du titre : accents retirés, caractères de chemin exclus.
 * Un titre est du texte libre ; il ne doit jamais devenir un chemin.
 */
export function nomDeFichier(titre: string, extension: string): string {
  const base = titre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base || 'document'}.${extension}`;
}

function countWords(state: EditorState | null): number {
  if (!state) return 0;
  const text = state.doc.textBetween(0, state.doc.content.size, ' ', ' ');
  const words = text.trim().match(/[\p{L}\p{N}''-]+/gu);
  return words?.length ?? 0;
}
