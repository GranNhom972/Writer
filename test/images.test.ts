/**
 * Images ancrées « comme caractère » (`SwFlyCntFrm`).
 *
 * Ce que ces tests garantissent, et pourquoi :
 *
 *  - le cadre occupe **une** position dans la chaîne du paragraphe, sinon le
 *    curseur se poserait au milieu de l'image ;
 *  - le moteur lui donne sa largeur et sa hauteur, et **ne coupe jamais dedans** ;
 *  - taper à côté d'une image ne produit pas une seconde image ;
 *  - l'aller-retour ODF conserve l'image, ses dimensions et son texte alternatif.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  clampSize,
  collectImageRuns,
  composeCrop,
  cropGeometry,
  fitToContentWidth,
  hasCrop,
  heightForWidth,
  imageCrop,
  IMAGE_PLACEHOLDER,
  isImageRun,
  isSafeImageSrc,
  makeImageRun,
  MAX_IMAGE_SIZE_PT,
  MIN_IMAGE_SIZE_PT,
  MIN_VISIBLE_FRACTION,
  normalizeCrop,
  NO_CROP,
  visibleFraction,
  widthForHeight,
  type ImageCrop,
} from '../src/domain/document/images';
import {
  formattingAt,
  insertTextInRuns,
  makeRun,
  runFormatting,
  runsText,
  sameFormatting,
} from '../src/domain/document/runs';
import { createEmptyDocument, createParagraph } from '../src/domain/document/document';
import { layoutParagraph } from '../src/domain/engine/lineBreak';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { DEFAULT_DEFAULTS } from '../src/domain/document/document';
import { paginateDocument } from '../src/domain/engine/paginate';
import { ptToPx } from '../src/domain/document/units';
import { buildContentXml } from '../src/domain/odf/export';
import { importOdfContent } from '../src/domain/odf/import';
import { collectPictures, base64ToBytes, bytesToBase64, parseDataUrl } from '../src/domain/odf/pictures';
import { exportOdt, openOdt } from '../src/domain/odf/package';
import { exportToPdfBytes } from '../src/domain/pdf/export';
import {
  isParagraph,
  type DocumentBlock,
  type TextRun,
  type WriterDocumentState,
} from '../src/domain/document/types';

/** Un GIF 1×1 transparent — la plus petite image valide qui soit. */
const GIF_1PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Le premier cadre image d'un bloc, en tant que run. */
function cadreDe(block: DocumentBlock | undefined): TextRun | undefined {
  if (!block || !isParagraph(block)) return undefined;
  return block.runs.find(isImageRun);
}

const measurer = new MetricTextMeasurer();

function ctx(contentWidthPx = 400) {
  return { measurer, defaults: DEFAULT_DEFAULTS, contentWidthPx };
}

