// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import type { JSX } from 'react';
import { Modal } from '../../design/components/Modal';
import { shortcutLabel } from '../shortcuts';

interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: HelpDialogProps): JSX.Element | null {
  if (!open) return null;

  return (
    <Modal title="Guide de Référence CloudAntille Writer" onClose={onClose} width={620}>
      <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '70vh', overflowY: 'auto' }}>
        <div>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', color: 'var(--fg-primary)' }}>
            À propos de CloudAntille Writer
          </h3>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--fg-secondary)' }}>
            Moteur de traitement de texte natif OpenOffice Writer (StarWriter / <code>sw</code>) écrit en TypeScript et React,
            sans aucune bibliothèque de rich-text externe. Prise en charge complète de la pagination physique A4,
            du format standard OpenDocument (.odt), des tableaux hiérarchiques et des formules mathématiques.
          </p>
        </div>

        <div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: 'var(--fg-primary)' }}>
            Raccourcis clavier principaux
          </h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px 16px',
              fontSize: '12px',
              background: 'var(--bg-sunken)',
              padding: '12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div><strong>{shortcutLabel('Mod-z')}</strong> : Annuler</div>
            <div><strong>{shortcutLabel('Mod-y')}</strong> : Rétablir</div>
            <div><strong>{shortcutLabel('Mod-b')}</strong> : Gras</div>
            <div><strong>{shortcutLabel('Mod-i')}</strong> : Italique</div>
            <div><strong>{shortcutLabel('Mod-u')}</strong> : Souligné</div>
            <div><strong>{shortcutLabel('Mod-Shift-x')}</strong> : Barré</div>
            <div><strong>{shortcutLabel('Mod-k')}</strong> : Palette / Lien</div>
            <div><strong>{shortcutLabel('Mod-f')}</strong> : Rechercher / Remplacer</div>
            <div><strong>{shortcutLabel('Mod-Shift-e')}</strong> : Formule mathématique</div>
            <div><strong>{shortcutLabel('Mod-Entrée')}</strong> : Saut de page</div>
            <div><strong>{shortcutLabel('Mod-p')}</strong> : Imprimer</div>
            <div><strong>{shortcutLabel('Mod-s')}</strong> : Enregistrer .odt</div>
          </div>
        </div>

        <div>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', color: 'var(--fg-primary)' }}>
            Fonctionnalités avancées
          </h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', lineHeight: 1.6, color: 'var(--fg-secondary)' }}>
            <li><strong>Pagination A4 temps réel</strong> avec règles de veuves et d'orphelines.</li>
            <li><strong>En-têtes et pieds de page</strong> physiques personnalisables avec numérotation automatique.</li>
            <li><strong>Règle graduée interactive</strong> pour ajuster visuellement les marges de page.</li>
            <li><strong>Formules mathématiques KaTeX</strong> intégrées ou en ligne.</li>
            <li><strong>Import / Export ODF natif</strong> fidèle aux spécifications OASIS OpenDocument v1.3.</li>
          </ul>
        </div>
      </div>

      <footer className="modal__footer" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Fermer
        </button>
      </footer>
    </Modal>
  );
}
