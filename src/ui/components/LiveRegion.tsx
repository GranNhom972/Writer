// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { useEffect, useState } from 'react';

/**
 * Deux régions live (directive UX §6.4) : `polite` pour l'état, `assertive` pour
 * les erreurs. Les frappes des collaborateurs distants ne sont JAMAIS annoncées —
 * ce serait un bavardage insupportable au lecteur d'écran.
 */
export function LiveRegion({ message, assertive = false }: { message: string; assertive?: boolean }) {
  const [announced, setAnnounced] = useState('');

  useEffect(() => {
    // Réémission différée : un lecteur d'écran ignore un texte identique consécutif.
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
