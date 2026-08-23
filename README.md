# Write — traitement de texte collaboratif (React + TypeScript / Rust)

Première tranche d'intégration de l'application **Write**, conforme aux directives
[`00_DIRECTIVE_ARCHITECTURE.md`](../00_DIRECTIVE_ARCHITECTURE.md),
[`01_DIRECTIVE_UX_ERGONOMIE.md`](../01_DIRECTIVE_UX_ERGONOMIE.md) et
[`integration_api_rust.md`](../integration_api_rust.md).

```
write/
├── client/    React 18 + TypeScript strict + ProseMirror + Yjs
└── server/    Rust + Axum + yrs (relais CRDT, journal durable)
```

## Exemples prêts à lancer

Le dossier [`exemples/`](exemples/) contient trois scénarios exécutables, écrits en
Python (bibliothèque standard uniquement — rien à installer) :

| Exemple | Commande | Serveur requis |
| :--- | :--- | :---: |
| Document local relié au serveur | `exemples/local/lancer.py` | oui |
| Créer une session | `exemples/online/create_session/lancer.py` | oui |
| Rejoindre une session | `exemples/online/join_session/lancer.py --derniere` | oui |

`exemples/local/lancer.py --sans-serveur` ouvre un document en mémoire, sans backend.

Chaque script installe ce qu'il faut, démarre les services manquants, **réutilise**
ceux qui tournent déjà, ouvre le navigateur, puis arrête proprement ce qu'il a
lancé. Détails et paramètres d'URL : [`exemples/README.md`](exemples/README.md).

## Démarrage manuel

Deux terminaux.

```bash
cd version_web/write/server && cargo run
```

```bash
cd version_web/write/client && npm install && npm run dev
```

Puis ouvrir <http://localhost:5173>. Le serveur écoute sur `127.0.0.1:8080` ; le
serveur de développement Vite relaie `/api` vers lui (même origine, donc pas de CORS
et un en-tête `Origin` conforme à la liste blanche du serveur).

Pour tester la collaboration : créer un document dans un onglet, copier son
identifiant, puis « Rejoindre » depuis un second onglet sous un autre nom.

### Variables d'environnement du serveur

| Variable | Défaut | Rôle |
| :--- | :--- | :--- |
| `WRITE_BIND` | `127.0.0.1:8080` | Adresse d'écoute |
| `WRITE_DATA_DIR` | `./data` | Journal + snapshots |
| `WRITE_AUTH_MODE` | `dev` | `dev` ou `jwt` |
| `WRITE_ALLOWED_ORIGINS` | `http://localhost:5173,…` | Liste blanche `Origin` (anti-CSWSH) |
| `WRITE_ENV` | — | `production` force `WRITE_AUTH_MODE=jwt` |

## Architecture retenue

**Le serveur est un relais + un journal.** Il ne connaît pas le schéma du document :
il ne manipule que des updates CRDT opaques (ADR-001). Cela rend le backend simple à
rendre correct, et donne gratuitement l'édition hors ligne et le rattrapage réseau.

Deux chemins **optionnels** font exception, et un seul module les porte
([`content.rs`](server/src/content.rs)) : l'amorçage d'une session à partir du
document fourni par le client, et le flux d'observation en JSON. Le cœur du relais,
lui, reste aveugle au contenu.

```
React 18 ──► ProseMirror (projection éditable)
              │
              ▼
           Y.XmlFragment  ← source de vérité (Yjs)
              │  trames binaires y-protocols (wss)
              ▼
         Axum ──► yrs ──► journal append-only (fsync) ──► snapshot compacté
                    └───► rediffusion aux autres clients
```

Séquence imposée pour toute update entrante : **valider → journaliser → rediffuser**.
Rediffuser avant de persister exposerait à une perte reconnue par les pairs.

## Ce qui fonctionne aujourd'hui (vérifié en navigateur)

**Modes d'ouverture**
- **Local** (`?mode=local`) : aucun serveur, aucune requête — même modèle de
  document, sans la couche de transport.
