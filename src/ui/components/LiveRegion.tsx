// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import { useEffect, useState } from 'react';

/**
 * Two live regions (UX directive §6.4): `polite` for the state, `assertive` for errors. The keystrokes of remote collaborators are NEVER announced:
 * that would be unbearable chatter for a screen reader.
 */
export function LiveRegion({ message, assertive = false }: { message: string; assertive?: boolean }) {
  const [announced, setAnnounced] = useState('');

  useEffect(() => {
    // Delayed re-emission: a screen reader ignores an identical consecutive text.
    const timer = window.setTimeout(() => setAnnounced(message), 100);
    return () => window.clearTimeout(timer);
  }, [message]);

  return (
    <div
      className="visually-hidden"
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      {announced}
    </div>
  );
}
