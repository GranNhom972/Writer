/**
 * Découpage d'un paragraphe en lignes. Transposition de `SwTxtGuess::Guess`
 * (`sw/source/core/text/guess.cxx`) et de `SwTxtFormatter`.
 *
 * L'algorithme d'origine, dans l'ordre :
 *
 *  1. tout le reste tient dans la ligne → on la termine là ;
 *  2. sinon `nCutPos` = **premier caractère qui ne tient plus** ;
 *  3. si ce caractère est une espace : couper là, reculer sur les espaces
 *     finales (elles débordent sans compter), puis avancer sur les espaces
 *     suivantes — la ligne suivante ne commence jamais par une espace ;
 *  4. sinon, chercher la dernière **occasion de coupure** avant `nCutPos` ;
 *  5. aucune trouvée → coupure forcée dans le mot (« break cut »).
 *
 * Ce qui n'est pas repris : césure par dictionnaire (`XHyphenator`),
 * ponctuation suspendue et compression des kanas. Le point 5 les remplace, et
 * la structure reste prête à les accueillir.
 */

import { cmToPx, ptToPx } from '../document/units';
import { runFormatting, runsText } from '../document/runs';
import { effectiveIndentLeftPt, LIST_INDENT_PT, type ListMarker } from '../document/lists';
import type {
  Alignment,
  DocumentDefaults,
  ListKind,
  ParagraphNode,
  RunFormatting,
} from '../document/types';
import { resolveBlockSpacing, resolveColor, resolveFont, resolveLineSpacing } from './style';
import type { FontMetrics, FontSpec, TextMeasurer } from './measure';
import { measureMathExact } from '../math/render';
import { isImageFormatting } from '../document/images';
import { nextClearY, usableBand, type FlyExclusion } from './flyLayout';

/** Taquet de tabulation par défaut de Writer : 1,25 cm. */
export const DEFAULT_TAB_STOP_PX = cmToPx(1.25);

