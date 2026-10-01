// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Formatting ribbon.
 *
 * Taken from the Write application and rewired onto the native engine. Every action is a **controller command**, the same as the keyboard shortcut and the
 * menu entry: one implementation, three ways in.
 *
 * The buttons keep no state: they read the formatting that the engine has computed. A button therefore stays consistent with the document even after an undo,
 * a case where a state duplicated in the component would get out of sync.
 *
 * ⚠️ A deliberate departure from Hick's law (UX directive §2): the ribbon exposes more than twelve actions to cover the office-suite scope. They are grouped and
 * separated; the overflow menu remains to be done.
 */

import { useRef, useState, type JSX, type MutableRefObject } from 'react';
import { ColorPicker } from '../../design/components/ColorPicker';
import { ToggleButton } from '../../design/components/Button';
import { Popover } from '../../design/components/Popover';
import { DOCUMENT_PALETTE, HIGHLIGHT_PALETTE } from '../../design/color/palette';
import { Icon } from '../../design/icons/Icon';
import type { Alignment, ListKind } from '../../domain/document/types';
import { MAX_FONT_SIZE_PT, MIN_FONT_SIZE_PT, type WriterController } from '../editor/useWriterInput';
import { shortcutLabel } from '../shortcuts';
import { TableSizePicker } from '../dialogs/TableSizePicker';
import { UrlDialog } from '../dialogs/LinkDialog';

export const ZOOM_LEVELS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;

import { OPENOFFICE_FONTS, FONT_CATEGORIES } from '../../domain/document/fonts';

export const FONT_FAMILIES = OPENOFFICE_FONTS;

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64] as const;

const ALIGNMENTS: readonly [Alignment, string, string, 'align-left' | 'align-center' | 'align-right' | 'align-justify'][] = [
  ['left', 'Aligner à gauche', 'Mod-l', 'align-left'],
  ['center', 'Centrer', 'Mod-e', 'align-center'],
  ['right', 'Aligner à droite', 'Mod-r', 'align-right'],
  ['justify', 'Justifier', 'Mod-j', 'align-justify'],
];

const LISTS: readonly [ListKind, string, string, 'list-check' | 'list-bullet' | 'list-ordered'][] = [
  ['task', 'Liste à cocher', 'Mod-Shift-9', 'list-check'],
  ['bullet', 'Liste à puces', 'Mod-Shift-8', 'list-bullet'],
  ['ordered', 'Liste numérotée', 'Mod-Shift-7', 'list-ordered'],
];

export interface RibbonProps {
  controller: WriterController;
  onPrint: () => void;
  onOpenFindReplace: () => void;
  onToggleOutline: () => void;
  outlineOpen: boolean;
  onOpenPageSetup: () => void;
  onOpenMath?: () => void;
  onOpenImage?: () => void;
  onOpenFurniture?: (band?: 'header' | 'footer') => void;
  linkButtonRef?: MutableRefObject<HTMLButtonElement | null>;
}

