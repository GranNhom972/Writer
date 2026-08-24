/**
 * Barre d'outils.
 *
 * Les boutons ne portent aucun état propre : ils lisent le formatage actif que
 * le moteur a calculé et appellent des commandes. Un bouton est donc toujours
 * d'accord avec le document, y compris après une annulation — cas où un état
 * dupliqué dans le composant se serait désynchronisé.
 */

import type { JSX } from 'react';
import type { Alignment } from '../../domain/document/types';
import type { WriterController } from '../editor/useWriterInput';

const FONT_FAMILIES: readonly { label: string; value: string }[] = [
  { label: 'Serif (Liberation)', value: 'Liberation Serif, Georgia, Times New Roman, serif' },
  { label: 'Sans (Liberation)', value: 'Liberation Sans, Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: 'Times New Roman, Times, serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Courier', value: 'Courier New, Courier, monospace' },
];

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48] as const;

const ALIGNMENTS: readonly { value: Alignment; label: string; glyph: string }[] = [
  { value: 'left', label: 'Aligner à gauche', glyph: '⯇' },
  { value: 'center', label: 'Centrer', glyph: '≡' },
  { value: 'right', label: 'Aligner à droite', glyph: '⯈' },
  { value: 'justify', label: 'Justifier', glyph: '☰' },
];

const LINE_SPACINGS = [1, 1.15, 1.5, 2] as const;

const COLORS: readonly { label: string; value: string | null }[] = [
  { label: 'Automatique', value: null },
  { label: 'Noir', value: '#16191d' },
  { label: 'Rouge', value: '#b42318' },
  { label: 'Bleu', value: '#1a56db' },
  { label: 'Vert', value: '#08702f' },
  { label: 'Orange', value: '#b54708' },
];

export function Toolbar({ controller }: { controller: WriterController }): JSX.Element {
  const { commands, activeFormat, currentParagraph, canUndo, canRedo, zoom, setZoom } = controller;
  const defaults = controller.session.state.doc.defaults;

  const headingValue = currentParagraph?.type === 'heading'
    ? String(currentParagraph.headingLevel ?? 1)
    : '0';

  return (
    <div className="writer-toolbar" role="toolbar" aria-label="Mise en forme">
      <div className="writer-toolbar__group">
        <button
          type="button"
          className="writer-button"
          onClick={commands.undo}
          disabled={!canUndo}
          aria-label="Annuler (Ctrl+Z)"
          title="Annuler (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          type="button"
          className="writer-button"
          onClick={commands.redo}
          disabled={!canRedo}
          aria-label="Rétablir (Ctrl+Y)"
          title="Rétablir (Ctrl+Y)"
        >
          ↷
        </button>
      </div>

      <div className="writer-toolbar__group">
        <select
          className="writer-select"
          aria-label="Style de paragraphe"
          value={headingValue}
          onChange={(event) =>
            commands.setHeadingLevel(Number(event.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6)
          }
        >
          <option value="0">Texte courant</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option key={level} value={level}>{`Titre ${level}`}</option>
          ))}
        </select>
      </div>

      <div className="writer-toolbar__group">
        <select
          className="writer-select"
          aria-label="Police"
          value={activeFormat.fontFamily ?? defaults.fontFamily}
          onChange={(event) => commands.setFontFamily(event.target.value)}
        >
          {FONT_FAMILIES.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
        <select
          className="writer-select"
          aria-label="Taille de police"
          value={String(activeFormat.fontSizePt ?? defaults.fontSizePt)}
          onChange={(event) => commands.setFontSize(Number(event.target.value))}
        >
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="writer-toolbar__group">
        <button
          type="button"
          className="writer-button writer-button--bold"
          aria-pressed={activeFormat.bold === true}
          onClick={commands.toggleBold}
          aria-label="Gras (Ctrl+B)"
          title="Gras (Ctrl+B)"
        >
          G
        </button>
        <button
          type="button"
          className="writer-button writer-button--italic"
          aria-pressed={activeFormat.italic === true}
          onClick={commands.toggleItalic}
          aria-label="Italique (Ctrl+I)"
          title="Italique (Ctrl+I)"
        >
          I
        </button>
        <button
          type="button"
          className="writer-button writer-button--underline"
          aria-pressed={activeFormat.underline === true}
          onClick={commands.toggleUnderline}
          aria-label="Souligné (Ctrl+U)"
          title="Souligné (Ctrl+U)"
        >
          S
        </button>
        <button
          type="button"
          className="writer-button writer-button--strike"
          aria-pressed={activeFormat.strikeThrough === true}
          onClick={commands.toggleStrike}
          aria-label="Barré"
          title="Barré"
        >
          B
        </button>
        <select
          className="writer-select"
          aria-label="Couleur du texte"
          value={activeFormat.color ?? ''}
          onChange={(event) => commands.setColor(event.target.value || null)}
        >
          {COLORS.map((color) => (
            <option key={color.label} value={color.value ?? ''}>
              {color.label}
            </option>
          ))}
        </select>
      </div>

      <div className="writer-toolbar__group">
        {ALIGNMENTS.map((alignment) => (
          <button
            key={alignment.value}
            type="button"
            className="writer-button"
            aria-pressed={(currentParagraph?.alignment ?? 'left') === alignment.value}
            onClick={() => commands.setAlignment(alignment.value)}
            aria-label={alignment.label}
            title={alignment.label}
          >
            {alignment.glyph}
          </button>
        ))}
      </div>

      <div className="writer-toolbar__group">
        <select
          className="writer-select"
          aria-label="Interligne"
          value={String(currentParagraph?.lineSpacing ?? defaults.lineSpacing)}
          onChange={(event) => commands.setLineSpacing(Number(event.target.value))}
        >
          {LINE_SPACINGS.map((spacing) => (
            <option key={spacing} value={spacing}>
              {spacing.toFixed(2).replace('.', ',')}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="writer-button"
          onClick={() => commands.indent(-1)}
          aria-label="Diminuer le retrait"
          title="Diminuer le retrait (Maj+Tab)"
        >
          ⇤
        </button>
        <button
          type="button"
          className="writer-button"
          onClick={() => commands.indent(1)}
          aria-label="Augmenter le retrait"
          title="Augmenter le retrait"
        >
          ⇥
        </button>
      </div>

      <div className="writer-toolbar__group">
        <button
          type="button"
          className="writer-button"
          onClick={commands.insertPageBreak}
          aria-label="Insérer un saut de page (Ctrl+Entrée)"
          title="Saut de page (Ctrl+Entrée)"
        >
          ⤓
        </button>
        <button
          type="button"
          className="writer-button"
          onClick={commands.clearFormatting}
          aria-label="Effacer la mise en forme (Ctrl+M)"
          title="Effacer la mise en forme (Ctrl+M)"
        >
          ⌫ᴀ
        </button>
      </div>

      <div className="writer-toolbar__group">
        <button
          type="button"
          className="writer-button"
          onClick={() => setZoom(zoom - 0.1)}
          aria-label="Réduire le zoom"
          title="Réduire le zoom"
        >
          −
        </button>
        <span
          style={{ minWidth: 44, textAlign: 'center', fontSize: 'var(--text-md)' }}
          aria-live="polite"
        >
          {Math.round(zoom * 100)} %
        </span>
        <button
          type="button"
          className="writer-button"
          onClick={() => setZoom(zoom + 0.1)}
          aria-label="Augmenter le zoom"
          title="Augmenter le zoom"
        >
          +
        </button>
      </div>
    </div>
  );
}
