// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Floating frames and wrapping: `SwFlyFreeFrm` (`sw/source/core/layout/fly.cxx`) and the usable-band computation of `SwTxtFly` (`sw/source/core/text/txtfly.cxx`).
 *
 * The question everything comes down to: *for a line going from `top` to `bottom`, what horizontal interval is still available?* These tests attack it first on its own, then through the line formatter and pagination.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { pageGeometry } from '../src/domain/document/pageSetup';
import { makeRun } from '../src/domain/document/runs';
import {
  collectFlyFrames,
  exclusionOf,
  isFloatingFly,
  nextClearY,
  paragraphExclusions,
  resolveFlyLeft,
  resolveIdealSurround,
  usableBand,
  DEFAULT_WRAP_MARGIN_PT,
  IDEAL_TEXT_MIN_PT,
  type FlyExclusion,
  type FlyFrame,
} from '../src/domain/engine/flyLayout';
import {
  imageWrapMode,
  wrapFormatting,
  IMAGE_WRAP_MODES,
} from '../src/domain/document/images';
import { layoutParagraph } from '../src/domain/engine/lineBreak';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { ptToPx } from '../src/domain/document/units';
import { buildContentXml } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';
import type { DocumentBlock, FlySurround } from '../src/domain/document/types';

const measurer = new MetricTextMeasurer();

function docOf(blocks: DocumentBlock[]) {
  return { ...createEmptyDocument(), blocks };
}

/** Geometry of an A4 with default margins, to resolve the alignments. */
const geometrie = pageGeometry(createEmptyDocument().pageSetup);

/** `collectFlyFrames` on the standard geometry: the usual shape in tests. */
function collecte(blocks: DocumentBlock[]) {
  return collectFlyFrames(docOf(blocks), geometrie);
}

function flyRun(surround: FlySurround, extra: Record<string, unknown> = {}) {
  return makeRun('￼', {
    imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
    imageWidthPt: 100,
    imageHeightPt: 60,
    imageAnchor: 'to-para',
    imageSurround: surround,
    imageXPt: 0,
    imageYPt: 0,
    ...extra,
  });
}

/** A bare frame, in pixels, to test `usableBand` without going through the model. */
function frame(overrides: Partial<FlyFrame> = {}): FlyFrame {
  return {
    anchorBlockId: 'p1',
    anchorOffset: 0,
    surround: 'parallel',
    anchor: 'to-para',
    leftPx: 100,
    topPx: 0,
    widthPx: 100,
    heightPx: 50,
    marginPx: 0,
    run: makeRun('￼'),
    ...overrides,
  };
}

describe('Traduction d\'un cadre en intervalle interdit (SwFmtSurround)', () => {
  it('`through` n\'interdit rien : le texte passe dessous', () => {
    expect(exclusionOf(frame({ surround: 'through' }), 600)).toBeNull();
  });

  it('`none` réserve toute la colonne', () => {
    const e = exclusionOf(frame({ surround: 'none' }), 600);
    expect(e).toEqual({ topPx: 0, bottomPx: 50, leftPx: 0, rightPx: 600 });
  });

  it('`parallel` n\'interdit que la largeur du cadre', () => {
    const e = exclusionOf(frame({ surround: 'parallel' }), 600);
    expect(e).toEqual({ topPx: 0, bottomPx: 50, leftPx: 100, rightPx: 200 });
  });

  it('`left` interdit tout ce qui est à droite du bord gauche du cadre', () => {
    const e = exclusionOf(frame({ surround: 'left' }), 600);
    expect(e).toEqual({ topPx: 0, bottomPx: 50, leftPx: 100, rightPx: 600 });
  });

  it('`right` interdit tout ce qui est à gauche du bord droit du cadre', () => {
    const e = exclusionOf(frame({ surround: 'right' }), 600);
    expect(e).toEqual({ topPx: 0, bottomPx: 50, leftPx: 0, rightPx: 200 });
  });

  it('la marge d\'habillage élargit l\'intervalle des quatre côtés', () => {
    const e = exclusionOf(frame({ marginPx: 10 }), 600);
    expect(e).toEqual({ topPx: -10, bottomPx: 60, leftPx: 90, rightPx: 210 });
  });
});

