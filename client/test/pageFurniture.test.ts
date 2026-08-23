import { describe, expect, it } from 'vitest';
import {
  bandContentMm,
  bandIsEmpty,
  blockHeightMm,
  blocksOf,
  createBlock,
  DEFAULT_FURNITURE,
  isSafeImageSrc,
  MAX_BLOCKS_PER_BAND,
  type FurnitureBlock,
  footerLine,
  isEmpty,
  readFurniture,
  renderFurniture,
  resolveGeometry,
  showsOn,
  type PageFurniture,
} from '../src/document/pageFurniture';

const contexte = { page: 2, pages: 5, titre: 'Notes de réunion', date: new Date('2026-08-22T10:00:00Z') };

describe('lecture des métadonnées', () => {
  it('accepte une définition complète', () => {
    const lu = readFurniture({ header: 'Société X', footer: 'Confidentiel', pageNumber: true, onFirstPage: false });
    expect(lu).toEqual({
      ...DEFAULT_FURNITURE,
      header: 'Société X',
      footer: 'Confidentiel',
      pageNumber: true,
      onFirstPage: false,
    });
  });

  it('retombe sur les valeurs par défaut si la source est illisible', () => {
    // Ces données viennent du réseau : elles ne sont jamais présumées valides.
    for (const source of [null, undefined, 42, 'texte', []]) {
      expect(readFurniture(source)).toEqual(DEFAULT_FURNITURE);
    }
  });

  it('ignore les champs du mauvais type plutôt que de les propager', () => {
    const lu = readFurniture({ header: 12, footer: null, pageNumber: 'oui', onFirstPage: 0 });
    expect(lu.header).toBe('');
    expect(lu.footer).toBe('');
    expect(lu.pageNumber).toBe(false);
    // Seul un `false` explicite masque la première page.
    expect(lu.onFirstPage).toBe(true);
  });

  it('borne la longueur : un en-tête n’est pas un paragraphe', () => {
    const lu = readFurniture({ header: 'a'.repeat(1000) });
    expect(lu.header.length).toBe(200);
  });
});

describe('substitution des jetons', () => {
  it('remplace numéro, total, titre et date', () => {
    const rendu = renderFurniture('{titre} — {page}/{pages} — {date}', contexte);
    expect(rendu).toBe('Notes de réunion — 2/5 — 22/08/2026');
  });

  it('remplace toutes les occurrences d’un même jeton', () => {
    expect(renderFurniture('{page} sur {pages}, page {page}', contexte)).toBe('2 sur 5, page 2');
  });

  it('laisse intact un texte sans jeton', () => {
    expect(renderFurniture('Document confidentiel', contexte)).toBe('Document confidentiel');
  });
});

describe('ligne de pied de page', () => {
  const base: PageFurniture = { ...DEFAULT_FURNITURE, footer: 'Confidentiel' };

  it('ajoute le numéro de page quand il est demandé', () => {
    expect(footerLine({ ...base, pageNumber: true }, contexte)).toBe('Confidentiel — Page 2 / 5');
  });

  it('affiche le numéro seul si le pied est vide', () => {
    expect(footerLine({ ...DEFAULT_FURNITURE, pageNumber: true }, contexte)).toBe('Page 2 / 5');
  });

  it('n’ajoute rien si le numéro n’est pas demandé', () => {
    expect(footerLine(base, contexte)).toBe('Confidentiel');
  });
});

describe('affichage par page', () => {
  it('masque la première page quand c’est demandé (page de garde)', () => {
    const sansPremiere: PageFurniture = { ...DEFAULT_FURNITURE, header: 'X', onFirstPage: false };
    expect(showsOn(sansPremiere, 1)).toBe(false);
    expect(showsOn(sansPremiere, 2)).toBe(true);
  });

  it('affiche partout par défaut', () => {
    expect(showsOn(DEFAULT_FURNITURE, 1)).toBe(true);
  });

  it('reconnaît une définition vide', () => {
    expect(isEmpty(DEFAULT_FURNITURE)).toBe(true);
    expect(isEmpty({ ...DEFAULT_FURNITURE, header: '  ' })).toBe(true);
    expect(isEmpty({ ...DEFAULT_FURNITURE, pageNumber: true })).toBe(false);
  });
});

