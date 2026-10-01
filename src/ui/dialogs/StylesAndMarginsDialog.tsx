// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

import { useState, type JSX } from 'react';
import type { PageSetup, DocumentDefaults } from '../../domain/document/types';
import { Modal } from '../../design/components/Modal';
import { Button } from '../../design/components/Button';
import { FONT_SIZES } from '../components/Ribbon';
import { OPENOFFICE_FONTS, FONT_CATEGORIES } from '../../domain/document/fonts';

export const PAGE_MARGIN_PRESETS: readonly {
  id: string;
  label: string;
  description: string;
  topMm: number;
  bottomMm: number;
  leftMm: number;
  rightMm: number;
}[] = [
  {
    id: 'normal',
    label: 'Standard',
    description: 'Haut / Bas : 2,5 cm · Gauche / Droite : 2,5 cm',
    topMm: 25,
    bottomMm: 25,
    leftMm: 25,
    rightMm: 25,
  },
  {
    id: 'narrow',
    label: 'Étroites',
    description: 'Haut / Bas : 1,27 cm · Gauche / Droite : 1,27 cm',
    topMm: 12.7,
    bottomMm: 12.7,
    leftMm: 12.7,
    rightMm: 12.7,
  },
  {
    id: 'wide',
    label: 'Larges',
    description: 'Haut / Bas : 2,5 cm · Gauche / Droite : 5,0 cm',
    topMm: 25,
    bottomMm: 25,
    leftMm: 50,
    rightMm: 50,
  },
  {
    id: 'moderate',
    label: 'Modérées',
    description: 'Haut / Bas : 2,54 cm · Gauche / Droite : 1,9 cm',
    topMm: 25.4,
    bottomMm: 25.4,
    leftMm: 19,
    rightMm: 19,
  },
];

interface StylesAndMarginsDialogProps {
  open: boolean;
  pageSetup: PageSetup;
  defaults: DocumentDefaults;
  onSave: (pageSetup: PageSetup, defaults: DocumentDefaults) => void;
  onClose: () => void;
}

