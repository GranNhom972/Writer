# Writer — moteur de traitement de texte natif (React + TypeScript)

Portage des **algorithmes d'Apache OpenOffice Writer** (`aoo-4.1.16/main/sw`,
`editeng`, `xmloff`) en TypeScript strict, conformément à
[`../../CLAUDE.md`](../../CLAUDE.md).

> **Règle d'or respectée** : aucune bibliothèque de traitement de texte externe.
> Pas de ProseMirror, Slate, Quill, TipTap ni CKEditor. Le rendu, le curseur, la
> césure, la pagination, l'annulation, la recherche, les listes et le format ODF
> sont écrits ici.
>
> Deux dépendances d'exécution s'ajoutent à React, et aucune n'est un éditeur.
>
> **KaTeX**, pour composer les formules mathématiques : un compositeur de
> formules, au même titre qu'un moteur de rendu de fontes. Écrire nous-mêmes la
> mise en forme mathématique de TeX serait un projet à part entière. La
> dépendance est isolée dans [`domain/math/`](src/domain/math/) : le moteur de
> texte n'en sait rien.
>
> **Yjs**, pour le partage. C'est une bibliothèque de **structures de données
> répliquées** (CRDT), pas de texte enrichi : elle ne sait ni rendre, ni
> paginer, ni gérer un curseur — tout cela reste écrit ici. Le CLAUDE.md la
> prévoit d'ailleurs explicitement au point 16 (`Y.UndoManager` en collaboratif).
> Elle n'entre que dans [`domain/collab/`](src/domain/collab/), où
> [`crdt.ts`](src/domain/collab/crdt.ts) traduit le modèle Writer en types
> répliqués et retour ; le moteur, lui, continue de ne connaître que
> `WriterDocumentState`.

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

**Images** — insertion par fichier, par adresse ou par glisser-déposer,
redimensionnement à rapport verrouillé, texte alternatif, **rognage**. Une image
est ancrée **comme caractère** (`FLY_AS_CHAR` / `SwFlyCntFrm`) : c'est un
attribut de run, pas un nœud à part, et elle se sélectionne, se copie et se
justifie donc exactement comme un caractère. Le moteur lui réserve sa place à la
ligne près et ne coupe jamais dedans.

**Rognage** — double-clic sur l'aperçu d'une image ouvre l'atelier : huit
poignées, un cadre déplaçable, grille des tiers, et les flèches du clavier pour
qui n'a pas de souris. Comme `SvxGrfCrop`, ce sont **quatre retraits** qui sont
mémorisés, pas un rectangle de découpe : l'image reste entière, seul son cadrage
change, et « Rétablir l'image entière » revient exactement au point de départ.
Rogner deux fois se compose — le second geste s'exprime dans ce que l'aperçu
montre, et non dans l'original.

**Partage** — un document se partage à une liste de personnes nommées, chacune
avec sa permission (lire, commenter, modifier). Chaque personne reçoit un lien
qui lui est propre ; la permission est inscrite dans le partage, jamais dans le
lien, et transmettre son lien ne donne donc aucun accès. Édition simultanée,
présence, rattrapage après coupure, et édition **hors ligne** : le document
local reste la source de ce que l'on voit, le réseau ne fait que le diffuser.
Deux personnes qui écrivent dans **le même paragraphe** voient leurs frappes
fusionner caractère par caractère — c'est un CRDT, repris de l'application Write.

**OpenDocument** — lecture et écriture de `content.xml`, `styles.xml`,
`meta.xml`, `META-INF/manifest.xml`, du dossier `Pictures/` et du conteneur ZIP
`.odt` lui-même. Les styles ODF sont aplatis à la lecture, refactorisés en
styles automatiques à l'écriture.

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
| [`domain/document/images.ts`](src/domain/document/images.ts) | `layout/flycnt.cxx`, `svx/grfcrop.hxx` | `SwFlyCntFrm`, `SwGrfNode`, `SvxGrfCrop`, `CH_TXTATR_BREAKWORD` |
| [`ui/dialogs/ImageCropper.tsx`](src/ui/dialogs/ImageCropper.tsx) | `svx/source/dialog/grfpage.cxx` | `SvxGrfCropPage` — le mode « Rogner » |
| [`domain/odf/import.ts`](src/domain/odf/import.ts) | `xmloff/source/text/txtimp.cxx` | `XMLTextImportHelper` |
| [`domain/odf/export.ts`](src/domain/odf/export.ts) | `xmloff/source/text/txtparae.cxx` | `XMLTextParagraphExport` |
| [`domain/odf/pictures.ts`](src/domain/odf/pictures.ts) | `xmloff/source/core/` | `SvXMLGraphicHelper` — le dossier `Pictures/` |
| [`domain/collab/crdt.ts`](src/domain/collab/crdt.ts) | `txtnode/thints.cxx`, `crsr/index.cxx` | `SwpHints` ⇄ delta `Y.Text` ; `SwIndexReg` — le report du curseur |

