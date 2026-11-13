// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Heading styles editor (OpenOffice: the "Paragraph Style" dialog opened on "Heading N").
 *
 * Two kinds of styles live here:
 * - the six built-in levels "Titre 1..6", whose look can be changed and reset;
 * - the styles created by the user ("Chapitre", "Annexe"...), each one based on an outline level.
 *   The level decides where the heading sits in the outline and the table of contents; the look
 *   starts from that level and only stores what differs.
 *
 * Nothing is written to the document before "Appliquer": the dialog works on a draft so that
 * one click on "Annuler" really leaves everything as it was, and so that the whole change is a
 * single undo step.
 */

import { useId, useMemo, useState, type JSX } from 'react';
import type {
  Alignment,
  CustomHeadingStyle,
  DocumentDefaults,
  HeadingLevel,
  HeadingStyle,
} from '../../domain/document/types';
import {
  HEADING_LEVELS,
  resolveCustomStyle,
  resolveLevelStyle,
  type ResolvedHeadingStyle,
} from '../../domain/engine/style';
import { newId } from '../../domain/document/document';
import { OPENOFFICE_FONTS, FONT_CATEGORIES } from '../../domain/document/fonts';
import { Modal } from '../../design/components/Modal';
import { Button } from '../../design/components/Button';
import { FONT_SIZES } from '../components/Ribbon';

/** What the dialog should show when it opens. */
export type HeadingStyleTarget =
  | { kind: 'level'; level: HeadingLevel }
  | { kind: 'custom'; id: string }
  | { kind: 'new'; level?: HeadingLevel };

interface HeadingStylesDialogProps {
  open: boolean;
  defaults: DocumentDefaults;
  initialTarget?: HeadingStyleTarget | undefined;
  onSave: (next: DocumentDefaults) => void;
  onClose: () => void;
}

export function HeadingStylesDialog(props: HeadingStylesDialogProps): JSX.Element | null {
  // Mounting the body only while open resets the draft at every opening.
  if (!props.open) return null;
  return <HeadingStylesEditor {...props} />;
}

type Selection = { kind: 'level'; level: HeadingLevel } | { kind: 'custom'; id: string };

const ALIGNMENT_OPTIONS: readonly [Alignment, string][] = [
  ['left', 'Gauche'],
  ['center', 'Centré'],
  ['right', 'Droite'],
  ['justify', 'Justifié'],
];

function createCustomStyle(level: HeadingLevel, existing: readonly CustomHeadingStyle[]): CustomHeadingStyle {
  let n = existing.length + 1;
  const names = new Set(existing.map((s) => s.name));
  while (names.has(`Titre personnalisé ${n}`)) n += 1;
  return { id: newId('hs'), name: `Titre personnalisé ${n}`, level };
}