describe('Bande utile (SwTxtFly::GetFrm)', () => {
  const contenu = 600;

  it('sans cadre, la colonne entière est disponible', () => {
    expect(usableBand([], 0, 20, contenu)).toEqual({ leftPx: 0, rightPx: contenu });
  });

  it('un cadre qui ne croise pas la ligne ne la gêne pas', () => {
    const e: FlyExclusion = { topPx: 100, bottomPx: 150, leftPx: 0, rightPx: 300 };
    expect(usableBand([e], 0, 20, contenu)).toEqual({ leftPx: 0, rightPx: contenu });
  });

  it('un cadre qui s\'arrête juste au haut de la ligne ne la gêne pas', () => {
    // **Strict** overlap: `bottomPx === topPx` is not a collision.
    const e: FlyExclusion = { topPx: 0, bottomPx: 20, leftPx: 0, rightPx: 300 };
    expect(usableBand([e], 20, 40, contenu)).toEqual({ leftPx: 0, rightPx: contenu });
  });

  it('retient le plus large des deux côtés d\'un cadre central', () => {
    // Frame from 250 to 300: 250 px on the left, 300 px on the right.
    const e: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 250, rightPx: 300 };
    expect(usableBand([e], 0, 20, contenu)).toEqual({ leftPx: 300, rightPx: 600 });
  });

  it('un cadre `none` bloque la ligne : aucune bande exploitable', () => {
    const e: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 0, rightPx: contenu };
    expect(usableBand([e], 0, 20, contenu)).toBeNull();
  });

  it('rejette une bande résiduelle trop étroite pour être lisible', () => {
    // 10 px on the left: under the threshold, one letter per line.
    const e: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 10, rightPx: contenu };
    expect(usableBand([e], 0, 20, contenu)).toBeNull();
  });

  it('soustrait deux cadres qui se chevauchent sans code particulier', () => {
    const gauche: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 0, rightPx: 150 };
    const centre: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 100, rightPx: 250 };
    // Both together block [0, 250]: [250, 600] remains.
    expect(usableBand([gauche, centre], 0, 20, contenu)).toEqual({ leftPx: 250, rightPx: 600 });
  });

  it('trois cadres laissent la plus large des tranches survivantes', () => {
    const a: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 100, rightPx: 150 };
    const b: FlyExclusion = { topPx: 0, bottomPx: 50, leftPx: 300, rightPx: 340 };
    expect(usableBand([a, b], 0, 20, contenu)).toEqual({ leftPx: 340, rightPx: 600 });
  });

  it('nextClearY donne le bas du cadre bloquant le plus haut', () => {
    const bas: FlyExclusion = { topPx: 0, bottomPx: 80, leftPx: 0, rightPx: 600 };
    const haut: FlyExclusion = { topPx: 0, bottomPx: 40, leftPx: 0, rightPx: 600 };
    expect(nextClearY([bas, haut], 0, 20)).toBe(40);
    expect(nextClearY([], 0, 20)).toBeNull();
  });

  it('nextClearY progresse toujours, même sur un cadre dégénéré', () => {
    // A frame of zero height *inside* the line counts as a collision, exactly as in `usableBand`: both functions share the overlap test, and making them disagree would make the formatter loop between a refused band and a
    // descent judged useless.
    const plat: FlyExclusion = { topPx: 10, bottomPx: 10, leftPx: 0, rightPx: 600 };
    const y = nextClearY([plat], 5, 25);
    expect(y).not.toBeNull();
    // Strict progress: it is what guarantees termination.
    expect(y!).toBeGreaterThan(5);

    const minuscule: FlyExclusion = { topPx: 5, bottomPx: 6, leftPx: 0, rightPx: 600 };
    expect(nextClearY([minuscule], 5, 25)!).toBeGreaterThan(5);

    // In practice the case does not occur: `collectFlyFrames` already discards any frame with no height.
    const p = createParagraph('', {
      runs: [makeRun('￼', { imageSrc: 'data:,x', imageAnchor: 'to-para', imageWidthPt: 10, imageHeightPt: 0 })],
    });
    expect(collecte([p])).toHaveLength(0);
  });
});

