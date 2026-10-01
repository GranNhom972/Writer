// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * Resolving the effective style. (OpenOffice: `SwFmt` / `SwAttrSet`.)
 *
 * Writer resolves an attribute by climbing the chain of styles up to the default style
 * (`SwFmt::GetItemState` with `bSrchInParent`). The chain here is short and explicit:
 * **run → paragraph → document defaults**.
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
 * Scale of the headings, as a fraction of the base font size.
 *
 * Taken from OpenOffice's "Heading 1..6" styles, which are defined as a percentage of the
 * parent style and not in absolute points: changing the document's font size makes the
 * headings follow.
 */
const HEADING_SCALE: Readonly<Record<HeadingLevel, number>> = {
  1: 1.3,
  2: 1.15,
  3: 1.01,
  4: 0.95,
  5: 0.85,
  6: 0.75,
};

/** Headings are bold; level 4 is also italic, as in Writer. */
function headingEmphasis(level: HeadingLevel): { bold: boolean; italic: boolean } {
  return { bold: true, italic: level === 4 };
}

export interface StyleContext {
  defaults: DocumentDefaults;
}

/** Effective font of a run, once the inheritance chain is resolved. */
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

/** Effective color of a run. */
export function resolveColor(formatting: RunFormatting, ctx: StyleContext): string {
  return formatting.color ?? ctx.defaults.color;
}

/** Effective line spacing factor (`SvxLineSpacingItem`). */
export function resolveLineSpacing(paragraph: ParagraphNode, ctx: StyleContext): number {
  return paragraph.lineSpacing ?? ctx.defaults.lineSpacing;
}

/**
 * Default vertical spacing of a heading, in points.
 *
 * A heading stuck to the previous paragraph is hard to read; Writer therefore gives heading
 * styles a non-zero `SvxULSpaceItem`, which we reproduce here when the node does not set one
 * itself.
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