/** Espace sécable au sens du retour à la ligne (`CH_BLANK`, `CH_FULL_BLANK`). */
export function isBlank(char: string): boolean {
  // L'espace insécable en est volontairement exclue : c'est sa raison d'être.
  return char === ' ' || char === '　';
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** Ponctuation qui ne peut pas commencer une ligne (règle du kinsoku). */
const NO_LINE_START = '、。，．！？」』）»)]}!?,.;:';

/** Un morceau de ligne prêt à peindre : même fonte, même formatage. */
export interface LayoutSegment {
  startOffset: number;
  endOffset: number;
  text: string;
  formatting: RunFormatting;
  font: FontSpec;
  color: string;
  /** Abscisse du bord gauche, relative au bord gauche de la zone de contenu. */
  leftPx: number;
  widthPx: number;
  /** Vrai pour le segment engendré par une tabulation (largeur calculée). */
  isTab: boolean;
}

export interface LayoutLine {
  index: number;
  /** Premier offset de la ligne, dans la chaîne brute du paragraphe. */
  startOffset: number;
  /** Fin du contenu **peint** : les espaces finales en sont exclues. */
  endOffset: number;
  /** Offset où commence la ligne suivante (espaces avalées comprises). */
  nextOffset: number;
  segments: LayoutSegment[];
  leftPx: number;
  widthPx: number;
  heightPx: number;
  ascentPx: number;
  /** Ordonnée du haut de la ligne, relative au haut du contenu du paragraphe. */
  topPx: number;
  /** Espacement de mot ajouté par la justification, en pixels. */
  wordSpacingPx: number;
  isLast: boolean;
}

/** Puce ou numéro peint devant la première ligne d'un élément de liste. */
export interface LayoutMarker {
  kind: ListKind;
  text: string;
  checked: boolean;
  /** Abscisse du bord gauche, relative au bord gauche de la zone de contenu. */
  leftPx: number;
  widthPx: number;
  font: FontSpec;
  color: string;
}

export interface ParagraphLayout {
  blockId: string;
  lines: LayoutLine[];
  /** Absent hors liste. */
  marker: LayoutMarker | null;
  marginTopPx: number;
  marginBottomPx: number;
  /** Hauteur du seul contenu, marges exclues. */
  contentHeightPx: number;
  /** Hauteur totale occupée dans le flux. */
  heightPx: number;
  alignment: Alignment;
}

export interface LayoutContext {
  measurer: TextMeasurer;
  defaults: DocumentDefaults;
  /** Largeur de la zone imprimable de la page. */
  contentWidthPx: number;
  tabStopPx?: number;
  /** Marqueur de liste, calculé en amont par `computeListMarkers`. */
  marker?: ListMarker | undefined;
  /**
   * Intervalles horizontaux interdits par les cadres flottants qui traversent
   * ce paragraphe, dans son repère local (`SwTxtFly`, txtfly.cxx).
   *
   * Absent dans le cas courant — un document sans cadre flottant ne paie donc
   * rien pour cette fonctionnalité, la boucle de remplissage retombant sur la
   * largeur pleine sans un test de plus par caractère.
   */
  exclusions?: readonly FlyExclusion[] | undefined;
}

/** Mesures pré-calculées d'un paragraphe : avances par offset et fontes par run. */
interface ParagraphMetrics {
  text: string;
  /** Index du run auquel appartient chaque offset. */
  runAt: Int32Array;
  /**
   * Avances cumulées, **hors tabulations** : l'avance d'une tabulation dépend
   * de la position courante, elle ne peut pas figurer dans un cumul. Le
   * remplisseur de ligne ne mesure donc jamais à travers une tabulation.
   */
  cum: Float64Array;
  fonts: FontSpec[];
  colors: string[];
  formats: RunFormatting[];
  metrics: FontMetrics[];
}

/**
 * Estime la largeur horizontale réelle d'une formule LaTeX en tenant compte
 * de l'empilement vertical des fractions, des matrices et des radicaux.
 */
export function estimateLatexWidth(latex: string, em: number): number {
  if (!latex || !latex.trim()) return em * 1.2;

  let str = latex.trim();

  // Traiter les matrices / environnements
  const matrixMatch = str.match(/\\begin\{(matrix|pmatrix|bmatrix|vmatrix|cases)\}([\s\S]*?)\\end\{\1\}/);
  if (matrixMatch && matrixMatch[2]) {
    const rows = matrixMatch[2].split('\\\\');
    let maxCols = 0;
    const colWidths: number[] = [];
    for (const row of rows) {
      const cells = row.split('&');
      maxCols = Math.max(maxCols, cells.length);
      cells.forEach((cell, idx) => {
        const cellW = estimateLatexWidth(cell.trim(), em);
        colWidths[idx] = Math.max(colWidths[idx] ?? 0, cellW);
      });
    }
    const tableWidth = colWidths.reduce((sum, w) => sum + w, 0) + Math.max(0, maxCols - 1) * (em * 0.7) + em * 0.8;
    const before = str.slice(0, matrixMatch.index);
    const after = str.slice((matrixMatch.index ?? 0) + matrixMatch[0].length);
    return estimateLatexWidth(before, em) + tableWidth + estimateLatexWidth(after, em);
  }

  // Traiter les fractions \frac{num}{den}, \dfrac, \tfrac (empilement vertical)
  const fracRegex = /\\(frac|dfrac|tfrac)\s*\{((?:[^{}]|{[^{}]*})*)\}\s*\{((?:[^{}]|{[^{}]*})*)\}/;
  let fracMatch = str.match(fracRegex);
  while (fracMatch) {
    const num = fracMatch[2] ?? '';
    const den = fracMatch[3] ?? '';
    const numW = estimateLatexWidth(num, em * 0.85);
    const denW = estimateLatexWidth(den, em * 0.85);
    const fracW = Math.max(numW, denW) + em * 0.25;

    const idx = fracMatch.index ?? 0;
    str = str.slice(0, idx) + `__FRAC_${Math.round(fracW)}__` + str.slice(idx + fracMatch[0].length);
    fracMatch = str.match(fracRegex);
  }

  // Traiter les racines carrées \sqrt{content} ou \sqrt[n]{content}
  const sqrtRegex = /\\sqrt(?:\[[^\]]*\])?\s*\{((?:[^{}]|{[^{}]*})*)\}/;
  let sqrtMatch = str.match(sqrtRegex);
  while (sqrtMatch) {
    const inner = sqrtMatch[1] ?? '';
    const innerW = estimateLatexWidth(inner, em);
    const sqrtW = innerW + em * 0.75;

    const idx = sqrtMatch.index ?? 0;
    str = str.slice(0, idx) + `__SQRT_${Math.round(sqrtW)}__` + str.slice(idx + sqrtMatch[0].length);
    sqrtMatch = str.match(sqrtRegex);
  }

  // Calculer la largeur restante
  let totalWidth = 0;
  const placeholderRegex = /__(FRAC|SQRT)_(\d+)__/g;
  let lastIdx = 0;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = placeholderRegex.exec(str)) !== null) {
    const beforeText = str.slice(lastIdx, pMatch.index);
    totalWidth += estimateSimpleMathTextWidth(beforeText, em);
    totalWidth += Number(pMatch[2]);
    lastIdx = pMatch.index + pMatch[0].length;
  }
  const tailText = str.slice(lastIdx);
  totalWidth += estimateSimpleMathTextWidth(tailText, em);

  return Math.max(em * 1.0, totalWidth);
}