describe('Collecte des cadres depuis le modèle', () => {
  it('distingue un cadre flottant d\'une image « comme caractère »', () => {
    expect(isFloatingFly(flyRun('parallel'))).toBe(true);
    expect(isFloatingFly(makeRun('￼', { imageSrc: 'data:,x', imageAnchor: 'as-char' }))).toBe(false);
    expect(isFloatingFly(makeRun('texte'))).toBe(false);
  });

  it('collecte les cadres avec leur ancre et leur offset', () => {
    const p = createParagraph('', {
      runs: [makeRun('avant'), flyRun('right'), makeRun('après')],
    });
    const flies = collecte([p]);

    expect(flies).toHaveLength(1);
    expect(flies[0]?.anchorBlockId).toBe(p.id);
    expect(flies[0]?.anchorOffset).toBe(5);
    expect(flies[0]?.surround).toBe('right');
    expect(flies[0]?.marginPx).toBeCloseTo(ptToPx(DEFAULT_WRAP_MARGIN_PT), 5);
  });

  it('écarte un cadre sans dimensions : il n\'exclurait rien', () => {
    const p = createParagraph('', {
      runs: [makeRun('￼', { imageSrc: 'data:,x', imageAnchor: 'to-para', imageWidthPt: 0, imageHeightPt: 0 })],
    });
    expect(collecte([p])).toHaveLength(0);
  });

  it('ne résout que les cadres ancrés au paragraphe demandé', () => {
    const p1 = createParagraph('', { runs: [flyRun('parallel')] });
    const p2 = createParagraph('autre');
    const flies = collecte([p1, p2]);

    expect(paragraphExclusions(flies, p1, 600)).toHaveLength(1);
    expect(paragraphExclusions(flies, p2, 600)).toHaveLength(0);
  });
});

describe('Habillage dans le formateur de lignes', () => {
  const texte = 'Le vif renard brun saute par-dessus le chien paresseux. '.repeat(6);

  function largeurPremiereLigne(exclusions: FlyExclusion[]): number {
    const p = createParagraph(texte);
    const layout = layoutParagraph(p, {
      measurer,
      defaults: createEmptyDocument().defaults,
      contentWidthPx: 600,
      ...(exclusions.length > 0 ? { exclusions } : {}),
    });
    return layout.lines[0]?.widthPx ?? 0;
  }

  it('réduit la largeur des lignes traversées par un cadre', () => {
    const pleine = largeurPremiereLigne([]);
    const amputee = largeurPremiereLigne([
      { topPx: 0, bottomPx: 200, leftPx: 400, rightPx: 600 },
    ]);
    expect(amputee).toBeLessThan(pleine);
  });

  it('rend la pleine largeur aux lignes situées sous le cadre', () => {
    const p = createParagraph(texte);
    const layout = layoutParagraph(p, {
      measurer,
      defaults: createEmptyDocument().defaults,
      contentWidthPx: 600,
      exclusions: [{ topPx: 0, bottomPx: 30, leftPx: 300, rightPx: 600 }],
    });

    const premiere = layout.lines[0]!;
    const derniere = layout.lines[layout.lines.length - 1]!;
    expect(derniere.topPx).toBeGreaterThan(30);
    expect(derniere.widthPx).toBeGreaterThan(premiere.widthPx);
  });

  it('décale la ligne à droite quand le cadre occupe la gauche', () => {
    const p = createParagraph(texte);
    const layout = layoutParagraph(p, {
      measurer,
      defaults: createEmptyDocument().defaults,
      contentWidthPx: 600,
      exclusions: [{ topPx: 0, bottomPx: 40, leftPx: 0, rightPx: 200 }],
    });
    expect(layout.lines[0]?.leftPx).toBeGreaterThanOrEqual(200);
  });

  it('pousse la ligne SOUS un cadre `none` au lieu de la comprimer', () => {
    const p = createParagraph(texte);
    const hauteurCadre = 45;
    const layout = layoutParagraph(p, {
      measurer,
      defaults: createEmptyDocument().defaults,
      contentWidthPx: 600,
      exclusions: [{ topPx: 0, bottomPx: hauteurCadre, leftPx: 0, rightPx: 600 }],
    });

    expect(layout.lines[0]?.topPx).toBeGreaterThanOrEqual(hauteurCadre);
    // The line gets its full width back once it is past the frame.
    expect(layout.lines[0]?.leftPx).toBe(0);
  });

  it('un paragraphe sans cadre garde exactement la mise en page d\'avant', () => {
    const p = createParagraph(texte);
    const base = { measurer, defaults: createEmptyDocument().defaults, contentWidthPx: 600 };
    const sans = layoutParagraph(p, base);
    const avecVide = layoutParagraph(p, { ...base, exclusions: [] });

    expect(avecVide.lines).toHaveLength(sans.lines.length);
    expect(avecVide.lines[0]?.widthPx).toBe(sans.lines[0]?.widthPx);
  });
});

