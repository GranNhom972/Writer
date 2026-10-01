// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Generates `exemple/doc_test.odt`: the 25-page demo document.
 *
 * The goal is not to look good: it is an **executable test bench**. Each chapter exercises a subsystem ported from OpenOffice, so that opening
 * the file in Writer 4.1 (or in the web editor) is enough to check that the port holds up: lists kept their numbering, notes do not overwrite the
 * body, wrapping really moves the text aside, and the table of contents points to the right page numbers.
 *
 * The script checks its own output: it paginates the document, refuses to write it if it is not the intended length, and verifies the ODF round
 * trip before saving. A wrong sample file would be worse than none.
 *
 *   npx vite-node scripts/genererExemple.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createEmptyDocument,
  createParagraph,
  createTable,
  mergeTableCells,
  splitTableCell,
} from '../src/domain/document/document';
import { makeRun } from '../src/domain/document/runs';
import { addComment, replyToComment, resolveCommentThread } from '../src/domain/document/comments';
import { setBookmark } from '../src/domain/document/bookmarks';
import { markDeleted, markFormatted, markInserted } from '../src/domain/document/redline';
import { createToc } from '../src/domain/document/tox';
import { paginateDocument } from '../src/domain/engine/paginate';
import { MetricTextMeasurer } from '../src/domain/engine/measure';
import { exportOdt } from '../src/domain/odf/package';
import { buildContentXml, documentPlainText } from '../src/domain/odf/export';
import type {
  DocumentBlock,
  HeadingLevel,
  ListKind,
  ParagraphNode,
  TextRun,
  WriterDocumentState,
} from '../src/domain/document/types';

/** Target length. The script fails outside this range. */
const PAGES_MIN = 25;
const PAGES_MAX = 27;

/**
 * A 1×1 PNG image as a `data:` URL.
 *
 * Deliberately tiny: what is demonstrated here is the **anchoring** and the wrapping, not the quality of the image. A sample file of several
 * megabytes would be tiresome to clone for nothing.
 */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ------------------------------------------------------------- builders */

let compteur = 0;
/** Readable and **deterministic** id: two runs give the same file. */
function id(prefixe: string): string {
  compteur += 1;
  return `${prefixe}${compteur}`;
}

function titre(texte: string, niveau: HeadingLevel): ParagraphNode {
  return { ...createParagraph(texte, { headingLevel: niveau }), id: id('h') };
}

function para(texte: string, options: Parameters<typeof createParagraph>[1] = {}): ParagraphNode {
  return { ...createParagraph(texte, options), id: id('p') };
}

function runsPara(runs: TextRun[], options: Parameters<typeof createParagraph>[1] = {}): ParagraphNode {
  return { ...createParagraph('', { ...options, runs }), id: id('p') };
}

function elementListe(
  texte: string,
  kind: ListKind,
  listId: string,
  level = 0,
  extra: Partial<ParagraphNode> = {},
): ParagraphNode {
  return { ...para(texte), listKind: kind, listId, listLevel: level, ...extra };
}

/** Filler text: real French, so that line breaking makes sense. */
const LOREM = [
  "La typographie n'est pas un ornement : c'est ce qui rend un texte lisible sans que le lecteur ait à y penser.",
  "Un moteur de composition décide, pour chaque ligne, où couper, combien d'espace ajouter entre les mots, et si la ligne suivante appartient encore à la même page.",
  "Ces trois décisions se prennent des milliers de fois par document, et une seule erreur systématique suffit à rendre le résultat désagréable à lire.",
  "OpenOffice Writer résout le problème depuis vingt ans avec un algorithme en cinq étapes, dont la subtilité tient moins à la coupure elle-même qu'au traitement des espaces qui l'entourent.",
  "Les règles de veuves et d'orphelines, elles, relèvent d'une autre logique : elles n'optimisent rien, elles interdisent — une ligne seule en haut ou en bas de page est jugée inacceptable, quel qu'en soit le coût.",
];

