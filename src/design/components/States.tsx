import type { ReactNode } from 'react';

/** Squelette respectant la géométrie finale — pas de spinner centré (directive UX §4). */
export function DocumentSkeleton() {
  return (
    <div className="skeleton-page" aria-busy="true" aria-live="polite" aria-label="Chargement du document">
      <div className="skeleton-line skeleton-line--title" />
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="skeleton-line" style={{ width: `${92 - (index % 3) * 12}%` }} />
      ))}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

/** État vide : explication + une seule action primaire. Jamais une zone muette. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="state-panel">
      <h2 className="state-panel__title">{title}</h2>
      <p className="state-panel__text">{description}</p>
      {action}
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  detail: string;
  onRetry?: () => void;
}

/** État d'erreur : cause en langage clair + action de réparation. */
export function ErrorState({ title, detail, onRetry }: ErrorStateProps) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <h2 className="state-panel__title">{title}</h2>
      <p className="state-panel__text">{detail}</p>
      {onRetry && (
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}