- **Session** (`?session=<token_session>&email=<adresse>`) : l'application rejoint
  la session et ouvre l'éditeur avec la permission que celle-ci accorde.
- **Création** (`?mode=create&title=…`) puis **participation** (`?doc=<id>&user=…&scope=…`).

**Sessions, participants, permissions**
- `POST /api/v1/sessions` — signature fournie par le client (`token_session`),
  participants (adresse + permission) et document initial. `409` si la signature
  est déjà prise ; la création du fichier de session est exclusive, donc l'unicité
  ne dépend pas d'un `GET` préalable.
- `POST /api/v1/sessions/{token}/join` — l'adresse identifie, la session autorise.
- La permission inscrite dans la session **borne** celle du jeton à l'ouverture du
  WebSocket de synchronisation : réclamer `write` quand la session dit `read` donne
  `read`, et une identité hors de la liste est refusée (`4403`).
- `ws /api/v1/sessions/{token}/events` — sauvegardes en JSON, en lecture seule, pour
  les clients qui ne parlent pas le protocole binaire de Yjs.

**Collaboration**
- Création de document, ouverture par identifiant, lien de partage (`?doc=…`), snapshot.
- Temps réel à plusieurs clients : curseurs et sélections distants, présence.
- Couleurs de présence **dérivées d'un hachage** de l'identifiant : identiques chez tous.
- Titre du document répliqué par le CRDT (renommage visible immédiatement) **et**
  rendu durable côté serveur (`PATCH /api/v1/documents/:id`).
- Édition hors ligne + resynchronisation automatique au retour du réseau.
- Durabilité : arrêt brutal du serveur → le document est rechargé depuis son journal.
- Présence purgée à la déconnexion : le serveur diffuse le retrait des participants
  d'une connexion fermée, sans attendre l'expiration côté client.
- **Points de restauration** : chaque compaction conserve l'état précédent
  (`GET /api/v1/documents/:id/restore-points`), et `POST …/restore` recrée un
  point choisi **dans un nouveau document**. Un nouveau document, et non le même :
  dans un CRDT une suppression est définitive, et le premier client encore
  connecté avec l'état supprimé le rediffuserait aussitôt.

**Système d'icônes**
- Jeu d'icônes maison ([`design/icons/Icon.tsx`](client/src/design/icons/Icon.tsx)) :
  grille 24 × 24, zone vive 20 × 20, contour 1,75 px, extrémités arrondies,
  `currentColor` exclusivement — l'icône suit l'état du bouton et le thème sans
  une seule règle CSS supplémentaire.
- Icônes **décoratives** (`aria-hidden`, `focusable="false"`) : le nom accessible
  vient toujours de l'`aria-label` du bouton, jamais de l'icône.
- Planche de contrôle en développement : <http://localhost:5173/icons.html>
  (16 / 20 / 48 px, thèmes clair et sombre, rendu en situation dans le ruban).

**Édition et mise en forme**
- Barre de menus complète : Fichier, Édition, Affichage, Insertion, Format, Aide —
  motif ARIA `menubar`, navigation aux flèches, `Échap`, raccourcis affichés.
- Caractère : gras, italique, souligné, barré, **police**, **taille (− / champ / +)**,
  **couleur de texte**, **surlignage**.
- Palette de couleurs **générée** (8 × 10) : une teinte de base par colonne, des
  niveaux de clarté partagés, donc un rythme homogène et un **nom accessible dérivé
  automatiquement** pour chacune des 80 pastilles. Motif ARIA `grid` avec tabulation
  itinérante : **un seul arrêt de tabulation**, navigation aux flèches.
- **Couleur personnalisée** : carré saturation/luminosité, curseur de teinte, saisie
  **HEX et R/V/B** synchronisées, aperçu avant/après, **rapport de contraste WCAG
  affiché en continu** (choisir un texte illisible doit être une décision, pas un
  accident). Les couleurs personnalisées sont mémorisées entre les sessions.
