/**
 * Raccourcis clavier — normatifs (01_DIRECTIVE_UX_ERGONOMIE.md §5.2).
 *
 * Principe de familiarité : l'usager arrive avec vingt ans de réflexes
 * bureautiques. Aucun raccourci n'est réinventé ; ils suivent les conventions
 * communes aux suites bureautiques du marché.
 */

import { baseKeymap, chainCommands, exitCode } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import type { Command, Plugin } from 'prosemirror-state';
import { redo, undo } from 'y-prosemirror';
import { writeSchema } from '../document/schema';
import {
  adjustFontSize,
  changeIndent,
  clearFormatting,
  insertPageBreak,
  setAlignment,
  setHeading,
  setParagraph,
  toggleBold,
  toggleItalic,
  toggleList,
  toggleStrike,
  toggleUnderline,
} from './commands';

const listItem = writeSchema.nodes['list_item'];
const taskItem = writeSchema.nodes['task_item'];

const hardBreak: Command = (state, dispatch) => {
  const type = writeSchema.nodes['hard_break'];
  if (!type) return false;
  dispatch?.(state.tr.replaceSelectionWith(type.create()).scrollIntoView());
  return true;
};

/** Commandes déclenchées hors éditeur (menus, ruban) mais liées à un raccourci. */
export interface HostCommands {
  openLinkDialog: () => void;
  openMathDialog: () => void;
  print: () => void;
}

export function writeKeymap(host: HostCommands): Plugin[] {
  const bindings: Record<string, Command> = {
    'Mod-b': toggleBold,
    'Mod-i': toggleItalic,
    'Mod-u': toggleUnderline,
    'Mod-Shift-x': toggleStrike,
    'Mod-\\': clearFormatting,

    'Mod-0': setParagraph,
    'Mod-1': setHeading(1),
    'Mod-2': setHeading(2),
    'Mod-3': setHeading(3),
    'Mod-4': setHeading(4),
    'Mod-5': setHeading(5),
    'Mod-6': setHeading(6),

    'Mod-l': setAlignment('left'),
    'Mod-e': setAlignment('center'),
    'Mod-r': setAlignment('right'),
    'Mod-j': setAlignment('justify'),

    'Mod-Shift-7': toggleList('ordered_list'),
    'Mod-Shift-8': toggleList('bullet_list'),
    'Mod-Shift-9': toggleList('task_list'),

    'Mod-]': changeIndent(1),
    'Mod-[': changeIndent(-1),

    'Mod-Shift-.': adjustFontSize(1),
    'Mod-Shift-,': adjustFontSize(-1),

    'Mod-Enter': insertPageBreak,
    'Shift-Enter': chainCommands(exitCode, hardBreak),

    // Annulation **par utilisateur** : chacun défait ses propres modifications,
    // jamais celles d'un collaborateur (ADR-001).
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,

    'Mod-k': () => {
      host.openLinkDialog();
      return true;
    },
    'Mod-p': () => {
      host.print();
      return true;
    },
    'Mod-Shift-m': () => {
      host.openMathDialog();
      return true;
    },
  };

  // Entrée / Tab dans une liste : scinder l'élément, changer de niveau.
  if (listItem && taskItem) {
    bindings['Enter'] = chainCommands(splitListItem(taskItem), splitListItem(listItem));
    bindings['Tab'] = chainCommands(sinkListItem(taskItem), sinkListItem(listItem), changeIndent(1));
    bindings['Shift-Tab'] = chainCommands(liftListItem(taskItem), liftListItem(listItem), changeIndent(-1));
  }

  return [keymap(bindings), keymap(baseKeymap)];
}

/** Libellés d'info-bulle : un raccourci non découvrable n'existe pas. */
export function shortcutLabel(binding: string): string {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');

  return binding
    .replace('Mod', isMac ? '⌘' : 'Ctrl')
    .replace('Shift', 'Maj')
    .split('-')
    // Les touches s'écrivent en capitale : « Ctrl+B », jamais « Ctrl+b ».
    .map((touche) => (touche.length === 1 ? touche.toUpperCase() : touche))
    .join('+');
}