describe('Pose des cadres à la pagination', () => {
  it('pose le cadre sur la page de son ancre', () => {
    const p = createParagraph('', { runs: [makeRun('texte '), flyRun('parallel')] });
    const layout = paginateDocument(docOf([p]), { measurer });

    expect(layout.pages[0]?.flies).toHaveLength(1);
    expect(layout.pages[0]?.flies?.[0]?.widthPx).toBeCloseTo(ptToPx(100), 3);
    expect(layout.pages[0]?.flies?.[0]?.heightPx).toBeCloseTo(ptToPx(60), 3);
  });

  it('décale un cadre ancré au paragraphe selon la position de celui-ci', () => {
    const avant = createParagraph('Un paragraphe qui occupe de la place avant le cadre.');
    const porteur = createParagraph('', { runs: [flyRun('parallel', { imageYPt: 10 })] });
    const layout = paginateDocument(docOf([avant, porteur]), { measurer });

    const pose = layout.pages[0]?.flies?.[0];
    const placement = layout.placements.get(porteur.id)?.[0];
    expect(pose?.topPx).toBeCloseTo((placement?.placed.topPx ?? 0) + ptToPx(10), 3);
  });

  it('borne l\'abscisse d\'un cadre à la largeur de la colonne', () => {
    const p = createParagraph('', { runs: [flyRun('parallel', { imageXPt: 10000 })] });
    const layout = paginateDocument(docOf([p]), { measurer });
    const pose = layout.pages[0]?.flies?.[0];
    expect(pose?.leftPx).toBeLessThanOrEqual(layout.geometry.contentWidthPx);
  });

  it('un document sans cadre ne pose aucun cadre', () => {
    const layout = paginateDocument(docOf([createParagraph('rien de flottant')]), { measurer });
    expect(layout.pages[0]?.flies).toBeUndefined();
  });
});

describe('Aller-retour ODF de l\'habillage', () => {
  it('exporte ancrage, habillage et position, puis les relit', () => {
    const p = createParagraph('', {
      runs: [makeRun('avant '), flyRun('right', { imageXPt: 24, imageYPt: 12, imageWrapMarginPt: 6 })],
    });
    const xml = buildContentXml(docOf([p]));

    expect(xml).toContain('text:anchor-type="paragraph"');
    expect(xml).toContain('style:wrap="right"');
    expect(xml).toContain('svg:x=');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');

    const cadre = bloc.runs.find((r) => r.imageSrc !== undefined);
    expect(cadre?.imageAnchor).toBe('to-para');
    expect(cadre?.imageSurround).toBe('right');
    expect(cadre?.imageXPt).toBeCloseTo(24, 1);
    expect(cadre?.imageYPt).toBeCloseTo(12, 1);
  });

  it('une image « comme caractère » reste ancrée dans la ligne', () => {
    const p = createParagraph('', {
      runs: [
        makeRun('￼', {
          imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
          imageWidthPt: 40,
          imageHeightPt: 30,
        }),
      ],
    });
    const xml = buildContentXml(docOf([p]));
    expect(xml).toContain('text:anchor-type="as-char"');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(bloc.runs.find((r) => r.imageSrc)?.imageAnchor).toBeUndefined();
  });

  it('ramène `run-through` d\'ODF sur `through` du modèle', () => {
    const p = createParagraph('', { runs: [flyRun('through')] });
    const xml = buildContentXml(docOf([p]));
    expect(xml).toContain('style:wrap="run-through"');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(bloc.runs.find((r) => r.imageSrc)?.imageSurround).toBe('through');
  });
});