- Paragraphe : titres 1–6, alignements, **interligne**, **retraits (± 1 cm)**.
- Listes : à puces, numérotées, **à cocher** (vraie case `<input>` focusable).
- Insertion : **liens** (dialogue avec texte d'affichage), **images** (texte alternatif
  obligatoire), saut de page.
- **En-tête et pied de page**, identiques sur toutes les pages (Insertion →
  En-tête et pied de page…). Jetons `{page}`, `{pages}`, `{titre}`, `{date}`,
  numérotation optionnelle, masquage sur la première page.
  **Format réglable** : distance de l'en-tête au bord haut, du pied au bord bas,
  alignement de chacun, corps du texte, et **marges du document** (haut, bas,
  gauche, droite). Ces réglages pilotent la géométrie réelle — corps de texte,
  cadres de page, pagination et impression — et non un simple aperçu. Si l'en-tête
  dépasse la marge, celle-ci est repoussée : le texte ne peut pas passer dessous. Ils vivent dans les
  métadonnées répliquées du document : un participant les modifie, tous les
  voient. Repris à l'impression grâce à des éléments fixés, qui se répètent sur
  chaque feuille.
- **Pagination** : le texte respecte réellement les limites de page — jamais de
  texte sur l'en-tête ni le pied. Démarche empruntée à Writer
  (`sw/source/core/layout/`) : le contenu qui ne tient plus est **reporté** sur la
  page suivante (`SwFlowFrm::MoveFwd`), et un tableau ne se déplace pas d'un bloc,
  il se coupe **entre deux lignes** (`SwTabFrm::Split`). Les unités de report sont
  donc les blocs, les éléments de liste et les lignes de tableau. Le report est une
  décoration d'affichage : absente du document, de l'export et de la
  synchronisation. `Ctrl+Entrée` envoie bien la suite sur une nouvelle page.
  Banc d'essai : <http://localhost:5173/pagination-test.html> — il construit un
  document éprouvant, mesure chaque élément et signale en rouge tout texte qui
  déborderait sur une marge.
- **Zoom** 50–200 %, **mode lecture**, **impression** (feuille de style dédiée),
  effacement de la mise en forme.
- **Téléchargements** (menu Fichier), tous produits dans le navigateur — le
  document n'est envoyé à aucun service tiers pour être converti :
  - **PDF** : le document est recomposé
    dans un **cadre isolé qui ne contient que la feuille**, avec les styles de
    l'écran. Aucun élément d'interface ne peut s'y glisser — masquer le chrome par
    des règles `@media print` était un jeu perdu d'avance : la règle du document,
    stylée en ligne, s'imprimait faute de classe à cibler.
    `@page { margin: 0 }` supprime la marge de page où le navigateur loge ses
    en-têtes (date, titre, URL) ; les marges du document sont appliquées dans la
    feuille. L'usager choisit « Enregistrer au format PDF » dans la boîte
    d'impression ; le message le lui dit avant qu'elle ne s'ouvre.
  - **Word (.docx)** et **ODF (.odt)** : fichiers complets.
  Ce que l'export ne transcrit pas fidèlement (images, formules) est **annoncé**,
  jamais perdu en silence.
- **Tableaux** : la taille se choisit **par survol d'une grille** dans le ruban
  (aperçu « 4 × 3 » en continu, flèches et `Entrée` au clavier). Le curseur va
  dans la première cellule, et un paragraphe est toujours conservé après le
  tableau — sans lui, un tableau en fin de document piège le curseur.
  Une fois posé, le tableau se manipule **directement sur lui-même** :
  poignées de ligne et de colonne sur ses bords (menu court : insérer avant /
  après, supprimer), **points « + » à chaque frontière** pour insérer exactement
  là où l'on pointe, et **poignée d'angle à étirer** comme une plage de tableur,
  avec un badge « 5 × 4 » qui suit le geste (une seule entrée d'historique, au
  relâchement). Le même bouton du ruban ouvre les **propriétés** pour ce qui ne
  se manipule pas au doigt : épaisseur et couleur du trait, ligne d'en-tête,
  dimensions au clavier. Tout s'applique en direct — `Ctrl+Z` annule.
