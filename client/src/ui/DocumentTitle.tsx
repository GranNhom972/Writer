import { useEffect, useRef, useState } from 'react';

interface DocumentTitleProps {
  title: string;
  disabled: boolean;
  onCommit: (title: string) => void;
}

/**
 * Titre du document, éditable en place.
 *
 * Le champ reste un `<input>` (pas un `contenteditable`) : il est annoncé comme
 * une zone de saisie nommée, `Échap` annule, `Entrée` valide, et le focus revient
 * naturellement au document.
 */
export function DocumentTitle({ title, disabled, onCommit }: DocumentTitleProps) {
  const [draft, setDraft] = useState(title);
  const committed = useRef(title);

  // Un renommage distant met à jour le champ, sauf pendant une saisie locale.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(title);
      committed.current = title;
    }
  }, [title]);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const commit = (): void => {
    const next = draft.trim();
    if (!next) {
      setDraft(committed.current);
      return;
    }
    if (next !== committed.current) {
      committed.current = next;
      onCommit(next);
    }
  };

  return (
    <h1 className="titlebar__heading">
      <input
        ref={inputRef}
        className="titlebar__input"
        value={draft}
        disabled={disabled}
        aria-label="Titre du document"
        onChange={(event) => setDraft(event.target.value.slice(0, 200))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            inputRef.current?.blur();
          }
          if (event.key === 'Escape') {
            setDraft(committed.current);
            inputRef.current?.blur();
          }
        }}
      />
    </h1>
  );
}
