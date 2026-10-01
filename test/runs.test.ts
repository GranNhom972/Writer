// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Invariants of the formatting ranges (`SwpHints`).
 */
import { describe, expect, it } from 'vitest';
import {
  applyFormattingToRange,
  commonFormatting,
  deleteRangeInRuns,
  formattingAt,
  insertTextInRuns,
  makeRun,
  normalizeRuns,
  runsLength,
  runsText,
  sliceRuns,
  splitRunsAt,
} from '../src/domain/document/runs';

describe('normalizeRuns — invariant de SwpHints::MergePortions', () => {
  it('fusionne deux runs adjacents de formatage identique', () => {
    const runs = normalizeRuns([makeRun('Bon', { bold: true }), makeRun('jour', { bold: true })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: 'Bonjour', bold: true });
  });

  it('ne fusionne pas des formatages différents', () => {
    const runs = normalizeRuns([makeRun('Bon', { bold: true }), makeRun('jour')]);
    expect(runs).toHaveLength(2);
  });

  it('supprime les runs vides', () => {
    const runs = normalizeRuns([makeRun('a'), makeRun(''), makeRun('b')]);
    expect(runs).toHaveLength(1);
    expect(runsText(runs)).toBe('ab');
  });

  it('conserve un run porteur de style quand tout le texte disparaît', () => {
    const runs = normalizeRuns([makeRun('', { italic: true })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.italic).toBe(true);
  });
});

describe('splitRunsAt', () => {
  it('coupe au milieu d’un run en préservant le formatage des deux moitiés', () => {
    const [before, after] = splitRunsAt([makeRun('Bonjour', { bold: true })], 3);
    expect(runsText(before)).toBe('Bon');
    expect(runsText(after)).toBe('jour');
    expect(before[0]?.bold).toBe(true);
    expect(after[0]?.bold).toBe(true);
  });

  it('coupe exactement sur une frontière de run', () => {
    const runs = [makeRun('Bon', { bold: true }), makeRun('jour')];
    const [before, after] = splitRunsAt(runs, 3);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]?.bold).toBeUndefined();
  });

  it('borne un offset hors limites au lieu de produire du vide', () => {
    const [before, after] = splitRunsAt([makeRun('abc')], 99);
    expect(runsText(before)).toBe('abc');
    expect(runsText(after)).toBe('');
  });
});

describe('insertTextInRuns', () => {
  it('hérite du formatage du caractère de gauche', () => {
    const runs = insertTextInRuns([makeRun('gras', { bold: true })], 4, '!');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: 'gras!', bold: true });
  });

  it('hérite du formatage de droite en début de paragraphe', () => {
    const runs = insertTextInRuns([makeRun('gras', { bold: true })], 0, '»');
    expect(runs[0]?.bold).toBe(true);
    expect(runsText(runs)).toBe('»gras');
  });

  it('insère au milieu sans casser le run porteur', () => {
    const runs = insertTextInRuns([makeRun('ab', { italic: true })], 1, 'XY');
    expect(runs).toHaveLength(1);
    expect(runsText(runs)).toBe('aXYb');
  });
});

describe('deleteRangeInRuns', () => {
  it('recolle les deux bords quand ils partagent le formatage', () => {
    const runs = deleteRangeInRuns(
      [makeRun('abc'), makeRun('XYZ', { bold: true }), makeRun('def')],
      3,
      6,
    );
    expect(runs).toHaveLength(1);
    expect(runsText(runs)).toBe('abcdef');
  });

  it('vide le paragraphe en conservant un run de style', () => {
    const runs = deleteRangeInRuns([makeRun('abc', { bold: true })], 0, 3);
    expect(runsText(runs)).toBe('');
    expect(runs[0]?.bold).toBe(true);
  });
});

describe('applyFormattingToRange', () => {
  it('découpe un run pour n’en formater qu’une partie', () => {
    const runs = applyFormattingToRange([makeRun('abcdef')], 2, 4, { bold: true });
    expect(runs.map((run) => run.text)).toEqual(['ab', 'cd', 'ef']);
    expect(runs[1]?.bold).toBe(true);
  });

  it('refusionne quand le formatage redevient identique', () => {
    const bolded = applyFormattingToRange([makeRun('abcdef')], 2, 4, { bold: true });
    const cleared = applyFormattingToRange(bolded, 2, 4, { bold: null });
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toEqual({ text: 'abcdef' });
  });

  it('n’écrit jamais `false` : la forme canonique d’un booléen est true ou absent', () => {
    const runs = applyFormattingToRange([makeRun('ab', { bold: true })], 0, 2, { bold: false });
    expect(runs[0]).toEqual({ text: 'ab' });
    expect('bold' in runs[0]!).toBe(false);
  });

  it('ne touche à rien sur une plage vide', () => {
    const runs = applyFormattingToRange([makeRun('ab')], 1, 1, { bold: true });
    expect(runs).toEqual([{ text: 'ab' }]);
  });
});

describe('commonFormatting — état des boutons de la barre d’outils', () => {
  it('retient l’attribut partagé par toute la plage', () => {
    const runs = [makeRun('ab', { bold: true }), makeRun('cd', { bold: true, italic: true })];
    expect(commonFormatting(runs, 0, 4)).toEqual({ bold: true });
  });

  it('oublie l’attribut dès qu’il varie', () => {
    const runs = [makeRun('ab', { bold: true }), makeRun('cd')];
    expect(commonFormatting(runs, 0, 4)).toEqual({});
  });
});

describe('formattingAt et sliceRuns', () => {
  it('prend le formatage de gauche à une frontière de run', () => {
    const runs = [makeRun('a', { bold: true }), makeRun('b', { italic: true })];
    expect(formattingAt(runs, 1)).toEqual({ bold: true });
  });

  it('extrait une plage à cheval sur deux runs', () => {
    const runs = [makeRun('abc', { bold: true }), makeRun('def')];
    const slice = sliceRuns(runs, 2, 4);
    expect(runsText(slice)).toBe('cd');
    expect(slice).toHaveLength(2);
    expect(runsLength(slice)).toBe(2);
  });
});
