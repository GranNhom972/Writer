# Writer — Moteur de Traitement de Texte Natif & Serveur Collaboratif

> **Implémentation de référence pour CloudServ** : Portage intégral et fidèle des **algorithmes et structures de données fondamentales d'Apache OpenOffice Writer** (`aoo-4.1.16/main/sw`, `svx`, `xmloff`, `editeng`, `starmath`) en **TypeScript strict** et **Rust (Axum + Yrs)**.

---

## 🌟 Principes Fondamentaux & Règle d'Or

1. **Zéro bibliothèque de traitement de texte tierce** :
   - Aucun recours à *ProseMirror*, *Slate*, *Quill*, *Draft.js*, *TipTap* ou *CKEditor*.
   - Le modèle de données, le moteur de composition typographique, la pagination physique A4, la gestion du curseur *Point & Mark*, l'annulation, les listes, les tableaux, les notes de bas de page, les cadres flottants, la table des matières et les filtres ODF sont **entièrement écrits et maîtrisés en interne**.
2. **Le DOM n'est qu'une projection réactive unidirectionnelle** :
   - Aucune mesure, aucune coordonnée, aucune limite de ligne ne remonte du DOM vers le modèle.
   - Le moteur purement fonctionnel calcule la position mathématique exacte de chaque caractère, ligne et page ; React se contente de peindre la géométrie calculée.
3. **Architecture purement modulaire (Web Worker ready)** :
   - Les couches de document et de calcul (`domain/document/`, `domain/engine/`, `domain/odf/`, `domain/pdf/`) sont des fonctions pures exemptes de tout import React ou accès au DOM.

---

## 🚀 Démarrage Rapide

```bash
# Depuis la racine de Writer (Client Web React + TypeScript)
npm run dev        # Lance l'éditeur sur http://localhost:5174
npm test           # Exécute les 27 suites de tests Vitest (504 tests)
npm run typecheck  # Vérifie les types TypeScript stricts (0 erreur)
npm run build      # Bundling de production optimisé (Vite)

# Depuis le sous-dossier server/ (Serveur Collaboratif Rust)
cd server
cargo run          # Démarre le serveur WebSocket & REST sur 127.0.0.1:8081
cargo test         # Exécute les 100 tests unitaires et d'intégration Rust
```

---

## 🏛️ Cartographie Complète des Intégrations (OpenOffice ⇄ Writer)

Le tableau ci-dessous référence l'ensemble des modules implémentés dans Writer avec leurs fichiers sources exacts et les composants OpenOffice C++ correspondants :

