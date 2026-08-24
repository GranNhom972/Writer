# Writer — moteur de traitement de texte natif (React + TypeScript)

Portage des **algorithmes d'Apache OpenOffice Writer** (`aoo-4.1.16/main/sw`,
`editeng`, `xmloff`) en TypeScript strict, conformément au
cahier des charges du projet.

> **Règle d'or respectée** : aucune bibliothèque de traitement de texte externe.
> Pas de ProseMirror, Slate, Quill, TipTap ni CKEditor. Le rendu, le curseur, la
> césure, la pagination, l'annulation, la recherche, les listes et le format ODF
> sont écrits ici.
>
> Une seule dépendance d'exécution s'ajoute à React : **KaTeX**, pour composer
> les formules mathématiques. Ce n'est pas un éditeur de texte enrichi mais un
> compositeur de formules — au même titre qu'un moteur de rendu de fontes.
> Écrire nous-mêmes la mise en forme mathématique de TeX serait un projet à part
> entière. La dépendance est isolée dans [`domain/math/`](src/domain/math/) : le
> moteur de texte n'en sait rien.

```bash
version_web/lancer.py --writer
```

## Ce que fait le moteur

**Mise en page** — retour à la ligne par occasions de coupure, coupure forcée
dans un mot trop long, espaces finales suspendues, espace insécable respectée,
tabulations à taquets, justification par répartition sur les blancs, hauteur de
ligne au plus grand corps de la ligne.

**Pagination A4** — feuilles à la taille réelle du papier, report du contenu qui
ne tient plus, coupure d'un paragraphe **entre deux lignes** avec règles de
veuves et d'orphelines, `keep-together`, sauts de page explicites, coupure d'un
tableau **entre deux lignes de tableau** avec répétition des lignes d'en-tête.

**Édition** — curseur et sélection *Point and Mark*, navigation par grappe de
graphèmes (un emoji composé ne se coupe pas), par mot, par ligne visuelle et par
paragraphe ; abscisse mémorisée pour les déplacements verticaux ; insertion,
suppression, fusion et scission de paragraphes en préservant le formatage local.

**Formatage** — gras, italique, souligné, barré, police, corps, couleur,
surlignage, lien ; titres 1 à 6, alignements, interligne, retraits, espacements.
Deux plages voisines de formatage identique sont **toujours** refusionnées.

**Listes** — à puces, numérotées et à cocher, imbriquées jusqu'à dix niveaux.
Comme dans Writer, une liste n'est **pas** une structure imbriquée : c'est un
jeu d'attributs de paragraphe (`RES_PARATR_LIST_*`), et le numéro se recalcule
au parcours plutôt que de se mémoriser. Changer un élément de niveau ne déplace
donc aucun nœud, et insérer au milieu renumérote la suite sans y toucher.

**Historique** — pile transactionnelle, regroupement de la frappe par classe de
caractère : `Ctrl+Z` défait un mot, pas une lettre.

**Rechercher et remplacer** — recherche en direct, casse et mot entier (accents
compris), **toutes** les occurrences surlignées avec la courante distinguée par
la teinte *et* par un contour, compteur « 3 / 14 », et un « Tout remplacer » qui
tient dans une seule transaction : un `Ctrl+Z` défait l'ensemble.

**Interface** — barre de menus complète (motif ARIA `menubar`), ruban de mise en
forme, règle graduée, plan du document, palette de commandes, aperçu avant
impression, en-tête et pied de page, formules mathématiques, export PDF. Le jeu
d'icônes, la palette de couleurs et les jetons de design sont ceux de
l'application Write, repris tels quels.

**OpenDocument** — lecture et écriture de `content.xml`, `styles.xml`,
`meta.xml`, `META-INF/manifest.xml`, et du conteneur ZIP `.odt` lui-même. Les
styles ODF sont aplatis à la lecture, refactorisés en styles automatiques à
l'écriture.

## Correspondance avec le code C++

