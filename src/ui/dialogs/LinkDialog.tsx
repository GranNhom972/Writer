// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useRef, useState } from 'react';
import { Popover } from '../../design/components/Popover';

interface UrlDialogProps {
  label: string;
  title: string;
  /** Initial value (link already applied to the selection). */
  initialUrl?: string;
  /** "Alternative text" field, required for images (accessibility). */
  withAltText?: boolean;
  /** "Text to display" field, optional for links. */
  withDisplayText?: boolean;
  onSubmit: (url: string, alt: string) => boolean;
  onRemove?: () => void;
  disabled?: boolean;
  /** External ref: lets a keyboard shortcut open this dialog. */
  buttonRef?: React.MutableRefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}

/**
 * URL entry (link or image): a form, not a `window.prompt`: a native prompt cannot be styled, announced or tested.
 */
export function UrlDialog({
  label,
  title,
  initialUrl = '',
  withAltText = false,
  withDisplayText = false,
  onSubmit,
  onRemove,
  disabled = false,
  buttonRef,
  children,
}: UrlDialogProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(initialUrl);
  const [alt, setAlt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const localRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = buttonRef ?? localRef;

  const close = (): void => {
    setOpen(false);
    setError(null);
    triggerRef.current?.focus();
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (withAltText && alt.trim().length === 0) {
      setError('Le texte alternatif est obligatoire : il décrit l’image aux personnes qui ne la voient pas.');
      return;
    }
    if (!onSubmit(url, alt)) {
      setError('Adresse invalide. Seuls http, https et mailto sont acceptés.');
      return;
    }
    setUrl('');
    setAlt('');
    close();
  };

  return (
    <div className="picker">
      <button
        type="button"
        ref={(element) => {
          triggerRef.current = element;
        }}
        className="btn btn--icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => {
          setUrl(initialUrl);
          setOpen((previous) => !previous);
        }}
      >
        {children}
      </button>

      {open && (
        <Popover label={label} onClose={close} triggerRef={triggerRef}>
          <form className="url-form" onSubmit={submit}>
            <label className="field">
              <span className="field__label">Adresse</span>
              <input
                className="field__input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://exemple.org"
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            {withDisplayText && (
              <label className="field">
                <span className="field__label">Texte à afficher (facultatif)</span>
                <input
                  className="field__input"
                  value={alt}
                  onChange={(event) => setAlt(event.target.value)}
                  placeholder="Ordre du jour"
                  autoComplete="off"
                />
              </label>
            )}

            {withAltText && (
              <label className="field">
                <span className="field__label">Texte alternatif</span>
                <input
                  className="field__input"
                  value={alt}
                  onChange={(event) => setAlt(event.target.value)}
                  placeholder="Graphique des ventes du trimestre"
                  autoComplete="off"
                />
              </label>
            )}

            {error && (
              <p className="url-form__error" role="alert">
                {error}
              </p>
            )}

            <div className="url-form__actions">
              {onRemove && initialUrl && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onRemove();
                    close();
                  }}
                >
                  Supprimer
                </button>
              )}
              <button type="submit" className="btn btn--primary">
                Appliquer
              </button>
            </div>
          </form>
        </Popover>
      )}
    </div>
  );
}