describe('modèle : le cadre image', () => {
  it('occupe un seul caractère de substitution dans la chaîne du paragraphe', () => {
    const cadre = makeImageRun({ src: GIF_1PX, widthPt: 100, heightPt: 50 });
    expect(cadre.text).toBe(IMAGE_PLACEHOLDER);
    expect(cadre.text.length).toBe(1);
    expect(isImageRun(cadre)).toBe(true);
  });

  it('borne les dimensions absurdes plutôt que de les propager', () => {
    expect(clampSize(0)).toBe(MIN_IMAGE_SIZE_PT);
    expect(clampSize(-40)).toBe(MIN_IMAGE_SIZE_PT);
    expect(clampSize(Number.NaN)).toBe(MIN_IMAGE_SIZE_PT);
    expect(clampSize(1e9)).toBe(MAX_IMAGE_SIZE_PT);
  });

  it('réduit à la largeur imprimable sans jamais agrandir', () => {
    // 96 px = 1 pouce = 72 pt, largeur imprimable 200 pt : rien à réduire.
    const petite = fitToContentWidth(96, 48, 200);
    expect(petite.widthPt).toBeCloseTo(72, 5);
    expect(petite.heightPt).toBeCloseTo(36, 5);

    // Deux fois trop large : ramenée à la limite, rapport conservé.
    const grande = fitToContentWidth(960, 480, 200);
    expect(grande.widthPt).toBeCloseTo(200, 5);
    expect(grande.heightPt).toBeCloseTo(100, 5);
  });

  it('conserve le rapport dans les deux sens', () => {
    const ratio = { widthPt: 200, heightPt: 100 };
    expect(heightForWidth(80, ratio)).toBeCloseTo(40, 5);
    expect(widthForHeight(40, ratio)).toBeCloseTo(80, 5);
  });

  it('refuse les adresses exécutables', () => {
    expect(isSafeImageSrc(GIF_1PX)).toBe(true);
    expect(isSafeImageSrc('https://exemple.fr/logo.png')).toBe(true);
    expect(isSafeImageSrc('/api/v1/documents/x/assets/y.png')).toBe(true);

    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
    expect(isSafeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeImageSrc('')).toBe(false);
  });

  it('énumère les cadres avec leur offset', () => {
    const runs = [
      makeRun('avant '),
      makeImageRun({ src: GIF_1PX, widthPt: 40, heightPt: 20 }),
      makeRun(' après'),
    ];
    const trouves = collectImageRuns(runs);
    expect(trouves).toHaveLength(1);
    expect(trouves[0]!.offset).toBe(6);
    expect(runsText(runs)).toBe(`avant ${IMAGE_PLACEHOLDER} après`);
  });
});

describe('modèle : le cadre ne déteint pas sur la frappe', () => {
  it('taper après une image produit du texte, pas une seconde image', () => {
    const runs = [makeImageRun({ src: GIF_1PX, widthPt: 40, heightPt: 20 })];
    const herite = formattingAt(runs, 1);
    expect(herite.imageSrc).toBeUndefined();
    expect(herite.imageWidthPt).toBeUndefined();

    const apres = insertTextInRuns(runs, 1, 'suite');
    expect(apres.filter(isImageRun)).toHaveLength(1);
    expect(apres.some((run) => run.text === 'suite' && !isImageRun(run))).toBe(true);
  });

  it('taper avant une image ne l’hérite pas non plus', () => {
    const runs = [makeImageRun({ src: GIF_1PX, widthPt: 40, heightPt: 20 })];
    const avant = insertTextInRuns(runs, 0, 'texte');
    expect(avant.filter(isImageRun)).toHaveLength(1);
  });
});

describe('moteur : mise en page du cadre', () => {
  it('donne à la ligne la hauteur de l’image', () => {
    const paragraphe = createParagraph('', {
      runs: [makeImageRun({ src: GIF_1PX, widthPt: 100, heightPt: 200 })],
    });
    const layout = layoutParagraph(paragraphe, ctx());

    expect(layout.lines).toHaveLength(1);
    // La hauteur de ligne suit celle du cadre, à l'interligne près.
    expect(layout.lines[0]!.heightPx).toBeGreaterThanOrEqual(ptToPx(200));
  });

  it('donne au segment la largeur du cadre, pas celle d’un caractère', () => {
    const paragraphe = createParagraph('', {
      runs: [makeImageRun({ src: GIF_1PX, widthPt: 150, heightPt: 40 })],
    });
    const layout = layoutParagraph(paragraphe, ctx());
    const segment = layout.lines[0]!.segments[0]!;
    expect(segment.widthPx).toBeCloseTo(ptToPx(150), 3);
  });

  it('reporte l’image sur la ligne suivante plutôt que de couper dedans', () => {
    // La zone fait 200 px ; le texte remplit presque tout, l'image ne tient plus.
    const paragraphe = createParagraph('', {
      runs: [
        makeRun('Un texte assez long pour occuper la ligne '),
        makeImageRun({ src: GIF_1PX, widthPt: 120, heightPt: 30 }),
      ],
    });
    const layout = layoutParagraph(paragraphe, ctx(200));

    // Le cadre se retrouve entier sur une seule ligne : jamais deux morceaux.
    const lignesAvecImage = layout.lines.filter((line) =>
      line.segments.some((segment) => segment.formatting.imageSrc),
    );
    expect(lignesAvecImage).toHaveLength(1);
    const segments = lignesAvecImage[0]!.segments.filter((s) => s.formatting.imageSrc);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.widthPx).toBeCloseTo(ptToPx(120), 3);
  });

  it('pagine une image plus haute que la page sans boucler', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('Grande image'),
      blocks: [
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 100, heightPt: 1500 })],
        }),
        createParagraph('Suite du document.'),
      ],
    };
    const layout = paginateDocument(doc, { measurer });
    expect(layout.pages.length).toBeGreaterThanOrEqual(1);
    expect(layout.pages.length).toBeLessThan(10);
  });
});

