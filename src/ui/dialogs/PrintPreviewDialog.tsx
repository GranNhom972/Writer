/**
 * Dialogue d'Aperçu avant impression (Page Preview / SwPagePreview).
 *
 * Affiche les pages physiques exactement telles qu'elles seront imprimées et
 * exportées en PDF (sans curseurs, marges d'édition ni éléments d'interface).
 *
 * Permet la navigation page par page, l'affichage livre (2 pages), le zoom,
 * ainsi que le déclenchement direct de l'impression et de l'exportation PDF.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { WriterDocumentState } from '../../domain/document/types';
import type { DocumentLayout } from '../../domain/engine/paginate';
import { DEFAULT_FURNITURE } from '../../domain/document/pageFurniture';
import { A4Page } from '../editor/A4Page';
import { Button } from '../../design/components/Button';
import { Icon } from '../../design/icons/Icon';

export interface PrintPreviewDialogProps {
  open: boolean;
  doc: WriterDocumentState;
  layout: DocumentLayout;
  onPrint: () => void;
  onExportPdf: () => void;
  onClose: () => void;
}

export function PrintPreviewDialog({
  open,
  doc,
  layout,
  onPrint,
  onExportPdf,
  onClose,
}: PrintPreviewDialogProps): JSX.Element | null {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'single' | 'dual' | 'all'>('single');
  const [zoom, setZoom] = useState(0.85);

  const totalPages = layout.pages.length;
  const geometry = layout.geometry;

  const goToPrev = useCallback(() => {
    setCurrentPageIndex((prev) => Math.max(0, prev - (viewMode === 'dual' ? 2 : 1)));
  }, [viewMode]);

  const goToNext = useCallback(() => {
    setCurrentPageIndex((prev) =>
      Math.min(totalPages - 1, prev + (viewMode === 'dual' ? 2 : 1)),
    );
  }, [totalPages, viewMode]);

  // Raccourcis clavier dans l'aperçu : Échap pour fermer, flèches pour naviguer, Ctrl+P pour imprimer
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goToNext();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        onPrint();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 10) / 10));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, goToPrev, goToNext, onPrint]);

  if (!open) return null;

  // Pages visibles selon le mode d'affichage
  const visiblePages = layout.pages.filter((page) => {
    if (viewMode === 'all') return true;
    if (viewMode === 'single') return page.index === currentPageIndex;
    if (viewMode === 'dual') {
      const startIdx = currentPageIndex % 2 === 0 ? currentPageIndex : currentPageIndex - 1;
      return page.index === startIdx || page.index === startIdx + 1;
    }
    return true;
  });

  return (
    <div
      className="print-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Aperçu avant impression"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#3c3f41',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Barre d'outils supérieure de l'aperçu */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: '8px 16px',
          background: '#2b2d30',
          color: '#ffffff',
          borderBottom: '1px solid #1e1f22',
          flex: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="ghost" onClick={onClose} aria-label="Fermer l'aperçu">
            <Icon name="close" size={16} />
            Fermer l’aperçu
          </Button>
          <span style={{ color: '#888', marginInline: '4px' }}>|</span>
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
            Aperçu avant impression — {doc.meta.title || 'Document'}
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Contrôles de navigation entre pages */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={goToPrev}
            disabled={currentPageIndex === 0}
            aria-label="Page précédente"
            style={{ color: '#fff', padding: '4px 8px' }}
          >
            ←
          </button>
          <span style={{ fontSize: 'var(--text-xs)', minWidth: '85px', textAlign: 'center' }}>
            Page {currentPageIndex + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={goToNext}
            disabled={currentPageIndex >= totalPages - 1}
            aria-label="Page suivante"
            style={{ color: '#fff', padding: '4px 8px' }}
          >
            →
          </button>
        </div>

        <span style={{ color: '#888', marginInline: '4px' }}>|</span>

        {/* Modes d'affichage */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            type="button"
            className={`btn ${viewMode === 'single' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ padding: '4px 8px', fontSize: '11px' }}
            onClick={() => setViewMode('single')}
          >
            1 page
          </button>
          <button
            type="button"
            className={`btn ${viewMode === 'dual' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ padding: '4px 8px', fontSize: '11px' }}
            onClick={() => setViewMode('dual')}
          >
            2 pages
          </button>
          <button
            type="button"
            className={`btn ${viewMode === 'all' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ padding: '4px 8px', fontSize: '11px' }}
            onClick={() => setViewMode('all')}
          >
            Toutes
          </button>
        </div>

        <span style={{ color: '#888', marginInline: '4px' }}>|</span>

        {/* Contrôles de Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ color: '#fff', padding: '2px 8px' }}
            onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 10) / 10))}
            aria-label="Zoom arrière"
          >
            −
          </button>
          <span style={{ fontSize: 'var(--text-xs)', minWidth: '45px', textAlign: 'center' }}>
            {Math.round(zoom * 100)} %
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ color: '#fff', padding: '2px 8px' }}
            onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.1) * 10) / 10))}
            aria-label="Zoom avant"
          >
            +
          </button>
        </div>

        <span style={{ color: '#888', marginInline: '4px' }}>|</span>

        {/* Actions d'impression et d'exportation */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant="ghost" onClick={onExportPdf}>
            <Icon name="export-pdf" size={16} />
            Exporter PDF
          </Button>
          <Button variant="primary" onClick={onPrint}>
            <Icon name="print" size={16} />
            Imprimer
          </Button>
        </div>
      </header>

      {/* Surface de rendu des pages d'aperçu */}
      <main
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '32px 16px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: viewMode === 'all' ? 'column' : 'row',
            flexWrap: viewMode === 'dual' ? 'nowrap' : 'wrap',
            justifyContent: 'center',
            gap: '24px',
            transform: `scale(${zoom})`,
            transformOrigin: 'top center',
            transition: 'transform 0.15s ease-out',
          }}
        >
          {visiblePages.map((page) => (
            <div
              key={page.index}
              style={{
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                borderRadius: '2px',
                background: '#ffffff',
                flex: 'none',
              }}
            >
              <A4Page
                page={page}
                totalPages={totalPages}
                documentTitle={doc.meta.title || 'Sans titre'}
                furniture={doc.furniture ?? DEFAULT_FURNITURE}
                geometry={geometry}
                paragraphLayouts={layout.paragraphLayouts}
                placements={layout.placements ? Array.from(layout.placements.entries()).flatMap(([blockId, list]) => list.filter(p => p.pageIndex === page.index).map(p => ({ blockId, placed: p.placed }))) : []}
                // L'aperçu montre la feuille telle qu'elle s'imprimera : ni
                // sélection, ni surlignage de recherche.
                selectionRects={[]}
                searchRects={[]}
                caret={null}
                caretIdle={true}
                showMargins={false}
                onToggleTask={() => {}}
                onPointerDown={() => {}}
                onPointerMove={() => {}}
                onPointerUp={() => {}}
              />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