describe('réglages de géométrie', () => {
  it('borne les distances hors plage au lieu de casser la page', () => {
    const lu = readFurniture({ headerMm: 0, footerMm: 999, fontSizePt: 40, marginTopMm: 2 });
    expect(lu.headerMm).toBe(5);
    expect(lu.footerMm).toBe(40);
    expect(lu.fontSizePt).toBe(16);
    expect(lu.marginTopMm).toBe(10);
  });

  it('accepte les valeurs décimales au dixième de millimètre', () => {
    expect(readFurniture({ headerMm: 12.34 }).headerMm).toBe(12.3);
  });

  it('refuse un alignement inconnu', () => {
    expect(readFurniture({ headerAlign: 'milieu' }).headerAlign).toBe('left');
    expect(readFurniture({ footerAlign: 'center' }).footerAlign).toBe('center');
  });

  it('repousse la marge du corps pour ne pas chevaucher l’en-tête', () => {
    // Un en-tête posé à 30 mm du bord aurait recouvert un corps commençant à 25 mm.
    const geo = resolveGeometry({ ...DEFAULT_FURNITURE, header: 'Société', headerMm: 30, marginTopMm: 25 });
    // 30 mm jusqu'à l'en-tête, plus la bande elle-même : une ligne de 9 pt
    // interlignée à 1,3, et les 5 mm d'écart au corps. La réserve se calcule,
    // elle n'est plus forfaitaire.
    expect(geo.headerBandMm).toBe(9.1);
    expect(geo.marginTopMm).toBe(39.1);
  });

  it('laisse la marge intacte quand l’en-tête tient dans la sienne', () => {
    const geo = resolveGeometry({ ...DEFAULT_FURNITURE, header: 'Société', headerMm: 12, marginTopMm: 25 });
    expect(geo.marginTopMm).toBe(25);
  });

  it('ne réserve pas de place pour un en-tête vide', () => {
    const geo = resolveGeometry({ ...DEFAULT_FURNITURE, headerMm: 35, marginTopMm: 20 });
    expect(geo.marginTopMm).toBe(20);
  });

  it('réserve la place du pied dès que la numérotation est active', () => {
    const geo = resolveGeometry({ ...DEFAULT_FURNITURE, pageNumber: true, footerMm: 30, marginBottomMm: 20 });
    expect(geo.marginBottomMm).toBe(39.1);
  });

  it('réserve davantage quand l’en-tête est en gros corps', () => {
    // Régression : la réserve forfaitaire de 8 mm ne couvrait pas une bande de
    // 16 pt (9,8 mm), et l'en-tête recouvrait la première ligne du texte.
    const gros = resolveGeometry({ ...DEFAULT_FURNITURE, header: 'Société', headerMm: 12, fontSizePt: 16 });
    const petit = resolveGeometry({ ...DEFAULT_FURNITURE, header: 'Société', headerMm: 12, fontSizePt: 6 });

    expect(gros.headerBandMm).toBeGreaterThan(petit.headerBandMm);
    expect(gros.headerBandMm).toBe(12.3);
    // 12 + 12,3 tient encore dans les 25 mm de marge : rien à repousser ici.
    expect(gros.marginTopMm).toBe(25);
    // Mais posé à 20 mm du bord, il faut bien pousser le corps.
    const bas = resolveGeometry({ ...DEFAULT_FURNITURE, header: 'Société', headerMm: 20, fontSizePt: 16 });
    expect(bas.marginTopMm).toBe(32.3);
  });
});


const bloc = (partiel: Partial<FurnitureBlock> = {}): FurnitureBlock => ({
  ...createBlock('header', 'text'),
  ...partiel,
});

describe('adresses d’image', () => {
  it('accepte un objet déposé sur notre serveur', () => {
    expect(
      isSafeImageSrc(
        '/api/v1/documents/01a02580-2135-7002-a0d3-7de5ce6db7de/assets/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png',
      ),
    ).toBe(true);
  });

  it('accepte une adresse http(s)', () => {
    expect(isSafeImageSrc('https://exemple.fr/logo.png')).toBe(true);
    expect(isSafeImageSrc('http://exemple.fr/logo.png')).toBe(true);
  });

  it('refuse tout ce qui pourrait exécuter du code', () => {
    // Ces valeurs viennent des métadonnées répliquées : un participant les
    // choisit, et elles finissent dans un attribut `src` chez tous les autres.
    for (const hostile of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '',
      42,
      null,
    ]) {
      expect(isSafeImageSrc(hostile)).toBe(false);
    }
  });

  it('refuse un chemin relatif qui n’est pas un objet de l’API', () => {
    expect(isSafeImageSrc('/api/v1/documents/../../etc/passwd')).toBe(false);
    expect(isSafeImageSrc('/etc/passwd')).toBe(false);
  });
});

