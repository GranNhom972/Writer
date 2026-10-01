// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * @vitest-environment jsdom
 *
 * Légende de figure : numérotation dérivée, réglages, aller-retour ODF.
 *
 * La règle qui structure tout : **le numéro n'est jamais enregistré**. Il est
 * dérivé de l'ordre du document à chaque lecture, comme Writer le fait de ses
 * champs de séquence. C'est ce qui rend impossibles les doublons et les trous,
 * et ce qui fait qu'ajouter, supprimer ou déplacer une image renumérote le
 * reste sans qu'aucun code n'ait à s'en charger.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, figureNumbering } from '../src/domain/document/document';
import {
  captionText,
  imageCaptionOf,
  imageKey,
  makeImageRun,
  type ImageCaption,
} from '../src/domain/document/images';
import { makeRun } from '../src/domain/document/runs';
import type { DocumentBlock, ParagraphNode, TextRun } from '../src/domain/document/types';
import { buildContentXml } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';

/**
 * Aller-retour complet : sérialisation puis relecture du `content.xml`.
 *
 * Les images restent en `data:` — l'extraction du ZIP ne change rien à la
 * légende, et s'en passer garde le test lisible.
 */
function roundTrip(doc: ReturnType<typeof docOf>) {
  return importOdfContent(buildContentXml(doc)).document;
}

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function image(caption?: Partial<ImageCaption>): TextRun {
  return makeImageRun({
    src: PIXEL,
    widthPt: 120,
    heightPt: 90,
    alt: 'un pixel',
    ...(caption
      ? {
          caption: {
            text: caption.text ?? '',
            position: caption.position ?? 'below',
            align: caption.align ?? 'center',
            manual: caption.manual ?? false,
          },
        }
      : {}),
  });
}

let compteur = 0;
function para(...runs: TextRun[]): ParagraphNode {
  compteur += 1;
  return { id: `p${compteur}`, type: 'paragraph', runs };
}

const docOf = (blocks: DocumentBlock[]) => ({ ...createEmptyDocument(), blocks });

/** Légendes rendues, dans l'ordre du document. */
function rendered(doc: ReturnType<typeof docOf>): string[] {
  const numbers = figureNumbering(doc);
  const out: string[] = [];
  for (const block of doc.blocks) {
    if (block.type === 'table' || block.type === 'toc') continue;
    let offset = 0;
    for (const run of block.runs) {
      if (run.imageSrc) {
        out.push(captionText(imageCaptionOf(run), numbers.get(imageKey(block.id, offset)) ?? null));
      }
      offset += run.text.length;
    }
  }
  return out;
}