function estimateSimpleMathTextWidth(text: string, em: number): number {
  if (!text) return 0;

  let width = 0;
  let s = text
    .replace(/\\(left|right|displaystyle|textstyle|mathbf|mathit|mathrm|mathbb|mathcal)\b/g, '')
    .replace(/[{}\\]/g, ' ');

  // Remplacer les commandes de symboles usuels (\alpha, \pm, \int, \sum, etc.) par 1 glyphe
  s = s.replace(/\\[a-zA-Z]+/g, 'X');

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') {
      width += em * 0.25;
    } else if (c === '=' || c === '+' || c === '-' || c === '<' || c === '>') {
      width += em * 0.65;
    } else if (c === '^' || c === '_') {
      width += em * 0.1;
    } else if (/[0-9]/.test(c)) {
      width += em * 0.5;
    } else {
      width += em * 0.55;
    }
  }

  return width;
}

/**
 * Estime la géométrie (hauteur, ligne de base et largeur) d'une formule mathématique.
 * Permet au moteur de réserver l'espace vertical adéquat pour les fractions, racines,
 * matrices et intégrales sans risquer de chevauchement sur les lignes voisines.
 */
export function estimateMathMetrics(
  latex: string,
  display: boolean,
  font: FontSpec,
): { widthPx: number; heightPx: number; ascentPx: number } {
  if (typeof document !== 'undefined') {
    const exact = measureMathExact(latex, display, font);
    if (exact.widthPx > 0) return exact;
  }

  // Facteur d'échelle de police KaTeX : ~1.22 en ligne et ~1.38 en mode bloc centré
  const mathScale = display ? 1.38 : 1.22;
  const em = font.fontSizePx * mathScale;
  const isComplex = /\\(frac|sqrt|sum|prod|int|iint|iiint|cases|matrix|pmatrix|bmatrix|vmatrix|begin)/.test(latex);
  const isMatrix = /\\begin\{(matrix|pmatrix|bmatrix|vmatrix|cases)\}/.test(latex);

  let heightPx: number;
  let ascentPx: number;

  if (display) {
    if (isMatrix) {
      heightPx = Math.max(72, em * 3.8);
    } else if (isComplex) {
      heightPx = Math.max(52, em * 2.8);
    } else {
      heightPx = Math.max(42, em * 2.2);
    }
    ascentPx = heightPx * 0.65;
  } else {
    if (isMatrix) {
      heightPx = Math.max(em * 1.6, em * 3.0);
      ascentPx = heightPx * 0.65;
    } else if (isComplex) {
      heightPx = Math.max(em * 1.5, em * 2.1);
      ascentPx = em * 1.35;
    } else {
      heightPx = Math.max(em * 1.25, em * 1.4);
      ascentPx = em * 1.0;
    }
  }

  const widthPx = estimateLatexWidth(latex, em);

  return { widthPx, heightPx, ascentPx };
}

