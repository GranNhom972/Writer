// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Unit tests of the model and the computations for page headers and footers. A transposition of OpenOffice's SwPageDesc / SwHeaderFrm / SwFooterFrm.
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

    // Odd page (page 1 or 3)
    const zonesImpaires = getThreeZones(furniture, 'header', 1);
    expect(zonesImpaires.left).toBe('Société ACME');
    expect(zonesImpaires.center).toBe('Confidentiel');
    expect(zonesImpaires.right).toBe('Page {page}');

    // Even page (page 2)
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

    // Close to the center (105.3 mm) -> snaps to 105 mm
    const snap = snapAxis(105.3, 10, reperes, 1);
    expect(snap.valeurMm).toBe(105);
    expect(snap.reperes).toContain('Centre');

    // Far from any guide (50 mm) -> no snapping
    const pasDeSnap = snapAxis(50, 10, reperes, 1);
    expect(pasDeSnap.valeurMm).toBe(50);
    expect(pasDeSnap.reperes).toHaveLength(0);
  });
});

/**
 * Zones and the single line describe the **same** band.
 *
 * The single line is not the fallback value of a zone but that of the whole band: pouring it into the zone designated by the alignment made a text written in both representations appear twice, which is what the presets and any
 * header imported from ODF do. "CONFIDENTIEL" put in the right zone and then aligned to the left was displayed on the left *and* on the right.
 */
describe('Zones et ligne simple d’une bande', () => {
  const confidentiel: PageFurniture = {
    ...DEFAULT_FURNITURE,
    headerRight: 'CONFIDENTIEL',
    // The duplicate: an old or imported document carries both.
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

    // And only once, whatever the alignment.
    const zones = getThreeZones({ ...simple, headerAlign: 'center' }, 'header', 2);
    expect([zones.left, zones.center, zones.right].filter(Boolean)).toEqual(['Mention']);
  });

  it('garde le numéro de page dans un pied resté vide', () => {
    const pied: PageFurniture = { ...DEFAULT_FURNITURE, pageNumber: true };
    expect(getThreeZones(pied, 'footer', 2).right).toBe('{page}');

    // But it disappears as soon as the footer carries content of its own.
    const occupe: PageFurniture = { ...pied, footerCenter: 'Interne' };
    const zones = getThreeZones(occupe, 'footer', 2);
    expect(zones.center).toBe('Interne');
    expect(zones.right).toBe('');
  });

  it('n’écrit jamais les deux représentations dans un préréglage', () => {
    // The invariant that keeps the duplicate from coming back: a preset fills the zones or the single line, never both.
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
