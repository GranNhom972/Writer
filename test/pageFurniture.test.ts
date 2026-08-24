/**
 * Tests unitaires du modèle et des calculs d'en-tête et pied de page
 * Transposition SwPageDesc / SwHeaderFrm / SwFooterFrm OpenOffice.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FURNITURE,
  formatPageNumber,
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
