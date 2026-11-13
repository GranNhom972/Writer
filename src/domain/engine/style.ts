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
  Alignment,
  CustomHeadingStyle,
  DocumentDefaults,
  HeadingLevel,
  HeadingStyle,
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
export const HEADING_SCALE: Readonly<Record<HeadingLevel, number>> = {
  1: 1.3,
  2: 1.15,
  3: 1.01,
  4: 0.95,
  5: 0.85,
  6: 0.75,
};

export const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

/** Every field of a heading style, once the inheritance chain is resolved. */
export type ResolvedHeadingStyle = Required<HeadingStyle>;

/**
 * Built-in look of a heading level, before any change by the user.
 *
 * Headings are bold; level 4 is also italic, as in Writer. A heading stuck to the previous
 * paragraph is hard to read; Writer therefore gives heading styles a non-zero `SvxULSpaceItem`,
 * which we reproduce here.
 */
export function builtinHeadingStyle(level: HeadingLevel, defaults: DocumentDefaults): ResolvedHeadingStyle {
  const base = defaults.fontSizePt;
  return {
    fontFamily: defaults.fontFamily,
    fontSizePt: Math.round(base * HEADING_SCALE[level] * 10) / 10,
    bold: true,
    italic: level === 4,
    color: defaults.color,
    alignment: 'left',
    spaceBeforePt: Math.round(base * 0.85 * 10) / 10,
    spaceAfterPt: Math.round(base * 0.4 * 10) / 10,
  };
}

/** Copies the fields that are actually set, so that `undefined` never hides an inherited value. */
function overlay(base: ResolvedHeadingStyle, patch: HeadingStyle | undefined): ResolvedHeadingStyle {
  if (!patch) return base;
  const out = { ...base };
  (Object.keys(patch) as (keyof HeadingStyle)[]).forEach((key) => {
    const value = patch[key];
    if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value;
  });
  return out;
}

/** Style of a built-in level: built-in values, then the user's changes to "Titre N". */
export function resolveLevelStyle(level: HeadingLevel, defaults: DocumentDefaults): ResolvedHeadingStyle {
  return overlay(builtinHeadingStyle(level, defaults), defaults.headingStyles?.[level]);
}

/** Custom heading style referenced by a paragraph, if it still exists. */
export function findCustomHeadingStyle(
  defaults: DocumentDefaults,
  styleName: string | undefined,
): CustomHeadingStyle | undefined {
  if (!styleName) return undefined;
  return defaults.customHeadingStyles?.find((style) => style.id === styleName);
}

/**
 * Style of a custom heading: it climbs to the style of its outline level, the way a Writer
 * paragraph style inherits from its parent (`SwFmt::GetItemState` with `bSrchInParent`).
 */
export function resolveCustomStyle(style: CustomHeadingStyle, defaults: DocumentDefaults): ResolvedHeadingStyle {
  const { id: _id, name: _name, level, ...look } = style;
  return overlay(resolveLevelStyle(level, defaults), look);
}

/**
 * Heading style of a paragraph, or `null` for body text.
 *
 * Chain: custom style (`styleName`) → "Titre N" as changed by the user → built-in values.
 */
export function resolveHeadingStyle(
  paragraph: Pick<ParagraphNode, 'type' | 'headingLevel' | 'styleName'>,
  defaults: DocumentDefaults,
): ResolvedHeadingStyle | null {
  if (paragraph.type !== 'heading') return null;
  const custom = findCustomHeadingStyle(defaults, paragraph.styleName);
  if (custom) return resolveCustomStyle(custom, defaults);
  return resolveLevelStyle(paragraph.headingLevel ?? 1, defaults);
}

export interface StyleContext {
  defaults: DocumentDefaults;
}

type StyledParagraph = Pick<ParagraphNode, 'type' | 'headingLevel' | 'styleName'>;

/** Effective font of a run, once the inheritance chain is resolved. */
export function resolveFont(
  formatting: RunFormatting,
  paragraph: StyledParagraph,
  ctx: StyleContext,
): FontSpec {
  const heading = resolveHeadingStyle(paragraph, ctx.defaults);
  const basePt = formatting.fontSizePt ?? heading?.fontSizePt ?? ctx.defaults.fontSizePt;

  return {
    fontFamily: formatting.fontFamily ?? heading?.fontFamily ?? ctx.defaults.fontFamily,
    fontSizePx: ptToPx(basePt),
    bold: formatting.bold ?? heading?.bold ?? false,
    italic: formatting.italic ?? heading?.italic ?? false,
  };
}

/** Effective color of a run. */
export function resolveColor(
  formatting: RunFormatting,
  ctx: StyleContext,
  paragraph?: StyledParagraph,
): string {
  if (formatting.color) return formatting.color;
  const heading = paragraph ? resolveHeadingStyle(paragraph, ctx.defaults) : null;
  return heading?.color ?? ctx.defaults.color;
}

/** Effective alignment: the paragraph's own, otherwise its heading style's. */
export function resolveAlignment(paragraph: ParagraphNode, ctx: StyleContext): Alignment {
  return paragraph.alignment ?? resolveHeadingStyle(paragraph, ctx.defaults)?.alignment ?? 'left';
}

/** Effective line spacing factor (`SvxLineSpacingItem`). */
export function resolveLineSpacing(paragraph: ParagraphNode, ctx: StyleContext): number {
  return paragraph.lineSpacing ?? ctx.defaults.lineSpacing;
}

/**
 * Vertical spacing of a paragraph, in points: the node's own value, otherwise its heading
 * style's, otherwise the body text default.
 */
export function resolveBlockSpacing(
  paragraph: ParagraphNode,
  ctx: StyleContext,
): { topPt: number; bottomPt: number } {
  const heading = resolveHeadingStyle(paragraph, ctx.defaults);
  const base = ctx.defaults.fontSizePt;
  return {
    topPt: paragraph.marginTopPt ?? heading?.spaceBeforePt ?? 0,
    bottomPt: paragraph.marginBottomPt ?? heading?.spaceAfterPt ?? base * 0.35,
  };
}
