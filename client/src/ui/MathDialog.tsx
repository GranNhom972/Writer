/**
 * Éditeur de formules mathématiques.
 *
 * Parti pris d'ergonomie : **une seule source de vérité, la saisie LaTeX**, et
 * tout le reste sert à ne pas avoir à la connaître —
 *  - aperçu rendu en direct sous le champ (on voit ce qu'on écrit) ;
 *  - palette de modèles qui insèrent le code au curseur, avec le point d'insertion
 *    placé là où l'usager va taper ;
 *  - exemples complets à recopier ;
 *  - erreurs traduites en français, jamais le message brut de l'analyseur.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../design/components/Modal';
import { EMPTY_MATH_MESSAGE, renderMath } from '../document/math/render';
import { MATH_EXAMPLES, MATH_SNIPPETS } from '../document/math/snippets';

export interface MathDraft {
  latex: string;
  display: boolean;
  /** Position du nœud en cours de modification ; absent pour une insertion. */
  pos?: number;
}

interface MathDialogProps {
  draft: MathDraft;
  onCancel: () => void;
  onSubmit: (latex: string, display: boolean) => void;
  onDelete?: (() => void) | undefined;
}

export function MathDialog({ draft, onCancel, onSubmit, onDelete }: MathDialogProps) {
  const [latex, setLatex] = useState(draft.latex);
  const [display, setDisplay] = useState(draft.display);
  const [preview, setPreview] = useState<{ html: string } | { error: string }>({
    error: EMPTY_MATH_MESSAGE,
  });
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  // Aperçu différé : rendre à chaque frappe ferait clignoter la formule et
  // gaspillerait du temps de calcul sur des états intermédiaires invalides.
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

  /** Insère un modèle à la position du curseur, pas à la fin du champ. */
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
  const isEdit = draft.pos !== undefined;

  return (
    <Modal title={isEdit ? 'Modifier la formule' : 'Insérer une formule'} onClose={onCancel} width={680}>
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
          />
        </label>

        <div className="math-dialog__preview" aria-live="polite" aria-atomic="true">
          {'html' in preview ? (
            <div
              className="math-dialog__render"
              // Contenu produit par KaTeX à partir de la saisie, avec `trust: false` :
              // ni lien, ni ressource externe, ni HTML de l'usager (cf. render.ts).
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

        <fieldset className="math-dialog__mode">
          <legend className="field__label">Disposition</legend>
          <label className="math-dialog__radio">
            <input
              type="radio"
              name="math-display"
              checked={!display}
              onChange={() => setDisplay(false)}
            />
            Dans le texte
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

        <footer className="math-dialog__actions">
          {onDelete && (
            <button type="button" className="btn" onClick={onDelete}>
              Supprimer la formule
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