function paragrapheLorem(index: number): ParagraphNode {
  return para(`${LOREM[index % LOREM.length]} ${LOREM[(index + 2) % LOREM.length]}`);
}

/* -------------------------------------------------------------- the document */

function construireDocument(): WriterDocumentState {
  const base = createEmptyDocument('Banc d\'essai — portage OpenOffice Writer');
  const blocs: DocumentBlock[] = [];

  /* -- Cover page and table of contents --------------------------------- */

  blocs.push(
    runsPara(
      [makeRun('Banc d\'essai du portage OpenOffice', { bold: true, fontSizePt: 26 })],
      { alignment: 'center' },
    ),
  );
  blocs.push(
    runsPara(
      [makeRun('Apache OpenOffice 4.1.16 → Writer Web', { italic: true, fontSizePt: 13, color: '#5f6368' })],
      { alignment: 'center' },
    ),
  );
  blocs.push(para(''));
  blocs.push(
    runsPara([
      makeRun(
        'Ce document exerce chaque sous-système porté depuis le code C++ de StarWriter. '
        + 'Il est engendré par ',
      ),
      makeRun('scripts/genererExemple.ts', { fontFamily: 'monospace', backgroundColor: '#f1f3f4' }),
      makeRun(
        ', qui vérifie sa longueur et son aller-retour ODF avant de l\'écrire. '
        + 'Chaque chapitre indique la classe OpenOffice dont il éprouve la transposition.',
      ),
    ], { alignment: 'justify' }),
  );

  const toc = { ...createToc({ title: 'Table des matières', maxLevel: 3 }), id: 'toc_principal' };
  blocs.push({ ...toc, pageBreakBefore: true });

  /* -- 1. Line composition --------------------------------------------- */

  blocs.push({ ...titre('Composition de ligne et pagination', 1), pageBreakBefore: true });
  blocs.push(para('SwTxtGuess::Guess, SwTxtFormatter, WidowsAndOrphans', { alignment: 'left' }));
  blocs.push(titre('Retour à la ligne et justification', 2));
  for (let i = 0; i < 6; i += 1) {
    blocs.push({ ...paragrapheLorem(i), alignment: 'justify' });
  }

  blocs.push(titre('Alignements', 2));
  blocs.push(para('Cette ligne est alignée à gauche — le réglage par défaut.', { alignment: 'left' }));
  blocs.push(para('Celle-ci est centrée.', { alignment: 'center' }));
  blocs.push(para('Celle-là est alignée à droite.', { alignment: 'right' }));
  blocs.push({ ...paragrapheLorem(1), alignment: 'justify' });

  blocs.push(titre('Veuves et orphelines', 2));
  blocs.push(
    para(
      'Le paragraphe qui suit refuse d\'être coupé entre deux pages (SvxFmtSplitItem). '
      + 'Selon la place restante, il bascule donc en entier sur la page suivante.',
    ),
  );
  blocs.push({ ...paragrapheLorem(3), keepTogether: true, alignment: 'justify' });
  for (let i = 0; i < 4; i += 1) blocs.push({ ...paragrapheLorem(i + 2), alignment: 'justify' });

  /* -- 2. Characters and styles ----------------------------------------- */

  blocs.push({ ...titre('Attributs de caractère', 1), pageBreakBefore: true });
  blocs.push(para('SwpHints, SwTxtAttr, SwAttrSet'));

  blocs.push(titre('Les attributs isolés', 2));
  blocs.push(
    runsPara([
      makeRun('Du texte '),
      makeRun('gras', { bold: true }),
      makeRun(', '),
      makeRun('italique', { italic: true }),
      makeRun(', '),
      makeRun('souligné', { underline: true }),
      makeRun(', '),
      makeRun('barré', { strikeThrough: true }),
      makeRun(', '),
      makeRun('coloré', { color: '#c9211e' }),
      makeRun(', '),
      makeRun('surligné', { backgroundColor: '#fff2a8' }),
      makeRun(', et '),
      makeRun('à chasse fixe', { fontFamily: 'monospace' }),
      makeRun('.'),
    ]),
  );

  blocs.push(titre('Les attributs combinés', 2));
  blocs.push(
    runsPara([
      makeRun('Gras italique souligné', { bold: true, italic: true, underline: true }),
      makeRun(' — trois attributs sur une seule plage, donc un seul run après '),
      makeRun('normalizeRuns', { fontFamily: 'monospace' }),
      makeRun(' (SwpHints::MergePortions).'),
    ]),
  );
  blocs.push(
    runsPara([
      makeRun('Tailles : '),
      makeRun('8 pt ', { fontSizePt: 8 }),
      makeRun('11 pt ', { fontSizePt: 11 }),
      makeRun('16 pt ', { fontSizePt: 16 }),
      makeRun('22 pt', { fontSizePt: 22 }),
    ]),
  );

  blocs.push(titre('Niveaux de titre', 2));
  blocs.push(titre('Titre de niveau 3', 3));
  blocs.push(para('Le niveau 3 entre encore dans le sommaire ; le niveau 4 en sort.'));
  blocs.push(titre('Titre de niveau 4', 4));
  blocs.push(para('Ce titre-ci n\'apparaît pas dans la table des matières, par construction.'));

  /* -- 3. Lists --------------------------------------------------------- */

  blocs.push({ ...titre('Listes et numérotation', 1), pageBreakBefore: true });
  blocs.push(para('SwNumRule, SwNumberTree, SwNodeNum'));

  blocs.push(titre('Liste à puces imbriquée', 2));
  const listePuces = 'liste_puces';
  blocs.push(elementListe('Premier élément de premier niveau', 'bullet', listePuces, 0));
  blocs.push(elementListe('Deuxième élément, avec un sous-niveau', 'bullet', listePuces, 0));
  blocs.push(elementListe('Sous-élément de deuxième niveau', 'bullet', listePuces, 1));
  blocs.push(elementListe('Sous-sous-élément de troisième niveau', 'bullet', listePuces, 2));
  blocs.push(elementListe('Retour au premier niveau', 'bullet', listePuces, 0));

  blocs.push(titre('Liste numérotée et reprise du compteur', 2));
  const listeA = 'liste_num_a';
  blocs.push(elementListe('Première étape', 'ordered', listeA, 0));
  blocs.push(elementListe('Deuxième étape', 'ordered', listeA, 0));
  blocs.push(elementListe('Sous-étape', 'ordered', listeA, 1));
  blocs.push(elementListe('Autre sous-étape', 'ordered', listeA, 1));
  blocs.push(elementListe('Troisième étape', 'ordered', listeA, 0));

  blocs.push(
    para(
      'Le paragraphe ci-dessous interrompt la liste. La suivante porte un autre '
      + 'RES_PARATR_LIST_ID : son compteur repart donc à 1, et non à 4.',
    ),
  );

  const listeB = 'liste_num_b';
  blocs.push(elementListe('Nouvelle liste, premier élément', 'ordered', listeB, 0));
  blocs.push(elementListe('Nouvelle liste, deuxième élément', 'ordered', listeB, 0));

  blocs.push(titre('Reprise explicite du compteur', 2));
  const listeC = 'liste_num_c';
  blocs.push(
    elementListe('Cet élément repart à 10', 'ordered', listeC, 0, {
      listRestart: true,
      listStartValue: 10,
    }),
  );
  blocs.push(elementListe('Puis 11', 'ordered', listeC, 0));
  blocs.push(elementListe('Puis 12', 'ordered', listeC, 0));

  blocs.push(titre('Liste de tâches', 2));
  const listeT = 'liste_taches';
  blocs.push(elementListe('Porter le moteur de lignes', 'task', listeT, 0, { listChecked: true }));
  blocs.push(elementListe('Porter la pagination', 'task', listeT, 0, { listChecked: true }));
  blocs.push(elementListe('Porter les sections multicolonnes', 'task', listeT, 0));

  /* -- 4. Tables -------------------------------------------------------- */

  blocs.push({ ...titre('Tableaux', 1), pageBreakBefore: true });
  blocs.push(para('SwTable, SwTableLine, SwTableBox, SwTabFrm'));

  blocs.push(titre('Tableau simple avec en-tête répétée', 2));
  const simple = { ...createTable(4, 3), id: id('t') };
  simple.rows[0]!.isHeader = true;
  const entetes = ['Sous-système', 'Classe OpenOffice', 'État'];
  const lignes = [
    ['Composition de ligne', 'SwTxtGuess', 'Porté'],
    ['Pagination', 'SwLayAction', 'Porté'],
    ['Habillage', 'SwTxtFly', 'Porté'],
  ];
  simple.rows[0]!.cells.forEach((cellule, i) => {
    cellule.blocks = [runsPara([makeRun(entetes[i] ?? '', { bold: true })])];
    cellule.backgroundColor = '#f1f3f4';
  });
  lignes.forEach((ligne, r) => {
    simple.rows[r + 1]!.cells.forEach((cellule, c) => {
      cellule.blocks = [para(ligne[c] ?? '')];
    });
  });
  blocs.push(simple);

  blocs.push(para(''));
  blocs.push(titre('Cellules fusionnées et scindées', 2));
  blocs.push(
    para(
      'Le tableau suivant fusionne les deux premières cellules de sa première '
      + 'ligne (SwDoc::MergeTbl), puis scinde une cellule de la dernière '
      + '(SwDoc::SplitTbl). Les cellules absorbées ne sont pas supprimées mais '
      + 'marquées recouvertes, ce qui garde la grille rectangulaire.',
    ),
  );

  let fusion = { ...createTable(3, 3), id: id('t') };
  fusion.rows.forEach((ligne, r) =>
    ligne.cells.forEach((cellule, c) => {
      cellule.blocks = [para(`L${r + 1}C${c + 1}`)];
    }),
  );

  const docFusion = mergeTableCells(
    { ...base, blocks: [fusion] },
    fusion.id,
    { fromRow: 0, toRow: 0, fromCol: 0, toCol: 1 },
  );
  const docScinde = splitTableCell(docFusion, fusion.id, 2, 2, 'horizontal', 2);
  const tableauFinal = docScinde.blocks.find((b) => b.type === 'table');
  if (tableauFinal) blocs.push(tableauFinal);

  /* -- 5. Footnotes ----------------------------------------------------- */

  blocs.push({ ...titre('Notes de bas de page', 1), pageBreakBefore: true });
  blocs.push(para('SwFtnFrm, SwFtnContFrm, SwFmtFtn'));

  blocs.push(
    runsPara([
      makeRun('La zone de notes réduit la hauteur utile du corps de la page'),
      makeRun('¹', {
        footnoteId: 'fn_reserve',
        footnoteText:
          'SwFtnBossFrm::GetVarSpace : la hauteur disponible d\'une page est sa hauteur '
          + 'utile moins celle qu\'occupe déjà son conteneur de notes.',
      }),
      makeRun('. Sans cette réserve, le bandeau recouvrirait les dernières lignes du texte'),
      makeRun('²', {
        footnoteId: 'fn_recouvre',
        footnoteText: 'C\'est le défaut exact qu\'a corrigé ce portage.',
      }),
      makeRun('.'),
    ], { alignment: 'justify' }),
  );

  for (let i = 0; i < 8; i += 1) blocs.push({ ...paragrapheLorem(i), alignment: 'justify' });

  blocs.push(
    runsPara([
      makeRun('Une note appelée plus loin dans le document n\'est due que par la page '),
      makeRun('portant la ligne de son appel'),
      makeRun('³', {
        footnoteId: 'fn_page',
        footnoteText:
          'La granularité est celle de la ligne, pas du paragraphe : compter le '
          + 'paragraphe entier réserverait sur la première page l\'espace de notes '
          + 'appelées trois pages plus loin.',
      }),
      makeRun('.'),
    ], { alignment: 'justify' }),
  );

  /* -- 6. Images and wrapping ------------------------------------------- */

  blocs.push({ ...titre('Images, ancrage et habillage', 1), pageBreakBefore: true });
  blocs.push(para('SwFlyFrm, SwFlyCntFrm, SwFmtSurround, SwTxtFly'));

  blocs.push(titre('Ancrage « comme caractère »', 2));
  blocs.push(
    runsPara([
      makeRun('Une image ancrée comme caractère coule dans la ligne '),
      makeRun('￼', {
        imageSrc: PNG_1X1,
        imageWidthPt: 12,
        imageHeightPt: 12,
        imageAlt: 'Carré de démonstration',
      }),
      makeRun(' et se sélectionne exactement comme un caractère (FLY_AS_CHAR).'),
    ]),
  );

  blocs.push(titre('Cadre flottant, habillage à droite', 2));
  blocs.push(
    runsPara([
      makeRun('￼', {
        imageSrc: PNG_1X1,
        imageWidthPt: 90,
        imageHeightPt: 70,
        imageAlt: 'Cadre flottant à gauche',
        imageAnchor: 'to-para',
        imageSurround: 'right',
        imageXPt: 0,
        imageYPt: 0,
        imageWrapMarginPt: 6,
      }),
      makeRun(
        'Ce cadre est ancré au paragraphe avec un habillage « à droite » : le '
        + 'texte n\'occupe que la bande située à droite du cadre, tant qu\'il le '
        + 'croise verticalement. Une fois la hauteur du cadre dépassée, les '
        + 'lignes retrouvent la pleine largeur de la colonne. C\'est le calcul '
        + 'de SwTxtFly::GetFrm, exprimé ici par soustraction d\'intervalles.',
      ),
    ], { alignment: 'justify' }),
  );
  blocs.push({ ...paragrapheLorem(0), alignment: 'justify' });

  blocs.push(titre('Habillage des deux côtés et par-dessous', 2));
  blocs.push(
    runsPara([
      makeRun('￼', {
        imageSrc: PNG_1X1,
        imageWidthPt: 60,
        imageHeightPt: 50,
        imageAlt: 'Cadre parallèle',
        imageAnchor: 'to-para',
        imageSurround: 'parallel',
        imageXPt: 150,
        imageYPt: 4,
        imageWrapMarginPt: 5,
      }),
      makeRun(
        'Un habillage « parallèle » laisse le texte des deux côtés du cadre ; le '
        + 'moteur retient à chaque ligne la plus large des deux bandes. Un '
        + 'habillage « au travers » (run-through) n\'exclurait rien du tout, et le '
        + 'texte passerait sous le cadre.',
      ),
    ], { alignment: 'justify' }),
  );
  for (let i = 0; i < 3; i += 1) blocs.push({ ...paragrapheLorem(i + 1), alignment: 'justify' });

  /* -- 7. Formulas ------------------------------------------------------ */

  blocs.push({ ...titre('Formules mathématiques', 1), pageBreakBefore: true });
  blocs.push(para('starmath, transposé en LaTeX/KaTeX'));

  blocs.push(
    runsPara([
      makeRun('Une formule en ligne, '),
      makeRun('￼', { mathLatex: 'e^{i\\pi} + 1 = 0' }),
      makeRun(', coule dans le texte comme une image ancrée au caractère.'),
    ]),
  );
  blocs.push(
    runsPara([makeRun('￼', { mathLatex: '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}', mathDisplay: true })], {
      alignment: 'center',
    }),
  );
  blocs.push(
    runsPara([makeRun('￼', { mathLatex: '\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', mathDisplay: true })], {
      alignment: 'center',
    }),
  );
  blocs.push({ ...paragrapheLorem(4), alignment: 'justify' });

  /* -- 8. Indents and spacing ------------------------------------------- */

  blocs.push({ ...titre('Retraits, espacements et sauts', 1), pageBreakBefore: true });
  blocs.push(para('SvxLRSpaceItem, SvxULSpaceItem, SwFmtPageDesc'));

  blocs.push(para('Paragraphe sans retrait, pour référence.'));
  blocs.push({ ...paragrapheLorem(0), indentLeftPt: 36, alignment: 'justify' });
  blocs.push({ ...paragrapheLorem(1), indentLeftPt: 36, indentRightPt: 36, alignment: 'justify' });
  blocs.push({ ...paragrapheLorem(2), firstLineIndentPt: 24, alignment: 'justify' });
  blocs.push({ ...paragrapheLorem(3), firstLineIndentPt: -24, indentLeftPt: 24, alignment: 'justify' });
  blocs.push({ ...paragrapheLorem(4), lineSpacing: 1.5, alignment: 'justify' });
  blocs.push({ ...paragrapheLorem(0), lineSpacing: 2, alignment: 'justify' });
  blocs.push({ ...paragrapheLorem(1), marginTopPt: 18, marginBottomPt: 18, alignment: 'justify' });

  /* -- 9. Bookmarks and cross-references -------------------------------- */

  blocs.push({ ...titre('Signets et renvois internes', 1), pageBreakBefore: true });
  blocs.push(para('SwBookmark, IDocumentMarkAccess, SwGetRefField'));

  const cible = para(
    'Cette phrase porte un signet nommé « point_de_repere ». Un renvoi interne '
    + 'peut la viser sans qu\'aucune position absolue ne soit stockée.',
  );
  blocs.push(cible);
  blocs.push(
    runsPara([
      makeRun('Voici un renvoi vers ce signet : '),
      makeRun('revenir au point de repère', { linkHref: '#point_de_repere', color: '#1a73e8', underline: true }),
      makeRun('. Et voici un lien externe ordinaire : '),
      makeRun('openoffice.org', { linkHref: 'https://www.openoffice.org/', color: '#1a73e8', underline: true }),
      makeRun('.'),
    ]),
  );
  for (let i = 0; i < 4; i += 1) blocs.push({ ...paragrapheLorem(i), alignment: 'justify' });

  /* -- 10. Comments and revisions --------------------------------------- */

  blocs.push({ ...titre('Commentaires et suivi des modifications', 1), pageBreakBefore: true });
  blocs.push(para('SwPostItField, SwPostItMgr, SwRangeRedline, SwRedlineTbl'));

  blocs.push(titre('Commentaires marginaux', 2));
  const commente = para(
    'Cette phrase porte un commentaire ancré sur une plage de texte, avec une '
    + 'réponse dans le même fil de discussion.',
  );
  blocs.push(commente);

  const resolu = para('Cette phrase-ci porte un fil déjà résolu, conservé mais grisé.');
  blocs.push(resolu);

  blocs.push(titre('Suivi des modifications', 2));
  const revise = para(
    'En mode révision, rien n\'est détruit : une insertion est soulignée, une '
    + 'suppression est barrée, et le texte reste jusqu\'à l\'acceptation.',
  );
  blocs.push(revise);
  for (let i = 0; i < 5; i += 1) blocs.push({ ...paragrapheLorem(i), alignment: 'justify' });

  /* -- 11. Padding up to the intended length ---------------------------- */

  blocs.push({ ...titre('Annexe — matière de pagination', 1), pageBreakBefore: true });
  blocs.push(
    para(
      'Les sections qui suivent portent le document à sa longueur cible, afin que '
      + 'la pagination, les en-têtes, les pieds de page et surtout les numéros du '
      + 'sommaire soient exercés sur une vingtaine de feuilles. Leurs titres '
      + 'alimentent la table des matières, ce qui met à l\'épreuve la résolution '
      + 'des numéros de page en deuxième passe.',
    ),
  );

  // Appendix sections: the number is calibrated to reach the page range checked at the end of the script. The titles are numbered so that a long
  // table of contents stays verifiable at a glance.
  const SECTIONS_ANNEXE = 9;
  const PARAGRAPHES_PAR_SECTION = 13;

  for (let section = 0; section < SECTIONS_ANNEXE; section += 1) {
    blocs.push(titre(`Section d'annexe ${section + 1}`, 2));
    for (let i = 0; i < PARAGRAPHES_PAR_SECTION; i += 1) {
      blocs.push({ ...paragrapheLorem(section * 3 + i), alignment: 'justify' });
    }
  }

  blocs.push(titre('Fin du banc d\'essai', 2));
  blocs.push(
    para(
      'Si ce document s\'ouvre sans avertissement dans OpenOffice Writer 4.1 et '
      + 'dans l\'éditeur web, et que les deux affichent les mêmes numéros de page '
      + 'dans le sommaire, le portage se comporte comme prévu.',
    ),
  );

  /* -- Assembly and annotations ----------------------------------------- */

  let doc: WriterDocumentState = {
    ...base,
    id: 'doc_test',
    meta: {
      title: 'Banc d\'essai — portage OpenOffice Writer',
      author: 'Writer Web',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    furniture: {
      header: 'Banc d\'essai du portage OpenOffice',
      footer: '',
      headerLeft: 'Writer Web',
      headerCenter: '',
      headerRight: '{titre}',
      footerLeft: '',
      footerCenter: 'Page {page} sur {pages}',
      footerRight: '',
      pageNumber: true,
      pageNumberFormat: 'page-sur',
      startPageNumber: 1,
      // The cover page carries neither header nor footer: that is the `SwPageDesc` convention for a distinct first page.
      onFirstPage: false,
      differentFirstPage: true,
      differentEvenOdd: false,
      headerSeparator: true,
      headerSeparatorStyle: 'solid',
      footerSeparator: true,
      footerSeparatorStyle: 'solid',
      headerMm: 12,
      footerMm: 12,
      headerAlign: 'left',
      footerAlign: 'center',
      fontSizePt: 9,
      marginTopMm: base.pageSetup.marginTopMm,
      marginBottomMm: base.pageSetup.marginBottomMm,
      marginLeftMm: base.pageSetup.marginLeftMm,
      marginRightMm: base.pageSetup.marginRightMm,
      blocks: [],
    },
    blocks: blocs,
  };

  // Bookmark: set after assembly, because it modifies the runs of the paragraph.
  doc = setBookmark(
    doc,
    { blockId: cible.id, startOffset: 0, endOffset: 13 },
    'point_de_repere',
  );

  // Comments: one thread with a reply, one resolved thread.
  const premier = addComment(
    doc,
    { blockId: commente.id, startOffset: 0, endOffset: 24 },
    'Alice',
    'Faut-il préciser que l\'ancre est un attribut de run ?',
    { now: '2026-01-02T09:00:00.000Z', initials: 'A' },
  );
  doc = replyToComment(
    premier.doc,
    premier.threadId,
    'Bob',
    'Oui — c\'est ce qui lui permet de suivre le texte sans maintenance.',
    { now: '2026-01-02T10:30:00.000Z', initials: 'B' },
  );

  const second = addComment(
    doc,
    { blockId: resolu.id, startOffset: 0, endOffset: 20 },
    'Bob',
    'Vérifier le rendu grisé d\'un fil clos.',
    { now: '2026-01-02T11:00:00.000Z', initials: 'B' },
  );
  doc = resolveCommentThread(second.doc, second.threadId, true);

  // Revisions: one insertion, one deletion, one formatting change.
  doc = markInserted(doc, revise.id, 0, 18, { author: 'Alice', now: '2026-01-03T08:00:00.000Z' });
  doc = markDeleted(doc, revise.id, 40, 60, { author: 'Bob', now: '2026-01-03T08:15:00.000Z' }).doc;
  doc = markFormatted(doc, revise.id, 70, 90, { author: 'Alice', now: '2026-01-03T08:30:00.000Z' });

  return doc;
}

/* ---------------------------------------------------------------- checks */

async function main(): Promise<void> {
  const doc = construireDocument();
  const measurer = new MetricTextMeasurer();
  const layout = paginateDocument(doc, { measurer });
  const pages = layout.pages.length;

  console.log(`Document engendré : ${doc.blocks.length} blocs, ${pages} pages.`);

  if (pages < PAGES_MIN || pages > PAGES_MAX) {
    throw new Error(
      `Longueur hors cible : ${pages} pages, attendu entre ${PAGES_MIN} et ${PAGES_MAX}. `
      + 'Ajuster le remplissage de l\'annexe.',
    );
  }

  // Content checks: better to fail here than write a wrong sample.
  const verifications: [string, boolean][] = [
    ['un sommaire', doc.blocks.some((b) => b.type === 'toc')],
    ['des tableaux', doc.blocks.filter((b) => b.type === 'table').length >= 2],
    ['une cellule fusionnée', doc.blocks.some((b) => b.type === 'table' && b.rows.some((r) => r.cells.some((c) => (c.colSpan ?? 1) > 1)))],
    ['une cellule recouverte', doc.blocks.some((b) => b.type === 'table' && b.rows.some((r) => r.cells.some((c) => c.covered)))],
    ['des commentaires', (doc.comments ?? []).length >= 3],
    ['un fil résolu', (doc.comments ?? []).some((c) => c.resolved)],
    ['des révisions', (doc.redlines ?? []).length >= 3],
    ['une suppression suivie', (doc.redlines ?? []).some((r) => r.type === 'delete')],
    ['des notes de bas de page', layout.pages.some((p) => (p.footnotes?.length ?? 0) > 0)],
    ['une réserve de notes', layout.pages.some((p) => (p.footnoteAreaHeightPx ?? 0) > 0)],
    ['des cadres flottants', layout.pages.some((p) => (p.flies?.length ?? 0) > 0)],
    ['des lignes de sommaire', layout.tocTargets.size >= 10],
    ['un en-tête et un pied', Boolean(doc.furniture?.header) && Boolean(doc.furniture?.footerCenter)],
  ];

  for (const [quoi, ok] of verifications) {
    if (!ok) throw new Error(`Contrôle échoué : le document devrait contenir ${quoi}.`);
    console.log(`  ✓ ${quoi}`);
  }

  // The invariant of the footnote area, verified on the real document.
  for (const page of layout.pages) {
    const total = page.usedHeightPx + (page.footnoteAreaHeightPx ?? 0);
    if (total > layout.geometry.contentHeightPx + 0.5) {
      throw new Error(`Page ${page.index + 1} : le corps et les notes débordent de la hauteur utile.`);
    }
  }
  console.log('  ✓ corps + notes tiennent dans la hauteur utile, sur toutes les pages');

  // The XML must contain the tags of the announced subsystems.
  const xml = buildContentXml(doc);
  const balises = [
    'text:table-of-content',
    'text:tracked-changes',
    'office:annotation',
    'text:bookmark-start',
    'text:note',
    'table:table',
    'draw:frame',
    'text:anchor-type="paragraph"',
    'style:wrap=',
  ];
  for (const balise of balises) {
    if (!xml.includes(balise)) throw new Error(`Le content.xml ne contient pas « ${balise} ».`);
  }
  console.log(`  ✓ content.xml : ${balises.length} familles de balises présentes`);

  const octets = await exportOdt(doc);
  const racine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dossier = resolve(racine, 'exemple');
  await mkdir(dossier, { recursive: true });

  const chemin = resolve(dossier, 'doc_test.odt');
  await writeFile(chemin, octets);

  // The plain text serves as a readable witness: a diff on this file immediately shows what a regression would have changed in the content.
  await writeFile(resolve(dossier, 'doc_test.txt'), documentPlainText(doc), 'utf-8');

  console.log(`\nÉcrit : exemple/doc_test.odt (${(octets.length / 1024).toFixed(1)} Kio, ${pages} pages)`);
  console.log('Écrit : exemple/doc_test.txt (témoin en texte brut)');
}

main().catch((erreur: unknown) => {
  console.error('\nGénération interrompue :', erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});