/**
 * `SURROUND_IDEAL`: the "optimal" wrapping of `SwTxtFly::GetSurroundForTextWrap` (`txtfly.cxx:2372-2402`).
 *
 * It does not describe a geometry but an **arbitration**: the room left on each side decides the mode that is really applied. The thresholds are those of the C++: `TEXT_MIN` (2 cm), below which a column does not
 * deserve to exist, and `FRAME_MAX` (1.5 cm), beyond which a frame only keeps its wider side.
 */
describe('Habillage optimal (SURROUND_IDEAL)', () => {
  const colonne = 600;
  const minPx = ptToPx(IDEAL_TEXT_MIN_PT);

  it('garde les deux côtés quand chacun dépasse le minimum', () => {
    const gauche = minPx + 20;
    // Narrow frame: the `FRAME_MAX` rule does not apply, both sides live.
    expect(resolveIdealSurround(gauche, gauche + 10, colonne)).toBe('parallel');
  });

  it('ne garde que le côté le plus large dès que le cadre est large', () => {
    // Frame of 200 px, far beyond `FRAME_MAX`: only one side survives, and it is the wider one, here the left.
    const droite = colonne - (minPx + 10);
    expect(resolveIdealSurround(minPx + 60, droite, colonne)).toBe('left');
  });

  it('bascule à droite quand c\'est de ce côté que la place est', () => {
    expect(resolveIdealSurround(-20, minPx + 40, colonne)).toBe('right');
  });

  it('renonce à habiller quand aucun côté n\'atteint le minimum', () => {
    // Frame almost as wide as the column: the two leftover bands are under `TEXT_MIN`, so the text goes above and below.
    expect(resolveIdealSurround(10, colonne - 10, colonne)).toBe('none');
  });

  it('ignore un cadre entièrement hors de la colonne', () => {
    expect(resolveIdealSurround(-300, -10, colonne)).toBe('parallel');
    expect(resolveIdealSurround(colonne + 10, colonne + 200, colonne)).toBe('parallel');
  });

  it('se résout au moment de calculer l\'exclusion, jamais avant', () => {
    // Frame stuck to the left edge: `ideal` must behave like `right`, that is to say only forbid the left part of the column.
    const cadre = frame({ surround: 'ideal', leftPx: 0, widthPx: 120, marginPx: 0 });
    const exclusion = exclusionOf(cadre, colonne);
    expect(exclusion).not.toBeNull();
    expect(exclusion!.leftPx).toBe(0);
    expect(exclusion!.rightPx).toBe(120);
  });
});

/**
 * Position of a frame: `SwFmtHoriOrient` and `text::RelOrientation`.
 *
 * What these tests check fits in one sentence: an alignment is **recomputed**, an offset is **read**. That is the whole difference between an image that stays stuck to the margin when the margin moves and an image that
 * comes away from it.
 */
describe('Alignement horizontal des cadres', () => {
  const geo = { pageWidthPx: 794, contentLeftPx: 76, contentWidthPx: 642 };

  it('aligne à gauche, au centre et à droite dans la colonne', () => {
    expect(resolveFlyLeft('left', 'text', 999, 100, geo)).toBe(0);
    expect(resolveFlyLeft('center', 'text', 999, 100, geo)).toBeCloseTo((642 - 100) / 2, 5);
    expect(resolveFlyLeft('right', 'text', 999, 100, geo)).toBeCloseTo(642 - 100, 5);
  });

  it('ne lit le décalage qu\'en position libre', () => {
    expect(resolveFlyLeft('from-left', 'text', 37, 100, geo)).toBe(37);
  });

  it('mesure sur la feuille entière, marges comprises, en repère « page »', () => {
    // Aligned to the left of the **sheet**: the frame therefore overflows into the margin, at a negative x coordinate in the column's frame of reference.
    expect(resolveFlyLeft('left', 'page', 0, 100, geo)).toBe(-76);
    expect(resolveFlyLeft('right', 'page', 0, 100, geo)).toBeCloseTo(-76 + 794 - 100, 5);
  });

  it('résout l\'alignement à la collecte, pas à la peinture', () => {
    const p = createParagraph('', {
      runs: [flyRun('parallel', { imageHoriOrient: 'right', imageHoriRelation: 'text', imageXPt: 0 })],
    });
    const cadres = collecte([p]);
    expect(cadres).toHaveLength(1);
    // 100 pt wide, aligned to the right of a known column: the x coordinate is no longer zero, whereas the model still carries `imageXPt: 0`.
    expect(cadres[0]!.leftPx).toBeCloseTo(geometrie.contentWidthPx - ptToPx(100), 5);
  });

  it('un cadre sans alignement déclaré garde son abscisse — les anciens documents', () => {
    const p = createParagraph('', { runs: [flyRun('parallel', { imageXPt: 30 })] });
    expect(collecte([p])[0]!.leftPx).toBeCloseTo(ptToPx(30), 5);
  });
});

