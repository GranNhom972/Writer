// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Catalogue complet des familles de polices d'Apache OpenOffice Writer.
 *
 * Source : Registre VCL d'OpenOffice (`aoo-4.1.16/main/officecfg/registry/data/org/openoffice/VCL.xcu`)
 * et familles standard de StarWriter (Liberation, Thorndale, Albany, Cumberland, OpenSymbol).
 */

export interface FontDefinition {
  label: string;
  value: string;
  category: 'openoffice' | 'serif' | 'sans-serif' | 'monospace' | 'symbols';
}

export const OPENOFFICE_FONTS: readonly FontDefinition[] = [
  // --- Familles phares d'OpenOffice & LibreOffice ---
  {
    label: 'Liberation Serif',
    value: 'Liberation Serif, Tinos, Thorndale, Times New Roman, serif',
    category: 'openoffice',
  },
  {
    label: 'Liberation Sans',
    value: 'Liberation Sans, Arimo, Albany, Arial, Helvetica, sans-serif',
    category: 'openoffice',
  },
  {
    label: 'Liberation Mono',
    value: 'Liberation Mono, Cousine, Cumberland, Courier New, monospace',
    category: 'openoffice',
  },
  {
    label: 'OpenSymbol',
    value: 'OpenSymbol, StarSymbol, Symbol, serif',
    category: 'openoffice',
  },
  {
    label: 'Thorndale AMT',
    value: 'Thorndale AMT, Thorndale, Liberation Serif, Times New Roman, serif',
    category: 'openoffice',
  },
  {
    label: 'Albany AMT',
    value: 'Albany AMT, Albany, Liberation Sans, Arial, sans-serif',
    category: 'openoffice',
  },
  {
    label: 'Cumberland AMT',
    value: 'Cumberland AMT, Cumberland, Liberation Mono, Courier New, monospace',
    category: 'openoffice',
  },

  // --- Polices Serif (avec empattement) ---
  {
    label: 'Times New Roman',
    value: 'Times New Roman, Times, Liberation Serif, serif',
    category: 'serif',
  },
  {
    label: 'Georgia',
    value: 'Georgia, serif',
    category: 'serif',
  },
  {
    label: 'Garamond',
    value: 'Garamond, Baskerville, Times New Roman, serif',
    category: 'serif',
  },
  {
    label: 'DejaVu Serif',
    value: 'DejaVu Serif, Bitstream Vera Serif, Liberation Serif, serif',
    category: 'serif',
  },
  {
    label: 'Palatino Linotype',
    value: 'Palatino Linotype, Book Antiqua, Palatino, serif',
    category: 'serif',
  },
  {
    label: 'Century Schoolbook',
    value: 'Century Schoolbook, TeX Gyre Schola, serif',
    category: 'serif',
  },
  {
    label: 'Cambria',
    value: 'Cambria, Georgia, serif',
    category: 'serif',
  },
  {
    label: 'Baskerville',
    value: 'Baskerville, Garamond, serif',
    category: 'serif',
  },
  {
    label: 'FreeSerif',
    value: 'FreeSerif, Nimbus Roman No9 L, serif',
    category: 'serif',
  },
  {
    label: 'Noto Serif',
    value: 'Noto Serif, Droid Serif, serif',
    category: 'serif',
  },

  // --- Polices Sans-Serif (sans empattement) ---
  {
    label: 'Arial',
    value: 'Arial, Helvetica, Liberation Sans, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Helvetica',
    value: 'Helvetica, Arial, Liberation Sans, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Calibri',
    value: 'Calibri, Carlito, Liberation Sans, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Verdana',
    value: 'Verdana, Geneva, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Tahoma',
    value: 'Tahoma, Geneva, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Trebuchet MS',
    value: 'Trebuchet MS, Lucida Sans Unicode, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'DejaVu Sans',
    value: 'DejaVu Sans, Bitstream Vera Sans, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Segoe UI',
    value: 'Segoe UI, Tahoma, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Open Sans',
    value: 'Open Sans, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Roboto',
    value: 'Roboto, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'Noto Sans',
    value: 'Noto Sans, Droid Sans, sans-serif',
    category: 'sans-serif',
  },
  {
    label: 'FreeSans',
    value: 'FreeSans, Nimbus Sans L, sans-serif',
    category: 'sans-serif',
  },

  // --- Polices Monospace (à chasse fixe) ---
  {
    label: 'Courier New',
    value: 'Courier New, Courier, Liberation Mono, monospace',
    category: 'monospace',
  },
  {
    label: 'Consolas',
    value: 'Consolas, Inconsolata, monospace',
    category: 'monospace',
  },
  {
    label: 'DejaVu Sans Mono',
    value: 'DejaVu Sans Mono, Bitstream Vera Sans Mono, monospace',
    category: 'monospace',
  },
  {
    label: 'FreeMono',
    value: 'FreeMono, Nimbus Mono L, monospace',
    category: 'monospace',
  },
  {
    label: 'Lucida Console',
    value: 'Lucida Console, Monaco, monospace',
    category: 'monospace',
  },
  {
    label: 'JetBrains Mono',
    value: 'JetBrains Mono, ui-monospace, monospace',
    category: 'monospace',
  },

  // --- Polices Spéciales / Décoratives ---
  {
    label: 'Impact',
    value: 'Impact, Haettenschweiler, sans-serif',
    category: 'symbols',
  },
  {
    label: 'Comic Sans MS',
    value: 'Comic Sans MS, cursive, sans-serif',
    category: 'symbols',
  },
];

export const FONT_CATEGORIES = [
  { id: 'openoffice', label: 'Polices OpenOffice standard' },
  { id: 'serif', label: 'Polices avec empattement (Serif)' },
  { id: 'sans-serif', label: 'Polices sans empattement (Sans-Serif)' },
  { id: 'monospace', label: 'Polices à chasse fixe (Monospace)' },
  { id: 'symbols', label: 'Polices décoratives et symboles' },
] as const;
