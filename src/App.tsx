// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * OpenOffice Writer native word processing application (StarWriter / sw).
 *
 * A 100 % pure engine in TypeScript and React 18, with no external rich-text library.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
} from './domain/document/document';
import { makeRun, runFormatting } from './domain/document/runs';
import type { WriterDocumentState } from './domain/document/types';
import { exportOdt, openOdt } from './domain/odf/package';
import { printDocument } from './domain/pdf';
import { WriterEditor, type CollabBinding } from './ui/editor/WriterEditor';
import { useCollab } from './ui/editor/useCollab';
import { ShareDialog, type Invitation } from './ui/dialogs/ShareDialog';
import {
  ApiError,
  dataUrlToBlob,
  getSession,
  inviteParticipant,
  joinSession,
  shareDocument,
  uploadAsset,
  type SessionJoin,
  type SessionSummary,
} from './domain/collab/api';
import { readCloudServLink, readShareLink, readTicketClaims } from './domain/collab/session';
import { collectImageRuns, isImageRun } from './domain/document/images';
import {
  isParagraph,
  isTable,
  type DocumentBlock,
  type DocumentSelection,
} from './domain/document/types';

const LOREM =
  'Le moteur de mise en page reprend la démarche de StarWriter : le texte ' +
  'coule dans un cadre, et ce qui ne tient plus est reporté sur la page ' +
  'suivante plutôt que rogné. La coupure ne tombe jamais au milieu d’une ' +
  'ligne, et les règles de veuves et d’orphelines empêchent qu’une ligne ' +
  'isolée se retrouve seule en haut ou en bas d’une feuille. ';

function demoDocument(): WriterDocumentState {
  const doc = createEmptyDocument('Guide de Référence CloudAntille Writer');
  const table = createTable(3, 3);
  table.rows[0]!.isHeader = true;
  table.rows[0]!.cells[0]!.blocks = [createParagraph('Couche')];
  table.rows[0]!.cells[1]!.blocks = [createParagraph('Origine C++')];
  table.rows[0]!.cells[2]!.blocks = [createParagraph('Rôle')];
  table.rows[1]!.cells[0]!.blocks = [createParagraph('Modèle')];
  table.rows[1]!.cells[1]!.blocks = [createParagraph('SwDoc, SwTxtNode')];
  table.rows[1]!.cells[2]!.blocks = [createParagraph('Nœuds et plages de formatage')];
  table.rows[2]!.cells[0]!.blocks = [createParagraph('Mise en page')];
  table.rows[2]!.cells[1]!.blocks = [createParagraph('SwTxtGuess, SwLayAction')];
  table.rows[2]!.cells[2]!.blocks = [createParagraph('Retour à la ligne, pagination')];

  doc.blocks = [
    createParagraph('Guide de Référence CloudAntille Writer', { headingLevel: 1 }),
    createParagraph('', {
      runs: [
        makeRun('Aucune bibliothèque de rich-text externe : le moteur est une '),
        makeRun('transposition directe', { bold: true }),
        makeRun(' des algorithmes d’Apache OpenOffice Writer ('),
        makeRun('sw', { italic: true, fontFamily: 'Courier New, monospace' }),
        makeRun('), écrite en TypeScript et React.'),
      ],
      alignment: 'justify',
    }),

    createParagraph('Retour à la ligne et pagination A4', { headingLevel: 2 }),
    createParagraph(LOREM.repeat(2), { alignment: 'justify' }),

    createParagraph('Tabulations et alignements', { headingLevel: 2 }),
    createParagraph('Gauche\tCentre\tDroite'),
    createParagraph('Ce paragraphe est centré.', { alignment: 'center' }),
    createParagraph('Celui-ci est aligné à droite.', { alignment: 'right' }),

    createParagraph('Formules mathématiques et équations', { headingLevel: 2 }),
    createParagraph('', {
      runs: [
        makeRun('Les formules s’intègrent en ligne, comme la relation '),
        makeRun('e^{i\\pi} + 1 = 0', { mathLatex: 'e^{i\\pi} + 1 = 0', mathDisplay: false }),
        makeRun(' d’Euler, ou centrées sur leur propre ligne :'),
      ],
    }),
    createParagraph('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', {
      alignment: 'center',
      runs: [
        makeRun('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', {
          mathLatex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
          mathDisplay: true,
        }),
      ],
    }),
    createParagraph('Cliquez sur une formule pour l’éditer dans l’atelier mathématique.'),

    createParagraph('Tableaux hiérarchiques', { headingLevel: 2 }),
    table,
    createParagraph('La ligne d’en-tête se répète en haut de chaque morceau lorsqu’un tableau est scindé.'),

    { ...createParagraph('Saut de page explicite', { headingLevel: 2 }), pageBreakBefore: true },
    createParagraph(LOREM.repeat(4), { alignment: 'justify' }),
  ];

  return doc;
}