/**
 * The five ways of placing an image on the page.
 *
 * `imageWrapMode` and `wrapFormatting` are reciprocal: that is what guarantees that a menu ticked on "In front of the text" does designate the state you get by clicking "In front of the text".
 */
describe('Modes d\'intégration au texte', () => {
  it('lit le mode des trois attributs d\'OpenOffice', () => {
    expect(imageWrapMode({})).toBe('inline');
    expect(imageWrapMode({ imageAnchor: 'as-char' })).toBe('inline');
    expect(imageWrapMode({ imageAnchor: 'to-para', imageSurround: 'ideal' })).toBe('wrap');
    expect(imageWrapMode({ imageAnchor: 'to-para', imageSurround: 'parallel' })).toBe('wrap');
    expect(imageWrapMode({ imageAnchor: 'to-para', imageSurround: 'none' })).toBe('break');
    expect(imageWrapMode({ imageAnchor: 'to-para', imageSurround: 'through' })).toBe('behind');
    expect(
      imageWrapMode({ imageAnchor: 'to-para', imageSurround: 'through', imageInFront: true }),
    ).toBe('front');
  });

  it('chaque mode se relit tel qu\'il a été écrit', () => {
    for (const { mode } of IMAGE_WRAP_MODES) {
      expect(imageWrapMode(wrapFormatting(mode))).toBe(mode);
    }
  });

  it('« derrière » et « devant » ne diffèrent que par le calque', () => {
    const derriere = wrapFormatting('behind');
    const devant = wrapFormatting('front');
    expect(derriere.imageSurround).toBe('through');
    expect(devant.imageSurround).toBe('through');
    expect(derriere.imageInFront).toBeUndefined();
    expect(devant.imageInFront).toBe(true);
  });

  it('conserve un ancrage à la page en changeant de mode', () => {
    // Switching "behind" → "in front" must not bring back to the paragraph a frame that was placed on the sheet.
    expect(wrapFormatting('front', 'to-page').imageAnchor).toBe('to-page');
  });

  it('« aligner » n\'écrit aucun attribut de cadre flottant', () => {
    expect(wrapFormatting('inline')).toEqual({});
  });
});