export function StylesAndMarginsDialog({
  open,
  pageSetup: initialPageSetup,
  defaults: initialDefaults,
  onSave,
  onClose,
}: StylesAndMarginsDialogProps): JSX.Element | null {
  const [tab, setTab] = useState<'margins' | 'styles'>('margins');
  const [pageSetupDraft, setPageSetupDraft] = useState<PageSetup>(initialPageSetup);
  const [defaultsDraft, setDefaultsDraft] = useState<DocumentDefaults>(initialDefaults);

  if (!open) return null;

  const updateMargins = (margins: Partial<Pick<PageSetup, 'marginTopMm' | 'marginBottomMm' | 'marginLeftMm' | 'marginRightMm'>>) => {
    setPageSetupDraft((prev) => ({ ...prev, ...margins }));
  };

  const cm = (mm: number): string => String(Math.round(mm * 10) / 100);
  const versMm = (valeur: string): number => Math.round(Number(valeur) * 100) / 10;

  const topCm = cm(pageSetupDraft.marginTopMm);
  const bottomCm = cm(pageSetupDraft.marginBottomMm);
  const leftCm = cm(pageSetupDraft.marginLeftMm);
  const rightCm = cm(pageSetupDraft.marginRightMm);

  const handleSave = () => {
    onSave(pageSetupDraft, defaultsDraft);
    onClose();
  };

  const handleReset = () => {
    setPageSetupDraft({
      ...initialPageSetup,
      marginTopMm: 25,
      marginBottomMm: 25,
      marginLeftMm: 25,
      marginRightMm: 25,
      orientation: 'portrait',
    });
    setDefaultsDraft({
      fontFamily: 'Liberation Serif, Georgia, Times New Roman, serif',
      fontSizePt: 12,
      lineSpacing: 1.15,
      color: '#16191d',
    });
  };

  return (
    <Modal title="Paramètres du document (Mise en page et Styles)" onClose={onClose} width={740}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {/* Onglets */}
        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '4px' }}>
          <button
            type="button"
            className={`btn ${tab === 'margins' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setTab('margins')}
          >
            Marges et format de page
          </button>
          <button
            type="button"
            className={`btn ${tab === 'styles' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setTab('styles')}
          >
            Typographie par défaut
          </button>
        </div>

        {tab === 'margins' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 'var(--space-6)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <div>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--fg-secondary)', display: 'block', marginBottom: '8px' }}>
                  Préréglages de marges
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  {PAGE_MARGIN_PRESETS.map((preset) => {
                    const isActive =
                      Math.abs(pageSetupDraft.marginTopMm - preset.topMm) < 0.5 &&
                      Math.abs(pageSetupDraft.marginBottomMm - preset.bottomMm) < 0.5 &&
                      Math.abs(pageSetupDraft.marginLeftMm - preset.leftMm) < 0.5 &&
                      Math.abs(pageSetupDraft.marginRightMm - preset.rightMm) < 0.5;

                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() =>
                          updateMargins({
                            marginTopMm: preset.topMm,
                            marginBottomMm: preset.bottomMm,
                            marginLeftMm: preset.leftMm,
                            marginRightMm: preset.rightMm,
                          })
                        }
                        style={{
                          padding: '8px 12px',
                          borderRadius: 'var(--radius-sm)',
                          border: isActive ? '1.5px solid var(--accent)' : '1px solid var(--border-subtle)',
                          backgroundColor: isActive ? 'var(--accent-subtle)' : 'var(--bg-sunken)',
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ fontWeight: 600, color: isActive ? 'var(--accent)' : 'var(--fg-primary)', fontSize: 'var(--text-sm)' }}>
                          {preset.label}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--fg-secondary)', marginTop: '2px' }}>
                          {preset.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Marges personnalisées */}
              <div
                style={{
                  padding: 'var(--space-4)',
                  backgroundColor: 'var(--bg-sunken)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--fg-secondary)', display: 'block', marginBottom: '12px' }}>
                  Marges personnalisées (en centimètres)
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 500, marginBottom: '4px' }}>
                      Haut (cm)
                    </label>
                    <input
                      type="number"
                      min={0.5}
                      max={6}
                      step={0.1}
                      value={topCm}
                      onChange={(e) => updateMargins({ marginTopMm: versMm(e.target.value) })}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        borderRadius: 'var(--radius-xs)',
                        border: '1px solid var(--border-strong)',
                        backgroundColor: 'var(--bg-app)',
                        color: 'var(--fg-primary)',
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 500, marginBottom: '4px' }}>
                      Bas (cm)
                    </label>
                    <input
                      type="number"
                      min={0.5}
                      max={6}
                      step={0.1}
                      value={bottomCm}
                      onChange={(e) => updateMargins({ marginBottomMm: versMm(e.target.value) })}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        borderRadius: 'var(--radius-xs)',
                        border: '1px solid var(--border-strong)',
                        backgroundColor: 'var(--bg-app)',
                        color: 'var(--fg-primary)',
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 500, marginBottom: '4px' }}>
                      Gauche (cm)
                    </label>
                    <input
                      type="number"
                      min={0.5}
                      max={6}
                      step={0.1}
                      value={leftCm}
                      onChange={(e) => updateMargins({ marginLeftMm: versMm(e.target.value) })}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        borderRadius: 'var(--radius-xs)',
                        border: '1px solid var(--border-strong)',
                        backgroundColor: 'var(--bg-app)',
                        color: 'var(--fg-primary)',
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 500, marginBottom: '4px' }}>
                      Droite (cm)
                    </label>
                    <input
                      type="number"
                      min={0.5}
                      max={6}
                      step={0.1}
                      value={rightCm}
                      onChange={(e) => updateMargins({ marginRightMm: versMm(e.target.value) })}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        borderRadius: 'var(--radius-xs)',
                        border: '1px solid var(--border-strong)',
                        backgroundColor: 'var(--bg-app)',
                        color: 'var(--fg-primary)',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Orientation */}
              <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--fg-secondary)' }}>
                  Orientation :
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="orientation"
                    checked={pageSetupDraft.orientation === 'portrait'}
                    onChange={() => setPageSetupDraft((p) => ({ ...p, orientation: 'portrait' }))}
                  />
                  Portrait (21 × 29,7 cm)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="orientation"
                    checked={pageSetupDraft.orientation === 'landscape'}
                    onChange={() => setPageSetupDraft((p) => ({ ...p, orientation: 'landscape' }))}
                  />
                  Paysage (29,7 × 21 cm)
                </label>
              </div>
            </div>

            {/* Représentation visuelle de la page */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div
                style={{
                  width: pageSetupDraft.orientation === 'portrait' ? '150px' : '200px',
                  height: pageSetupDraft.orientation === 'portrait' ? '212px' : '140px',
                  backgroundColor: '#ffffff',
                  border: '1px solid var(--border-strong)',
                  boxShadow: 'var(--elevation-popover)',
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: `${(pageSetupDraft.marginTopMm / (pageSetupDraft.orientation === 'portrait' ? 297 : 210)) * 100}%`,
                    bottom: `${(pageSetupDraft.marginBottomMm / (pageSetupDraft.orientation === 'portrait' ? 297 : 210)) * 100}%`,
                    left: `${(pageSetupDraft.marginLeftMm / (pageSetupDraft.orientation === 'portrait' ? 210 : 297)) * 100}%`,
                    right: `${(pageSetupDraft.marginRightMm / (pageSetupDraft.orientation === 'portrait' ? 210 : 297)) * 100}%`,
                    border: '1px dashed var(--accent)',
                    backgroundColor: 'rgba(26, 86, 219, 0.05)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    padding: '4px',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ width: '80%', height: '2px', backgroundColor: 'var(--border-strong)', margin: '2px 0' }} />
                  <div style={{ width: '100%', height: '2px', backgroundColor: 'var(--border-subtle)', margin: '2px 0' }} />
                  <div style={{ width: '90%', height: '2px', backgroundColor: 'var(--border-subtle)', margin: '2px 0' }} />
                </div>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--fg-secondary)', marginTop: '8px' }}>
                Aperçu {pageSetupDraft.orientation === 'portrait' ? 'Portrait' : 'Paysage'}
              </span>
            </div>
          </div>
        )}

        {tab === 'styles' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: '4px' }}>
                  Police par défaut
                </label>
                <select
                  value={defaultsDraft.fontFamily}
                  onChange={(e) => setDefaultsDraft((d) => ({ ...d, fontFamily: e.target.value }))}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-xs)',
                    border: '1px solid var(--border-strong)',
                    backgroundColor: 'var(--bg-app)',
                    color: 'var(--fg-primary)',
                  }}
                >
                  {FONT_CATEGORIES.map((category) => {
                    const fontsInCat = OPENOFFICE_FONTS.filter((f) => f.category === category.id);
                    if (fontsInCat.length === 0) return null;
                    return (
                      <optgroup key={category.id} label={category.label}>
                        {fontsInCat.map((font) => (
                          <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>
                            {font.label}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: '4px' }}>
                  Taille par défaut (pt)
                </label>
                <select
                  value={defaultsDraft.fontSizePt}
                  onChange={(e) => setDefaultsDraft((d) => ({ ...d, fontSizePt: Number(e.target.value) }))}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-xs)',
                    border: '1px solid var(--border-strong)',
                    backgroundColor: 'var(--bg-app)',
                    color: 'var(--fg-primary)',
                  }}
                >
                  {FONT_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} pt
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: '4px' }}>
                  Interligne par défaut
                </label>
                <select
                  value={defaultsDraft.lineSpacing}
                  onChange={(e) => setDefaultsDraft((d) => ({ ...d, lineSpacing: Number(e.target.value) }))}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-xs)',
                    border: '1px solid var(--border-strong)',
                    backgroundColor: 'var(--bg-app)',
                    color: 'var(--fg-primary)',
                  }}
                >
                  <option value={1}>1.0 (Simple)</option>
                  <option value={1.15}>1.15</option>
                  <option value={1.5}>1.5</option>
                  <option value={2}>2.0 (Double)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--fg-secondary)', marginBottom: '4px' }}>
                  Couleur par défaut
                </label>
                <input
                  type="color"
                  value={defaultsDraft.color}
                  onChange={(e) => setDefaultsDraft((d) => ({ ...d, color: e.target.value }))}
                  style={{
                    width: '100%',
                    height: '34px',
                    padding: '2px',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius-xs)',
                    backgroundColor: 'var(--bg-app)',
                    cursor: 'pointer',
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-4)' }}>
          <Button variant="ghost" onClick={handleReset}>
            Valeurs par défaut
          </Button>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button variant="primary" onClick={handleSave}>
              Appliquer
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