export function Ribbon({
  controller,
  onPrint,
  onOpenFindReplace,
  onToggleOutline,
  outlineOpen,
  onOpenPageSetup,
  onOpenMath,
  onOpenImage,
  onOpenFurniture,
  linkButtonRef,
}: RibbonProps): JSX.Element {
  const [spacingOpen, setSpacingOpen] = useState(false);
  const spacingTriggerRef = useRef<HTMLButtonElement | null>(null);

  const { commands, activeFormat, currentParagraph, canUndo, canRedo, zoom, setZoom } = controller;
  const defaults = controller.session.state.doc.defaults;

  const blockValue = currentParagraph?.type === 'heading'
    ? `h${currentParagraph.headingLevel ?? 1}`
    : 'p';
  const fontSize = activeFormat.fontSizePt ?? defaults.fontSizePt;
  const lineSpacing = currentParagraph?.lineSpacing ?? defaults.lineSpacing;
  const effectiveFontFamily = activeFormat.fontFamily ?? defaults.fontFamily;
  const isKnownFont = FONT_FAMILIES.some((f) => f.value === effectiveFontFamily);
  const customFontLabel = effectiveFontFamily.split(',')[0]?.trim().replace(/['"]/g, '') || effectiveFontFamily;

  return (
    <div className="ribbon" role="toolbar" aria-label="Mise en forme" aria-controls="document-body">
      <div className="ribbon__group" role="group" aria-label="Historique et outils">
        <ToggleButton
          label="Annuler"
          shortcut={shortcutLabel('Mod-z')}
          pressed={false}
          disabled={!canUndo}
          onClick={commands.undo}
        >
          <Icon name="undo" />
        </ToggleButton>
        <ToggleButton
          label="Rétablir"
          shortcut={shortcutLabel('Mod-y')}
          pressed={false}
          disabled={!canRedo}
          onClick={commands.redo}
        >
          <Icon name="redo" />
        </ToggleButton>
        {/* The PDF export stays in the File menu: one more icon in the ribbon would not have made it more accessible, only more crowded. */}
        <ToggleButton label="Imprimer" shortcut={shortcutLabel('Mod-p')} pressed={false} onClick={onPrint}>
          <Icon name="print" />
        </ToggleButton>
        <ToggleButton
          label="Rechercher et remplacer"
          shortcut={shortcutLabel('Mod-f')}
          pressed={false}
          onClick={onOpenFindReplace}
        >
          <Icon name="search" />
        </ToggleButton>
        <ToggleButton label="Plan du document" pressed={outlineOpen} onClick={onToggleOutline}>
          <Icon name="outline" />
        </ToggleButton>
        <ToggleButton label="Mise en page…" pressed={false} onClick={onOpenPageSetup}>
          <Icon name="replace" />
        </ToggleButton>
        <ToggleButton
          label="Effacer la mise en forme"
          shortcut={shortcutLabel('Mod-\\')}
          pressed={false}
          onClick={commands.clearFormatting}
        >
          <Icon name="clear-format" />
        </ToggleButton>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <label className="ribbon__select">
        <span className="visually-hidden">Zoom</span>
        <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="Zoom">
          {ZOOM_LEVELS.map((level) => (
            <option key={level} value={level}>
              {Math.round(level * 100)} %
            </option>
          ))}
        </select>
      </label>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Style de paragraphe">
        <label className="ribbon__select">
          <span className="visually-hidden">Style de paragraphe</span>
          <select
            value={blockValue}
            aria-label="Style de paragraphe"
            onChange={(event) => {
              const value = event.target.value;
              commands.setHeadingLevel(value === 'p' ? 0 : (Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6));
            }}
          >
            <option value="p">Texte standard</option>
            {[1, 2, 3, 4, 5, 6].map((level) => (
              <option key={level} value={`h${level}`}>{`Titre ${level}`}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="ribbon__group" role="group" aria-label="Police et taille">
        <label className="ribbon__select">
          <span className="visually-hidden">Police</span>
          <select
            value={effectiveFontFamily}
            aria-label="Police"
            onChange={(event) => commands.setFontFamily(event.target.value)}
          >
            {!isKnownFont && (
              <option value={effectiveFontFamily} style={{ fontFamily: effectiveFontFamily }}>
                {customFontLabel}
              </option>
            )}
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
        </label>

        <label className="ribbon__select ribbon__select--size">
          <span className="visually-hidden">Taille de police</span>
          <select
            value={String(fontSize)}
            aria-label="Taille de police"
            onChange={(event) => commands.setFontSize(Number(event.target.value))}
          >
            {/* The current size may come from an import and not be in the list: we add it there rather than display a wrong value. */}
            {(FONT_SIZES as readonly number[]).includes(fontSize)
              ? null
              : <option value={String(fontSize)}>{`${fontSize} pt`}</option>}
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>{`${size} pt`}</option>
            ))}
          </select>
        </label>

        <ToggleButton
          label="Diminuer la taille de police"
          shortcut={shortcutLabel('Mod-Shift-<')}
          pressed={false}
          disabled={fontSize <= MIN_FONT_SIZE_PT}
          onClick={() => commands.adjustFontSize(-1)}
        >
          <Icon name="font-smaller" />
        </ToggleButton>
        <ToggleButton
          label="Augmenter la taille de police"
          shortcut={shortcutLabel('Mod-Shift->')}
          pressed={false}
          disabled={fontSize >= MAX_FONT_SIZE_PT}
          onClick={() => commands.adjustFontSize(1)}
        >
          <Icon name="font-larger" />
        </ToggleButton>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Format de caractère">
        <ToggleButton
          label="Gras"
          shortcut={shortcutLabel('Mod-b')}
          pressed={activeFormat.bold === true}
          onClick={commands.toggleBold}
        >
          <Icon name="bold" />
        </ToggleButton>
        <ToggleButton
          label="Italique"
          shortcut={shortcutLabel('Mod-i')}
          pressed={activeFormat.italic === true}
          onClick={commands.toggleItalic}
        >
          <Icon name="italic" />
        </ToggleButton>
        <ToggleButton
          label="Souligné"
          shortcut={shortcutLabel('Mod-u')}
          pressed={activeFormat.underline === true}
          onClick={commands.toggleUnderline}
        >
          <Icon name="underline" />
        </ToggleButton>
        <ToggleButton
          label="Barré"
          shortcut={shortcutLabel('Mod-Shift-x')}
          pressed={activeFormat.strikeThrough === true}
          onClick={commands.toggleStrike}
        >
          <Icon name="strikethrough" />
        </ToggleButton>

        <ColorPicker
          label="Couleur du texte"
          palette={DOCUMENT_PALETTE}
          value={activeFormat.color ?? null}
          resetLabel="Couleur automatique"
          onSelect={(color) => commands.setColor(color)}
        >
          <Icon name="text-color" barColor={activeFormat.color ?? 'currentColor'} />
        </ColorPicker>

        <ColorPicker
          label="Surlignage"
          palette={HIGHLIGHT_PALETTE}
          value={activeFormat.backgroundColor ?? null}
          resetLabel="Aucun surlignage"
          onSelect={(color) => commands.setHighlight(color)}
        >
          <Icon name="highlight" barColor={activeFormat.backgroundColor ?? 'transparent'} />
        </ColorPicker>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Insertion">
        {activeFormat.linkHref ? (
          <ToggleButton
            label="Supprimer le lien"
            shortcut={shortcutLabel('Mod-k')}
            pressed
            onClick={commands.removeLink}
          >
            <Icon name="link" />
          </ToggleButton>
        ) : (
          <UrlDialog
            label="Insérer un lien"
            title="Insérer un lien hypertexte"
            {...(linkButtonRef ? { buttonRef: linkButtonRef } : {})}
            onSubmit={(url) => commands.setLink(url)}
          >
            <Icon name="link" />
          </UrlDialog>
        )}

        <TableSizePicker label="Insérer un tableau" onInsert={commands.insertTable}>
          <Icon name="table" />
        </TableSizePicker>

        {onOpenImage && (
          <ToggleButton
            label="Insérer une image"
            shortcut={shortcutLabel('Mod-Shift-i')}
            pressed={false}
            onClick={onOpenImage}
          >
            <Icon name="image" />
          </ToggleButton>
        )}

        {onOpenMath && (
          <ToggleButton
            label="Insérer une formule mathématique"
            shortcut={shortcutLabel('Mod-Shift-e')}
            pressed={false}
            onClick={onOpenMath}
          >
            <Icon name="math" />
          </ToggleButton>
        )}

        <ToggleButton
          label="Insérer un saut de page"
          shortcut={shortcutLabel('Mod-Entrée')}
          pressed={false}
          onClick={commands.insertPageBreak}
        >
          <Icon name="page-break" />
        </ToggleButton>

        {onOpenFurniture && (
          <>
            <ToggleButton
              label="En-tête de page…"
              pressed={false}
              onClick={() => onOpenFurniture('header')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <line x1="2" y1="9" x2="22" y2="9" />
              </svg>
            </ToggleButton>
            <ToggleButton
              label="Pied de page…"
              pressed={false}
              onClick={() => onOpenFurniture('footer')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <line x1="2" y1="15" x2="22" y2="15" />
              </svg>
            </ToggleButton>
          </>
        )}
      </div>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Paragraphe">
        {ALIGNMENTS.map(([align, label, binding, icon]) => (
          <ToggleButton
            key={align}
            label={label}
            shortcut={shortcutLabel(binding)}
            pressed={(currentParagraph?.alignment ?? 'left') === align}
            onClick={() => commands.setAlignment(align)}
          >
            <Icon name={icon} />
          </ToggleButton>
        ))}

        <div className="picker">
          <ToggleButton
            buttonRef={spacingTriggerRef}
            label="Interligne et espacement des paragraphes"
            pressed={spacingOpen}
            onClick={() => setSpacingOpen((open) => !open)}
          >
            <Icon name="line-height" />
          </ToggleButton>

          {spacingOpen && (
            <Popover
              label="Interligne et espacement des paragraphes"
              triggerRef={spacingTriggerRef}
              onClose={() => setSpacingOpen(false)}
              className="menu"
              style={{ width: 'auto', minWidth: '320px', padding: '4px 0', whiteSpace: 'nowrap' }}
            >
              <div role="menu" aria-label="Interligne et espacement">
                {[
                  { height: 1, label: 'Simple' },
                  { height: 1.15, label: '1,15' },
                  { height: 1.5, label: '1,5' },
                  { height: 2, label: 'Double' },
                ].map(({ height, label }) => {
                  const coche = Math.abs(lineSpacing - height) < 0.05;
                  return (
                    <button
                      key={height}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={coche}
                      className="menu__entry"
                      onClick={() => {
                        commands.setLineSpacing(height);
                        setSpacingOpen(false);
                      }}
                    >
                      <span className="menu__check">{coche ? '✓' : ''}</span>
                      <span className="menu__label">{label}</span>
                    </button>
                  );
                })}

                <div className="menu__group" />

                <button
                  type="button"
                  role="menuitem"
                  className="menu__entry"
                  onClick={() => {
                    commands.toggleSpaceBefore();
                    setSpacingOpen(false);
                  }}
                >
                  <span className="menu__check" />
                  <span className="menu__label">
                    {(currentParagraph?.marginTopPt ?? 0) > 0
                      ? 'Supprimer l’espacement avant le paragraphe'
                      : 'Insérer un espacement avant le paragraphe'}
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  className="menu__entry"
                  onClick={() => {
                    commands.toggleSpaceAfter();
                    setSpacingOpen(false);
                  }}
                >
                  <span className="menu__check" />
                  <span className="menu__label">
                    {(currentParagraph?.marginBottomPt ?? 0) > 0
                      ? 'Supprimer l’espacement après le paragraphe'
                      : 'Insérer un espacement après le paragraphe'}
                  </span>
                </button>

                <div className="menu__group" />

                <button
                  type="button"
                  role="menuitem"
                  className="menu__entry"
                  onClick={() => {
                    commands.insertPageBreak();
                    setSpacingOpen(false);
                  }}
                >
                  <span className="menu__check" />
                  <span className="menu__label">Ajouter un saut de page avant</span>
                </button>
              </div>
            </Popover>
          )}
        </div>
      </div>

      <div className="ribbon__group" role="group" aria-label="Listes et retraits">
        {LISTS.map(([kind, label, binding, icon]) => (
          <ToggleButton
            key={kind}
            label={label}
            shortcut={shortcutLabel(binding)}
            pressed={currentParagraph?.listKind === kind}
            onClick={() => commands.toggleList(kind)}
          >
            <Icon name={icon} />
          </ToggleButton>
        ))}
        <ToggleButton
          label="Diminuer le retrait"
          shortcut={shortcutLabel('Mod-[')}
          pressed={false}
          disabled={
            currentParagraph?.listKind === undefined && (currentParagraph?.indentLeftPt ?? 0) === 0
          }
          onClick={() => commands.indent(-1)}
        >
          <Icon name="indent-decrease" />
        </ToggleButton>
        <ToggleButton
          label="Augmenter le retrait"
          shortcut={shortcutLabel('Mod-]')}
          pressed={false}
          onClick={() => commands.indent(1)}
        >
          <Icon name="indent-increase" />
        </ToggleButton>
      </div>
    </div>
  );
}