describe('Aller-retour ODF de l\'habillage optimal et du calque', () => {
  it('écrit `dynamic` pour l\'habillage optimal et le relit', () => {
    const p = createParagraph('', { runs: [flyRun('ideal')] });
    const xml = buildContentXml(docOf([p]));
    expect(xml).toContain('style:wrap="dynamic"');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(bloc.runs.find((r) => r.imageSrc)?.imageSurround).toBe('ideal');
  });

  it('écrit le calque en `style:run-through` et le relit', () => {
    const p = createParagraph('', { runs: [flyRun('through', { imageInFront: true })] });
    const xml = buildContentXml(docOf([p]));
    expect(xml).toContain('style:run-through="foreground"');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(bloc.runs.find((r) => r.imageSrc)?.imageInFront).toBe(true);
  });

  it('un cadre « derrière le texte » s\'écrit en arrière-plan', () => {
    const xml = buildContentXml(docOf([createParagraph('', { runs: [flyRun('through')] })]));
    expect(xml).toContain('style:run-through="background"');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');
    expect(bloc.runs.find((r) => r.imageSrc)?.imageInFront).toBeUndefined();
  });

  it('écrit alignement et repère, puis les relit', () => {
    const p = createParagraph('', {
      runs: [flyRun('ideal', { imageHoriOrient: 'right', imageHoriRelation: 'page' })],
    });
    const xml = buildContentXml(docOf([p]));
    expect(xml).toContain('style:horizontal-pos="right"');
    expect(xml).toContain('style:horizontal-rel="page"');

    const { document: relu } = importOdfContent(xml);
    const bloc = relu.blocks[0];
    if (bloc?.type !== 'paragraph') throw new Error('paragraphe attendu');
    const cadre = bloc.runs.find((r) => r.imageSrc);
    expect(cadre?.imageHoriOrient).toBe('right');
    expect(cadre?.imageHoriRelation).toBe('page');
  });

  it('nomme la colonne de texte comme ODF l\'exige selon l\'ancre', () => {
    // Under a page anchor, ODF does not accept `paragraph`: the column's frame of reference is called `page-content` there.
    const surPage = buildContentXml(
      docOf([
        createParagraph('', {
          runs: [flyRun('parallel', { imageAnchor: 'to-page', imageHoriOrient: 'center' })],
        }),
      ]),
    );
    expect(surPage).toContain('style:horizontal-rel="page-content"');
  });
});

/**
 * Overflow of a frame beyond its anchor: `SwTxtFly` queries the list of frames of the **page**, not that of the paragraph.
 *
 * It is the usual case and not an edge case: an eight-centimeter image anchored to a two-line paragraph necessarily overflows onto what follows.
 */
describe('Cadres débordant de leur paragraphe d\'ancrage', () => {
  const suite = 'Un paragraphe suivant, assez long pour occuper plusieurs lignes de la colonne et se faire couper par un cadre voisin.';

  /** Width of the widest line of a laid-out paragraph. */
  function largeurMax(layout: ReturnType<typeof paginateDocument>, blockId: string): number {
    const lignes = layout.paragraphLayouts.get(blockId)?.lines ?? [];
    return Math.max(0, ...lignes.map((ligne) => ligne.widthPx));
  }

  it('écarte le texte des paragraphes suivants', () => {
    // A frame 400 pt high anchored to a one-line paragraph: it necessarily covers the paragraphs below.
    const porteur = createParagraph('', {
      runs: [flyRun('parallel', { imageHeightPt: 400, imageWidthPt: 200 })],
    });
    const apres = createParagraph(suite);

    const avec = paginateDocument(docOf([porteur, apres]), { measurer });
    const sans = paginateDocument(docOf([createParagraph(''), apres]), { measurer });

    expect(largeurMax(avec, apres.id)).toBeLessThan(largeurMax(sans, apres.id));
  });

  it('laisse intact un paragraphe posé sous le bas du cadre', () => {
    /*
     * Frame entirely contained in its anchor: the next paragraph starts lower and has nothing to go around.
     *
     * The carrier must have its own height for the case to exist. A frame anchored to an **empty** paragraph always overflows: the paragraph is only a few pixels high, the frame is necessarily bigger, and it is indeed the
     * next paragraph that it covers.
     */
    const porteur = createParagraph(suite, {
      runs: [makeRun(suite), flyRun('parallel', { imageHeightPt: 8, imageWidthPt: 40 })],
    });
    const apres = createParagraph(suite);

    const avec = paginateDocument(docOf([porteur, apres]), { measurer });
    const sans = paginateDocument(docOf([createParagraph(suite), apres]), { measurer });

    expect(largeurMax(avec, apres.id)).toBeCloseTo(largeurMax(sans, apres.id), 3);
  });

  it('un cadre `through` ne creuse rien, même en débordant', () => {
    const porteur = createParagraph('', {
      runs: [flyRun('through', { imageHeightPt: 400, imageWidthPt: 200 })],
    });
    const apres = createParagraph(suite);

    const avec = paginateDocument(docOf([porteur, apres]), { measurer });
    const sans = paginateDocument(docOf([createParagraph(''), apres]), { measurer });

    expect(largeurMax(avec, apres.id)).toBeCloseTo(largeurMax(sans, apres.id), 3);
  });
});
