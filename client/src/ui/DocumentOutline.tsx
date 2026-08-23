import { useMemo } from 'react';
import { Selection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Button } from '../design/components/Button';
import { Icon } from '../design/icons/Icon';

interface DocumentOutlineProps {
  editorState: EditorState | null;
  editorView: EditorView | null;
  open: boolean;
  onClose: () => void;
}

interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

export function DocumentOutline({ editorState, editorView, open, onClose }: DocumentOutlineProps) {
  const headings = useMemo<HeadingItem[]>(() => {
    if (!editorState) return [];
    const items: HeadingItem[] = [];
    const schema = editorState.schema;

    editorState.doc.descendants((node, pos) => {
      if (node.type === schema.nodes['heading']) {
        const level = Number(node.attrs['level'] ?? 1);
        const text = node.textContent.trim() || 'Titre sans texte';
        items.push({
          id: `heading_${pos}`,
          level,
          text,
          pos,
        });
      }
    });

    return items;
  }, [editorState]);

  if (!open) return null;

  const handleScrollTo = (pos: number) => {
    if (!editorView) return;
    const resolved = editorView.state.doc.resolve(pos + 1);
    const tr = editorView.state.tr.setSelection(
      Selection.near(resolved)
    ).scrollIntoView();
    editorView.dispatch(tr);
    editorView.focus();
  };

  return (
    <aside
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
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>Plan du document</span>
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
            Les titres (H1 à H6) ajoutés au document apparaîtront ici.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {headings.map((h) => (
              <li key={h.id} style={{ margin: '2px 0' }}>
                <button
                  type="button"
                  onClick={() => handleScrollTo(h.pos)}
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