/** Readable message for an API error: 5xx errors never give their detail. */
function messageErreur(error: unknown): string {
  if (error instanceof ApiError) {
    return error.isOffline ? 'serveur injoignable' : error.message;
  }
  return (error as Error).message;
}

export function App(): JSX.Element {
  /**
   * The opening address, read **only once** at the first render.
   *
   * The CloudServ opening effect clears the fragment as soon as it has read it: a ticket has no business in the address bar or in the
   * history. The following effects can therefore no longer query `window.location`: they would find a bare address and wrongly conclude
   * that we are in standalone mode, which loaded the sample document **on top of** the CloudServ document that had just been opened.
   *
   * The computation is done during render, before any effect, which guarantees seeing the original address whatever the order of execution.
   */
  const [lienInitial] = useState(() => ({
    cloudServ: readCloudServLink(window.location.hash, window.location.pathname, window.location.search),
    partage: readShareLink(window.location.search),
  }));

  /**
   * Displayed document. The choice of the initial state is not cosmetic.
   *
   * Opened from CloudServ or from a share, the editor starts from an **empty** document: the real content arrives through collaborative
   * synchronization. Putting the demo document there would make it appear while synchronization is being established and, in write mode,
   * that local content could be merged into the shared document, overwriting the user's.
   *
   * The demo document stays the welcome screen of standalone mode, when the editor is opened directly and has nothing else to show.
   */
  const [doc, setDoc] = useState<WriterDocumentState>(() =>
    lienInitial.cloudServ || lienInitial.partage
      ? createEmptyDocument('')
      : demoDocument(),
  );
  const [generation, setGeneration] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* ------------------------------------------------------------- sharing */

  const [join, setJoin] = useState<SessionJoin | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  /** Local address: that of the sharing link, or a working value. */
  const [ownerEmail, setOwnerEmail] = useState('moi@exemple.fr');


  // The remote-apply command comes from the editor, which owns the state.
  const applyRemoteRef = useRef<
    | ((
        transform: (doc: WriterDocumentState) => WriterDocumentState,
        remapSelection?: (selection: DocumentSelection) => DocumentSelection,
      ) => void)
    | null
  >(null);

  /**
   * The **live** document, as the editor holds it at this moment.
   *
   * `doc` is only the initial state: the editor takes a copy at mount time and does not read it again. Sharing, exporting or printing by
   * relying on `doc` would send the document as it was when it was opened, without a single one of the keystrokes that followed.
   */
  const liveDocRef = useRef<WriterDocumentState>(doc);

  const collabState = useCollab({
    join,
    onRemoteDocument: (apply, remapSelection) => applyRemoteRef.current?.(apply, remapSelection),
  });

  /** The editor publishes on every change: we take the opportunity to keep the ref. */
  const publish = useCallback(
    (current: WriterDocumentState) => {
      liveDocRef.current = current;
      collabState.publish(current);
    },
    [collabState],
  );

  /**
   * Opening through a sharing link: `?session=…&email=…`.
   *
   * We join **before** displaying anything else: the share's document replaces the demo one, and showing it first would flash content that
   * is not the right one.
   */
  /**
   * Opening from CloudServ: `/doc/<uuid>#token=<ticket>` or `#doc=<uuid>&token=<ticket>`.
   *
   * No prior network call, unlike a share managed by Writer, where you must first join to learn your permission. Here CloudServ has already
   * decided: the ticket **is** the answer, signed and tied to this document.
   *
   * The fragment / parameter carrying the token is cleared from the address bar while keeping the isolated `/doc/<docId>` route.
   */
  useEffect(() => {
    const lien = lienInitial.cloudServ;
    if (!lien) return;

    const targetUrl = `/doc/${lien.docId}`;
    if (window.location.pathname !== targetUrl || window.location.hash || window.location.search) {
      window.history.replaceState(null, '', targetUrl);
    }

    const claims = readTicketClaims(lien.token);
    if (!claims) {
      setMessage('Billet d’accès illisible : rouvrez le document depuis CloudServ.');
      return;
    }

    setJoin({
      token_session: '',
      doc_id: lien.docId,
      title: '',
      user_id: claims.userId,
      email: claims.displayName,
      permission: claims.permission,
      access_token: lien.token,
      auth_mode: 'jwt',
      sync_path: `/api/v1/sync/${lien.docId}`,
      events_path: '',
      editor_path: '',
    });
    setMessage(
      claims.permission === 'write'
        ? 'Document CloudServ ouvert. Vos modifications sont enregistrées régulièrement dans votre Drive.'
        : 'Document CloudServ ouvert en lecture seule.',
    );
  }, [lienInitial]);

  useEffect(() => {
    const lien = lienInitial.partage;
    if (!lien) return;

    let annule = false;
    void (async () => {
      try {
        const resultat = await joinSession(lien.tokenSession, lien.email);
        if (annule) return;
        setJoin(resultat);
        setOwnerEmail(resultat.email);
        setSession(await getSession(lien.tokenSession).catch(() => null));
        setMessage(
          resultat.permission === 'write'
            ? `Document partagé « ${resultat.title} » ouvert.`
            : `Document partagé « ${resultat.title} » ouvert en lecture seule.`,
        );
      } catch (error) {
        if (annule) return;
        const detail =
          error instanceof ApiError && error.status === 403
            ? "Vous n'êtes pas sur la liste des participants de ce partage."
            : (error as Error).message;
        setMessage(`Ouverture du partage impossible : ${detail}`);
      }
    })();

    return () => {
      annule = true;
    };
  }, [lienInitial]);

  /**
   * Default loading of the sample ODT document (`doc_test.odt`).
   *
   * In standalone mode (without a CloudServ `#doc=` fragment or a `?session=` parameter), the application loads the 25-page OpenOffice
   * sample document to offer, right away, a complete test bench for all the subsystems.
   */
  useEffect(() => {
    // We query the captured value, not `window.location`: the fragment was already cleared by the opening effect, and reading it again would
    // load the sample on top of the user's document.
    if (lienInitial.cloudServ || lienInitial.partage) return;

    let annule = false;
    void (async () => {
      try {
        const response = await fetch('/doc_test.odt');
        if (!response.ok || annule) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const result = await openOdt(bytes, { title: "Banc d'essai OpenOffice Writer" });
        if (annule) return;
        setDoc(result.document);
        liveDocRef.current = result.document;
        setGeneration((v) => v + 1);
        setMessage("Document d'exemple OpenOffice « doc_test.odt » chargé.");
      } catch (e) {
        console.warn("Impossible de charger doc_test.odt, conservation de l'exemple de repli :", e);
      }
    })();

    return () => {
      annule = true;
    };
  }, [lienInitial]);

  const onLoadSample = useCallback(async () => {
    try {
      const response = await fetch('/doc_test.odt');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const result = await openOdt(bytes, { title: "Banc d'essai OpenOffice Writer" });
      setDoc(result.document);
      liveDocRef.current = result.document;
      setGeneration((v) => v + 1);
      setMessage("Document d'exemple OpenOffice « doc_test.odt » chargé.");
    } catch (error) {
      setMessage(`Impossible de charger le document d’exemple : ${(error as Error).message}`);
    }
  }, []);

  const onOpen = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await openOdt(bytes, { title: file.name.replace(/\.odt$/i, '') });
      setDoc(result.document);
      liveDocRef.current = result.document;
      setGeneration((value) => value + 1);
      setMessage(
        result.warnings.length > 0
          ? `Document ouvert avec avertissements : ${result.warnings.join(' ')}`
          : `« ${result.document.meta.title} » ouvert.`,
      );
    } catch (error) {
      setMessage(`Ouverture impossible : ${(error as Error).message}`);
    }
  }, []);

  const onSave = useCallback(async (currentDoc?: WriterDocumentState) => {
    const docToSave = currentDoc ?? liveDocRef.current;
    const bytes = await exportOdt(docToSave);
    const blob = new Blob([bytes as BlobPart], {
      type: 'application/vnd.oasis.opendocument.text',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${docToSave.meta.title || 'document'}.odt`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage('Document enregistré au format OpenDocument (.odt).');
  }, []);

  /**
   * PDF export and printing take the same path: the browser's dialog. The export chooses the "Save as PDF" destination, printing a printer;
   * the rendering is identical.
   *
   * The title comes from the live document, not from the initial state: renaming the document must rename the suggested file.
   */
  const onExportPdf = useCallback(() => {
    printDocument(liveDocRef.current.meta.title);
    setMessage('Dans la boîte d’impression, choisissez la destination « Enregistrer au format PDF ».');
  }, []);

  const onPrint = useCallback(() => {
    printDocument(liveDocRef.current.meta.title);
  }, []);

  /**
   * Uploads to the server all the images that are still `data:` URLs.
   *
   * An image inserted offline lives in the document as a `data:` URL, several hundred kilobytes in the body of a paragraph. Leaving it there
   * would send it over the network again **on every keystroke** in that paragraph, for every participant. So we transfer it once, and the run
   * only carries an address.
   *
   * An image that refuses to go stays as a `data:` URL: sharing still works, it is just heavier. Refusing the whole share because of one image
   * would be out of proportion.
   */
  const televerserImages = useCallback(
    async (source: WriterDocumentState, token: string, docId: string): Promise<WriterDocumentState> => {
      const adresses = new Set<string>();
      const parcourir = (blocks: readonly DocumentBlock[]): void => {
        for (const block of blocks) {
          if (isTable(block)) {
            for (const row of block.rows) {
              for (const cell of row.cells) parcourir(cell.blocks);
            }
            continue;
          }
          // A table of contents carries no image: its lines are generated at pagination time and do not exist in the uploaded AST.
          if (!isParagraph(block)) continue;
          for (const { run } of collectImageRuns(block.runs)) {
            if (run.imageSrc?.startsWith('data:')) adresses.add(run.imageSrc);
          }
        }
      };
      parcourir(source.blocks);
      if (adresses.size === 0) return source;

      const remplacement = new Map<string, string>();
      await Promise.all(
        [...adresses].map(async (dataUrl) => {
          const blob = dataUrlToBlob(dataUrl);
          if (!blob) return;
          try {
            const depose = await uploadAsset(token, docId, blob);
            remplacement.set(dataUrl, depose.url);
          } catch {
            /* image kept as data: the share remains possible */
          }
        }),
      );
      if (remplacement.size === 0) return source;

      const reecrire = (blocks: readonly DocumentBlock[]): DocumentBlock[] =>
        blocks.map((block) => {
          if (isTable(block)) {
            return {
              ...block,
              rows: block.rows.map((row) => ({
                ...row,
                cells: row.cells.map((cell) => ({
                  ...cell,
                  blocks: reecrire(cell.blocks) as typeof cell.blocks,
                })),
              })),
            };
          }
          if (!isParagraph(block)) return block;
          if (!block.runs.some(isImageRun)) return block;
          return {
            ...block,
            runs: block.runs.map((run) => {
              const cible = run.imageSrc ? remplacement.get(run.imageSrc) : undefined;
              return cible ? makeRun(run.text, { ...runFormatting(run), imageSrc: cible }) : run;
            }),
          };
        });

      return { ...source, blocks: reecrire(source.blocks) };
    },
    [],
  );

  const onShare = useCallback(
    async (tokenSession: string, invitations: Invitation[]) => {
      // The share carries the document **as it is at this moment**, images included: the person who joins must see what we see, not an empty
      // document that they would then have to catch up.
      const courant = liveDocRef.current;
      const cree = await shareDocument({
        tokenSession,
        title: courant.meta.title || 'Document sans titre',
        participants: invitations,
        document: courant,
      });

      const rejoint = await joinSession(tokenSession, ownerEmail);
      setJoin(rejoint);
      setSession(cree);
      setShareOpen(false);

      // The images go **after** the creation: they need the `doc_id`, which only the share has just produced. Rewriting the addresses goes through
      // the editor, the sole holder of the live document: `setDoc` would do nothing, since the editor does not re-read its initial document.
      if (rejoint.access_token) {
        const allege = await televerserImages(courant, rejoint.access_token, rejoint.doc_id);
        if (allege !== courant) {
          applyRemoteRef.current?.(() => allege);
        }
      }

      // The address now carries the share: refreshing the page reopens the shared document, and the link can be copied from the browser bar.
      window.history.replaceState(null, '', rejoint.editor_path);
      setMessage(`Document partagé avec ${invitations.length} personne(s).`);
    },
    [ownerEmail, televerserImages],
  );

  const onInvite = useCallback(
    async (invitation: Invitation) => {
      if (!join?.access_token) throw new Error('Document non partagé.');
      const { session: misAJour } = await inviteParticipant(
        join.access_token,
        join.token_session,
        invitation.email,
        invitation.permission,
      );
      setSession(misAJour);
      setMessage(`${invitation.email} a été ajouté au partage.`);
    },
    [join],
  );

  const uploadImage = useCallback(
    async (dataUrl: string): Promise<string | null> => {
      const token = collabState.token;
      const docId = collabState.docId;
      if (!token || !docId) return null;

      const blob = dataUrlToBlob(dataUrl);
      if (!blob) return null;
      try {
        return (await uploadAsset(token, docId, blob)).url;
      } catch (error) {
        // The upload failed: the image stays as a `data:` URL. It displays, it exports, it shares, only more heavily.
        setMessage(`Image conservée dans le document : ${messageErreur(error)}`);
        return null;
      }
    },
    [collabState.token, collabState.docId],
  );

  const collab = useMemo<CollabBinding>(
    () => ({
      status: collabState.status,
      peers: collabState.peers,
      self: collabState.self,
      pending: collabState.pending,
      rejection: collabState.rejection,
      canWrite: collabState.canWrite,
      shared: join !== null,
      publish,
      setCursor: collabState.setCursor,
      clearRejection: collabState.clearRejection,
      onOpenShare: () => setShareOpen(true),
      uploadImage,
      bindApplyRemote: (apply) => {
        applyRemoteRef.current = apply;
      },
    }),
    [collabState, join, publish, uploadImage],
  );

  const handleTitleCommit = useCallback((newTitle: string) => {
    setDoc((prev) => ({
      ...prev,
      meta: {
        ...prev.meta,
        title: newTitle,
        updatedAt: new Date().toISOString(),
      },
    }));
  }, []);

  return (
    <div className="shell">
      {message && (
        <div
          className="shell-banner"
          role="status"
          style={{
            flex: 'none',
            padding: '6px 16px',
            color: 'var(--fg-secondary)',
            background: 'var(--bg-sunken)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            gap: 'var(--space-3)',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{message}</span>
          <button
            type="button"
            className="btn btn--ghost shell-banner__close"
            onClick={() => setMessage(null)}
          >
            Fermer
          </button>
        </div>
      )}

      {/* Complete Writer editor with the integrated Title bar (Title + MenuBar) */}
      <WriterEditor
        key={generation}
        initialDocument={doc}
        collab={collab}
        onTitleChange={handleTitleCommit}
        onOpen={() => fileRef.current?.click()}
        onLoadSample={onLoadSample}
        onSave={onSave}
        onPrint={onPrint}
        onExportPdf={onExportPdf}
      />

      {shareOpen && (
        <ShareDialog
          documentTitle={liveDocRef.current.meta.title || 'Document sans titre'}
          session={session}
          ownerEmail={ownerEmail}
          canInvite={collabState.canWrite}
          onShare={onShare}
          onInvite={onInvite}
          onClose={() => setShareOpen(false)}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".odt,application/vnd.oasis.opendocument.text"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onOpen(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