describe('ODF : aller-retour d’une image', () => {
  it('écrit un draw:frame ancré comme caractère', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('Avec image'),
      blocks: [
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 72, heightPt: 36, alt: 'Un logo' })],
        }),
      ],
    };
    const { hrefBySrc, pictures } = collectPictures(doc);
    const xml = buildContentXml(doc, hrefBySrc);

    expect(pictures).toHaveLength(1);
    expect(pictures[0]!.path).toBe('Pictures/image1.gif');
    expect(pictures[0]!.mediaType).toBe('image/gif');
    expect(xml).toContain('text:anchor-type="as-char"');
    expect(xml).toContain('xlink:href="Pictures/image1.gif"');
    expect(xml).toContain('<svg:title>Un logo</svg:title>');
    // Dimensions écrites : sans elles, Writer dessine un cadre de taille nulle.
    expect(xml).toMatch(/svg:width="[\d.]+pt"/);
    expect(xml).toMatch(/svg:height="[\d.]+pt"/);
  });

  it('ne duplique pas les octets d’une image répétée', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('Logo répété'),
      blocks: [
        createParagraph('', { runs: [makeImageRun({ src: GIF_1PX, widthPt: 20, heightPt: 20 })] }),
        createParagraph('', { runs: [makeImageRun({ src: GIF_1PX, widthPt: 30, heightPt: 30 })] }),
      ],
    };
    expect(collectPictures(doc).pictures).toHaveLength(1);
  });

  it('relit le cadre, ses dimensions et son texte alternatif', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('Avec image'),
      blocks: [
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 72, heightPt: 36, alt: 'Un logo' })],
        }),
      ],
    };
    const { hrefBySrc, pictures } = collectPictures(doc);
    const xml = buildContentXml(doc, hrefBySrc);

    const table = new Map(pictures.map((p) => [p.path, GIF_1PX]));
    const { document } = importOdfContent(xml, { pictures: table });

    const cadre = cadreDe(document.blocks[0]);
    expect(cadre).toBeDefined();
    expect(cadre!.imageSrc).toBe(GIF_1PX);
    expect(cadre!.imageWidthPt).toBeCloseTo(72, 1);
    expect(cadre!.imageHeightPt).toBeCloseTo(36, 1);
    expect(cadre!.imageAlt).toBe('Un logo');
  });

  it('survit à l’écriture puis à la relecture d’une archive .odt', async () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('Archive avec image'),
      blocks: [
        createParagraph('Avant.'),
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 50, heightPt: 25, alt: 'Vignette' })],
        }),
        createParagraph('Après.'),
      ],
    };

    const archive = await exportOdt(doc);
    const { document } = await openOdt(archive);

    const cadres = document.blocks
      .filter((block): block is Extract<typeof block, { runs: unknown }> => block.type !== 'table')
      .flatMap((block) => block.runs)
      .filter(isImageRun);

    expect(cadres).toHaveLength(1);
    expect(cadres[0]!.imageSrc).toBe(GIF_1PX);
    expect(cadres[0]!.imageAlt).toBe('Vignette');
  });

  it('laisse passer une adresse servie sans la rapatrier dans l’archive', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('Image distante'),
      blocks: [
        createParagraph('', {
          runs: [
            makeImageRun({ src: '/api/v1/documents/abc/assets/def.png', widthPt: 40, heightPt: 40 }),
          ],
        }),
      ],
    };
    const { pictures, hrefBySrc } = collectPictures(doc);
    expect(pictures).toHaveLength(0);
    expect(hrefBySrc.get('/api/v1/documents/abc/assets/def.png')).toBe(
      '/api/v1/documents/abc/assets/def.png',
    );
  });
});