- **Rechercher et remplacer** (`Ctrl+F`) : panneau **non modal** ancré dans la zone
  du document, recherche en direct, **toutes les occurrences surlignées** avec la
  courante distinguée, compteur « 3 / 12 », options casse et mot entier (accents
  compris), remplacement replié par défaut. `Entrée` / `Maj+Entrée` naviguent,
  `Échap` ferme. « Tout remplacer » tient dans **une seule transaction** : un
  `Ctrl+Z` défait l'ensemble. En lecture seule, la partie remplacement disparaît.
- Raccourcis : `Ctrl+B/I/U`, `Ctrl+Maj+X`, `Ctrl+1..6`, `Ctrl+L/E/R/J`, `Ctrl+K`,
  `Ctrl+Maj+7/8/9`, `Ctrl+]`/`Ctrl+[`, `Ctrl+Maj+</>`, `Ctrl+\\`, `Ctrl+Entrée`,
  `Ctrl+P`, `Ctrl+Z`/`Ctrl+Y` (**annulation par utilisateur**, pas globale).
- Sept états d'interface : vide, chargement, erreur, hors ligne, lecture seule
  (avec la **raison** : droits insuffisants ≠ mode lecture choisi), reconnexion.

**Sécurité**
- Identité issue du jeton (jamais du corps de requête), `doc_id` généré par le serveur,
  jeton transporté par sous-protocole WebSocket, vérification d'`Origin`, limites de
  trame / débit / clients, erreurs normalisées RFC 9457.
- URL de liens et d'images normalisées : `javascript:`, `data:`, `file:` **refusés**
  (un lien est rediffusé à tous les collaborateurs — vecteur XSS classique).
- Import ODT : `content.xml` → document (titres, paragraphes, listes, tabulations),
  avec bornes anti zip-bomb.

## Ce qui n'est pas encore fait

| Manque | Jalon |
| :--- | :---: |
| Vérification JWT réelle (`auth.rs::verify_jwt` refuse tout pour l'instant) | J0 |
| Persistance Postgres + fan-out Redis (aujourd'hui : fichiers locaux, une instance) | J0 |
| Export serveur (rendu identique quel que soit le poste) ; aujourd'hui l'export a lieu dans le navigateur | J1 |
| Images incorporées à l'export DOCX (aujourd'hui : texte alternatif) | J1 |
| Formules en OMML dans le DOCX (aujourd'hui : source LaTeX) | J1 |
| Styles nommés ODF (`styles.xml`), tableaux, images | J1 |
| Découpe d'un bloc plus haut qu'une page (tableau très long) sur deux pages | J1 |
| Panneau d'historique / points de restauration | J4 |
| Menu de dépassement du ruban (écart assumé à la Loi de Hick, cf. `Ribbon.tsx`) | J1 |
| Téléversement d'images (aujourd'hui : insertion par URL uniquement) | J1 |
| Fusion de cellules, largeurs de colonnes ajustables à la souris | J1 |
| En-têtes et pieds de page dans les exports Word et ODF | J1 |

## Tests

```bash
cd version_web/write/server && cargo test
```

```bash
cd version_web/write/client && npm test
```

Couverture actuelle : 35 tests Rust (protocole lib0, convergence CRDT, journal et
compaction, portées d'authentification, limitation de débit, validation des
sessions et des participants, aller-retour JSON ⇄ CRDT) et 112 tests TypeScript
(pagination, présence, import ODF, commandes d'édition, normalisation d'URL et refus
des schémas exécutables, bornes de taille et de retrait, listes, effacement de format,
contrat du jeu d'icônes, conversions de couleur, contraste WCAG, invariants de la
palette dont l'unicité des noms accessibles, recherche et remplacement, tableaux).

Restent à écrire, exigés par la Definition of Done : fuzzing de convergence à N
clients, aller-retour ODF sur corpus, e2e multi-clients Playwright, axe-core.