## Architecture — les quatre couches du CLAUDE.md

```
src/
├── domain/document/   Couche 1 — modèle et types. Aucun React, aucun DOM.
├── domain/engine/     Couche 2 — algorithmes purs, exécutables en Web Worker.
├── domain/odf/        Couche 2 — moteur XML OpenDocument.
├── domain/pdf/        Couche 2 — écriture PDF native.
├── domain/image/      Adaptateur — décodage d'images par le navigateur.
├── domain/collab/     Couche 4 — projection CRDT, transport, présence.
├── ui/                Couche 3 — rendu React et saisie.
└── server/            Serveur Rust : relais CRDT, journal durable, dépôt d'images.
```

Deux fichiers seulement connaissent le DOM en dehors de `ui/` :
[`engine/measure.ts`](src/domain/engine/measure.ts) pour mesurer le texte et
[`image/raster.ts`](src/domain/image/raster.ts) pour décoder les images. Les
deux existent pour la même raison — écrire nous-mêmes un moteur de fontes ou un
décodeur PNG serait un projet à part entière — et les deux sont isolés derrière
une interface que le reste du moteur ne voit pas.

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

## Le partage : un CRDT, repris de l'application Write

La première version ne partageait pas un CRDT mais des **opérations de bloc**
typées, qu'un serveur séquençait : `replace-block`, `insert-block`,
`remove-block`… Le modèle convergeait, au sens strict — tous les participants
appliquaient la même suite d'opérations dans le même ordre.

Il convergeait à la **granularité du bloc**, et c'est ce qui le rendait
inutilisable à deux. Deux personnes qui écrivaient dans le même paragraphe
émettaient chacune un « remplace ce paragraphe », et la seconde effaçait la
première. Sur un paragraphe, c'est une phrase perdue — sans message, sans trace,
sans moyen de la récupérer.