describe('base64 maison', () => {
  it('correspond aux vecteurs de référence', () => {
    const octets = (s: string) => new TextEncoder().encode(s);
    expect(bytesToBase64(octets(''))).toBe('');
    expect(bytesToBase64(octets('f'))).toBe('Zg==');
    expect(bytesToBase64(octets('fo'))).toBe('Zm8=');
    expect(bytesToBase64(octets('foo'))).toBe('Zm9v');
    expect(bytesToBase64(octets('foobar'))).toBe('Zm9vYmFy');
  });

  it('fait l’aller-retour sur des octets binaires quelconques', () => {
    const source = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) source[i] = i;
    expect(Array.from(base64ToBytes(bytesToBase64(source)))).toEqual(Array.from(source));
  });

  it('décode une data: d’image et refuse les autres', () => {
    const decode = parseDataUrl(GIF_1PX);
    expect(decode?.mediaType).toBe('image/gif');
    // GIF87a/GIF89a : la signature doit être intacte après décodage.
    expect(String.fromCharCode(...decode!.bytes.subarray(0, 6))).toBe('GIF89a');

    expect(parseDataUrl('data:text/html;base64,PHA+')).toBeNull();
    expect(parseDataUrl('https://exemple.fr/x.png')).toBeNull();
  });
});

describe('PDF : le cadre image', () => {
  it('écrit un XObject /DCTDecode et le référence dans les ressources', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('PDF avec image'),
      blocks: [
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 72, heightPt: 36 })],
        }),
      ],
    };
    const layout = paginateDocument(doc, { measurer });

    // Un « JPEG » minimal : ce module place les octets, il ne les décode pas.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const bytes = exportToPdfBytes(doc, layout, {
      images: new Map([[GIF_1PX, { jpegBytes: jpeg, widthPx: 2, heightPx: 1 }]]),
    });

    const texte = String.fromCharCode(...bytes);
    expect(texte).toContain('/Subtype /Image');
    expect(texte).toContain('/Filter /DCTDecode');
    expect(texte).toContain('/XObject <<');
    expect(texte).toMatch(/\/I\d+ Do/);
    // Les octets du JPEG doivent traverser le flux **intacts** : c'est tout
    // l'intérêt de /DCTDecode, et une conversion en UTF-8 les détruirait.
    expect(texte).toContain(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0));
  });

  it('laisse un cadre vide quand l’image n’a pas pu être décodée', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('PDF sans raster'),
      blocks: [
        createParagraph('', { runs: [makeImageRun({ src: GIF_1PX, widthPt: 72, heightPt: 36 })] }),
      ],
    };
    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const texte = String.fromCharCode(...bytes);

    expect(texte.startsWith('%PDF-1.4')).toBe(true);
    expect(texte).not.toContain('/DCTDecode');
    // Le rectangle réservé est tout de même tracé, à la taille du cadre.
    expect(texte).toContain('72.00 36.00 re S');
  });

  it('annonce des décalages xref comptés en octets', () => {
    // L'entête binaire du PDF porte quatre octets ≥ 0x80 : compter en caractères
    // décalerait toute la table et rendrait le fichier illisible aux lecteurs stricts.
    const doc = createEmptyDocument('Décalages');
    const layout = paginateDocument(doc, { measurer });
    const bytes = exportToPdfBytes(doc, layout);
    const texte = String.fromCharCode(...bytes);

    const startXref = Number(/startxref\n(\d+)/.exec(texte)![1]);
    expect(texte.slice(startXref, startXref + 4)).toBe('xref');

    const premierObjet = Number(/xref\n0 \d+\n0000000000 65535 f \r\n(\d{10})/.exec(texte)![1]);
    expect(texte.slice(premierObjet, premierObjet + 7)).toBe('1 0 obj');
  });
});

