/**
 * Application de traitement de texte natif OpenOffice Writer (StarWriter / sw).
 *
 * Moteur 100 % pur en TypeScript et React 18 sans aucune bibliothèque de rich-text externe.
 */

import { useCallback, useRef, useState, type JSX } from 'react';
import {
  createEmptyDocument,
  createParagraph,
  createTable,
} from './domain/document/document';
import { makeRun } from './domain/document/runs';
import type { WriterDocumentState } from './domain/document/types';
import { exportOdt, openOdt } from './domain/odf/package';
import { downloadPdf } from './domain/pdf';
import { paginateDocument } from './domain/engine/paginate';
import { createMeasurer } from './domain/engine/measure';
import { WriterEditor } from './ui/editor/WriterEditor';

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

export function App(): JSX.Element {
  const [doc, setDoc] = useState<WriterDocumentState>(demoDocument);
  const [generation, setGeneration] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onOpen = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await openOdt(bytes, { title: file.name.replace(/\.odt$/i, '') });
      setDoc(result.document);
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
    const docToSave = currentDoc ?? doc;
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
  }, [doc]);

  const onExportPdf = useCallback(() => {
    try {
      const measurer = createMeasurer();
      const layout = paginateDocument(doc, { measurer });
      downloadPdf(doc, layout);
      setMessage('Document exporté au format PDF (.pdf).');
    } catch (error) {
      setMessage(`Échec de l'export PDF : ${(error as Error).message}`);
    }
  }, [doc]);

  const onPrint = useCallback(() => {
    window.print();
  }, []);

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
          role="status"
          style={{
            flex: 'none',
            padding: '6px 16px',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-secondary)',
            background: 'var(--bg-sunken)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{message}</span>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: '2px 8px', fontSize: '11px' }}
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
        onTitleChange={handleTitleCommit}
        onOpen={() => fileRef.current?.click()}
        onSave={onSave}
        onPrint={onPrint}
        onExportPdf={onExportPdf}
      />

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
