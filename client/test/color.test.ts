import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  contrastVerdict,
  hslToRgb,
  hsvToRgb,
  parseHex,
  readableOutline,
  relativeLuminance,
  rgbToHsv,
  toHex,
} from '../src/design/color/color';
import { DOCUMENT_PALETTE, describeColor } from '../src/design/color/palette';

describe('lecture d’une couleur saisie', () => {
  it('accepte les formes courtes, longues, avec ou sans dièse', () => {
    expect(parseHex('#1a56db')).toEqual({ r: 26, g: 86, b: 219 });
    expect(parseHex('1a56db')).toEqual({ r: 26, g: 86, b: 219 });
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex('  #FFF  ')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('refuse une saisie invalide plutôt que de deviner', () => {
    for (const input of ['', '#', '#12', '#12345', 'rouge', '#gggggg', '#1a56db7']) {
      expect(parseHex(input)).toBeNull();
    }
  });

  it('écrit toujours six chiffres en minuscules', () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(toHex({ r: 26, g: 86, b: 219 })).toBe('#1a56db');
  });

  it('borne les canaux hors plage au lieu de produire un hex invalide', () => {
    expect(toHex({ r: -20, g: 300, b: 128.6 })).toBe('#00ff81');
  });
});

describe('conversions RVB ↔ TSV', () => {
  it('fait l’aller-retour sans dérive perceptible', () => {
    const samples = [
      { r: 26, g: 86, b: 219 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 123, g: 45, b: 200 },
    ];
    for (const rgb of samples) {
      expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb);
    }
  });

  it('donne les teintes attendues aux primaires', () => {
    expect(Math.round(rgbToHsv({ r: 255, g: 0, b: 0 }).h)).toBe(0);
    expect(Math.round(rgbToHsv({ r: 0, g: 255, b: 0 }).h)).toBe(120);
    expect(Math.round(rgbToHsv({ r: 0, g: 0, b: 255 }).h)).toBe(240);
  });

  it('traite le gris comme désaturé, quelle que soit la teinte', () => {
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0);
    expect(hslToRgb(200, 0, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
  });
});

describe('contraste WCAG', () => {
  it('retrouve les valeurs de référence', () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
  });

  it('classe correctement les seuils', () => {
    expect(contrastVerdict(21)).toBe('AAA');
    expect(contrastVerdict(4.6)).toBe('AA');
    expect(contrastVerdict(3.2)).toBe('AA-large');
    expect(contrastVerdict(2.4)).toBe('insuffisant');
  });

  it('choisit un liseré lisible sur clair comme sur foncé', () => {
    expect(readableOutline({ r: 255, g: 255, b: 255 })).toBe('#16191d');
    expect(readableOutline({ r: 10, g: 10, b: 10 })).toBe('#ffffff');
  });
});

describe('palette du document', () => {
  it('forme une grille régulière de 8 × 10', () => {
    expect(DOCUMENT_PALETTE).toHaveLength(8);
    for (const row of DOCUMENT_PALETTE) {
      expect(row).toHaveLength(10);
    }
  });

  it('donne un nom accessible unique à chaque pastille', () => {
    // Une pastille sans nom distinct est inutilisable au lecteur d'écran.
    const names = DOCUMENT_PALETTE.flat().map((swatch) => swatch.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0);
  });

  it('ne produit que des couleurs hexadécimales valides', () => {
    for (const swatch of DOCUMENT_PALETTE.flat()) {
      expect(parseHex(swatch.value)).not.toBeNull();
    }
  });

  it('assombrit bien chaque colonne du haut vers le bas', () => {
    for (let column = 0; column < 10; column += 1) {
      // On ignore la première ligne (dégradé de gris, ordre inverse assumé).
      const luminances = DOCUMENT_PALETTE.slice(1).map((row) =>
        relativeLuminance(parseHex(row[column]!.value)!),
      );
      for (let i = 1; i < luminances.length; i += 1) {
        expect(luminances[i]!).toBeLessThan(luminances[i - 1]!);
      }
    }
  });

  it('nomme une couleur connue, et décrit les autres par leur code', () => {
    const known = DOCUMENT_PALETTE[4]![0]!;
    expect(describeColor(known.value)).toBe(known.name);
    expect(describeColor('#123456')).toContain('#123456');
  });
});