describe('rognage : l’algèbre de SvxGrfCrop', () => {
  const crop = (top: number, right: number, bottom: number, left: number): ImageCrop => ({
    topPct: top,
    rightPct: right,
    bottomPct: bottom,
    leftPct: left,
  });

  it('reconnaît l’absence de rognage', () => {
    expect(hasCrop(NO_CROP)).toBe(false);
    expect(hasCrop(undefined)).toBe(false);
    expect(hasCrop(crop(0, 0, 0.1, 0))).toBe(true);
  });

  it('calcule la part restante', () => {
    const reste = visibleFraction(crop(0.1, 0.2, 0.1, 0.2));
    expect(reste.width).toBeCloseTo(0.6, 6);
    expect(reste.height).toBeCloseTo(0.8, 6);
  });

  it('réduit proportionnellement deux bords opposés qui se recouvrent', () => {
    // Écrêter un seul des deux déplacerait le centre de la partie visible : ce
    // qu'on garde ne serait plus ce qu'on a désigné.
    const normalise = normalizeCrop(crop(0, 0.8, 0, 0.4));
    expect(normalise.leftPct / normalise.rightPct).toBeCloseTo(0.5, 6);
    expect(1 - normalise.leftPct - normalise.rightPct).toBeCloseTo(MIN_VISIBLE_FRACTION, 6);
  });

  it('refuse les valeurs absurdes plutôt que de les propager', () => {
    const normalise = normalizeCrop(crop(Number.NaN, -1, 5, Number.POSITIVE_INFINITY));
    expect(normalise.topPct).toBe(0);
    expect(normalise.rightPct).toBe(0);
    expect(normalise.leftPct).toBe(0);
    expect(normalise.bottomPct).toBeLessThanOrEqual(1);
  });

  it('compose un second rognage dans le repère du visible, pas de l’original', () => {
    // C'est le cœur du sujet : après avoir gardé la moitié gauche, retirer
    // encore la moitié gauche de ce qui reste doit laisser un quart de
    // l'original — pas la moitié moins la moitié, qui ne laisserait rien.
    const premier = crop(0, 0.5, 0, 0);
    const second = crop(0, 0.5, 0, 0);
    const total = composeCrop(premier, second);

    expect(total.rightPct).toBeCloseTo(0.75, 6);
    expect(visibleFraction(total).width).toBeCloseTo(0.25, 6);
  });

  it('compose sur les quatre bords à la fois', () => {
    const premier = crop(0.1, 0.1, 0.1, 0.1);   // reste 80 % × 80 %
    const second = crop(0.5, 0, 0, 0.5);        // moitié de ce qui reste
    const total = composeCrop(premier, second);

    expect(total.topPct).toBeCloseTo(0.1 + 0.5 * 0.8, 6);
    expect(total.leftPct).toBeCloseTo(0.1 + 0.5 * 0.8, 6);
    expect(total.rightPct).toBeCloseTo(0.1, 6);
    expect(total.bottomPct).toBeCloseTo(0.1, 6);
  });

  it('composer avec un cadre plein ne change rien', () => {
    const existant = crop(0.2, 0.1, 0.05, 0.3);
    const inchange = composeCrop(existant, NO_CROP);
    expect(inchange.topPct).toBeCloseTo(existant.topPct, 6);
    expect(inchange.rightPct).toBeCloseTo(existant.rightPct, 6);
    expect(inchange.bottomPct).toBeCloseTo(existant.bottomPct, 6);
    expect(inchange.leftPct).toBeCloseTo(existant.leftPct, 6);
  });

  it('agrandit et décale l’image pour que la part gardée remplisse le cadre', () => {
    // Garder la moitié droite d'une image dans un cadre de 100 px : l'image doit
    // faire 200 px et reculer de 100 px, pour que sa moitié droite tombe dedans.
    const geometrie = cropGeometry(crop(0, 0, 0, 0.5), 100, 60);
    expect(geometrie.widthPx).toBeCloseTo(200, 6);
    expect(geometrie.offsetXPx).toBeCloseTo(-100, 6);
    expect(geometrie.heightPx).toBeCloseTo(60, 6);
    expect(geometrie.offsetYPx).toBeCloseTo(0, 6);
  });

  it('porte le rognage sur le run et le relit', () => {
    const cadre = makeImageRun({
      src: GIF_1PX,
      widthPt: 100,
      heightPt: 50,
      crop: crop(0.25, 0, 0, 0.25),
    });
    expect(cadre.imageCropTopPct).toBeCloseTo(0.25, 6);
    expect(cadre.imageCropLeftPct).toBeCloseTo(0.25, 6);
    // Les bords non rognés restent **absents**, jamais posés à zéro : la forme
    // canonique du formatage veut qu'un attribut non posé n'existe pas.
    expect(cadre.imageCropRightPct).toBeUndefined();
    expect(hasCrop(imageCrop(cadre))).toBe(true);
  });

  it('n’écrit aucune clé de rognage quand il n’y en a pas', () => {
    const cadre = makeImageRun({ src: GIF_1PX, widthPt: 100, heightPt: 50, crop: NO_CROP });
    expect(cadre.imageCropTopPct).toBeUndefined();
    expect(cadre.imageCropLeftPct).toBeUndefined();
  });

  it('laisse deux runs rognés pareil fusionner, et pas les autres', () => {
    // Les quatre valeurs sont des clés plates justement pour cela : un objet ne
    // serait jamais `===` à un autre, et deux runs voisins cesseraient de fusionner.
    const a = makeImageRun({ src: GIF_1PX, widthPt: 20, heightPt: 20, crop: crop(0.1, 0, 0, 0) });
    const b = makeImageRun({ src: GIF_1PX, widthPt: 20, heightPt: 20, crop: crop(0.1, 0, 0, 0) });
    const c = makeImageRun({ src: GIF_1PX, widthPt: 20, heightPt: 20, crop: crop(0.2, 0, 0, 0) });

    expect(sameFormatting(runFormatting(a), runFormatting(b))).toBe(true);
    expect(sameFormatting(runFormatting(a), runFormatting(c))).toBe(false);
  });
});