function measureParagraph(paragraph: ParagraphNode, ctx: LayoutContext): ParagraphMetrics {
  const text = runsText(paragraph.runs);
  const runAt = new Int32Array(text.length);
  const cum = new Float64Array(text.length + 1);
  const fonts: FontSpec[] = [];
  const colors: string[] = [];
  const formats: RunFormatting[] = [];
  const metrics: FontMetrics[] = [];

  let offset = 0;
  paragraph.runs.forEach((run, runIndex) => {
    const formatting = runFormatting(run);
    const font = resolveFont(formatting, paragraph, ctx);
    formats.push(formatting);
    fonts.push(font);
    colors.push(resolveColor(formatting, ctx));

    if (isImageFormatting(formatting)) {
      // Un cadre image n'a pas de ligne de base propre : `SwFlyCntFrm` est posé
      // sur celle du texte et monte d'autant (`SwTxtFrm::CalcBaseOfstForFly`).
      // Toute sa hauteur est donc de l'ascendance, la descente est nulle.
      const widthPx = ptToPx(formatting.imageWidthPt ?? 0);
      const heightPx = ptToPx(formatting.imageHeightPt ?? 0);
      metrics.push({
        ascentPx: heightPx,
        descentPx: 0,
        naturalLineHeightPx: heightPx,
      });

      // Le run vaut un seul caractère de substitution : toute sa largeur tombe
      // sur cette unique avance, ce qui interdit au curseur de s'y insérer.
      const charCount = Math.max(1, run.text.length);
      const step = widthPx / charCount;
      for (let i = 0; i < run.text.length; i += 1) {
        runAt[offset + i] = runIndex;
        cum[offset + i + 1] = cum[offset + i]! + step;
      }
    } else if (formatting.mathLatex) {
      const mathGeom = estimateMathMetrics(formatting.mathLatex, Boolean(formatting.mathDisplay), font);
      metrics.push({
        ascentPx: mathGeom.ascentPx,
        descentPx: mathGeom.heightPx - mathGeom.ascentPx,
        naturalLineHeightPx: mathGeom.heightPx,
      });

      const totalMathWidth = mathGeom.widthPx;
      const charCount = Math.max(1, run.text.length);
      const step = totalMathWidth / charCount;

      for (let i = 0; i < run.text.length; i += 1) {
        runAt[offset + i] = runIndex;
        cum[offset + i + 1] = cum[offset + i]! + step;
      }
    } else {
      metrics.push(ctx.measurer.metrics(font));
      const prefix = ctx.measurer.prefixWidths(run.text, font);
      for (let i = 0; i < run.text.length; i += 1) {
        runAt[offset + i] = runIndex;
        const advance = prefix[i + 1]! - prefix[i]!;
        const char = run.text[i]!;
        cum[offset + i + 1] = cum[offset + i]! + (char === '\t' || char === '\n' ? 0 : advance);
      }
    }
    offset += run.text.length;
  });

  return { text, runAt, cum, fonts, colors, formats, metrics };
}

/** Largeur de `[from, to)`, valide tant que l'intervalle ne franchit pas de tabulation. */
function width(m: ParagraphMetrics, from: number, to: number): number {
  return m.cum[to]! - m.cum[from]!;
}

/**
 * Plus grand `j` de `[from, limit]` tel que `[from, j)` tienne dans `available`.
 *
 * Recherche dichotomique sur les avances cumulées — c'est le rôle de
 * `SwTxtSizeInfo::GetTxtBreak`, que le périphérique de sortie résout en une
 * passe ; ici les cumuls sont déjà là, autant en profiter.
 */
function fittingEnd(
  m: ParagraphMetrics,
  from: number,
  limit: number,
  available: number,
): number {
  if (width(m, from, limit) <= available) return limit;
  let low = from;
  let high = limit;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(m, from, mid) <= available) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Dernière occasion de coupure dans `(lineStart, cutPos]`, ou `-1`.
 *
 * Remplace `XBreakIterator::getLineBreak`. Les occasions retenues : après une
 * espace, après un tiret ou une barre oblique, et entre idéogrammes — sauf
 * devant une ponctuation qui ne peut pas ouvrir une ligne.
 */
function findBreakOpportunity(m: ParagraphMetrics, lineStart: number, cutPos: number): number {
  const { text } = m;
  for (let p = cutPos; p > lineStart; p -= 1) {
    // Ne jamais couper à l'intérieur d'un objet mathématique atomique
    const runIdxBefore = m.runAt[p - 1];
    const runIdxAfter = m.runAt[p];
    if (
      runIdxBefore !== undefined &&
      runIdxAfter !== undefined &&
      runIdxBefore === runIdxAfter &&
      (m.formats[runIdxBefore]?.mathLatex || isImageFormatting(m.formats[runIdxBefore]!))
    ) {
      continue;
    }

    const before = text[p - 1]!;
    if (isBlank(before)) return p;

    const after = text[p];
    if (after === undefined) continue;
    if (NO_LINE_START.includes(after)) continue;

    if (before === '-' || before === '/' || before === '–' || before === '—') {
      // Ne pas couper « 12 - 3 » juste après le tiret d'une plage numérique
      // isolée : la coupure y est correcte, mais pas au milieu d'un nombre
      // négatif collé au signe.
      return p;
    }
    if (isCjk(before.codePointAt(0) ?? 0) || isCjk(after.codePointAt(0) ?? 0)) return p;
  }
  return -1;
}