La collaboration est donc reprise de l'application Write, qui n'a pas ce défaut
parce qu'elle ne compare rien : son document **est** un CRDT
([Yjs](https://github.com/yjs/yjs) côté client, [`yrs`](https://github.com/y-crdt/y-crdt)
côté serveur), et deux insertions concurrentes dans la même phrase fusionnent
caractère par caractère.

Ce qui a été repris, et ce qui ne l'a pas été : **la couche de transport, pas
l'éditeur**. Write projette son document dans ProseMirror ; Writer garde son
propre moteur — rendu, curseur, césure, pagination, annulation. Seule la
synchronisation change.

### La correspondance

Le point qui rend l'opération possible : `Y.Text` et `TextRun[]` disent
exactement la même chose — une suite de plages de texte homogènes. La
représentation en delta d'un `Y.Text` **est** une liste de runs. La conversion
est donc une bijection, et non une approximation.

```
 writer:meta    Y.Map      titre, auteur, dates
 writer:setup   Y.Map      pageSetup, defaults, furniture
 writer:blocks  Y.Array    un Y.Map par bloc
     ├─ id, type          clés simples ; `paragraph` ⇄ `heading` n'est qu'un
     │                    changement de clé, pas un nœud reconstruit
     ├─ text   Y.Text      le texte, le formatage de caractère porté par ses
     │                     attributs (`SwpHints` aplati)
     ├─ attrs  Y.Map       attributs de paragraphe (alignement, liste, retraits)
     └─ rows   Y.Array     tableaux : lignes → cellules → blocs, récursivement
```

[`domain/collab/crdt.ts`](src/domain/collab/crdt.ts) tient les deux sens, et
`server/src/content.rs` en est le miroir exact en Rust — le seul endroit du
projet où deux langages décrivent la même structure.

### Les quatre règles qui tiennent la correction

1. **La descente dans le CRDT est chirurgicale.** `reconcile` ne réécrit pas le
   paragraphe modifié : il en déduit *la plage réellement remplacée* et ne
   touche qu'à elle. C'est cette économie, et rien d'autre, qui fait que deux
   frappes concurrentes fusionnent au lieu de s'écraser.
2. **Une frappe descend dans le CRDT même hors ligne.** Le document répliqué est
   ce qui la retient jusqu'au retour du réseau ; suspendre la descente pendant
   une coupure la perdrait, puisque rien d'autre ne la garde.
3. **La publication a lieu dans un effet de mise en page**, donc dans la même
   tâche que la frappe. Un effet passif serait rejeté à une tâche ultérieure, et
   une trame distante reçue entre les deux ferait relire un document répliqué où
   la frappe ne figure pas encore.
4. **Le curseur local est reporté** quand quelqu'un écrit avant lui — règle de
   `SwIndexReg`. Sans ce report, écrire au-dessus de quelqu'un lui décale son
   texte sous le curseur : il croit taper à un endroit et les lettres tombent
   ailleurs.

Et deux règles inchangées, côté serveur :

5. **Valider → journaliser (`fsync`) → rediffuser**, dans cet ordre. Rediffuser
   avant d'écrire exposerait à une perte que les pairs auraient déjà affichée.
6. **La permission vient de la liste des participants**, jamais du jeton.
   Réclamer `write` dans son jeton ne donne rien si la session dit `read`. Et
   l'identité vient d'un jeton vérifié, transporté dans le sous-protocole
   WebSocket, où il ne fuite ni dans les journaux d'accès, ni dans le `Referer`,
   ni dans l'historique du navigateur.

### Ce que le changement coûte

Le journal contenait des lignes JSON qu'un `tail -f` rendait lisibles ; il
contient maintenant des updates binaires. C'est un vrai regret, et la
contrepartie assumée de la fusion caractère par caractère. Le contenu reste
consultable à la demande : `GET /api/v1/documents/{id}/snapshot` et le flux
d'observation le projettent en JSON (`server/src/content.rs`).

Les documents partagés **avant** ce changement ne sont pas perdus : au premier
chargement, le serveur rejoue leur ancien journal (`server/src/legacy.rs`), en
tire l'état, et s'en sert pour amorcer le document répliqué.

### Le serveur

```bash
cd version_web/writer/server && cargo run     # écoute sur 127.0.0.1:8081
cargo test                                    # 66 tests
```

| Route | Rôle |
| :--- | :--- |
| `POST /api/v1/sessions` | Partager un document à une liste de personnes |
| `GET /api/v1/sessions/{jeton}` | Le partage existe-t-il ? Adresses **masquées** |
| `POST /api/v1/sessions/{jeton}/join` | Rejoindre — rend la permission inscrite |
| `POST /api/v1/sessions/{jeton}/participants` | Inviter (réservé à l'écriture) |
| `GET /api/v1/sessions/{jeton}/events` | Flux d'observation JSON, lecture seule |
| `GET /api/v1/sync/{doc_id}` | WebSocket d'édition : trames Yjs binaires, présence |
| `POST /api/v1/documents/{id}/assets` | Déposer une image |
| `GET /api/v1/documents/{id}/assets/{nom}` | Servir une image |
| `GET /api/v1/documents/{id}/restore-points` | États conservés à chaque compaction |
| `DELETE /api/v1/documents/{id}` | Efface le document et ses données — refusé s'il reste des participants |

**Les images ne transitent pas dans le document.** Une image insérée hors ligne
vit en `data:` ; au partage, elle est déposée une fois et le run ne porte plus
qu'une adresse. Sans cela, une photo de 2 Mo repartirait sur le réseau à chaque
caractère tapé dans le paragraphe qui la porte, pour chaque participant.

**Le format d'une image est reconnu à ses octets, jamais au `Content-Type`
annoncé.** Un fichier prétendument PNG mais contenant du HTML serait servi depuis
notre origine — c'est un XSS stocké. Le SVG est refusé pour la même raison : c'est
un document capable de porter du script. Le nom du fichier est fabriqué par le
serveur (UUIDv4), jamais repris de la requête : aucun `..` ne peut atteindre le
système de fichiers.


## Éditeur temporaire de CloudServ

Writer sait aussi ne **pas** posséder les documents qu'il édite. Branché à
CloudServ, il devient un éditeur collaboratif temporaire : le fichier, ses
partages et son historique restent chez CloudServ, et rien ne subsiste ici une
fois la séance terminée.

```bash
export WRITER_AUTH_MODE=jwt
export WRITER_JWT_SECRET="…"                      # partagé avec CloudServ
export WRITER_CLOUDSERV_URL=http://127.0.0.1:8021
export WRITER_DATA_DIR=~/cloudantille/.writer
cargo run
```

Sans `WRITER_CLOUDSERV_URL`, le serveur fonctionne exactement comme avant :
partages gérés par lui-même, aucun rappel, aucune purge. Les deux modes coexistent.

### Le billet d'accès remplace la liste des participants

Pour un document de CloudServ, Writer ne tient **aucune** liste : c'est CloudServ
qui signe, à chaque ouverture, un billet nominatif portant l'identité, la
permission et **l'identifiant du document**. Quatre contrôles, et chacun ferme
une faille :

| Contrôle | Ce qu'il empêche |
| :--- | :--- |
| `alg` figé à `HS256` | `"alg":"none"`, la vulnérabilité la plus répandue des implémentations JWT |
| signature recalculée, comparée à temps constant | forger `{"sub":"alice","scope":"write"}` — ce que la version précédente laissait passer, faute de vérifier quoi que ce soit |
| `exp` obligatoire et borné à deux heures | un billet sans expiration est un droit d'accès permanent que rien ne révoque |
| `doc` comparé à la route appelée | qu'un billet obtenu légitimement ouvre **tous** les autres documents, dont l'identifiant suffirait alors à connaître |

Le billet voyage dans le **fragment** de l'adresse d'ouverture
(`#doc=…&token=…`), jamais dans la query string : un fragment n'est pas transmis
au serveur, donc n'apparaît ni dans les journaux d'accès ni dans le `Referer`. Le
client l'efface dès qu'il l'a lu.

SHA-256 et HMAC-SHA256 sont écrits dans [`crypto.rs`](server/src/crypto.rs), avec
les vecteurs d'essai des RFC : deux cents lignes entièrement spécifiées plutôt que
`sha2`, `hmac`, `digest` et leur suite dans un projet qui n'a **aucune**
dépendance de cryptographie.

### La fin de session

```text
  dernier départ
       │
       ├─ attendre le délai de grâce      un F5 ferme le WebSocket et en rouvre un ;
       │  (WRITER_CLOSE_GRACE_SECS, 30 s) sans ce délai, chaque rechargement
       │                                  sauvegarderait et créerait une version
       ├─ le document est-il resté vide ? un compteur d'occupation qui ne
       │                                  redescend jamais distingue « personne
       │                                  n'est venu » de « quelqu'un est passé »
       ├─ projeter en JSON, y incorporer les images
       │                                  le fichier remis à CloudServ doit se
       │                                  suffire à lui-même : les images du dépôt
       │                                  deviennent des URI `data:`, sans quoi il
       │                                  serait truffé de liens morts dès la purge
       ├─ POST signé vers CloudServ
       └─ purger — et seulement si CloudServ a confirmé
```

**On ne purge jamais avant confirmation.** CloudServ injoignable, les données
restent en place et seront resauvegardées à la réouverture ; un `404` — document
que CloudServ ne connaît pas — ne purge pas non plus. Perdre le travail de
quelqu'un parce qu'un service voisin redémarrait serait indéfendable.

Le rappel est signé (HMAC-SHA256 du corps) : sans cela, quiconque peut joindre
l'API de CloudServ pourrait annoncer la fin d'une session et lui faire écrire le
document de son choix.

Le client HTTP sortant est écrit à la main
([`hook.rs`](server/src/hook.rs)) — c'est la seule requête sortante du projet, et
y faire entrer `reqwest` avec sa pile TLS pour un POST vers un service interne
serait disproportionné. La contrepartie est explicite : **seul `http://` est
géré**, et une adresse `https://` est refusée plutôt que traitée à moitié.

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
| `Ctrl+Maj+I` | Insérer une image |
| `Ctrl+P` / `Ctrl+Maj+O` | Imprimer / aperçu avant impression |
| `Échap` | Quitter la zone d'édition (puis `Tab` pour sortir) |

Double clic : le mot. Triple clic : le paragraphe. Double clic sur l'aperçu
d'une image, dans son atelier : le rognage.

## Tests

```bash
cd version_web/writer && npm test
```

259 tests couvrant les invariants de `SwpHints` (fusion, scission, formatage sur
plage), le retour à la ligne (occasions de coupure, coupure forcée, espaces
suspendues, insécable, tabulations, justification), la pagination (zone
imprimable, veuves et orphelines, `keep-together`, paragraphe plus haut qu'une
page, coupure et en-têtes répétées d'un tableau), l'édition (grappes de
graphèmes, fusion de paragraphes, frontières de tableau, presse-papiers),
l'historique (regroupement par classe de caractère, purge du refaire), les
listes (numérotation par niveau, reprise, cloisonnement par cellule, `Entrée`
sur un élément vide), la recherche (casse, mot entier avec accents, traversée
des runs, remplacement de la fin vers le début), l'en-tête et le pied de page,
l'export PDF, les formules, le moteur ODF (unités XSL-FO, styles hérités,
aller-retour complet, conteneur ZIP), les **images** (cadre atomique, report
plutôt que coupure, adresses refusées, aller-retour `Pictures/`, XObject
`/DCTDecode`), le **rognage** (composition de deux gestes, bords opposés qui se
recouvrent, forme canonique des attributs, `fo:clip` aller-retour, chemin de
rognage PDF), le **partage** (convergence de deux frappes dans le même
paragraphe, plage réellement remplacée, report du curseur, liens) et
l'**ouverture depuis CloudServ** (billet lu dans le fragment, portée inconnue
rabattue en lecture, nom accentué, billet illisible refusé plutôt que deviné).

```bash
cd version_web/writer/server && cargo test
```

96 tests côté serveur : convergence de deux updates concurrentes, aller-retour
JSON ⇄ CRDT, reprise d'un document de l'ancien format, durabilité du journal,
trame tronquée ignorée, unicité d'un jeton de partage, rotation des points de
restauration, traversée de répertoire, reconnaissance des formats d'image.

S'y ajoutent ceux de l'intégration CloudServ : les vecteurs d'essai de SHA-256
(FIPS 180-4) et de HMAC (RFC 4231), le refus d'`alg:none`, d'une signature
forgée, d'une charge utile modifiée, d'un billet sans expiration ou à validité
excessive, le cloisonnement d'un billet à son document, et l'incorporation des
images — y compris dans une cellule de tableau, le cas qu'on oublie.

```bash
npm run typecheck   # TypeScript strict, exactOptionalPropertyTypes compris
```

## Ce qui n'est pas encore fait

| Manque | Pourquoi il compte |
| :--- | :--- |
| Césure par dictionnaire (`XHyphenator`) | Le point 5 de `Guess` — coupure forcée — la remplace ; la structure est prête à l'accueillir |
| Import ODF des listes | L'export écrit les listes ; à la relecture, elles redeviennent des paragraphes retraits |
| Cadres flottants et habillage (`SwFmtSurround`) | Seul l'ancrage « comme caractère » est porté ; une image ancrée à la page ou au paragraphe est lue, mais coule dans le flux |
| Rognage à taille de cadre constante | Le rognage réduit le cadre d'autant (mode « conserver l'échelle ») ; Writer propose aussi « conserver la taille », qui agrandit ce qui reste |
| Coupure d'une **ligne** de tableau à cheval sur deux pages | Un tableau se coupe entre lignes ; une ligne plus haute qu'une page déborde |
| Largeurs de colonnes ODF (`<table:table-column>`) | Les colonnes importées sont réparties également |
| Édition des tableaux (insérer, supprimer, fusionner) | Le modèle et la mise en page les portent, l'interface ne les manipule pas |
| Curseurs distants peints dans le texte | La présence donne les avatars et transporte déjà la position ; le rendu du caret d'autrui reste à faire |
| Déplacement d'un bloc sans le reconstruire | `Y.Array` ne sait pas déplacer un élément : réordonner un paragraphe le retire et le repose, ce qui perd les frappes concurrentes **de ce bloc-là**. Rare (glisser-déposer, opérations de tableau) face à la frappe, qui elle est préservée |
| Commentaires de marge et suivi des modifications | Points 13 et 14 du CLAUDE.md ; la permission `comment` existe côté serveur mais n'ouvre encore rien de plus que la lecture |
| Fournisseur d'identité OIDC (JWKS, `iss`, `aud`) | `WRITER_AUTH_MODE=jwt` vérifie désormais la **signature** HS256 avec `WRITER_JWT_SECRET`, l'algorithme, l'expiration et le lien au document. Ce qui reste à faire est d'accepter aussi des jetons signés par un fournisseur externe (RS256 + JWKS), pour les déploiements où l'identité ne vient pas de CloudServ |
