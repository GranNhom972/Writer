/**
 * Ruban de mise en forme (couche 4).
 *
 * Toute action est un `Command` réutilisé tel quel par le raccourci clavier et
 * par les menus : une implémentation, plusieurs chemins d'accès.
 *
 * ⚠️ Écart assumé à la Loi de Hick (≤ 12 actions visibles, directive UX §2) :
 * le ruban en expose davantage pour couvrir le périmètre bureautique demandé.
 * Les actions sont regroupées et séparées ; le menu de dépassement reste à faire.
 */

import type { MutableRefObject } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { redo, undo } from 'y-prosemirror';
import { ColorPicker } from '../design/components/ColorPicker';
import { DOCUMENT_PALETTE, HIGHLIGHT_PALETTE } from '../design/color/palette';
import { Icon } from '../design/icons/Icon';
import { ToggleButton } from '../design/components/Button';
import {
  FONT_FAMILIES,
  FONT_SIZES,
  LINE_HEIGHTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from '../document/schema';
import {
  adjustFontSize,
  changeIndent,
  clearFormatting,
  insertImage,
  readFormattingState,
  removeLink,
  setAlignment,
  setFontFamily,
  setFontSize,
  setHeading,
  setHighlight,
  setLineHeight,
  setLink,
  setParagraph,
  setTextColor,
  toggleBold,
  toggleItalic,
  toggleList,
  toggleStrike,
  toggleUnderline,
} from '../editor/commands';
import { shortcutLabel } from '../editor/keymap';
import { UrlDialog } from './LinkDialog';
import { TableSizePicker } from './TableSizePicker';

export const ZOOM_LEVELS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;

interface RibbonProps {
  view: EditorView | null;
  state: EditorState | null;
  disabled: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onPrint: () => void;
  onInsertMath: () => void;
  /** Insertion d'un tableau aux dimensions choisies dans la grille. */
  onInsertTable?: (rows: number, cols: number) => void;
  /** Ouvre les propriétés du tableau sous le curseur. */
  onOpenTableProperties?: () => void;
  /** Vrai quand le curseur se trouve dans un tableau. */
  inTable?: boolean;
  tableButtonRef?: MutableRefObject<HTMLButtonElement | null>;
  onInsertFootnote?: () => void;
  onToggleOutline?: () => void;
  onOpenFindReplace?: () => void;
  outlineOpen?: boolean;
  /** Refs des dialogues, pour que Ctrl+K et les menus les ouvrent. */
  linkButtonRef?: MutableRefObject<HTMLButtonElement | null>;
  imageButtonRef?: MutableRefObject<HTMLButtonElement | null>;
}

export function Ribbon({
  view,
  state,
  disabled,
  zoom,
  onZoomChange,
  onPrint,
  onInsertMath,
  onInsertTable,
  onOpenTableProperties,
  inTable = false,
  tableButtonRef,
  onInsertFootnote,
  onToggleOutline,
  onOpenFindReplace,
  outlineOpen,
  linkButtonRef,
  imageButtonRef,
}: RibbonProps) {
  const format = state ? readFormattingState(state) : null;

  const run = (command: Command) => (): boolean => {
    if (!view) return false;
    const applied = command(view.state, view.dispatch, view);
    view.focus(); // le focus revient toujours au document après une action de ruban
    return applied;
  };

  const blockValue = format?.blockType === 'heading' ? `h${format.headingLevel}` : 'p';

  return (
    <div className="ribbon" role="toolbar" aria-label="Mise en forme" aria-controls="document-body">
      <div className="ribbon__group" role="group" aria-label="Historique & Outils">
        <ToggleButton
          label="Annuler"
          shortcut={shortcutLabel('Mod-z')}
          pressed={false}
          disabled={disabled}
          onClick={run(undo)}
        >
          <Icon name="undo" />
        </ToggleButton>
        <ToggleButton
          label="Rétablir"
          shortcut={shortcutLabel('Mod-y')}
          pressed={false}
          disabled={disabled}
          onClick={run(redo)}
        >
          <Icon name="redo" />
        </ToggleButton>
        <ToggleButton label="Imprimer" shortcut={shortcutLabel('Mod-p')} pressed={false} onClick={onPrint}>
          <Icon name="print" />
        </ToggleButton>
        {onOpenFindReplace && (
          <ToggleButton label="Rechercher / Remplacer" shortcut="Ctrl+F" pressed={false} onClick={onOpenFindReplace}>
            <Icon name="search" />
          </ToggleButton>
        )}
        {onToggleOutline && (
          <ToggleButton label="Plan du document" pressed={Boolean(outlineOpen)} onClick={onToggleOutline}>
            <Icon name="outline" />
          </ToggleButton>
        )}
        <ToggleButton
          label="Effacer la mise en forme"
          shortcut={shortcutLabel('Mod-\\')}
          pressed={false}
          disabled={disabled}
          onClick={run(clearFormatting)}
        >
          <Icon name="clear-format" />
        </ToggleButton>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <label className="ribbon__select">
        <span className="visually-hidden">Zoom</span>
        <select
          value={zoom}
          onChange={(event) => onZoomChange(Number(event.target.value))}
          aria-label="Zoom"
        >
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
            disabled={disabled}
            aria-label="Style de paragraphe"
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'p') {
                run(setParagraph)();
              } else {
                const level = Number(value.replace('h', ''));
                run(setHeading(level))();
              }
            }}
          >
            <option value="p">Texte standard</option>
            <option value="h1">Titre 1</option>
            <option value="h2">Titre 2</option>
            <option value="h3">Titre 3</option>
            <option value="h4">Titre 4</option>
            <option value="h5">Titre 5</option>
            <option value="h6">Titre 6</option>
          </select>
        </label>
      </div>

      <div className="ribbon__group" role="group" aria-label="Police et taille">
        <label className="ribbon__select">
          <span className="visually-hidden">Police</span>
          <select
            value={format?.fontFamily ?? ''}
            disabled={disabled}
            aria-label="Police"
            onChange={(event) => run(setFontFamily(event.target.value || null))()}
          >
            <option value="">Police par défaut</option>
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </label>

        <label className="ribbon__select ribbon__select--size">
          <span className="visually-hidden">Taille de police</span>
          <select
            value={format?.fontSize ?? ''}
            disabled={disabled}
            aria-label="Taille de police"
            onChange={(event) => {
              const raw = event.target.value;
              run(setFontSize(raw ? Number(raw) : null))();
            }}
          >
            <option value="">12 pt (défaut)</option>
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} pt
              </option>
            ))}
          </select>
        </label>

        <ToggleButton
          label="Diminuer la taille de police"
          shortcut={shortcutLabel('Mod-Shift-<')}
          pressed={false}
          disabled={disabled || (format?.fontSize ?? 12) <= MIN_FONT_SIZE}
          onClick={run(adjustFontSize(-1))}
        >
          <Icon name="font-smaller" />
        </ToggleButton>
        <ToggleButton
          label="Augmenter la taille de police"
          shortcut={shortcutLabel('Mod-Shift->')}
          pressed={false}
          disabled={disabled || (format?.fontSize ?? 12) >= MAX_FONT_SIZE}
          onClick={run(adjustFontSize(1))}
        >
          <Icon name="font-larger" />
        </ToggleButton>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Format de caractère">
        <ToggleButton
          label="Gras"
          shortcut={shortcutLabel('Mod-b')}
          pressed={format?.bold ?? false}
          disabled={disabled}
          onClick={run(toggleBold)}
        >
          <Icon name="bold" />
        </ToggleButton>
        <ToggleButton
          label="Italique"
          shortcut={shortcutLabel('Mod-i')}
          pressed={format?.italic ?? false}
          disabled={disabled}
          onClick={run(toggleItalic)}
        >
          <Icon name="italic" />
        </ToggleButton>
        <ToggleButton
          label="Souligné"
          shortcut={shortcutLabel('Mod-u')}
          pressed={format?.underline ?? false}
          disabled={disabled}
          onClick={run(toggleUnderline)}
        >
          <Icon name="underline" />
        </ToggleButton>
        <ToggleButton
          label="Barré"
          shortcut={shortcutLabel('Mod-Shift-x')}
          pressed={format?.strike ?? false}
          disabled={disabled}
          onClick={run(toggleStrike)}
        >
          <Icon name="strikethrough" />
        </ToggleButton>

        <ColorPicker
          label="Couleur du texte"
          palette={DOCUMENT_PALETTE}
          value={format?.textColor ?? null}
          resetLabel="Couleur automatique"
          disabled={disabled}
          onSelect={(color) => run(setTextColor(color))()}
        >
          <Icon name="text-color" barColor={format?.textColor ?? 'currentColor'} />
        </ColorPicker>

        <ColorPicker
          label="Surlignage"
          palette={HIGHLIGHT_PALETTE}
          value={format?.highlight ?? null}
          resetLabel="Aucun surlignage"
          disabled={disabled}
          onSelect={(color) => run(setHighlight(color))()}
        >
          <Icon name="highlight" barColor={format?.highlight ?? 'transparent'} />
        </ColorPicker>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Insertion">
        {format?.linkHref ? (
          <ToggleButton
            label="Supprimer le lien"
            shortcut={shortcutLabel('Mod-k')}
            pressed={true}
            disabled={disabled}
            onClick={run(removeLink)}
          >
            <Icon name="link" />
          </ToggleButton>
        ) : (
          <UrlDialog
            label="Insérer un lien"
            title="Insérer un lien hypertexte"
            disabled={disabled}
            {...(linkButtonRef ? { buttonRef: linkButtonRef } : {})}
            onSubmit={(url, _alt) => run(setLink(url))()}
          >
            <Icon name="link" />
          </UrlDialog>
        )}

        <ToggleButton
          label="Insérer une formule mathématique"
          shortcut={shortcutLabel('Mod-Shift-e')}
          pressed={false}
          disabled={disabled}
          onClick={onInsertMath}
        >
          <Icon name="math" />
        </ToggleButton>

        {/* Un seul bouton, deux fonctions selon le contexte : hors tableau il
            propose une taille, dans un tableau il ouvre ses propriétés. C'est ce
            que l'usager cherche dans chaque cas. */}
        {onInsertTable && !inTable && (
          <TableSizePicker
            label="Insérer un tableau"
            disabled={disabled}
            onInsert={onInsertTable}
            {...(tableButtonRef ? { buttonRef: tableButtonRef } : {})}
          >
            <Icon name="table" />
          </TableSizePicker>
        )}

        {inTable && onOpenTableProperties && (
          <ToggleButton
            label="Propriétés du tableau"
            pressed={false}
            // Le curseur est dans un tableau : le bouton le montre, comme
            // l'alignement montre l'alignement courant.
            active
            aria-haspopup="dialog"
            disabled={disabled}
            onClick={onOpenTableProperties}
            {...(tableButtonRef ? { buttonRef: tableButtonRef } : {})}
          >
            <Icon name="table" />
          </ToggleButton>
        )}

        {onInsertFootnote && (
          <ToggleButton
            label="Insérer une note de bas de page"
            pressed={false}
            disabled={disabled}
            onClick={onInsertFootnote}
          >
            <Icon name="footnote" />
          </ToggleButton>
        )}

        <UrlDialog
          label="Insérer une image"
          title="Insérer une image par son adresse"
          withAltText
          disabled={disabled}
          {...(imageButtonRef ? { buttonRef: imageButtonRef } : {})}
          onSubmit={(url, alt) => run(insertImage(url, alt))()}
        >
          <Icon name="image" />
        </UrlDialog>
      </div>

      <div className="ribbon__separator" role="presentation" />

      <div className="ribbon__group" role="group" aria-label="Paragraphe">
        {(
          [
            ['left', 'Aligner à gauche', 'Mod-l', 'align-left'],
            ['center', 'Centrer', 'Mod-e', 'align-center'],
            ['right', 'Aligner à droite', 'Mod-r', 'align-right'],
            ['justify', 'Justifier', 'Mod-j', 'align-justify'],
          ] as const
        ).map(([align, label, binding, icon]) => (
          <ToggleButton
            key={align}
            label={label}
            shortcut={shortcutLabel(binding)}
            pressed={format?.alignment === align}
            disabled={disabled}
            onClick={run(setAlignment(align))}
          >
            <Icon name={icon} />
          </ToggleButton>
        ))}

        <label className="ribbon__select">
          <span className="visually-hidden">Interligne</span>
          <select
            value={format?.lineHeight ?? 1}
            disabled={disabled}
            aria-label="Interligne"
            onChange={(event) => run(setLineHeight(Number(event.target.value)))()}
          >
            {LINE_HEIGHTS.map((height) => (
              <option key={height} value={height}>
                Interligne {height.toLocaleString('fr-FR')}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="ribbon__group" role="group" aria-label="Listes et retraits">
        <ToggleButton
          label="Liste à cocher"
          shortcut={shortcutLabel('Mod-Shift-9')}
          pressed={format?.listKind === 'task_list'}
          disabled={disabled}
          onClick={run(toggleList('task_list'))}
        >
          <Icon name="list-check" />
        </ToggleButton>
        <ToggleButton
          label="Liste à puces"
          shortcut={shortcutLabel('Mod-Shift-8')}
          pressed={format?.listKind === 'bullet_list'}
          disabled={disabled}
          onClick={run(toggleList('bullet_list'))}
        >
          <Icon name="list-bullet" />
        </ToggleButton>
        <ToggleButton
          label="Liste numérotée"
          shortcut={shortcutLabel('Mod-Shift-7')}
          pressed={format?.listKind === 'ordered_list'}
          disabled={disabled}
          onClick={run(toggleList('ordered_list'))}
        >
          <Icon name="list-ordered" />
        </ToggleButton>
        <ToggleButton
          label="Diminuer le retrait"
          shortcut={shortcutLabel('Mod-[')}
          pressed={false}
          disabled={disabled || format?.indent === 0}
          onClick={run(changeIndent(-1))}
        >
          <Icon name="indent-decrease" />
        </ToggleButton>
        <ToggleButton
          label="Augmenter le retrait"
          shortcut={shortcutLabel('Mod-]')}
          pressed={false}
          disabled={disabled}
          onClick={run(changeIndent(1))}
        >
          <Icon name="indent-increase" />
        </ToggleButton>
      </div>
    </div>
  );
}