function HeadingStylesEditor({
  defaults,
  initialTarget,
  onSave,
  onClose,
}: HeadingStylesDialogProps): JSX.Element {
  const uid = useId();
  const [levelStyles, setLevelStyles] = useState<Partial<Record<HeadingLevel, HeadingStyle>>>(
    () => ({ ...(defaults.headingStyles ?? {}) }),
  );
  const [customStyles, setCustomStyles] = useState<CustomHeadingStyle[]>(() => {
    const list = [...(defaults.customHeadingStyles ?? [])];
    if (initialTarget?.kind === 'new') list.push(createCustomStyle(initialTarget.level ?? 1, list));
    return list;
  });
  const [selection, setSelection] = useState<Selection>(() => {
    if (initialTarget?.kind === 'level') return initialTarget;
    if (initialTarget?.kind === 'custom' && defaults.customHeadingStyles?.some((s) => s.id === initialTarget.id)) {
      return initialTarget;
    }
    if (initialTarget?.kind === 'new') return { kind: 'custom', id: customStyles[customStyles.length - 1]!.id };
    return { kind: 'level', level: 1 };
  });

  // Draft document defaults, used to resolve every style exactly as the layout engine will.
  const draft = useMemo<DocumentDefaults>(
    () => ({ ...defaults, headingStyles: levelStyles, customHeadingStyles: customStyles }),
    [defaults, levelStyles, customStyles],
  );

  const selectedCustom = selection.kind === 'custom' ? customStyles.find((s) => s.id === selection.id) : undefined;
  const resolved: ResolvedHeadingStyle = selectedCustom
    ? resolveCustomStyle(selectedCustom, draft)
    : resolveLevelStyle(selection.kind === 'level' ? selection.level : 1, draft);

  /** Records one change on the selected style. */
  const patch = (change: HeadingStyle): void => {
    if (selection.kind === 'level') {
      const level = selection.level;
      setLevelStyles((prev) => ({ ...prev, [level]: { ...(prev[level] ?? {}), ...change } }));
    } else {
      setCustomStyles((prev) => prev.map((s) => (s.id === selection.id ? { ...s, ...change } : s)));
    }
  };

  const patchCustom = (change: Partial<Pick<CustomHeadingStyle, 'name' | 'level'>>): void => {
    if (selection.kind !== 'custom') return;
    setCustomStyles((prev) => prev.map((s) => (s.id === selection.id ? { ...s, ...change } : s)));
  };

  const addStyle = (): void => {
    const level = selection.kind === 'level' ? selection.level : (selectedCustom?.level ?? 1);
    const created = createCustomStyle(level, customStyles);
    setCustomStyles((prev) => [...prev, created]);
    setSelection({ kind: 'custom', id: created.id });
  };

  const resetSelected = (): void => {
    if (selection.kind === 'level') {
      const level = selection.level;
      setLevelStyles((prev) => {
        const next = { ...prev };
        delete next[level];
        return next;
      });
    } else {
      // A custom style goes back to plain inheritance from its level: name and level stay.
      setCustomStyles((prev) =>
        prev.map((s) => (s.id === selection.id ? { id: s.id, name: s.name, level: s.level } : s)),
      );
    }
  };

  const deleteSelected = (): void => {
    if (!selectedCustom) return;
    const level = selectedCustom.level;
    setCustomStyles((prev) => prev.filter((s) => s.id !== selectedCustom.id));
    setSelection({ kind: 'level', level });
  };

  const handleSave = (): void => {
    const cleanedLevels: Partial<Record<HeadingLevel, HeadingStyle>> = {};
    for (const level of HEADING_LEVELS) {
      const style = levelStyles[level];
      if (style && Object.keys(style).length > 0) cleanedLevels[level] = style;
    }
    const cleanedCustom = customStyles.map((s) => ({ ...s, name: s.name.trim() || 'Titre sans nom' }));
    const next: DocumentDefaults = { ...defaults };
    if (Object.keys(cleanedLevels).length > 0) next.headingStyles = cleanedLevels;
    else delete next.headingStyles;
    if (cleanedCustom.length > 0) next.customHeadingStyles = cleanedCustom;
    else delete next.customHeadingStyles;
    onSave(next);
    onClose();
  };

  const isSelected = (candidate: Selection): boolean =>
    candidate.kind === selection.kind &&
    (candidate.kind === 'level'
      ? candidate.level === (selection as { level: HeadingLevel }).level
      : candidate.id === (selection as { id: string }).id);

  const styleLabel = selectedCustom ? selectedCustom.name || 'Titre sans nom' : `Titre ${resolvedLevel(selection)}`;
  const isModified =
    selection.kind === 'level'
      ? Object.keys(levelStyles[selection.level] ?? {}).length > 0
      : Object.keys(selectedCustom ?? {}).some((k) => !['id', 'name', 'level'].includes(k));

  return (
    <Modal
      title="Styles de titre"
      onClose={onClose}
      width={820}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', width: '100%' }}>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Appliquer
          </Button>
        </div>
      }
    >
      <div className="heading-styles">
        {/* Style list */}
        <nav className="heading-styles__list" aria-label="Styles de titre">
          <p className="heading-styles__group-label">Titres intégrés</p>
          <ul role="list">
            {HEADING_LEVELS.map((level) => {
              const style = resolveLevelStyle(level, draft);
              const candidate: Selection = { kind: 'level', level };
              return (
                <li key={level}>
                  <button
                    type="button"
                    className="heading-styles__item"
                    aria-current={isSelected(candidate) ? 'true' : undefined}
                    onClick={() => setSelection(candidate)}
                  >
                    <span className="heading-styles__item-name" style={sampleStyle(style, 15)}>
                      Titre {level}
                    </span>
                    <span className="heading-styles__item-meta">
                      {style.fontSizePt} pt{levelStyles[level] ? ' · modifié' : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <p className="heading-styles__group-label">Mes styles</p>
          {customStyles.length === 0 ? (
            <p className="bento-help heading-styles__empty">Aucun style créé pour l’instant.</p>
          ) : (
            <ul role="list">
              {customStyles.map((custom) => {
                const style = resolveCustomStyle(custom, draft);
                const candidate: Selection = { kind: 'custom', id: custom.id };
                return (
                  <li key={custom.id}>
                    <button
                      type="button"
                      className="heading-styles__item"
                      aria-current={isSelected(candidate) ? 'true' : undefined}
                      onClick={() => setSelection(candidate)}
                    >
                      <span className="heading-styles__item-name" style={sampleStyle(style, 15)}>
                        {custom.name || 'Titre sans nom'}
                      </span>
                      <span className="heading-styles__item-meta">Niveau {custom.level}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Button variant="ghost" onClick={addStyle}>
            + Nouveau style de titre
          </Button>
        </nav>

        {/* Editor */}
        <section className="heading-styles__editor" aria-label={`Réglages — ${styleLabel}`}>
          <div className="heading-styles__preview" aria-hidden="true">
            <div style={{ ...sampleStyle(resolved, Math.min(resolved.fontSizePt, 32)), textAlign: resolved.alignment }}>
              {styleLabel}
            </div>
            <div className="heading-styles__preview-body" style={{ fontFamily: defaults.fontFamily }}>
              Le texte normal qui suit le titre garde la police du document, pour que la différence entre
              titre, sous-titre et texte courant reste nette.
            </div>
          </div>

          <div className="bento-form bento-form--2">
            {selectedCustom && (
              <>
                <div className="bento-field">
                  <label className="bento-label" htmlFor={`${uid}-name`}>
                    Nom du style
                  </label>
                  <input
                    id={`${uid}-name`}
                    className="bento-input"
                    value={selectedCustom.name}
                    maxLength={40}
                    onChange={(e) => patchCustom({ name: e.target.value })}
                  />
                </div>
                <div className="bento-field">
                  <label className="bento-label" htmlFor={`${uid}-level`}>
                    Niveau dans le plan
                  </label>
                  <select
                    id={`${uid}-level`}
                    className="bento-input"
                    value={selectedCustom.level}
                    onChange={(e) => patchCustom({ level: Number(e.target.value) as HeadingLevel })}
                  >
                    {HEADING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level === 1 ? 'Niveau 1 (titre)' : `Niveau ${level} (sous-titre)`}
                      </option>
                    ))}
                  </select>
                  <p className="bento-help">Place du titre dans le plan et la table des matières.</p>
                </div>
              </>
            )}

            <div className="bento-field">
              <label className="bento-label" htmlFor={`${uid}-font`}>
                Police
              </label>
              <select
                id={`${uid}-font`}
                className="bento-input"
                value={resolved.fontFamily}
                onChange={(e) => patch({ fontFamily: e.target.value })}
              >
                {!OPENOFFICE_FONTS.some((f) => f.value === resolved.fontFamily) && (
                  <option value={resolved.fontFamily}>{resolved.fontFamily.split(',')[0]}</option>
                )}
                {FONT_CATEGORIES.map((category) => {
                  const fonts = OPENOFFICE_FONTS.filter((f) => f.category === category.id);
                  if (fonts.length === 0) return null;
                  return (
                    <optgroup key={category.id} label={category.label}>
                      {fonts.map((font) => (
                        <option key={font.value} value={font.value}>
                          {font.label}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </div>

            <div className="bento-field">
              <label className="bento-label" htmlFor={`${uid}-size`}>
                Taille (pt)
              </label>
              <input
                id={`${uid}-size`}
                className="bento-input"
                type="number"
                min={6}
                max={96}
                step={0.5}
                list={`${uid}-sizes`}
                value={resolved.fontSizePt}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= 6 && value <= 96) patch({ fontSizePt: value });
                }}
              />
              <datalist id={`${uid}-sizes`}>
                {FONT_SIZES.map((size) => (
                  <option key={size} value={size} />
                ))}
              </datalist>
            </div>

            <fieldset className="bento-fieldset">
              <legend>Style du texte</legend>
              <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
                <label className="bento-check">
                  <input type="checkbox" checked={resolved.bold} onChange={(e) => patch({ bold: e.target.checked })} />
                  <span style={{ fontWeight: 700 }}>Gras</span>
                </label>
                <label className="bento-check">
                  <input
                    type="checkbox"
                    checked={resolved.italic}
                    onChange={(e) => patch({ italic: e.target.checked })}
                  />
                  <span style={{ fontStyle: 'italic' }}>Italique</span>
                </label>
              </div>
            </fieldset>

            <div className="bento-field">
              <label className="bento-label" htmlFor={`${uid}-color`}>
                Couleur
              </label>
              <input
                id={`${uid}-color`}
                className="bento-input heading-styles__color"
                type="color"
                value={toHexColor(resolved.color)}
                onChange={(e) => patch({ color: e.target.value })}
              />
            </div>

            <fieldset className="bento-fieldset">
              <legend>Alignement</legend>
              <div className="bento-segmented" role="group" aria-label="Alignement">
                {ALIGNMENT_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={resolved.alignment === value}
                    onClick={() => patch({ alignment: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="bento-form bento-form--2" style={{ gap: 'var(--space-3)' }}>
              <div className="bento-field">
                <label className="bento-label" htmlFor={`${uid}-before`}>
                  Espace avant (pt)
                </label>
                <input
                  id={`${uid}-before`}
                  className="bento-input"
                  type="number"
                  min={0}
                  max={72}
                  step={1}
                  value={resolved.spaceBeforePt}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isFinite(value) && value >= 0) patch({ spaceBeforePt: value });
                  }}
                />
              </div>
              <div className="bento-field">
                <label className="bento-label" htmlFor={`${uid}-after`}>
                  Espace après (pt)
                </label>
                <input
                  id={`${uid}-after`}
                  className="bento-input"
                  type="number"
                  min={0}
                  max={72}
                  step={1}
                  value={resolved.spaceAfterPt}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isFinite(value) && value >= 0) patch({ spaceAfterPt: value });
                  }}
                />
              </div>
            </div>
          </div>

          <div className="heading-styles__actions">
            <Button variant="ghost" onClick={resetSelected} disabled={!isModified}>
              {selectedCustom ? `Reprendre le style du Titre ${selectedCustom.level}` : 'Rétablir le style d’origine'}
            </Button>
            {selectedCustom && (
              <Button variant="danger" onClick={deleteSelected}>
                Supprimer ce style
              </Button>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}

function resolvedLevel(selection: Selection): HeadingLevel {
  return selection.kind === 'level' ? selection.level : 1;
}

/** Inline CSS of a style sample. `maxPt` keeps the list readable with very large headings. */
function sampleStyle(style: ResolvedHeadingStyle, maxPt: number): React.CSSProperties {
  return {
    fontFamily: style.fontFamily,
    fontSize: `${Math.min(style.fontSizePt, maxPt)}pt`,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    color: style.color,
  };
}

/** `<input type="color">` only accepts `#rrggbb`. */
function toHexColor(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  return '#000000';
}