/** Prochain taquet de tabulation strictement à droite de `x`. */
function nextTabStop(x: number, tabStopPx: number): number {
  return (Math.floor(x / tabStopPx) + 1) * tabStopPx;
}

/** Avance d'au moins une grappe de graphèmes, pour garantir la progression. */
function advanceOneGrapheme(text: string, from: number): number {
  const code = text.codePointAt(from);
  if (code === undefined) return from + 1;
  return from + (code > 0xffff ? 2 : 1);
}

interface LineBreakResult {
  /** Fin du contenu peint, espaces finales retirées. */
  endOffset: number;
  /** Début de la ligne suivante. */
  nextOffset: number;
}

/**
 * Détermine où couper la ligne commencée à `lineStart`.
 *
 * `startX` permet de reprendre après une tabulation : la largeur disponible
 * n'est plus la ligne entière mais ce qu'il en reste.
 */
function breakLine(
  m: ParagraphMetrics,
  lineStart: number,
  available: number,
  tabStopPx: number,
): LineBreakResult {
  const { text } = m;
  const total = text.length;
  let pos = lineStart;
  let x = 0;

  for (;;) {
    // Le morceau courant s'arrête à la prochaine tabulation, au prochain saut
    // de ligne, ou à la fin du paragraphe.
    let stop = total;
    for (let i = pos; i < total; i += 1) {
      const char = text[i]!;
      if (char === '\t' || char === '\n') {
        stop = i;
        break;
      }
    }

    const chunkWidth = width(m, pos, stop);

    if (x + chunkWidth > available) {
      return breakInsideChunk(m, lineStart, pos, stop, available - x);
    }

    x += chunkWidth;
    pos = stop;

    if (pos >= total) return { endOffset: total, nextOffset: total };

    const char = text[pos]!;
    if (char === '\n') {
      // Saut de ligne exprès (`SwBreakPortion`) : la ligne s'arrête avant, et
      // le caractère lui-même n'est pas peint.
      return { endOffset: pos, nextOffset: pos + 1 };
    }

    // Tabulation : avancer au taquet suivant. Si le taquet sort de la ligne,
    // la tabulation elle-même provoque le passage à la ligne.
    const tabX = nextTabStop(x, tabStopPx);
    if (tabX > available) {
      return pos > lineStart
        ? { endOffset: pos, nextOffset: pos + 1 }
        : { endOffset: pos + 1, nextOffset: pos + 1 };
    }
    x = tabX;
    pos += 1;
  }
}

/** Points 2 à 5 de `SwTxtGuess::Guess`, appliqués à un morceau sans tabulation. */
function breakInsideChunk(
  m: ParagraphMetrics,
  lineStart: number,
  chunkStart: number,
  chunkEnd: number,
  available: number,
): LineBreakResult {
  const { text } = m;
  let cutPos = fittingEnd(m, chunkStart, chunkEnd, Math.max(0, available));

  // Colonne si étroite qu'aucun caractère ne tient : avancer d'une grappe
  // malgré tout. Sans cette garde, la ligne serait vide et la boucle
  // appelante ne progresserait jamais.
  if (cutPos <= lineStart) cutPos = advanceOneGrapheme(text, lineStart);
  if (cutPos >= chunkEnd) return { endOffset: chunkEnd, nextOffset: chunkEnd };

  // Si cutPos tombe au milieu d'un objet atomique — formule ou cadre image —
  // couper **avant** l'objet plutôt qu'en son sein.
  const cutRunIdx = m.runAt[cutPos];
  if (
    cutRunIdx !== undefined &&
    (m.formats[cutRunIdx]?.mathLatex || isImageFormatting(m.formats[cutRunIdx]!))
  ) {
    let mathStart = cutPos;
    while (mathStart > 0 && m.runAt[mathStart - 1] === cutRunIdx) mathStart -= 1;
    if (mathStart > lineStart) {
      let endOffset = mathStart;
      while (endOffset > lineStart && isBlank(text[endOffset - 1]!)) endOffset -= 1;
      return { endOffset, nextOffset: mathStart };
    }
  }

  const cutChar = text[cutPos]!;

  if (isBlank(cutChar)) {
    // Espace à la coupure : reculer sur les espaces finales, qui débordent dans
    // la marge sans compter dans la largeur…
    let endOffset = cutPos;
    while (endOffset > lineStart && isBlank(text[endOffset - 1]!)) endOffset -= 1;
    // …puis avaler celles qui suivent, pour que la ligne suivante commence sur
    // un caractère visible.
    let nextOffset = cutPos;
    while (nextOffset < text.length && isBlank(text[nextOffset]!)) nextOffset += 1;
    return { endOffset, nextOffset };
  }

  const breakPos = findBreakOpportunity(m, lineStart, cutPos);
  if (breakPos > lineStart) {
    let endOffset = breakPos;
    while (endOffset > lineStart && isBlank(text[endOffset - 1]!)) endOffset -= 1;
    return { endOffset, nextOffset: breakPos };
  }

  // Aucune occasion de coupure : mot plus long que la ligne, coupure forcée.
  const forced = Math.max(cutPos, advanceOneGrapheme(text, lineStart));
  return { endOffset: forced, nextOffset: forced };
}

