import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  computeSpacers,
  countPages,
  type BlockBox,
  type PageGeometry,
} from '../src/editor/pagination-plugin';

/**
 * Page A4 à 96 dpi : 1123 px de haut, marges de 94 px.
 *
 * Sans gouttière : ces cas éprouvent le report en lui-même. Le pas de feuille
 * (page + gouttière) a son propre bloc plus bas.
 */
const A4: PageGeometry = { pageHeight: 1123, marginTop: 94, marginBottom: 94, gap: 0 };

const bloc = (pos: number, top: number, height: number, forcedBreak = false): BlockBox => ({
  pos,
  top,
  height,
  forcedBreak,
});

describe('cales de pagination', () => {
  it('ne pose aucune cale tant que tout tient sur la page', () => {
    const blocs = [bloc(0, 94, 200), bloc(1, 294, 200), bloc(2, 494, 200)];
    expect(computeSpacers(blocs, A4)).toEqual([]);
  });

  it('repousse au début de la page suivante le bloc qui déborde', () => {
    // La zone utile de la page 1 s'arrête à 1123 - 94 = 1029 px.
    const blocs = [bloc(0, 94, 900), bloc(1, 994, 200)];
    const cales = computeSpacers(blocs, A4);

    expect(cales).toHaveLength(1);
    expect(cales[0]!.pos).toBe(1);
    // Le bloc doit commencer à 1123 + 94 = 1217 px.
    expect(cales[0]!.height).toBe(1217 - 994);
  });

  it('applique un saut manuel même si la page n’est pas pleine', () => {
    // C'est précisément ce que Ctrl+Entrée doit produire : le trait reste en fin
    // de page, et c'est le bloc SUIVANT qui démarre la page d'après.
    const blocs = [bloc(0, 94, 100), bloc(1, 194, 2, true), bloc(2, 196, 100)];
    const cales = computeSpacers(blocs, A4);

    expect(cales).toHaveLength(1);
    expect(cales[0]!.pos).toBe(2);
    expect(196 + cales[0]!.height).toBe(1217);
  });

  it('ne pousse rien si le saut manuel termine le document', () => {
    const blocs = [bloc(0, 94, 100), bloc(1, 194, 2, true)];
    expect(computeSpacers(blocs, A4)).toEqual([]);
  });

  it('enchaîne plusieurs pages sans dériver', () => {
    // Chaque cale décale les blocs suivants : le cumul doit être pris en compte.
    const blocs = [bloc(0, 94, 900), bloc(1, 994, 900), bloc(2, 1894, 900)];
    const cales = computeSpacers(blocs, A4);

    expect(cales).toHaveLength(2);
    expect(994 + cales[0]!.height).toBe(1217);
    // Après la première cale, le second bloc démarre à 1217 et finit à 2117 ;
    // le troisième doit atterrir en haut de la page 3.
    const decalage = cales[0]!.height;
    expect(1894 + decalage + cales[1]!.height).toBe(2 * 1123 + 94);
  });

  it('ne repousse pas un bloc déjà en tête de page', () => {
    const blocs = [bloc(0, 94, 1029)];
    expect(computeSpacers(blocs, A4)).toEqual([]);
  });

  it('gère plusieurs sauts manuels consécutifs', () => {
    const blocs = [
      bloc(0, 94, 50),
      bloc(1, 144, 2, true),
      bloc(2, 146, 50),
      bloc(3, 196, 2, true),
      bloc(4, 198, 50),
    ];
    const cales = computeSpacers(blocs, A4);
    expect(cales).toHaveLength(2);
    // Ce sont bien les blocs qui SUIVENT les sauts qui sont repoussés.
    expect(cales.map((c) => c.pos)).toEqual([2, 4]);
  });

  it('refuse une géométrie absurde plutôt que de boucler', () => {
    expect(computeSpacers([bloc(0, 0, 100)], { pageHeight: 100, marginTop: 60, marginBottom: 60 })).toEqual([]);
  });

  it('ne produit jamais de cale de hauteur négative', () => {
    const blocs = [bloc(0, 94, 4000)];
    for (const cale of computeSpacers(blocs, A4)) {
      expect(cale.height).toBeGreaterThan(0);
    }
  });
});

