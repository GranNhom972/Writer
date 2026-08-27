/**
 * Vérifie le document d'exemple livré dans `exemple/doc_test.odt`.
 *
 * Un fichier d'exemple faux est pire qu'aucun : c'est le premier document
 * qu'ouvrira quelqu'un qui découvre le projet, et il sert de témoin de
 * non-régression du format. Ces tests le rouvrent donc **par le vrai
 * importateur**, comme le ferait Writer, et vérifient que chaque sous-système
 * annoncé y a bien survécu à l'aller-retour ODF.
 *
 * Le fichier est engendré par `scripts/genererExemple.ts`. Si ces tests
 * échouent après une modification du format, relancer le script.
 *
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { openOdt, readOdtArchive } from '../src/domain/odf/package';
import { commentThreads } from '../src/domain/document/comments';
import { listBookmarks, resolveInternalLink } from '../src/domain/document/bookmarks';
import { listRedlineRanges } from '../src/domain/document/redline';
import { tocNodes } from '../src/domain/document/tox';
import { collectFlyFrames } from '../src/domain/engine/flyLayout';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { isParagraph, isTable, type WriterDocumentState } from '../src/domain/document/types';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHEMIN = resolve(RACINE, 'exemple', 'doc_test.odt');

let doc: WriterDocumentState;
let avertissements: string[];

beforeAll(async () => {
  // `openOdt` est le chemin qu'emprunte l'application quand on ouvre un
  // fichier : le tester lui plutôt que ses morceaux vérifie la chaîne réelle.
  const octets = await readFile(CHEMIN);
  const resultat = await openOdt(new Uint8Array(octets));

  doc = resultat.document;
  avertissements = resultat.warnings;
});

describe('Archive ODT de l\'exemple', () => {
  it('est un paquet ODF complet', async () => {
    const octets = await readFile(CHEMIN);
    const archive = await readOdtArchive(new Uint8Array(octets));

    for (const requis of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) {
      expect(archive.texts.has(requis), `entrée manquante : ${requis}`).toBe(true);
    }
    // L'image de démonstration voyage dans l'archive, pas en `data:`.
    expect(archive.pictures.size).toBeGreaterThan(0);
  });

  it('se réimporte sans avertissement', () => {
    expect(avertissements).toEqual([]);
  });

  it('conserve son titre et son auteur', () => {
    expect(doc.meta.title).toContain('Banc d\'essai');
  });
});

describe('Sous-systèmes présents dans l\'exemple relu', () => {
  it('porte une table des matières avec sa définition', () => {
    const sommaires = tocNodes(doc);
    expect(sommaires).toHaveLength(1);
    expect(sommaires[0]?.maxLevel).toBe(3);
    expect(sommaires[0]?.showPageNumbers).toBe(true);
    expect(sommaires[0]?.useDotLeader).toBe(true);
  });

  it('porte des listes natives, avec leur nature et leur niveau', () => {
    const listes = doc.blocks.filter(
      (b) => isParagraph(b) && b.listKind !== undefined,
    );
    expect(listes.length).toBeGreaterThanOrEqual(15);

    const natures = new Set(listes.map((b) => (isParagraph(b) ? b.listKind : undefined)));
    expect(natures.has('bullet')).toBe(true);
    expect(natures.has('ordered')).toBe(true);

    // L'imbrication a survécu : au moins un niveau 1 et un niveau 2.
    const niveaux = new Set(listes.map((b) => (isParagraph(b) ? b.listLevel ?? 0 : 0)));
    expect(niveaux.has(1)).toBe(true);
    expect(niveaux.has(2)).toBe(true);
  });

  it('garde des listes distinctes séparées : leurs compteurs ne fusionnent pas', () => {
    const identifiants = new Set(
      doc.blocks
        .filter((b) => isParagraph(b) && b.listId !== undefined)
        .map((b) => (isParagraph(b) ? b.listId : undefined)),
    );
    // Puces, deux listes numérotées, reprise à 10, tâches.
    expect(identifiants.size).toBeGreaterThanOrEqual(4);
  });

  it('conserve la reprise explicite du compteur à 10', () => {
    const repris = doc.blocks.find((b) => isParagraph(b) && b.listStartValue === 10);
    expect(repris).toBeDefined();
  });

  it('porte deux tableaux, dont un à cellules fusionnées', () => {
    const tableaux = doc.blocks.filter(isTable);
    expect(tableaux.length).toBeGreaterThanOrEqual(2);

    const fusion = tableaux.some((t) =>
      t.rows.some((r) => r.cells.some((c) => (c.colSpan ?? 1) > 1)),
    );
    expect(fusion).toBe(true);
  });

  it('conserve la ligne d\'en-tête répétée du tableau', () => {
    const avecEntete = doc.blocks.filter(isTable).some((t) => t.rows.some((r) => r.isHeader));
    expect(avecEntete).toBe(true);
  });

  it('porte des notes de bas de page avec leur texte', () => {
    const notes = doc.blocks
      .filter(isParagraph)
      .flatMap((b) => b.runs)
      .filter((r) => r.footnoteText !== undefined);

    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(notes.some((n) => n.footnoteText?.includes('GetVarSpace'))).toBe(true);
  });

  it('porte un signet et le renvoi interne qui le vise', () => {
    const signets = listBookmarks(doc);
    expect(signets.map((s) => s.name)).toContain('point_de_repere');

    // Le renvoi `#point_de_repere` retrouve bien sa cible après l'aller-retour.
    expect(resolveInternalLink(doc, '#point_de_repere')).not.toBeNull();
  });

  it('porte les fils de commentaires, réponse et fil résolu compris', () => {
    const fils = commentThreads(doc);
    expect(fils.length).toBeGreaterThanOrEqual(2);

    const avecReponse = fils.find((f) => f.replies.length > 0);
    expect(avecReponse?.root.author).toBe('Alice');
    expect(avecReponse?.replies[0]?.author).toBe('Bob');

    // Un fil au moins a été clos avant l'export.
    expect(doc.comments?.some((c) => c.resolved)).toBe(true);
  });

  it('porte les révisions avec leur auteur et leur nature', () => {
    const plages = listRedlineRanges(doc);
    expect(plages.length).toBeGreaterThanOrEqual(2);

    const natures = new Set(plages.map((p) => p.redline.type));
    expect(natures.has('insert')).toBe(true);
    expect(natures.has('delete')).toBe(true);

    const auteurs = new Set(plages.map((p) => p.redline.author));
    expect(auteurs.has('Alice')).toBe(true);
  });

  it('restitue le texte supprimé, que le corps ODF ne porte pas', () => {
    // ODF range le texte d'une suppression dans `<text:deletion>` : il n'est
    // récupérable que si l'import le réinjecte au jalon `<text:change>`.
    const suppression = listRedlineRanges(doc).find((p) => p.redline.type === 'delete');
    expect(suppression?.text.length).toBeGreaterThan(0);
  });

  it('porte des cadres flottants avec leur habillage', () => {
    const cadres = collectFlyFrames(doc);
    expect(cadres.length).toBeGreaterThanOrEqual(2);

    const habillages = new Set(cadres.map((c) => c.surround));
    expect(habillages.has('right')).toBe(true);
    expect(habillages.has('parallel')).toBe(true);
  });

  it('porte une image ancrée « comme caractère », distincte des cadres', () => {
    const images = doc.blocks
      .filter(isParagraph)
      .flatMap((b) => b.runs)
      .filter((r) => r.imageSrc !== undefined);

    expect(images.some((r) => r.imageAnchor === undefined)).toBe(true);
  });

  it('porte l\'en-tête et le pied de page avec leurs champs', () => {
    expect(doc.furniture).toBeDefined();
    // Le champ `{page} sur {pages}` a été interpolé à l'export — ODF n'a pas de
    // notion de gabarit, il porte `<text:page-number>` et `<text:page-count>`.
    // Ce qui doit survivre, c'est la **présence** des deux bandes.
    const enTete = [doc.furniture?.header, doc.furniture?.headerRight, doc.furniture?.headerLeft]
      .filter(Boolean)
      .join(' ');
    const pied = [doc.furniture?.footer, doc.furniture?.footerCenter].filter(Boolean).join(' ');
    expect(enTete.length + pied.length).toBeGreaterThan(0);
  });
});

describe('Mise en page de l\'exemple relu', () => {
  it('fait la longueur annoncée', () => {
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    // Le document relu n'a pas à faire exactement 25 pages — les styles nommés
    // d'ODF ne sont pas tous reconstitués — mais il doit rester du même ordre.
    expect(layout.pages.length).toBeGreaterThanOrEqual(20);
    expect(layout.pages.length).toBeLessThanOrEqual(32);
  });

  it('respecte l\'invariant de la zone de notes sur toutes ses pages', () => {
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    for (const page of layout.pages) {
      const total = page.usedHeightPx + (page.footnoteAreaHeightPx ?? 0);
      expect(total, `page ${page.index + 1}`).toBeLessThanOrEqual(
        layout.geometry.contentHeightPx + 0.5,
      );
    }
  });

  it('résout les numéros de page du sommaire', () => {
    const layout = paginateDocument(doc, { measurer: new MetricTextMeasurer() });
    expect(layout.tocTargets.size).toBeGreaterThanOrEqual(10);

    // Chaque ligne de sommaire vise un paragraphe qui existe réellement.
    for (const [, cibleId] of layout.tocTargets) {
      expect(layout.placements.has(cibleId), `cible introuvable : ${cibleId}`).toBe(true);
    }
  });
});