/** Construit les segments peints d'une ligne, tabulations résolues. */
function buildSegments(
  m: ParagraphMetrics,
  startOffset: number,
  endOffset: number,
  originX: number,
  tabStopPx: number,
): { segments: LayoutSegment[]; widthPx: number } {
  const segments: LayoutSegment[] = [];
  let x = 0;
  let pos = startOffset;

  while (pos < endOffset) {
    const char = m.text[pos]!;

    if (char === '\t') {
      const target = nextTabStop(x, tabStopPx);
      const runIndex = m.runAt[pos]!;
      segments.push({
        startOffset: pos,
        endOffset: pos + 1,
        text: '\t',
        formatting: m.formats[runIndex] ?? {},
        font: m.fonts[runIndex]!,
        color: m.colors[runIndex]!,
        leftPx: originX + x,
        widthPx: target - x,
        isTab: true,
      });
      x = target;
      pos += 1;
      continue;
    }

    // Un segment court jusqu'au changement de run, jusqu'à la prochaine
    // tabulation, ou jusqu'à la fin de la ligne — le premier des trois.
    const runIndex = m.runAt[pos]!;
    let stop = pos + 1;
    while (stop < endOffset && m.runAt[stop] === runIndex && m.text[stop] !== '\t') stop += 1;

    const segmentWidth = width(m, pos, stop);
    segments.push({
      startOffset: pos,
      endOffset: stop,
      text: m.text.slice(pos, stop),
      formatting: m.formats[runIndex] ?? {},
      font: m.fonts[runIndex]!,
      color: m.colors[runIndex]!,
      leftPx: originX + x,
      widthPx: segmentWidth,
      isTab: false,
    });
    x += segmentWidth;
    pos = stop;
  }

  if (segments.length === 0) {
    // Ligne vide : un segment de largeur nulle porte tout de même la fonte, ce
    // qui donne au curseur sa hauteur et à la frappe suivante son formatage.
    // Un paragraphe vide conserve toujours un run (cf. `normalizeRuns`), donc
    // `fonts[0]` existe : il n'y a pas de cas sans fonte à couvrir.
    const runIndex = Math.max(0, Math.min(m.fonts.length - 1, m.runAt[startOffset] ?? 0));
    segments.push({
      startOffset,
      endOffset: startOffset,
      text: '',
      formatting: m.formats[runIndex] ?? {},
      font: m.fonts[runIndex]!,
      color: m.colors[runIndex] ?? '#000000',
      leftPx: originX,
      widthPx: 0,
      isTab: false,
    });
  }

  return { segments, widthPx: x };
}

/** Hauteur et ligne de base d'une ligne : le plus grand des runs qui la composent. */
function lineHeightOf(
  m: ParagraphMetrics,
  startOffset: number,
  endOffset: number,
  spacing: number,
): { heightPx: number; ascentPx: number } {
  const first = m.runAt[startOffset] ?? 0;
  let ascent = m.metrics[first]?.ascentPx ?? 0;
  let natural = m.metrics[first]?.naturalLineHeightPx ?? 0;

  for (let i = startOffset; i < endOffset; i += 1) {
    const metrics = m.metrics[m.runAt[i]!];
    if (!metrics) continue;
    if (metrics.ascentPx > ascent) ascent = metrics.ascentPx;
    if (metrics.naturalLineHeightPx > natural) natural = metrics.naturalLineHeightPx;
  }

  const heightPx = natural * spacing;
  // L'interligne supplémentaire se place **au-dessus** du texte, comme le
  // « leading » d'une fonte : la ligne de base descend d'autant.
  return { heightPx, ascentPx: ascent + (heightPx - natural) / 2 };
}

/** Aucun cadre : constante partagée pour éviter une allocation par paragraphe. */
const EMPTY_EXCLUSIONS: readonly FlyExclusion[] = [];

