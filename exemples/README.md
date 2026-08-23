# Exemples — lancer un document Write

Trois scénarios, trois scripts **Python** (bibliothèque standard uniquement).
Chacun démarre ce dont il a besoin, **réutilise** ce qui tourne déjà, ouvre le
navigateur, et arrête proprement ce qu'il a lancé (Ctrl+C).

| Exemple | Serveur requis | Ce qu'il montre |
| :--- | :---: | :--- |
| [`local/`](local/) | oui¹ | Un document rédigé en local, fourni au serveur, dont les sauvegardes arrivent en temps réel dans le terminal |
| [`online/create_session/`](online/create_session/) | oui | Créer une session : signature unique, participants, permissions, document |
| [`online/join_session/`](online/join_session/) | oui | Rejoindre une session existante et recevoir la permission qu'elle accorde |

¹ `local/lancer.py --sans-serveur` ouvre un document en mémoire, sans backend.

## Démarrage le plus court

```bash
cd version_web/write/exemples/local && ./lancer.py
```

Pour la collaboration, deux terminaux :

```bash
cd version_web/write/exemples/online/create_session && ./lancer.py
```

```bash
cd version_web/write/exemples/online/join_session && ./lancer.py
```

Chaque `lancer.py` a une enveloppe `lancer.sh` équivalente, pour qui préfère.

## Le modèle : session, participants, permissions

Les trois exemples reposent sur la même notion. Une **session** nomme un document
par une signature choisie par le client — `token_session` — et lui attache la
liste des personnes qui y ont accès, avec leur adresse et leur permission.

```
token_session ──► nomme la session.  Public. N'ouvre aucun droit à lui seul.
participants  ──► ouvrent l'accès.   L'adresse identifie, la permission autorise.
doc_id        ──► adresse le document. Généré par le serveur (UUIDv7).
```

Cette séparation est délibérée. La v1 de l'API confondait les trois dans un seul
`unique_signature` qui servait à la fois d'identifiant et de secret : la connaître,
c'était pouvoir écrire (cf. [`AUDIT_CRITIQUE.md`](../../AUDIT_CRITIQUE.md)). Ici,
connaître le jeton ne suffit pas — il faut figurer sur la liste, et **c'est la
liste qui fixe la permission**. Un client qui réclame `write` alors que la session
lui accorde `read` obtient `read` : la restriction s'applique dans le WebSocket de
synchronisation, pas seulement dans l'interface.

Le jeton doit néanmoins être long (12 caractères au minimum) et non devinable :
il révèle l'existence d'une session. C'est aussi pourquoi la lecture publique
d'une session **masque les adresses** de ses participants.

## Routes utilisées

| Appel | Rôle |
| :--- | :--- |
| `GET /api/v1/sessions/{token_session}` | La session existe-t-elle ? (`404` ou `200`) |
| `POST /api/v1/sessions` | Créer : jeton, participants, permissions, document. `409` si le jeton est pris |
| `POST /api/v1/sessions/{token_session}/join` | Rejoindre par adresse → `doc_id`, permission, jeton d'accès |
| `GET /api/v1/sessions` | Inventaire (utilisé par `--derniere`) |
| `ws /api/v1/sessions/{token_session}/events` | Sauvegardes en JSON, en lecture seule |
| `ws /api/v1/sync/{doc_id}` | Synchronisation CRDT binaire — ce que parle l'éditeur |

## Prérequis

| Outil | Version | Nécessaire pour |
| :--- | :--- | :--- |
| Python | 3.10 ou plus | les scripts d'exemple (aucun paquet à installer) |
| Node.js + npm | 20 ou plus | client React |
| Rust + cargo | 1.75 ou plus | serveur de collaboration |

Les dépendances npm sont installées automatiquement à la première exécution.

## Réglages

| Variable | Défaut | Effet |
| :--- | :--- | :--- |
| `PORT_CLIENT` | `5173` | Port du serveur de développement Vite |
| `PORT_SERVEUR` | `8080` | Port du serveur Rust |

```bash
PORT_CLIENT=5200 PORT_SERVEUR=8100 ./lancer.py
```

Si un service écoute déjà sur le port attendu, le script le **réutilise** au lieu
d'échouer — pratique pour ouvrir plusieurs participants sans relancer le backend.
Il vérifie au passage que ce serveur connaît bien les sessions : un binaire
antérieur laissé en écoute produirait sinon un `404` incompréhensible.

## Paramètres d'URL

Les scripts ne font qu'assembler ces adresses ; elles se composent aussi à la main.

| Paramètre | Exemple | Effet |
| :--- | :--- | :--- |
| `session` + `email` | `?session=sess-…&email=alice@exemple.fr` | Rejoint la session ; **la permission vient de la session** |
| `mode=local` | `?mode=local&title=Notes` | Document en mémoire, aucune connexion |
| `doc` | `?doc=018f…&user=bob&scope=read` | Ouverture par identifiant de document (sans session) |

## Authentification en développement

En `WRITE_AUTH_MODE=dev` (le défaut hors production), figurer sur la liste des
participants tient lieu d'authentification : `join` délivre un jeton
`dev.<utilisateur>.<permission>`. C'est ce qui permet aux exemples de tourner sans
fournisseur d'identité — et **uniquement** ce qui le permet.

Avec `WRITE_ENV=production`, le serveur exige un JWT vérifié : `join` ne délivre
plus rien et se contente de confirmer que le jeton présenté correspond à un
participant. Les exemples ne fonctionnent alors plus tels quels — c'est voulu.