describe('comptage des pages', () => {
  it('compte au moins une page, même vide', () => {
    expect(countPages(0, A4)).toBe(1);
    expect(countPages(10, A4)).toBe(1);
  });

  it('compte une page par hauteur entamée, au pixel de tolérance près', () => {
    expect(countPages(1123, A4)).toBe(1);
    // 1124 px, soit un pixel de plus : c'est un arrondi, pas une page de plus.
    expect(countPages(1124, A4)).toBe(1);
    expect(countPages(1130, A4)).toBe(2);
    expect(countPages(3369, A4)).toBe(3);
  });

  it('tolère l’arrondi du navigateur', () => {
    // Régression : une page A4 mesure 1122,52 px, le navigateur rapporte 1123.
    // Sans tolérance, un document d'une page en annonçait deux.
    const reel: PageGeometry = { pageHeight: 1122.5197, marginTop: 94.4882, marginBottom: 94.4882 };
    expect(countPages(1123, reel)).toBe(1);
    expect(countPages(1122.52, reel)).toBe(1);
    expect(countPages(1200, reel)).toBe(2);
  });
});

/** 5 mm de gouttière à 96 dpi, comme `GAPBETWEENPAGES` chez Writer. */
const GOUTTIERE = 18.9;

describe('gouttière entre feuilles', () => {
  const avecGouttiere: PageGeometry = { ...A4, gap: GOUTTIERE };

  it('pose le bloc reporté sur la feuille suivante, gouttière comprise', () => {
    // Sans compter la gouttière, le bloc atterrissait 18,9 px trop haut : le texte
    // débordait de la feuille dessinée, un peu plus à chaque page.
    const blocs = [bloc(0, 94, 900), bloc(1, 994, 200)];
    const cales = computeSpacers(blocs, avecGouttiere);

    expect(cales).toHaveLength(1);
    expect(994 + cales[0]!.height).toBe(Math.round(1123 + GOUTTIERE + 94));
  });

  it('cumule la gouttière page après page', () => {
    const blocs = [bloc(0, 94, 900), bloc(1, 994, 900), bloc(2, 1894, 900)];
    const cales = computeSpacers(blocs, avecGouttiere);
    const decalage = cales[0]!.height;

    expect(cales).toHaveLength(2);
    expect(1894 + decalage + cales[1]!.height).toBe(Math.round(2 * (1123 + GOUTTIERE) + 94));
  });

  it('compte les pages au pas de feuille, pas à la hauteur de page', () => {
    expect(countPages(1123, avecGouttiere)).toBe(1);
    expect(countPages(1200, avecGouttiere)).toBe(2);
    expect(countPages(3 * (1123 + GOUTTIERE), avecGouttiere)).toBe(3);
  });
});

describe('marges haute et basse distinctes', () => {
  // Les confondre par leur maximum — ce que faisait la vue — rognait la page du
  // côté de la plus petite : une bande utilisable trop courte de 56 px.
  const dissymetrique: PageGeometry = { pageHeight: 1123, marginTop: 150, marginBottom: 94, gap: 0 };

  it('démarre le corps à la marge haute et l’arrête à la marge basse', () => {
    // La bande utile va de 150 à 1123 - 94 = 1029. En confondant les deux marges
    // par leur maximum, elle s'arrêtait à 973 et ce second bloc était reporté.
    const blocs = [bloc(0, 150, 700), bloc(1, 850, 179)];
    expect(computeSpacers(blocs, dissymetrique)).toEqual([]);
  });

  it('reporte dès que le bas de bande est dépassé', () => {
    const blocs = [bloc(0, 150, 700), bloc(1, 850, 180)];
    const cales = computeSpacers(blocs, dissymetrique);

    expect(cales).toHaveLength(1);
    expect(850 + cales[0]!.height).toBe(1123 + 150);
  });
});

describe('étendue du contenu', () => {
  it('rend le bas du dernier bloc, reports appliqués', () => {
    const blocs = [bloc(0, 94, 900), bloc(1, 994, 200)];
    const { contentBottom } = computeLayout(blocs, A4);
    expect(contentBottom).toBe(1217 + 200);
  });

  it('vaut le bas du contenu quand rien n’est reporté', () => {
    const { contentBottom } = computeLayout([bloc(0, 94, 300)], A4);
    expect(contentBottom).toBe(394);
  });

  it('ne dépend pas du nombre de blocs vides qui suivent', () => {
    const { contentBottom } = computeLayout([], A4);
    expect(contentBottom).toBe(0);
  });
});
