/**
 * Tests unitaires du modèle et des calculs d'en-tête et pied de page
 * Transposition SwPageDesc / SwHeaderFrm / SwFooterFrm OpenOffice.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FURNITURE,
  formatPageNumber,
  FURNITURE_PRESETS,
  getThreeZones,
  renderFurniture,
  resolveGeometry,
  showsOn,
  snapAxis,
  type PageFurniture,
} from '../src/domain/document/pageFurniture';

describe('Modèle de mobilier de page (PageFurniture)', () => {
  it('supporte le rendu des jetons dynamiques', () => {
    const contexte = {
      page: 3,
      pages: 12,
      titre: 'Rapport Annuel',
      auteur: 'Marie Curie',
      date: '2026-08-24',
      heure: '14:30',
    };

    expect(renderFurniture('{titre} — Page {page}/{pages}', contexte)).toBe('Rapport Annuel — Page 3/12');
    expect(renderFurniture('{auteur} ({date} à {heure})', contexte)).toBe('Marie Curie (2026-08-24 à 14:30)');
  });

  it('génère des formats de numéros de page étendus (Arabes, Romains, Alphabétiques)', () => {
    expect(formatPageNumber(1, 5, 'page')).toBe('Page 1');
    expect(formatPageNumber(1, 5, 'page-sur')).toBe('Page 1 sur 5');
    expect(formatPageNumber(2, 5, 'tiret')).toBe('— 2 —');
    expect(formatPageNumber(4, 5, 'roman-upper')).toBe('IV');
    expect(formatPageNumber(4, 5, 'roman-lower')).toBe('iv');
    expect(formatPageNumber(14, 50, 'roman-upper')).toBe('XIV');
    expect(formatPageNumber(1, 26, 'alpha-upper')).toBe('A');
    expect(formatPageNumber(2, 26, 'alpha-lower')).toBe('b');
    expect(formatPageNumber(27, 50, 'alpha-upper')).toBe('AA');
  });

  it('gère l’extraction des 3 zones (Gauche, Centre, Droite)', () => {
    const furniture: PageFurniture = {
      ...DEFAULT_FURNITURE,
      headerLeft: 'Société ACME',
      headerCenter: 'Confidentiel',
      headerRight: 'Page {page}',
      differentEvenOdd: true,
      headerEvenLeft: 'Page {page}',
      headerEvenCenter: 'Confidentiel',
      headerEvenRight: 'Société ACME',
    };

    // Page impaire (page 1 ou 3)
    const zonesImpaires = getThreeZones(furniture, 'header', 1);
    expect(zonesImpaires.left).toBe('Société ACME');
    expect(zonesImpaires.center).toBe('Confidentiel');
    expect(zonesImpaires.right).toBe('Page {page}');

    // Page paire (page 2)
    const zonesPaires = getThreeZones(furniture, 'header', 2);
    expect(zonesPaires.left).toBe('Page {page}');
    expect(zonesPaires.center).toBe('Confidentiel');
    expect(zonesPaires.right).toBe('Société ACME');
  });

  it('calcule la géométrie dynamique (SwHeaderFrm / SwFooterFrm)', () => {
    const furniture: PageFurniture = {
      ...DEFAULT_FURNITURE,
      marginTopMm: 20,
      marginBottomMm: 20,
      headerMm: 12,
      footerMm: 12,
      header: 'En-tête de base',
      footer: 'Pied de base',
    };

    const geom = resolveGeometry(furniture, 1);
    expect(geom.headerContentMm).toBeGreaterThan(0);
    expect(geom.footerContentMm).toBeGreaterThan(0);
    expect(geom.effectiveMarginTopMm).toBeGreaterThanOrEqual(20);
    expect(geom.effectiveMarginBottomMm).toBeGreaterThanOrEqual(20);
  });

  it('respecte les règles d’affichage selon la page (showsOn / onFirstPage)', () => {
    const furniture: PageFurniture = {
      ...DEFAULT_FURNITURE,
      onFirstPage: false,
    };

    expect(showsOn(furniture, 1)).toBe(false);
    expect(showsOn(furniture, 2)).toBe(true);

    const furnitureAlways: PageFurniture = {
      ...DEFAULT_FURNITURE,
      onFirstPage: true,
    };
    expect(showsOn(furnitureAlways, 1)).toBe(true);
  });

  it('calcule les repères magnétiques (snapAxis)', () => {
    const reperes = [
      { coordMm: 25, label: 'Marge gauche' },
      { coordMm: 105, label: 'Centre' },
      { coordMm: 185, label: 'Marge droite' },
    ];

    // Proche du centre (105.3 mm) -> aimantation à 105 mm
    const snap = snapAxis(105.3, 10, reperes, 1);
    expect(snap.valeurMm).toBe(105);
    expect(snap.reperes).toContain('Centre');

    // Loin de tout repère (50 mm) -> pas d'aimantation
    const pasDeSnap = snapAxis(50, 10, reperes, 1);
    expect(pasDeSnap.valeurMm).toBe(50);
    expect(pasDeSnap.reperes).toHaveLength(0);
  });
});

/**
 * Zones et ligne simple décrivent la **même** bande.
 *
 * La ligne simple n'est pas la valeur de repli d'une zone mais celle de la
 * bande entière : la reverser dans la zone que désigne l'alignement faisait
 * apparaître deux fois un texte écrit dans les deux représentations — ce que
 * font les préréglages et tout en-tête importé d'ODF. « CONFIDENTIEL » posé en
 * zone droite puis aligné à gauche s'affichait à gauche *et* à droite.
 */