| Fichier TypeScript | Source OpenOffice | Ce qui a été transposé |
| :--- | :--- | :--- |
| [`domain/document/types.ts`](src/domain/document/types.ts) | `sw/inc/doc.hxx`, `ndtxt.hxx` | `SwDoc`, `SwTxtNode`, `SwPaM`, `SwPageDesc` |
| [`domain/document/runs.ts`](src/domain/document/runs.ts) | `txtnode/thints.cxx` | `SwpHints`, dont `MergePortions` (thints.cxx:2684) |
| [`domain/document/document.ts`](src/domain/document/document.ts) | `docnode/node.cxx` | `SwNodes` : l'ordre plat des nœuds, frontières de conteneur |
| [`domain/engine/lineBreak.ts`](src/domain/engine/lineBreak.ts) | `text/guess.cxx` | `SwTxtGuess::Guess` — les cinq étapes du retour à la ligne |
| [`domain/engine/paginate.ts`](src/domain/engine/paginate.ts) | `layout/layact.cxx`, `text/widorp.cxx` | `SwLayAction`, `WidowsAndOrphans`, `SwTabFrm::Split` |
| [`domain/engine/cursor.ts`](src/domain/engine/cursor.ts) | `crsr/pam.cxx`, `crsr/swcrsr.cxx` | `SwPosition::operator<`, `SwPaM::Normalize`, `GoNextWord` |
| [`domain/engine/edit.ts`](src/domain/engine/edit.ts) | `txtnode/ndtxt.cxx` | `SplitCntntNode`, `JoinNext`, `InsertText`, `EraseText` |
| [`domain/engine/history.ts`](src/domain/engine/history.ts) | `undo/unins.cxx` | `SwUndoManager`, `SwUndoInsert::CanGrouping` |
| [`domain/engine/search.ts`](src/domain/engine/search.ts) | `crsr/findtxt.cxx` | `SwCursor::Find` |
| [`domain/document/lists.ts`](src/domain/document/lists.ts) | `doc/number.cxx`, `SwNumberTree/` | `SwNumRule`, `SwNodeNum`, `aDefNumIndents` |
| [`domain/odf/import.ts`](src/domain/odf/import.ts) | `xmloff/source/text/txtimp.cxx` | `XMLTextImportHelper` |
| [`domain/odf/export.ts`](src/domain/odf/export.ts) | `xmloff/source/text/txtparae.cxx` | `XMLTextParagraphExport` |

## Architecture — les quatre couches du cahier des charges

```
src/
├── domain/document/   Couche 1 — modèle et types. Aucun React, aucun DOM.
├── domain/engine/     Couche 2 — algorithmes purs, exécutables en Web Worker.
├── domain/odf/        Couche 2 — moteur XML OpenDocument.
└── ui/                Couche 3 — rendu React et saisie.
```

La couche 4 (collaboration CRDT) n'est pas branchée ici : le modèle est fait de
valeurs immuables, donc prêt à être adossé au relais Yjs décrit dans
[`../integration_api_rust.md`](../integration_api_rust.md).

### Deux décisions qui expliquent le reste

**Le moteur est seul juge de la géométrie.** Il calcule la position de chaque
caractère ; le DOM ne fait que peindre. Rien n'est mesuré dans le sens inverse —
ni le texte, ni le curseur, ni les limites de ligne. C'est ce qui permet au
document de vivre dans un Web Worker et d'être testé sans navigateur.

**Crénage et ligatures sont désactivés** ([`editor.css`](src/ui/editor/editor.css)).
La largeur d'une ligne est la somme des avances de ses grappes de graphèmes. Si
le navigateur appliquait un crénage, cette somme ne vaudrait plus la largeur
rendue et l'écart s'accumulerait le long de la ligne : le curseur, placé par le
moteur, dériverait des glyphes, peints par le navigateur. Les désactiver rend les
deux calculs identiques *par construction* — vérifié en navigateur : l'écart
entre segments consécutifs est nul sur les 54 lignes du document de démonstration.

