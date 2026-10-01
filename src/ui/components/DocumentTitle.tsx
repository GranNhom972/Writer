// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useEffect, useRef, useState } from 'react';

interface DocumentTitleProps {
  title: string;
  disabled: boolean;
  onCommit: (title: string) => void;
}

/**
 * Document title, editable in place.
 *
 * The field stays an `<input>` (not a `contenteditable`): it is announced as a named input area, `Escape` cancels, `Enter` confirms, and the
 * focus naturally returns to the document.
 */
export function DocumentTitle({ title, disabled, onCommit }: DocumentTitleProps) {
  const [draft, setDraft] = useState(title);
  const committed = useRef(title);

  // A remote rename updates the field, except during a local edit.
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
