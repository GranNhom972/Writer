/**
 * Planche d'icônes — vitrine de contrôle (`/icons.html` en développement).
 *
 * Sert à juger le jeu d'icônes comme le ferait un designer : à la taille réelle
 * d'usage (16 et 20 px), en gros pour vérifier la géométrie (48 px), sur les deux
 * thèmes, et en situation dans un bouton.
 */

import { createRoot } from 'react-dom/client';
import { ICON_NAMES, Icon } from './design/icons/Icon';
import './design/tokens.css';
import './ui/app.css';

function Sheet() {
  return (
    <main style={{ padding: 'var(--space-6)', display: 'grid', gap: 'var(--space-7)' }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Planche d’icônes Write</h1>
        <p style={{ color: 'var(--fg-secondary)' }}>
          Grille 24 × 24, zone vive 20 × 20, contour 1,75 px, `currentColor`.
        </p>
      </header>

      {[48, 20, 16].map((size) => (
        <section key={size}>
          <h2 style={{ fontSize: 'var(--text-lg)' }}>{size} px</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${size + 96}px, 1fr))`,
              gap: 'var(--space-4)',
            }}
          >
            {ICON_NAMES.map((name) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-2)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <Icon name={name} size={size} />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-secondary)' }}>{name}</span>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section>
        <h2 style={{ fontSize: 'var(--text-lg)' }}>En situation (boutons de ruban)</h2>
        <div className="ribbon" style={{ border: '1px solid var(--border-subtle)' }}>
          {ICON_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className="btn btn--icon"
              aria-label={name}
              aria-pressed={name === 'bold' || name === 'align-left'}
            >
              <Icon name={name} />
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<Sheet />);