describe('Zones et ligne simple d’une bande', () => {
  const confidentiel: PageFurniture = {
    ...DEFAULT_FURNITURE,
    headerRight: 'CONFIDENTIEL',
    // La doublure : un document ancien, ou importé, porte les deux.
    header: 'CONFIDENTIEL',
  };

  it('ne peint pas la ligne simple quand une zone porte déjà du texte', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const zones = getThreeZones({ ...confidentiel, headerAlign: align }, 'header', 2);
      const occurrences = [zones.left, zones.center, zones.right].filter(
        (zone) => zone === 'CONFIDENTIEL',
      );
      expect(occurrences).toHaveLength(1);
      expect(zones.right).toBe('CONFIDENTIEL');
    }
  });

  it('peint la ligne simple là où l’alignement la place, zones vides', () => {
    const simple: PageFurniture = { ...DEFAULT_FURNITURE, header: 'Mention' };

    expect(getThreeZones({ ...simple, headerAlign: 'left' }, 'header', 2).left).toBe('Mention');
    expect(getThreeZones({ ...simple, headerAlign: 'center' }, 'header', 2).center).toBe('Mention');
    expect(getThreeZones({ ...simple, headerAlign: 'right' }, 'header', 2).right).toBe('Mention');

    // Et une seule fois, quel que soit l'alignement.
    const zones = getThreeZones({ ...simple, headerAlign: 'center' }, 'header', 2);
    expect([zones.left, zones.center, zones.right].filter(Boolean)).toEqual(['Mention']);
  });

  it('garde le numéro de page dans un pied resté vide', () => {
    const pied: PageFurniture = { ...DEFAULT_FURNITURE, pageNumber: true };
    expect(getThreeZones(pied, 'footer', 2).right).toBe('{page}');

    // Mais il s'efface dès que le pied porte un contenu à lui.
    const occupe: PageFurniture = { ...pied, footerCenter: 'Interne' };
    const zones = getThreeZones(occupe, 'footer', 2);
    expect(zones.center).toBe('Interne');
    expect(zones.right).toBe('');
  });

  it('n’écrit jamais les deux représentations dans un préréglage', () => {
    // L'invariant qui empêche la doublure de revenir : un préréglage remplit
    // les zones ou la ligne simple, jamais les deux.
    for (const preset of FURNITURE_PRESETS) {
      const patch = preset.patch as Record<string, unknown>;
      const prefixe = preset.band;
      const zones = ['Left', 'Center', 'Right']
        .map((suffixe) => (patch[`${prefixe}${suffixe}`] as string | undefined) ?? '')
        .filter((valeur) => valeur.length > 0);
      const ligne = (patch[prefixe] as string | undefined) ?? '';

      if (zones.length > 0) {
        expect(`${preset.id}: ${ligne}`).toBe(`${preset.id}: `);
      }
    }
  });
});