| Domaine Fonctionnel | Fichier Source **Writer** | Source C++ **OpenOffice 4.1.16** | Classes & Concepts Transposés |
| :--- | :--- | :--- | :--- |
| **Noyau AST & Types** | [`src/domain/document/types.ts`](src/domain/document/types.ts) | `main/sw/inc/doc.hxx`<br>`main/sw/inc/ndtxt.hxx` | `SwDoc`, `SwTxtNode`, `SwPaM`, `SwPageDesc`, `TextRun`, `ParagraphNode` |
| **Normalisation des Runs** | [`src/domain/document/runs.ts`](src/domain/document/runs.ts) | `main/sw/source/core/txtnode/thints.cxx` | `SwpHints::MergePortions` (fusion de portions identiques, suppression des vides) |
| **Index Séquentiel & Document** | [`src/domain/document/document.ts`](src/domain/document/document.ts) | `main/sw/source/core/doc/nodes.cxx` | `SwNodes`, `paragraphIndex` (index linéaire de lecture plat O(N)) |
| **Tableaux & Mutations** | [`src/domain/document/document.ts`](src/domain/document/document.ts)<br>[`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) | `main/sw/source/core/doc/tblrwcl.cxx`<br>`main/sw/inc/swtable.hxx` | `SwTable::InsertRow`, `DeleteRow`, `InsertCol`, `DeleteCol`, `colSpan`, `rowSpan` |
| **Notes de Bas de Page** | [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts)<br>[`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) | `main/sw/source/core/layout/ftnfrm.cxx`<br>`main/sw/source/core/text/txtftn.cxx` | `SwFtnFrm`, `SwFtnContFrm`, `SwTxtFtn`, indices séquentiels `¹`, `²` |
| **Table des Matières (TOC)** | [`src/domain/document/tox.ts`](src/domain/document/tox.ts)<br>[`src/domain/engine/tox.ts`](src/domain/engine/tox.ts) | `main/sw/source/core/tox/tox.cxx`<br>`main/sw/inc/tox.hxx` | `SwTOXBase`, `SwTOXMark`, `TOX_CONTENT`, génération dynamique des entrées |
| **Commentaires Marginaux** | [`src/domain/document/comments.ts`](src/domain/document/comments.ts)<br>[`src/ui/editor/CommentBand.tsx`](src/ui/editor/CommentBand.tsx) | `main/sw/source/core/fields/postit.cxx`<br>`main/sw/source/ui/docvw/PostItMgr.cxx` | `SwPostItField`, `SwPostItMgr`, fils de discussion et bulles de gouttière |
| **Suivi des Modifications** | [`src/domain/document/redline.ts`](src/domain/document/redline.ts) | `main/sw/source/core/doc/docredln.cxx`<br>`main/sw/inc/redline.hxx` | `SwRedline`, `SwRedlineTbl`, mode `REDLINE_ON`, acceptation et rejet |
| **Signets & Renvois** | [`src/domain/document/bookmarks.ts`](src/domain/document/bookmarks.ts) | `main/sw/source/core/doc/docbm.cxx`<br>`main/sw/inc/bookmrk.hxx` | `SwBookmark`, `IDocumentMarkAccess`, ancres de texte scalaires |
| **Cadres Flottants & Habillage** | [`src/domain/engine/flyLayout.ts`](src/domain/engine/flyLayout.ts)<br>[`src/ui/components/ImageWrapPicker.tsx`](src/ui/components/ImageWrapPicker.tsx) | `main/sw/source/core/layout/fly.cxx`<br>`main/sw/source/core/text/txtfly.cxx`<br>`main/sw/inc/fmtornt.hxx` | `SwFlyFrm`, `SwFlyFreeFrm`, `SwFmtSurround` (parallel, ideal, left, right, none, through), `SwTxtFly::GetSurroundForTextWrap`, `SwFmtHoriOrient`, `RES_OPAQUE` |
| **Césure, Mesure & Lignes** | [`src/domain/engine/lineBreak.ts`](src/domain/engine/lineBreak.ts)<br>[`src/domain/engine/measure.ts`](src/domain/engine/measure.ts) | `main/sw/source/core/text/txtfrm.cxx`<br>`main/sw/source/core/text/guess.cxx` | `SwTxtFormatter`, `SwLineLayout`, `SwTxtGuess::Guess`, justification inter-mots |
| **Pagination Physique A4** | [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts)<br>[`src/domain/document/pageSetup.ts`](src/domain/document/pageSetup.ts) | `main/sw/source/core/layout/layact.cxx`<br>`main/sw/source/core/layout/widorp.cxx` | `SwLayAction`, `WidowsAndOrphans`, `keepTogether`, `SwTabFrm::Split` |
| **En-têtes & Pieds de Page** | [`src/domain/document/pageFurniture.ts`](src/domain/document/pageFurniture.ts)<br>[`src/ui/components/FurnitureBand.tsx`](src/ui/components/FurnitureBand.tsx) | `main/sw/source/core/layout/headfrm.cxx`<br>`main/sw/source/core/fields/docufld.cxx` | `SwHeaderFrm`, `SwFooterFrm`, discrimination paires/impaires/première, variables |
| **Curseur & Sélection** | [`src/domain/engine/cursor.ts`](src/domain/engine/cursor.ts) | `main/sw/source/core/crsr/pam.cxx`<br>`main/sw/source/core/crsr/swcrsr.cxx` | `SwPaM`, `SwPosition`, grappes de graphèmes Unicode, mémoire d'abscisse `stickyX` |
| **Édition Atomique** | [`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) | `main/sw/source/core/txtnode/ndtxt.cxx`<br>`main/sw/source/core/edit/editshell.cxx` | `SplitCntntNode`, `JoinNext`, `InsertText`, `EraseText`, `applyRunFormat` |
| **Historique & Annulation** | [`src/domain/engine/history.ts`](src/domain/engine/history.ts) | `main/sw/source/core/undo/undobj.cxx`<br>`main/sw/source/core/undo/undoman.cxx` | `SwUndo`, `SwUndoManager`, regroupement intelligent par classe de caractères |
| **Listes & Numérotation** | [`src/domain/document/lists.ts`](src/domain/document/lists.ts) | `main/sw/source/core/doc/number.cxx`<br>`main/sw/inc/numrule.hxx` | `SwNumRule`, `SwNodeNum`, listes comme attributs de paragraphe (`RES_PARATR_LIST_*`) |
| **Règle Graduée & Retraits** | [`src/ui/components/Ruler.tsx`](src/ui/components/Ruler.tsx)<br>[`src/ui/editor/useWriterInput.ts`](src/ui/editor/useWriterInput.ts) | `main/svx/source/dialog/svxruler.cxx`<br>`main/svx/source/items/svxitems.cxx` | `SvxRuler`, `SvxLRSpaceItem`, retraits gauche/droite et première ligne |
| **Images & Recadrage** | [`src/domain/document/images.ts`](src/domain/document/images.ts)<br>[`src/ui/dialogs/ImageCropper.tsx`](src/ui/dialogs/ImageCropper.tsx) | `main/sw/source/core/layout/flycnt.cxx`<br>`main/svx/source/items/grfatr.cxx` | `FLY_AS_CHAR`, `SwFlyCntFrm`, `SvxGrfCrop` (recadrage vectoriel 4 retraits) |
| **Formules Mathématiques** | [`src/domain/math/render.ts`](src/domain/math/render.ts)<br>[`src/domain/math/snippets.ts`](src/domain/math/snippets.ts) | `main/starmath/source/document.cxx`<br>`main/starmath/source/parse.cxx` | StarMath (LaTeX/KaTeX rendu en SVG vectoriel inline et display) |
| **Recherche & Regex** | [`src/domain/engine/search.ts`](src/domain/engine/search.ts)<br>[`src/ui/dialogs/FindReplacePanel.tsx`](src/ui/dialogs/FindReplacePanel.tsx) | `main/sw/source/core/edit/search.cxx` | `SwSearch`, `SwCursor::Find`, surlignage simultané et remplacement atomique |
| **Désérialisation ODF XML** | [`src/domain/odf/import.ts`](src/domain/odf/import.ts)<br>[`src/domain/odf/styles.ts`](src/domain/odf/styles.ts) | `main/xmloff/source/text/txtimp.cxx`<br>`main/xmloff/source/text/XMLTableImport.cxx` | `XMLTextImportHelper`, parsing de `content.xml`, `styles.xml`, résolution de styles |
| **Sérialisation ODF XML** | [`src/domain/odf/export.ts`](src/domain/odf/export.ts)<br>[`src/domain/odf/styles.ts`](src/domain/odf/styles.ts) | `main/xmloff/source/text/txtparae.cxx`<br>`main/xmloff/source/text/XMLTableExport.cxx` | `XMLTextParagraphExport`, `AutomaticStyles` (déduplication optimale de styles) |
| **Archive ZIP ODF Native** | [`src/domain/odf/package.ts`](src/domain/odf/package.ts)<br>[`src/domain/odf/pictures.ts`](src/domain/odf/pictures.ts) | `main/xmloff/source/core/` | Génération ZIP native sans lib (CRC32, `deflate-raw`, dossier `Pictures/`) |
| **Génération PDF Vectorielle** | [`src/domain/pdf/export.ts`](src/domain/pdf/export.ts)<br>[`src/domain/pdf/print.ts`](src/domain/pdf/print.ts) | `main/vcl/source/gdi/pdfwriter_impl.cxx` | Export PDF natif avec vectorisation des textes, images XObject et formules |
| **Synchronisation CRDT** | [`src/domain/collab/crdt.ts`](src/domain/collab/crdt.ts)<br>[`src/domain/collab/session.ts`](src/domain/collab/session.ts) | `main/sw/source/core/txtnode/thints.cxx`<br>`main/sw/source/core/crsr/index.cxx` | Bijection `TextRun[]` ⇄ `Y.Text`, report de curseur `SwIndexReg` |
| **Serveur Temps Réel (Rust)** | [`server/src/main.rs`](server/src/main.rs)<br>[`server/src/sync.rs`](server/src/sync.rs)<br>[`server/src/doc.rs`](server/src/doc.rs) | `main/sw/source/ui/wrtsh/` | Relais WebSocket Yjs binaire, journal persistant, présence et snapshots |
| **Sécurité & JWT CloudServ** | [`server/src/auth.rs`](server/src/auth.rs)<br>[`server/src/crypto.rs`](server/src/crypto.rs)<br>[`server/src/hook.rs`](server/src/hook.rs) | `main/sfx2/` | Vérification JWT HS256, signature HMAC-SHA256 pour les rappels CloudServ |

---

## 📐 Description Détaillée des Sous-Systèmes

### 1. Composition Typographique & Mise en Page (`SwTxtFormatter`, `SwLineLayout`)
- **Découpage de lignes pur** : Implémenté dans [`src/domain/engine/lineBreak.ts`](src/domain/engine/lineBreak.ts), découpant le texte selon les opportunités de coupure d'espace, les césures forcées sur mots trop longs, et préservant les espaces insécables (`\u00a0`).
- **Justification parfaite** : Calcul de l'espacement inter-mots (`wordSpacingPx`) répartissant la largeur résiduelle sur les espaces de la ligne sans toucher à la dernière ligne d'un paragraphe.
- **Réglettes de tabulation** : Calcul des taquets de tabulation réguliers (`tabStopPx`) ou personnalisés.

### 2. Pagination A4 & Veuves/Orphelines (`SwLayAction`, `WidowsAndOrphans`)
- **Zone imprimable A4 réelle** : Calculée dans [`src/domain/document/pageSetup.ts`](src/domain/document/pageSetup.ts) (`pageWidthPx`, `pageHeightPx`, déduction des marges millimétriques et des bandes d'en-tête/pied).
- **Règles typographiques de coupure** : [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts) garantit qu'aucun paragraphe ne laisse moins de 2 lignes orphelines en bas de page ou moins de 2 lignes veuves en haut de page suivante.
- **Coupure et répétition de tableaux** : Coupure nette entre deux lignes d'un tableau et répétition automatique des lignes marquées `isHeader` en tête de chaque nouvelle page.

### 3. Notes de Bas de Page (`SwFtnFrm` / `SwFtnContFrm`)
- **Numérotation séquentielle automatique** : [`src/domain/engine/edit.ts`](src/domain/engine/edit.ts) insère des exposants (`¹`, `²`, etc.) dont les métadonnées (`footnoteText`, `footnoteId`) sont isolées pour ne pas polluer la frappe ultérieure.
- **Réservation d'espace & Rendu** : [`src/domain/engine/paginate.ts`](src/domain/engine/paginate.ts) et [`src/ui/editor/A4Page.tsx`](src/ui/editor/A4Page.tsx) réservent dynamiquement la hauteur nécessaire en bas de page et tracent le filet de séparation horizontal typographique de 20%.
- **Persistance ODF** : Relecture et écriture conformes aux balises `<text:note text:note-class="footnote">`.

### 4. Table des Matières Dynamique (`SwTOXBase`)
- **Collecte non destructive** : [`src/domain/document/tox.ts`](src/domain/document/tox.ts) et [`src/domain/engine/tox.ts`](src/domain/engine/tox.ts) analysent les titres (`Heading 1-6`) du document sans figer le texte, recalculant dynamiquement les numéros de page à chaque passe de pagination.
- **Mise en page avec points de suite** : Rendu des entrées de sommaire avec indentation hiérarchique, ligne de points de suite (`. . . . .`) et renvois cliquables (`__RefHeading__`).

### 5. Commentaires Marginaux & Suivi des Modifications (`SwPostItField`, `SwRedline`)
- **Bulles d'annotations** : [`src/domain/document/comments.ts`](src/domain/document/comments.ts) et [`src/ui/editor/CommentBand.tsx`](src/ui/editor/CommentBand.tsx) positionnent les commentaires en marge droite de la feuille A4, reliés visuellement à la plage textuelle commentée.
- **Mode Révision (`REDLINE_ON`)** : [`src/domain/document/redline.ts`](src/domain/document/redline.ts) enregistre les insertions (`REDLINE_INSERT`) et suppressions (`REDLINE_DELETE`) avec identification de l'auteur, date et couleur d'auteur dédiée (`REDLINE_AUTHOR_COLORS`), avec commandes d'acceptation et de rejet unitaire ou global.

### 6. Cadres Flottants & Habillage (`SwFlyFrm`, `SwSurround`)
- **Soustraction d'intervalles géométriques** : [`src/domain/engine/flyLayout.ts`](src/domain/engine/flyLayout.ts) calcule la bande utile restante pour chaque ligne de texte coupée par un cadre flottant selon les modes d'habillage OpenOffice (*Parallel*, *Left*, *Right*, *None*, *Through*).
- **Habillage optimal (`SURROUND_IDEAL`)** : port de `SwTxtFly::GetSurroundForTextWrap` (`txtfly.cxx:2372`). Le mode ne décrit pas une géométrie mais un **arbitrage** — la place restant de chaque côté du cadre décide, avec les seuils du C++ : `TEXT_MIN` (2 cm) sous lequel une colonne ne mérite pas d'exister, `FRAME_MAX` (1,5 cm) au-delà duquel le cadre ne garde que son côté le plus large.
- **Position déclarée, non figée (`SwFmtHoriOrient`)** : un cadre porte un **alignement** (gauche, centre, droite, ou position libre) et son **repère** (colonne de texte ou feuille entière), résolus en abscisse à chaque mise en page. Une image collée à la marge droite le reste quand la marge change ; une abscisse figée en points ne le ferait pas.
- **Deux calques (`RES_OPAQUE`)** : « derrière le texte » et « devant le texte » partagent l'habillage `through` et la même géométrie — seul l'ordre de peinture les sépare, comme `SwRootFrm::Paint` peint `hell` avant le texte et `heaven` après. L'export PDF respecte le même ordre.
- **Débordement hors de l'ancre** : `SwTxtFly` interroge la liste des cadres de la **page**, non celle du paragraphe d'ancrage. `projectedExclusions` fait de même : une image qui dépasse de son paragraphe — le cas courant — écarte aussi le texte des paragraphes suivants. Sa position absolue venant d'une passe déjà faite, la pagination en exécute une seconde dès qu'un cadre est présent.
- **Choix par l'usager** : [`src/ui/components/ImageWrapPicker.tsx`](src/ui/components/ImageWrapPicker.tsx) réunit les trois attributs d'OpenOffice — ancrage, habillage, calque — en les cinq combinaisons utiles du menu « Format ▸ Adaptation du texte » : *Aligner*, *Retour à la ligne*, *Intercaler le texte*, *Derrière le texte*, *Devant le texte*. Le menu est offert sur la barre de l'image sélectionnée et dans l'atelier d'image.
- **Glissement et ré-ancrage (`SwFEShell::BeginDrag` / `SetAnchor`)** : **toute** image se saisit à la souris, cadre flottant comme image du fil du texte. Au relâchement, [`moveImageRun`](src/domain/engine/edit.ts) ré-ancre le cadre au paragraphe où on l'a lâché — c'est l'ancre qui décide de sa page, et la corriger est ce qui permet de déposer une image sur une autre feuille. Un cadre flottant y gagne des coordonnées libres (`HoriOrientation::NONE`) ; une image du fil change simplement de place dans le texte.

---

### 7. Fenêtres de dialogue (`Modal`, `SwFrmDlg`)

- **Une colonne, trois zones** : [`src/design/components/Modal.tsx`](src/design/components/Modal.tsx) fixe l'en-tête et la barre d'actions, et ne laisse défiler que le corps. Faire défiler la fenêtre entière emportait « Appliquer » sous le bord de l'écran, et l'on croyait le dialogue sans issue.
- **Largeur souhaitée, jamais imposée** : `width` devient `min(largeur, 100 %)`. Une largeur en dur débordait des écrans étroits, et il fallait un ascenseur **horizontal** pour atteindre la moitié des champs — le défaut le plus coûteux d'un formulaire.
- **Onglets de l'atelier d'image** : le découpage est celui de `SwFrmDlg` — *Image* (source, dimensions, texte alternatif), *Position* (habillage, alignement, décalages), *Légende*. Vingt réglages à plat se valaient tous ; trois pages de six se parcourent d'un coup d'œil. L'aperçu, lui, reste en vue : il est le sujet des trois pages. Barre d'onglets ARIA complète — un seul onglet à la tabulation, les autres aux flèches.
- **Mobile (≤ 767 px)** : la fenêtre prend l'écran entier, l'aperçu passe au-dessus des réglages, les cinq modes d'habillage se rangent sur deux colonnes, et toute cible tactile atteint 44 px (WCAG 2.5.8). Les encoches sont respectées (`env(safe-area-inset-*)`).

## 🔒 Intégration Sécurisée à CloudServ

Writer s'intègre comme éditeur temporaire sans état durable pour **CloudServ** selon le principe :
> **« L'application édite. CloudServ possède. »**

```text
   ┌───────────────────────┐   Billet de service (JWT HS256, 60s)  ┌──────────────────────────┐
   │                       │ ────────────────────────────────────▶ │                          │
   │       CloudServ       │   POST /api/v1/documents              │   Serveur Writer (Rust)  │
   │      (API Python)     │                                       │   (Port 8081)            │
   │                       │ ◀──────────────────────────────────── │                          │
   └───────────────────────┘   Corps signé HMAC-SHA256             └──────────────────────────┘
                               POST …/session-checkpoint (en cours)
                               POST …/session-closed     (à la fin)
```

1. **Billets JWT nominatifs** : Émis par CloudServ (`WRITER_JWT_SECRET`), vérifiés par [`server/src/auth.rs`](server/src/auth.rs) (contrôle strict de `alg: HS256`, expiration courte 900s, et concordance obligatoire avec l'identifiant du document).
2. **Déchargement périodique (`session-checkpoint`)** : Envoyé par [`server/src/hook.rs`](server/src/hook.rs) toutes les 10s d'accalmie ou 120s maximales pour sauvegarder l'état dans le Drive sans saturer l'historique de versions.
3. **Fermeture sécurisée (`session-closed`)** : Déclenchée après départ du dernier utilisateur et délai de grâce de 30s. Le rappel signé HMAC-SHA256 déclenche l'archivage d'une version dans `.versions/` et la purge des données locales temporaires.

---

## 🧪 Suites de Tests & Validation

La robustesse de Writer est garantie par **27 suites de tests automatisés** côté client et **100 tests unitaires** côté serveur :

### Tests Client Vitest (`test/*.test.ts`) — 504 tests (100% Succès)
- [`test/runs.test.ts`](test/runs.test.ts) : 20 tests sur `SwpHints::MergePortions` et la normalisation des plages de style.
- [`test/lineBreak.test.ts`](test/lineBreak.test.ts) : 15 tests sur `SwTxtFormatter` (césure, justification, tabulations).
- [`test/paginate.test.ts`](test/paginate.test.ts) : 15 tests sur `SwLayAction` (pagination A4, veuves, orphelines, tableaux).
- [`test/footnote.test.ts`](test/footnote.test.ts) & [`test/footnoteReserve.test.ts`](test/footnoteReserve.test.ts) : 13 tests sur `SwFtnFrm` et la réservation de bas de page.
- [`test/tableMutation.test.ts`](test/tableMutation.test.ts) & [`test/cellMerge.test.ts`](test/cellMerge.test.ts) : 20 tests sur les mutations et fusions de cellules.
- [`test/tox.test.ts`](test/tox.test.ts) : 20 tests sur la table des matières `SwTOXBase`.
- [`test/annotations.test.ts`](test/annotations.test.ts) : 25 tests sur les commentaires `SwPostItField`.
- [`test/redline.test.ts`](test/redline.test.ts) : 21 tests sur le suivi des modifications `SwRedline`.
- [`test/flyLayout.test.ts`](test/flyLayout.test.ts) : 56 tests sur les cadres flottants, l'habillage (`SURROUND_IDEAL` compris), l'alignement et le calque.
- [`test/odf.test.ts`](test/odf.test.ts) : 29 tests sur l'import/export ODF 1.2 natif (`xmloff`).
- [`test/images.test.ts`](test/images.test.ts) : 48 tests sur `FLY_AS_CHAR`, le recadrage `SvxGrfCrop` et le déplacement d'un cadre (`SwFEShell::SetAnchor`).
- [`test/collab.test.ts`](test/collab.test.ts) : 35 tests sur la synchronisation CRDT Yjs.
- [`test/search.test.ts`](test/search.test.ts) : 20 tests sur le moteur de recherche regex `SwSearch`.
- [`test/lists.test.ts`](test/lists.test.ts) : 22 tests sur la numérotation hiérarchique `SwNumRule`.
- [`test/math.test.ts`](test/math.test.ts) : 17 tests sur les formules mathématiques vectorielles.
- [`test/pdf.test.ts`](test/pdf.test.ts) : 8 tests sur l'export PDF vectoriel.
- [`test/pageFurniture.test.ts`](test/pageFurniture.test.ts) : 6 tests sur les en-têtes/pieds de page et variables.
- [`test/edit.test.ts`](test/edit.test.ts) : 26 tests sur les opérations d'édition atomique et `SwUndo`.
- [`test/cloudserv.test.ts`](test/cloudserv.test.ts) : 8 tests sur l'authentification par billets JWT et les sessions.
- [`test/lectureSeule.test.ts`](test/lectureSeule.test.ts) : 4 tests sur les permissions et le mode lecture seule.
- [`test/exemple.test.ts`](test/exemple.test.ts) : 20 tests validant le document de démonstration complet.

### Tests Serveur Rust (`server/src/`) — 100 tests (100% Succès)
- Validation cryptographique (SHA-256 FIPS 180-4, HMAC RFC 4231, temps constant).
- Convergence CRDT Yrs, compaction de journal, rotation des points de restauration et parsing de paquets binaires.
- Vérification des billets JWT et rappels HTTP `session-checkpoint` / `session-closed`.