describe('rognage : ODF fo:clip', () => {
  const crop = (top: number, right: number, bottom: number, left: number): ImageCrop => ({
    topPct: top,
    rightPct: right,
    bottomPct: bottom,
    leftPct: left,
  });

  function docRogne(c: ImageCrop): WriterDocumentState {
    return {
      ...createEmptyDocument('Image rognée'),
      blocks: [
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 72, heightPt: 36, crop: c })],
        }),
      ],
    };
  }

  it('écrit fo:clip dans l’ordre haut, droite, bas, gauche', () => {
    // On garde la moitié droite : le cadre fait 72 pt, l'original en ferait 144,
    // et c'est donc 72 pt qui sont retranchés à gauche.
    const doc = docRogne(crop(0, 0, 0, 0.5));
    const xml = buildContentXml(doc, collectPictures(doc).hrefBySrc);

    const clip = /fo:clip="rect\(([^)]*)\)"/.exec(xml);
    expect(clip).not.toBeNull();
    const valeurs = clip![1]!.trim().split(/\s+/);
    expect(valeurs).toHaveLength(4);
    expect(parseFloat(valeurs[0]!)).toBeCloseTo(0, 1);    // haut
    expect(parseFloat(valeurs[1]!)).toBeCloseTo(0, 1);    // droite
    expect(parseFloat(valeurs[2]!)).toBeCloseTo(0, 1);    // bas
    expect(parseFloat(valeurs[3]!)).toBeCloseTo(72, 1);   // gauche
  });

  it('n’écrit pas fo:clip pour une image entière', () => {
    const doc = docRogne(NO_CROP);
    expect(buildContentXml(doc, collectPictures(doc).hrefBySrc)).not.toContain('fo:clip');
  });

  it('donne des styles distincts à deux rognages différents', () => {
    // `fo:clip` vit dans le style, pas dans le cadre : le partager rognerait les
    // deux images de la même façon.
    const base = createEmptyDocument('Deux rognages');
    const doc: WriterDocumentState = {
      ...base,
      blocks: [
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 40, heightPt: 40, crop: crop(0.1, 0, 0, 0) })],
        }),
        createParagraph('', {
          runs: [makeImageRun({ src: GIF_1PX, widthPt: 40, heightPt: 40, crop: crop(0.4, 0, 0, 0) })],
        }),
      ],
    };
    const xml = buildContentXml(doc, collectPictures(doc).hrefBySrc);
    const styles = [...xml.matchAll(/draw:style-name="(Fr\d+)"/g)].map((m) => m[1]);
    expect(new Set(styles).size).toBe(2);
  });

  it('survit à l’aller-retour ODF', () => {
    const depart = crop(0.25, 0.1, 0, 0.5);
    const doc = docRogne(depart);
    const { hrefBySrc, pictures } = collectPictures(doc);
    const xml = buildContentXml(doc, hrefBySrc);

    const table = new Map(pictures.map((p) => [p.path, GIF_1PX]));
    const { document } = importOdfContent(xml, { pictures: table });

    const cadre = cadreDe(document.blocks[0]);
    expect(cadre).toBeDefined();
    expect(cadre!.imageCropTopPct).toBeCloseTo(depart.topPct, 3);
    expect(cadre!.imageCropRightPct).toBeCloseTo(depart.rightPct, 3);
    expect(cadre!.imageCropLeftPct).toBeCloseTo(depart.leftPct, 3);
  });

  it('ignore un fo:clip illisible plutôt que d’inventer un cadrage', () => {
    const xml =
      '<?xml version="1.0"?><office:document-content ' +
      'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
      'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
      'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
      'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
      'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
      'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<office:automatic-styles>' +
      '<style:style style:name="FrX" style:family="graphic">' +
      '<style:graphic-properties fo:clip="auto"/></style:style>' +
      '</office:automatic-styles>' +
      '<office:body><office:text><text:p>' +
      '<draw:frame draw:style-name="FrX" text:anchor-type="as-char" svg:width="20pt" svg:height="20pt">' +
      `<draw:image xlink:href="${GIF_1PX}"/></draw:frame>` +
      '</text:p></office:text></office:body></office:document-content>';

    const { document } = importOdfContent(xml);
    const cadre = cadreDe(document.blocks[0]);
    expect(cadre).toBeDefined();
    expect(cadre!.imageCropTopPct).toBeUndefined();
  });
});

describe('rognage : PDF', () => {
  it('restreint le tracé par un chemin de rognage', () => {
    const doc: WriterDocumentState = {
      ...createEmptyDocument('PDF rogné'),
      blocks: [
        createParagraph('', {
          runs: [
            makeImageRun({
              src: GIF_1PX,
              widthPt: 72,
              heightPt: 36,
              crop: { topPct: 0, rightPct: 0, bottomPct: 0, leftPct: 0.5 },
            }),
          ],
        }),
      ],
    };
    const layout = paginateDocument(doc, { measurer });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const texte = String.fromCharCode(
      ...exportToPdfBytes(doc, layout, {
        images: new Map([[GIF_1PX, { jpegBytes: jpeg, widthPx: 4, heightPx: 2 }]]),
      }),
    );

    // `re W n` : rectangle, puis chemin de rognage non peint.
    expect(texte).toMatch(/72\.00 36\.00 re W n/);
    // L'image est posée à sa taille **entière** — 144 pt pour une moitié gardée.
    expect(texte).toContain('144.00 0 0 36.00');
  });
});