/**
 * Nombre maximal de descentes successives sous des cadres bloquants.
 *
 * Garde-fou, pas une limite fonctionnelle : `nextClearY` progresse strictement,
 * donc la boucle termine toujours. Elle borne le coût d'un document pathologique
 * empilant des dizaines de cadres `surround: none` au même endroit.
 */
const MAX_FLY_DESCENTS = 64;

/** Bande utile pour une ligne, ou la colonne entière en l'absence de cadre. */
function resolveBand(
  exclusions: readonly FlyExclusion[],
  hasExclusions: boolean,
  topPx: number,
  heightPx: number,
  contentWidthPx: number,
): { leftPx: number; rightPx: number } | null {
  if (!hasExclusions) return { leftPx: 0, rightPx: contentWidthPx };
  return usableBand(exclusions, topPx, topPx + Math.max(1, heightPx), contentWidthPx);
}

/** Abscisse du bord gauche de la ligne, alignement appliqué. */
function alignLine(
  alignment: Alignment,
  lineWidth: number,
  available: number,
  indentLeftPx: number,
  firstLineIndentPx: number,
): number {
  const base = indentLeftPx + firstLineIndentPx;
  switch (alignment) {
    case 'center':
      return base + Math.max(0, available - lineWidth) / 2;
    case 'right':
      return base + Math.max(0, available - lineWidth);
    case 'left':
    case 'justify':
    default:
      return base;
  }
}

/**
 * Met en page un paragraphe : découpage en lignes, hauteurs, alignement.
 *
 * Fonction pure — c'est elle qui rend le moteur exécutable dans un Web Worker,
 * comme l'exige la couche 2 du cahier des charges.
 */
