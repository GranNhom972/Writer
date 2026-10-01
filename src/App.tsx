// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Application de traitement de texte natif OpenOffice Writer (StarWriter / sw).
 *
 * Moteur 100 % pur en TypeScript et React 18 sans aucune bibliothèque de rich-text externe.
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

/** Message lisible d'une erreur d'API : les 5xx ne disent jamais leur détail. */
function messageErreur(error: unknown): string {
  if (error instanceof ApiError) {
    return error.isOffline ? 'serveur injoignable' : error.message;
  }
  return (error as Error).message;
}

export function App(): JSX.Element {
  /**
   * L'adresse d'ouverture, lue **une seule fois** au premier rendu.
   *
   * L'effet d'ouverture CloudServ efface le fragment aussitôt qu'il l'a lu —
   * un billet n'a rien à faire dans la barre d'adresse ni dans l'historique.
   * Les effets suivants ne peuvent donc plus interroger `window.location` :
   * ils y trouveraient une adresse nue et concluraient à tort au mode
   * autonome, ce qui chargeait le document d'exemple **par-dessus** le
   * document CloudServ tout juste ouvert.
   *
   * Le calcul se fait pendant le rendu, avant tout effet, ce qui garantit de
   * voir l'adresse d'origine quel que soit l'ordre d'exécution.
   */
  const [lienInitial] = useState(() => ({
    cloudServ: readCloudServLink(window.location.hash, window.location.pathname, window.location.search),
    partage: readShareLink(window.location.search),
  }));

  /**
   * Document affiché. Le choix de l'état initial n'est pas cosmétique.
   *
   * Ouvert depuis CloudServ ou depuis un partage, l'éditeur part d'un document
   * **vide** : le contenu réel arrive par la synchronisation collaborative.
   * Y placer le document de démonstration le ferait apparaître le temps que la
   * synchronisation s'établisse — et, en écriture, ce contenu local pouvait
   * être fusionné dans le document partagé, écrasant celui de l'utilisateur.
   *
   * Le document de démonstration reste l'accueil du mode autonome, quand
   * l'éditeur est ouvert directement et n'a rien d'autre à montrer.
   */
  const [doc, setDoc] = useState<WriterDocumentState>(() =>
    lienInitial.cloudServ || lienInitial.partage
      ? createEmptyDocument('')
      : demoDocument(),
  );
  const [generation, setGeneration] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* ------------------------------------------------------------- partage */

  const [join, setJoin] = useState<SessionJoin | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  /** Adresse locale : celle du lien de partage, ou une valeur de travail. */
  const [ownerEmail, setOwnerEmail] = useState('moi@exemple.fr');


  // La commande d'application distante vient de l'éditeur, qui possède l'état.
  const applyRemoteRef = useRef<
    | ((
        transform: (doc: WriterDocumentState) => WriterDocumentState,
        remapSelection?: (selection: DocumentSelection) => DocumentSelection,
      ) => void)
    | null
  >(null);

  /**
   * Document **vivant**, tel que l'éditeur le tient à cet instant.
   *
   * `doc` n'est que l'état initial : l'éditeur en prend une copie au montage et
   * ne la relit plus. Partager, exporter ou imprimer en se fiant à `doc`
   * enverrait le document tel qu'il était à l'ouverture — sans une seule des
   * frappes qui ont suivi.
   */
  const liveDocRef = useRef<WriterDocumentState>(doc);

  const collabState = useCollab({
    join,
    onRemoteDocument: (apply, remapSelection) => applyRemoteRef.current?.(apply, remapSelection),
  });

  /** L'éditeur publie à chaque changement : on en profite pour tenir la réf. */
  const publish = useCallback(
    (current: WriterDocumentState) => {
      liveDocRef.current = current;
      collabState.publish(current);
    },
    [collabState],
  );

  /**
   * Ouverture par un lien de partage : `?session=…&email=…`.
   *
   * On rejoint **avant** d'afficher quoi que ce soit d'autre : le document du
   * partage remplace celui de démonstration, et le montrer d'abord ferait
   * clignoter un contenu qui n'est pas le bon.
   */
  /**
   * Ouverture depuis CloudServ : `/doc/<uuid>#token=<billet>` ou `#doc=<uuid>&token=<billet>`.
   *
   * Aucun appel réseau préalable — contrairement au partage géré par Writer, où
   * il faut d'abord rejoindre pour connaître sa permission. Ici c'est CloudServ
   * qui a tranché : le billet **est** la réponse, signé et lié à ce document.
   *
   * Le fragment / paramètre portant le jeton est effacé de la barre d'adresse
   * tout en conservant la route isolée `/doc/<docId>`.
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
   * Chargement par défaut du document d'exemple ODT (`doc_test.odt`).
   *
   * En mode autonome (sans fragment `#doc=` CloudServ ni paramètre `?session=`),
   * l'application charge le document d'exemple OpenOffice de 25 pages pour
   * offrir d'emblée un banc d'essai complet de tous les sous-systèmes.
   */
  useEffect(() => {
    // On interroge la capture, pas `window.location` : le fragment a déjà été
    // effacé par l'effet d'ouverture, et le relire ferait charger l'exemple
    // par-dessus le document de l'utilisateur.
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
   * Export PDF et impression empruntent le même chemin : la boîte du
   * navigateur. L'export choisit la destination « Enregistrer au format
   * PDF », l'impression une imprimante — le rendu, lui, est identique.
   *
   * Le titre vient du document vivant, pas de l'état initial : renommer le
   * document doit renommer le fichier proposé.
   */
  const onExportPdf = useCallback(() => {
    printDocument(liveDocRef.current.meta.title);
    setMessage('Dans la boîte d’impression, choisissez la destination « Enregistrer au format PDF ».');
  }, []);

  const onPrint = useCallback(() => {
    printDocument(liveDocRef.current.meta.title);
  }, []);

  /**
   * Dépose sur le serveur toutes les images encore en `data:`.
   *
   * Une image insérée hors ligne vit dans le document sous forme de `data:` —
   * plusieurs centaines de kilooctets dans le corps d'un paragraphe. La laisser
   * là la ferait repartir sur le réseau **à chaque frappe** dans ce paragraphe,
   * pour chaque participant. On la transfère donc une fois, et le run ne porte
   * plus qu'une adresse.
   *
   * Une image qui refuse de partir reste en `data:` : le partage fonctionne
   * quand même, il est seulement plus lourd. Refuser tout le partage pour une
   * image serait disproportionné.
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
          // Un sommaire ne porte pas d'image : ses lignes sont engendrées à la
          // pagination et n'existent pas dans l'AST téléversé.
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
            /* image conservée en data: — le partage reste possible */
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
      // Le partage porte le document **tel qu'il est à cet instant**, images
      // comprises : celui qui rejoint doit voir ce que l'on voit, pas un
      // document vide qu'il faudrait ensuite rattraper.
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

      // Les images partent **après** la création : elles ont besoin du `doc_id`,
      // que seul le partage vient de produire. La réécriture des adresses passe
      // par l'éditeur, seul détenteur du document vivant — `setDoc` ne ferait
      // rien, l'éditeur ne relisant pas son document initial.
      if (rejoint.access_token) {
        const allege = await televerserImages(courant, rejoint.access_token, rejoint.doc_id);
        if (allege !== courant) {
          applyRemoteRef.current?.(() => allege);
        }
      }

      // L'adresse porte désormais le partage : rafraîchir la page rouvre le
      // document partagé, et le lien est copiable depuis la barre du navigateur.
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
        // Le dépôt a échoué : l'image reste en `data:`. Elle s'affiche, elle
        // s'exporte, elle se partage — seulement plus lourdement.
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

      {/* Éditeur Writer complet avec Barre de titre intégrée (Titre + MenuBar) */}
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