La saisie passe par une zone de texte invisible plutôt que par
`contenteditable`, et écoute l'événement **natif** `beforeinput` : c'est le seul
qui porte `inputType`, par lequel les claviers virtuels annoncent leurs
effacements et la dictée son insertion.

## Raccourcis

| Touche | Effet |
| :--- | :--- |
| `Ctrl+B` `Ctrl+I` `Ctrl+U` | Gras, italique, souligné |
| `Ctrl+1`…`Ctrl+6` | Titre de niveau 1 à 6 |
| `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Maj+Z` | Annuler, rétablir |
| `Ctrl+A` | Tout sélectionner |
| `Ctrl+M` | Effacer la mise en forme |
| `Ctrl+Entrée` | Saut de page |
| `Maj+Entrée` | Saut de ligne dans le paragraphe |
| `Ctrl+←` / `Ctrl+→` | Mot précédent / suivant |
| `Origine` / `Fin` | Début / fin de la **ligne visuelle** |
| `Ctrl+Origine` / `Ctrl+Fin` | Début / fin du document |
| `Tab` / `Maj+Tab` | Tabulation, ou niveau de liste si l'on est dans une liste |
| `Ctrl+Maj+7/8/9` | Liste numérotée, à puces, à cocher |
| `Ctrl+]` / `Ctrl+[` | Augmenter / diminuer le retrait |
| `Ctrl+Maj+<` / `Ctrl+Maj+>` | Corps de police |
| `Ctrl+L/E/R/J` | Aligner à gauche, centrer, à droite, justifier |
| `Ctrl+F` | Rechercher et remplacer |
| `Ctrl+K` | Lien hypertexte |
| `Ctrl+Maj+P` | Palette de commandes |
| `Ctrl+Maj+E` | Formule mathématique |
| `Ctrl+P` / `Ctrl+Maj+O` | Imprimer / aperçu avant impression |
| `Échap` | Quitter la zone d'édition (puis `Tab` pour sortir) |

Double clic : le mot. Triple clic : le paragraphe.

## Tests

```bash
cd version_web/writer && npm test
```

173 tests couvrant les invariants de `SwpHints` (fusion, scission, formatage sur
plage), le retour à la ligne (occasions de coupure, coupure forcée, espaces
suspendues, insécable, tabulations, justification), la pagination (zone
imprimable, veuves et orphelines, `keep-together`, paragraphe plus haut qu'une
page, coupure et en-têtes répétées d'un tableau), l'édition (grappes de
graphèmes, fusion de paragraphes, frontières de tableau, presse-papiers),
l'historique (regroupement par classe de caractère, purge du refaire), les
listes (numérotation par niveau, reprise, cloisonnement par cellule, `Entrée`
sur un élément vide), la recherche (casse, mot entier avec accents, traversée
des runs, remplacement de la fin vers le début), l'en-tête et le pied de page,
l'export PDF, les formules, et le moteur ODF (unités XSL-FO, styles hérités,
aller-retour complet, conteneur ZIP).

```bash
npm run typecheck   # TypeScript strict, exactOptionalPropertyTypes compris
```

## Ce qui n'est pas encore fait

| Manque | Pourquoi il compte |
| :--- | :--- |
| Césure par dictionnaire (`XHyphenator`) | Le point 5 de `Guess` — coupure forcée — la remplace ; la structure est prête à l'accueillir |
| Import ODF des listes | L'export écrit les listes ; à la relecture, elles redeviennent des paragraphes retraits |
| Images (`SwGrfNode`) | Ni le modèle ni l'export ne les portent |
| Coupure d'une **ligne** de tableau à cheval sur deux pages | Un tableau se coupe entre lignes ; une ligne plus haute qu'une page déborde |
| Largeurs de colonnes ODF (`<table:table-column>`) | Les colonnes importées sont réparties également |
| Édition des tableaux (insérer, supprimer, fusionner) | Le modèle et la mise en page les portent, l'interface ne les manipule pas |
| Collaboration CRDT | Couche 4, non branchée |