describe('Numérotation automatique', () => {
  it('numérote dans l’ordre du document', () => {
    const doc = docOf([
      para(image({ text: 'Mon titre' })),
      para(image({ text: 'Deuxième image' })),
      para(image({ text: 'Troisième image' })),
    ]);

    expect(rendered(doc)).toEqual([
      'Figure n°1 : Mon titre',
      'Figure n°2 : Deuxième image',
      'Figure n°3 : Troisième image',
    ]);
  });

  it('renumérote après une suppression', () => {
    const a = para(image({ text: 'A' }));
    const b = para(image({ text: 'B' }));
    const c = para(image({ text: 'C' }));

    expect(rendered(docOf([a, c]))).toEqual(['Figure n°1 : A', 'Figure n°2 : C']);
    expect(rendered(docOf([a, b, c]))[2]).toBe('Figure n°3 : C');
  });

  it('renumérote après un déplacement', () => {
    const a = para(image({ text: 'A' }));
    const b = para(image({ text: 'B' }));

    expect(rendered(docOf([b, a]))).toEqual(['Figure n°1 : B', 'Figure n°2 : A']);
  });

  it('renumérote après une insertion en tête', () => {
    const a = para(image({ text: 'A' }));
    const neuf = para(image({ text: 'Nouvelle' }));

    expect(rendered(docOf([neuf, a]))).toEqual(['Figure n°1 : Nouvelle', 'Figure n°2 : A']);
  });

  it('n’attribue jamais deux fois le même numéro', () => {
    const doc = docOf(Array.from({ length: 12 }, (_, i) => para(image({ text: `img ${i}` }))));
    const numbers = [...figureNumbering(doc).values()];

    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('numérote plusieurs images d’un même paragraphe', () => {
    const doc = docOf([para(image({ text: 'A' }), makeRun(' entre '), image({ text: 'B' }))]);
    expect(rendered(doc)).toEqual(['Figure n°1 : A', 'Figure n°2 : B']);
  });

  it('compte les images des cellules de tableau', () => {
    const doc = docOf([
      para(image({ text: 'avant' })),
      {
        id: 't1',
        type: 'table',
        rows: [
          {
            id: 'r1',
            cells: [{ id: 'c1', blocks: [para(image({ text: 'dans la cellule' }))] }],
          },
        ],
      },
      para(image({ text: 'après' })),
    ]);

    expect(rendered(doc).length).toBe(2); // `rendered` ignore les tableaux
    expect([...figureNumbering(doc).values()]).toEqual([1, 2, 3]);
  });
});

describe('Mode manuel', () => {
  it('affiche le texte seul, sans préfixe', () => {
    const doc = docOf([para(image({ text: 'Mon titre', manual: true }))]);
    expect(rendered(doc)).toEqual(['Mon titre']);
  });

  it('ne consomme pas de numéro', () => {
    const doc = docOf([
      para(image({ text: 'A' })),
      para(image({ text: 'hors suite', manual: true })),
      para(image({ text: 'C' })),
    ]);

    expect(rendered(doc)).toEqual(['Figure n°1 : A', 'hors suite', 'Figure n°2 : C']);
  });

  it('numérote sans texte, mais n’écrit rien en manuel', () => {
    expect(captionText({ text: '', position: 'below', align: 'center', manual: false }, 4)).toBe(
      'Figure n°4',
    );
    expect(captionText({ text: '', position: 'below', align: 'center', manual: true }, null)).toBe('');
  });
});

describe('Aller-retour OpenDocument', () => {
  it('conserve texte, mode, position et alignement', () => {
    const doc = docOf([
      para(image({ text: 'Première', position: 'above', align: 'left' })),
      para(image({ text: 'Manuelle', manual: true, position: 'below', align: 'right' })),
    ]);

    const relu = roundTrip(doc);
    const images = relu.blocks
      .flatMap((b) => (b.type === 'table' || b.type === 'toc' ? [] : b.runs))
      .filter((r) => r.imageSrc);

    expect(images).toHaveLength(2);

    const first = imageCaptionOf(images[0]!);
    expect(first.text).toBe('Première');
    expect(first.position).toBe('above');
    expect(first.align).toBe('left');
    expect(first.manual).toBe(false);

    const second = imageCaptionOf(images[1]!);
    expect(second.text).toBe('Manuelle');
    expect(second.align).toBe('right');
    expect(second.manual).toBe(true);
  });

  it('renumérote correctement après relecture', () => {
    const doc = docOf([
      para(image({ text: 'A' })),
      para(image({ text: 'B' })),
      para(image({ text: 'C' })),
    ]);

    const relu = roundTrip(doc);
    expect(rendered(relu)).toEqual([
      'Figure n°1 : A',
      'Figure n°2 : B',
      'Figure n°3 : C',
    ]);
  });

  it('conserve la taille et le rognage d’une image légendée', () => {
    const run = {
      ...image({ text: 'rognée' }),
      imageWidthPt: 150,
      imageHeightPt: 100,
      imageCropLeftPct: 0.25,
    };
    const relu = roundTrip(docOf([para(run)]));
    const found = relu.blocks
      .flatMap((b) => (b.type === 'table' || b.type === 'toc' ? [] : b.runs))
      .find((r) => r.imageSrc);

    expect(found?.imageWidthPt).toBeCloseTo(150, 0);
    expect(found?.imageHeightPt).toBeCloseTo(100, 0);
    expect(found?.imageCropLeftPct).toBeCloseTo(0.25, 2);
  });

  it('laisse intacte une image sans légende', () => {
    const relu = roundTrip(docOf([para(image())]));
    const found = relu.blocks
      .flatMap((b) => (b.type === 'table' || b.type === 'toc' ? [] : b.runs))
      .find((r) => r.imageSrc);

    expect(found).toBeDefined();
    expect(found?.imageCaption).toBeUndefined();
  });
});
