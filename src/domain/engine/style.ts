// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Résolution du style effectif. Transposition de `SwFmt` / `SwAttrSet`.
 *
 * Writer résout un attribut en remontant la chaîne des styles jusqu'au style
 * par défaut (`SwFmt::GetItemState` avec `bSrchInParent`). La chaîne est ici
 * courte et explicite : **run → paragraphe → défauts du document**.
 */

import { ptToPx } from '../document/units';
import type {
  DocumentDefaults,
  HeadingLevel,
  ParagraphNode,
  RunFormatting,
} from '../document/types';
import type { FontSpec } from './measure';

/**
 * Échelle des titres, en fraction du corps de base.
 *
 * Reprise des styles « Heading 1..6 » d'OpenOffice, qui sont définis en
 * pourcentage du style parent et non en points absolus : changer le corps du
 * document fait suivre les titres.
 */
const HEADING_SCALE: Readonly<Record<HeadingLevel, number>> = {
  1: 1.3,
  2: 1.15,
  3: 1.01,
  4: 0.95,
  5: 0.85,
  6: 0.75,
};

/** Les titres sont gras ; le niveau 4 est en plus italique, comme dans Writer. */
function headingEmphasis(level: HeadingLevel): { bold: boolean; italic: boolean } {
  return { bold: true, italic: level === 4 };
}

export interface StyleContext {
  defaults: DocumentDefaults;
}

/** Fonte effective d'un run, une fois la chaîne d'héritage résolue. */
export function resolveFont(
  formatting: RunFormatting,
  paragraph: Pick<ParagraphNode, 'type' | 'headingLevel'>,
  ctx: StyleContext,
): FontSpec {
  const level = paragraph.type === 'heading' ? paragraph.headingLevel ?? 1 : null;
  const scale = level ? HEADING_SCALE[level] : 1;
  const emphasis = level ? headingEmphasis(level) : { bold: false, italic: false };

  const basePt = formatting.fontSizePt ?? ctx.defaults.fontSizePt * scale;

  return {
    fontFamily: formatting.fontFamily ?? ctx.defaults.fontFamily,
    fontSizePx: ptToPx(basePt),
    bold: formatting.bold ?? emphasis.bold,
    italic: formatting.italic ?? emphasis.italic,
  };
}

/** Couleur effective d'un run. */
export function resolveColor(formatting: RunFormatting, ctx: StyleContext): string {
  return formatting.color ?? ctx.defaults.color;
}

/** Facteur d'interligne effectif (`SvxLineSpacingItem`). */
export function resolveLineSpacing(paragraph: ParagraphNode, ctx: StyleContext): number {
  return paragraph.lineSpacing ?? ctx.defaults.lineSpacing;
}

/**
 * Espacement vertical par défaut d'un titre, en points.
 *
 * Un titre collé au paragraphe précédent se lit mal ; Writer donne donc aux
 * styles de titre un `SvxULSpaceItem` non nul, que l'on reproduit ici quand le
 * nœud ne le fixe pas lui-même.
 */
export function resolveBlockSpacing(
  paragraph: ParagraphNode,
  ctx: StyleContext,
): { topPt: number; bottomPt: number } {
  const isHeading = paragraph.type === 'heading';
  const base = ctx.defaults.fontSizePt;
  return {
    topPt: paragraph.marginTopPt ?? (isHeading ? base * 0.85 : 0),
    bottomPt: paragraph.marginBottomPt ?? (isHeading ? base * 0.4 : base * 0.35),
  };
}
