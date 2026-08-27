import { useMemo, type JSX } from 'react';
import type { WriterDocumentState } from '../../domain/document/types';
import { isParagraph } from '../../domain/document/types';
import { Button } from '../../design/components/Button';
import { Icon } from '../../design/icons/Icon';
import { paragraphText } from '../../domain/document/document';

interface HeadingItem {
  id: string;
  blockId: string;
  level: number;
  text: string;
}

export interface DocumentOutlineProps {
  documentState: WriterDocumentState;
  open: boolean;
  onClose: () => void;
  onSelectHeading: (blockId: string) => void;
}

export function DocumentOutline({
  documentState,
  open,
  onClose,
  onSelectHeading,
}: DocumentOutlineProps): JSX.Element | null {
  const headings = useMemo<HeadingItem[]>(() => {
    const items: HeadingItem[] = [];

    for (const block of documentState.blocks) {
      if (isParagraph(block) && (block.type === 'heading' || (block.headingLevel && block.headingLevel > 0))) {
        const level = Number(block.headingLevel ?? 1);
        const text = paragraphText(block).trim() || 'Titre sans texte';
        items.push({
          id: `heading_${block.id}`,
          blockId: block.id,
          level,
          text,
        });
      }
    }

    return items;
  }, [documentState]);

  if (!open) return null;

  return (
    <aside
      // La classe n'est pas décorative : c'est par elle que la feuille
      // `@media print` masque le plan. Sans elle, le panneau s'imprimait et
      // décalait les pages A4 hors de la feuille.
      className="document-outline"
      aria-label="Plan du document"
      style={{
        width: 260,
        backgroundColor: 'var(--bg-app)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        zIndex: 10,
        boxShadow: 'var(--elevation-base)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--fg-primary)' }}>
          Plan du document
        </span>
        <Button variant="ghost" onClick={onClose} aria-label="Fermer le plan">
          <Icon name="close" size={16} />
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-2)' }}>
        {headings.length === 0 ? (
          <div
            style={{
              padding: 'var(--space-4)',
              color: 'var(--fg-secondary)',
              fontSize: 'var(--text-xs)',
              textAlign: 'center',
            }}
          >
            Les titres (Titre 1 à 6) ajoutés au document apparaîtront ici pour naviguer rapidement.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {headings.map((h) => (
              <li key={h.id} style={{ margin: '2px 0' }}>
                <button
                  type="button"
                  onClick={() => onSelectHeading(h.blockId)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 'var(--space-1) var(--space-2)',
                    paddingLeft: `calc(var(--space-2) + ${(h.level - 1) * 12}px)`,
                    border: 'none',
                    borderRadius: 'var(--radius-xs)',
                    backgroundColor: 'transparent',
                    color: 'var(--fg-primary)',
                    fontSize: h.level === 1 ? 'var(--text-sm)' : 'var(--text-xs)',
                    fontWeight: h.level === 1 ? 600 : 400,
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    transition: 'background-color var(--motion-fast)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--accent-subtle)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