describe('lecture des blocs', () => {
  it('ramène chaque réglage dans ses bornes', () => {
    const lu = readFurniture({
      blocks: [
        { kind: 'text', band: 'header', x: 5, y: -3, fontSizePt: 400, color: 'rouge', text: 'a'.repeat(500) },
      ],
    });

    expect(lu.blocks).toHaveLength(1);
    const b = lu.blocks[0]!;
    expect(b.x).toBe(1);
    expect(b.y).toBe(0);
    expect(b.fontSizePt).toBe(48);
    // Une couleur non reconnue retombe sur la valeur par défaut : jamais recopiée
    // telle quelle dans une feuille de style.
    expect(b.color).toBe('#475467');
    expect(b.text.length).toBe(200);
  });

  it('écarte une image dont l’adresse est refusée', () => {
    const lu = readFurniture({
      blocks: [
        { kind: 'image', band: 'header', src: 'javascript:alert(1)' },
        { kind: 'image', band: 'header', src: 'https://exemple.fr/logo.png' },
      ],
    });

    expect(lu.blocks).toHaveLength(1);
    expect(lu.blocks[0]!.src).toBe('https://exemple.fr/logo.png');
  });

  it('plafonne le nombre de blocs bande par bande', () => {
    const trop = Array.from({ length: 40 }, (_, i) => ({
      kind: 'text',
      band: i % 2 === 0 ? 'header' : 'footer',
      text: `bloc ${i}`,
    }));
    const lu = readFurniture({ blocks: trop });

    // Le plafond vaut par bande : en remplir une ne DOIT pas condamner l'autre.
    expect(blocksOf(lu, 'header')).toHaveLength(MAX_BLOCKS_PER_BAND);
    expect(blocksOf(lu, 'footer')).toHaveLength(MAX_BLOCKS_PER_BAND);
  });

  it('ignore une liste de blocs qui n’en est pas une', () => {
    expect(readFurniture({ blocks: 'oui' }).blocks).toEqual([]);
    expect(readFurniture({}).blocks).toEqual([]);
  });
});

describe('hauteur de bande', () => {
  it('vaut zéro quand la bande est vide', () => {
    expect(bandContentMm(DEFAULT_FURNITURE, 'header')).toBe(0);
    expect(bandIsEmpty(DEFAULT_FURNITURE, 'header')).toBe(true);
  });

  it('suit le bloc le plus bas, pas le premier venu', () => {
    const f = {
      ...DEFAULT_FURNITURE,
      blocks: [
        bloc({ kind: 'image', src: 'https://x.fr/a.png', y: 0, heightMm: 10 }),
        bloc({ kind: 'image', src: 'https://x.fr/b.png', y: 12, heightMm: 20 }),
        bloc({ kind: 'image', src: 'https://x.fr/c.png', y: 4, heightMm: 6 }),
      ],
    };
    expect(bandContentMm(f, 'header')).toBe(32);
  });

  it('repousse le corps du texte pour laisser passer un logo', () => {
    // Transposition de `SwHeadFootFrm::GrowFrm` : la bande grandit, et c'est la
    // marge qui cède — jamais le texte qui se fait recouvrir.
    const f = {
      ...DEFAULT_FURNITURE,
      headerMm: 10,
      blocks: [bloc({ kind: 'image', src: 'https://x.fr/logo.png', y: 0, heightMm: 30 })],
    };
    const geo = resolveGeometry(f);

    expect(geo.headerContentMm).toBe(30);
    expect(geo.headerBandMm).toBe(35);
    expect(geo.marginTopMm).toBe(45);
  });

  it('ne réserve rien dans la bande d’en face', () => {
    const f = {
      ...DEFAULT_FURNITURE,
      blocks: [bloc({ band: 'footer', kind: 'image', src: 'https://x.fr/logo.png', heightMm: 30 })],
    };
    const geo = resolveGeometry(f);

    expect(geo.marginTopMm).toBe(25);
    expect(geo.marginBottomMm).toBe(47);
  });

  it('mesure un bloc de texte à son interligne', () => {
    expect(blockHeightMm(bloc({ fontSizePt: 10 }))).toBe(4.6);
    expect(blockHeightMm(bloc({ kind: 'image', heightMm: 18 }))).toBe(18);
  });
});