export function layoutParagraph(
  paragraph: ParagraphNode,
  ctx: LayoutContext,
): ParagraphLayout {
  const tabStopPx = ctx.tabStopPx ?? DEFAULT_TAB_STOP_PX;
  const metrics = measureParagraph(paragraph, ctx);

  const spacing = resolveLineSpacing(paragraph, ctx);
  const { topPt, bottomPt } = resolveBlockSpacing(paragraph, ctx);
  const alignment: Alignment = paragraph.alignment ?? 'left';

  const indentLeftPx = ptToPx(effectiveIndentLeftPt(paragraph));
  const indentRightPx = ptToPx(paragraph.indentRightPt ?? 0);
  const firstLineIndentPx = ptToPx(paragraph.firstLineIndentPt ?? 0);

  const lines: LayoutLine[] = [];
  const total = metrics.text.length;
  let offset = 0;
  let top = 0;
  let index = 0;

  // Cadres flottants traversant ce paragraphe. Le cas courant — aucun — court-
  // circuite tout le calcul de bande ci-dessous.
  const exclusions = ctx.exclusions ?? EMPTY_EXCLUSIONS;
  const hasExclusions = exclusions.length > 0;

  do {
    const isFirst = index === 0;
    const extraIndent = isFirst ? firstLineIndentPx : 0;

    // Hauteur *probable* de la ligne, avant de savoir ce qu'elle contiendra :
    // la bande utile dépend de l'extension verticale de la ligne, qui dépend de
    // son contenu, qui dépend de la bande. Writer tranche la circularité de la
    // même façon (`SwTxtFrm::FormatLine`) — on estime, on découpe, et on ne
    // recommence qu'une fois si l'estimation s'est révélée trop basse.
    let probeHeight = lineHeightOf(metrics, offset, Math.min(total, offset + 1), spacing).heightPx;
    let band = resolveBand(exclusions, hasExclusions, top, probeHeight, ctx.contentWidthPx);

    // Aucune bande exploitable : la ligne descend sous le cadre qui la bloque.
    let guard = 0;
    while (band === null && guard < MAX_FLY_DESCENTS) {
      const clear = nextClearY(exclusions, top, top + probeHeight);
      if (clear === null || clear <= top) break;
      top = clear;
      band = resolveBand(exclusions, hasExclusions, top, probeHeight, ctx.contentWidthPx);
      guard += 1;
    }

    let bandLeftPx = band ? band.leftPx : 0;
    let bandRightPx = band ? band.rightPx : ctx.contentWidthPx;

    let lineLeftPx = Math.max(indentLeftPx, bandLeftPx);
    let lineRightPx = Math.min(ctx.contentWidthPx - indentRightPx, bandRightPx);
    let available = Math.max(1, lineRightPx - lineLeftPx - extraIndent);

    let broken = breakLine(metrics, offset, available, tabStopPx);
    let measured = lineHeightOf(
      metrics,
      offset,
      Math.max(offset + 1, broken.endOffset),
      spacing,
    );

    // La ligne s'est révélée plus haute que l'estimation — une image en ligne,
    // une formule — et croise donc peut-être un cadre que la bande ignorait.
    // Une seule reprise suffit : la seconde estimation, elle, est exacte.
    if (hasExclusions && measured.heightPx > probeHeight) {
      probeHeight = measured.heightPx;
      const retry = resolveBand(exclusions, hasExclusions, top, probeHeight, ctx.contentWidthPx);
      if (retry && (retry.leftPx !== bandLeftPx || retry.rightPx !== bandRightPx)) {
        bandLeftPx = retry.leftPx;
        bandRightPx = retry.rightPx;
        lineLeftPx = Math.max(indentLeftPx, bandLeftPx);
        lineRightPx = Math.min(ctx.contentWidthPx - indentRightPx, bandRightPx);
        available = Math.max(1, lineRightPx - lineLeftPx - extraIndent);
        broken = breakLine(metrics, offset, available, tabStopPx);
        measured = lineHeightOf(
          metrics,
          offset,
          Math.max(offset + 1, broken.endOffset),
          spacing,
        );
      }
    }

    const { endOffset, nextOffset } = broken;
    const isLast = nextOffset >= total;

    const { segments, widthPx } = buildSegments(metrics, offset, endOffset, 0, tabStopPx);
    const { heightPx, ascentPx } = measured;
    const leftPx = alignLine(alignment, widthPx, available, lineLeftPx, extraIndent);

    // Justification : l'espace en trop se répartit sur les blancs de la ligne.
    // La dernière ligne d'un paragraphe en est exclue, sinon un mot esseulé se
    // retrouverait étiré sur toute la largeur.
    let wordSpacingPx = 0;
    if (alignment === 'justify' && !isLast) {
      const gaps = countBlanks(metrics.text, offset, endOffset);
      if (gaps > 0) wordSpacingPx = Math.max(0, (available - widthPx) / gaps);
    }

    for (const segment of segments) segment.leftPx += leftPx;

    lines.push({
      index,
      startOffset: offset,
      endOffset,
      nextOffset,
      segments,
      leftPx,
      widthPx,
      heightPx,
      ascentPx,
      topPx: top,
      wordSpacingPx,
      isLast,
    });

    top += heightPx;
    index += 1;
    // `nextOffset` progresse toujours, sauf en fin de paragraphe : la garde
    // évite la boucle infinie que provoquerait un découpage sans avancée.
    if (nextOffset <= offset && nextOffset < total) break;
    offset = nextOffset;
  } while (offset < total);

  const marginTopPx = ptToPx(topPt);
  const marginBottomPx = ptToPx(bottomPt);

  return {
    blockId: paragraph.id,
    lines,
    marker: buildMarker(paragraph, ctx, indentLeftPx),
    marginTopPx,
    marginBottomPx,
    contentHeightPx: top,
    heightPx: top + marginTopPx + marginBottomPx,
    alignment,
  };
}

/**
 * Géométrie du marqueur de liste.
 *
 * Il est posé **en dehors** du texte, un cran à gauche : c'est la disposition
 * par défaut de Writer, où le numéro occupe le retrait du niveau précédent et
 * le texte commence à celui de son propre niveau. Le marqueur ne participe donc
 * pas au retour à la ligne — il n'entre jamais en concurrence avec le texte.
 */
function buildMarker(
  paragraph: ParagraphNode,
  ctx: LayoutContext,
  indentLeftPx: number,
): LayoutMarker | null {
  const marker = ctx.marker;
  if (!marker) return null;

  const first = paragraph.runs[0];
  const formatting = first ? runFormatting(first) : {};
  // Le marqueur suit la fonte du texte mais jamais son gras ni son italique :
  // une puce en italique n'a aucun sens, et Writer ne les propage pas non plus.
  const font = { ...resolveFont(formatting, paragraph, ctx), bold: false, italic: false };

  return {
    kind: marker.kind,
    text: marker.text,
    checked: marker.checked,
    leftPx: Math.max(0, indentLeftPx - ptToPx(LIST_INDENT_PT)),
    widthPx: ptToPx(LIST_INDENT_PT),
    font,
    color: resolveColor(formatting, ctx),
  };
}

function countBlanks(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) if (isBlank(text[i]!)) count += 1;
  return count;
}
