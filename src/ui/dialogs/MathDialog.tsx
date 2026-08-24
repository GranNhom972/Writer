/**
 * Éditeur ergonomique de formules mathématiques.
 *
 * Saisie LaTeX avec :
 *  - aperçu rendu en direct (KaTeX avec fallback textuel élégant) ;
 *  - palette de modèles par catégories (Structures, Opérateurs, Relations, Lettres grecques, Ensembles) ;
 *  - exemples complets prêts à l'emploi à insérer au clic ;
 *  - positionnement automatique du curseur dans le modèle ;
 *  - messages d'erreurs traduits en français clair.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Modal } from '../../design/components/Modal';
import { EMPTY_MATH_MESSAGE, renderMath } from '../../domain/math/render';
import { MATH_EXAMPLES, MATH_SNIPPETS } from '../../domain/math/snippets';

export interface MathDraft {
  latex: string;
  display: boolean;
  blockId?: string;
}

interface MathDialogProps {
  draft: MathDraft;
  onCancel: () => void;
  onSubmit: (latex: string, display: boolean) => void;
  onDelete?: (() => void) | undefined;
}

export function MathDialog({ draft, onCancel, onSubmit, onDelete }: MathDialogProps): JSX.Element {
  const [latex, setLatex] = useState(draft.latex);
  const [display, setDisplay] = useState(draft.display);
  const [preview, setPreview] = useState<{ html: string } | { error: string }>({
    error: EMPTY_MATH_MESSAGE,
  });
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  // Aperçu différé pour éviter les clignotements pendant la saisie
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void renderMath(latex, display).then((result) => {
        if (cancelled) return;
        setPreview(result.ok ? { html: result.html } : { error: result.message });
      });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [latex, display]);

  /** Insère un modèle à la position actuelle du curseur */
  const insert = (snippet: string, caret = 0): void => {
    const field = fieldRef.current;
    const start = field?.selectionStart ?? latex.length;
    const end = field?.selectionEnd ?? latex.length;
    const next = latex.slice(0, start) + snippet + latex.slice(end);
    setLatex(next);

    const position = start + snippet.length + caret;
    window.requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(position, position);
    });
  };

  const valid = useMemo(() => 'html' in preview, [preview]);
  const isEdit = draft.blockId !== undefined || draft.latex.length > 0;

  return (
    <Modal title={isEdit ? 'Modifier la formule' : 'Insérer une formule mathématique'} onClose={onCancel} width={680}>
      <div className="math-dialog">
        <label className="math-dialog__field">
          <span className="field__label">
            Formule (langage LaTeX) — <kbd>Ctrl</kbd>+<kbd>Entrée</kbd> pour valider
          </span>
          <textarea
            ref={fieldRef}
            className="math-dialog__input"
            value={latex}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="math-preview-status"
            onChange={(event) => setLatex(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && valid) {
                event.preventDefault();
                onSubmit(latex, display);
              }
            }}
            placeholder="Ex : \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"
          />
        </label>

        {/* Prévisualisation en direct */}
        <div className="math-dialog__preview" aria-live="polite" aria-atomic="true">
          {'html' in preview ? (
            <div
              className="math-dialog__render"
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          ) : (
            <p
              id="math-preview-status"
              className={
                preview.error === EMPTY_MATH_MESSAGE
                  ? 'math-dialog__hint'
                  : 'math-dialog__error'
              }
              role={preview.error === EMPTY_MATH_MESSAGE ? undefined : 'alert'}
            >
              {preview.error}
            </p>
          )}
        </div>

        {/* Mode de disposition */}
        <fieldset className="math-dialog__mode">
          <legend className="field__label">Disposition</legend>
          <label className="math-dialog__radio">
            <input
              type="radio"
              name="math-display"
              checked={!display}
              onChange={() => setDisplay(false)}
            />
            Dans le texte (en ligne)
          </label>
          <label className="math-dialog__radio">
            <input
              type="radio"
              name="math-display"
              checked={display}
              onChange={() => setDisplay(true)}
            />
            Centrée sur sa propre ligne
          </label>
        </fieldset>

        {/* Palette de modèles rapides */}
        <div className="math-dialog__palette">
          {MATH_SNIPPETS.map((group) => (
            <section key={group.name} className="math-group">
              <h3 className="math-group__title">{group.name}</h3>
              <div className="math-group__items">
                {group.snippets.map((snippet) => (
                  <button
                    key={snippet.label}
                    type="button"
                    className="math-group__button"
                    aria-label={snippet.label}
                    title={`${snippet.label} — ${snippet.latex.trim()}`}
                    onClick={() => insert(snippet.latex, snippet.caret ?? 0)}
                  >
                    <span aria-hidden="true">{snippet.glyph}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Exemples prêts à l'emploi */}
        <section className="math-dialog__examples">
          <h3 className="math-group__title">Exemples</h3>
          <div className="math-dialog__example-row">
            {MATH_EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                className="btn"
                onClick={() => setLatex(example.latex)}
              >
                {example.label}
              </button>
            ))}
          </div>
        </section>

        {/* Actions du dialogue */}
        <footer className="math-dialog__actions">
          {onDelete && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={onDelete}
              title="Supprimer définitivement cette formule mathématique"
            >
              🗑 Supprimer la formule
            </button>
          )}
          <span className="titlebar__spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!valid}
            onClick={() => onSubmit(latex, display)}
          >
            {isEdit ? 'Appliquer' : 'Insérer'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
