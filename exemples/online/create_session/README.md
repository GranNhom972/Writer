# Créer une session collaborative

```bash
./lancer.py                        # session.json tel quel
./lancer.py --nouveau              # même contenu, signature régénérée
./lancer.py --token sess-xxxxxxxx  # signature imposée
./lancer.py --api                  # création seule, sans navigateur
```

Tout ce que décrit la session est dans [`session.json`](session.json) : la signature,
les participants avec leur adresse et leur permission, et le document de départ.

## Les quatre étapes

### Étape 1 — fournir la signature unique

```json
{ "token_session": "sess-rapport-q3-3f9c2a7d41b8" }
```

C'est le client qui la choisit. Elle **nomme** la session ; elle n'ouvre aucun
droit. Le serveur exige au moins 12 caractères alphanumériques (`-` et `_` admis) :
une signature courte serait énumérable, et l'existence d'une session — donc la
composition d'une équipe — se devinerait.

### Étape 2 — vérifier que la session n'existe pas

```
GET /api/v1/sessions/sess-rapport-q3-3f9c2a7d41b8
→ 404  la voie est libre
→ 200  la signature est déjà prise
```

Le script s'arrête sur un `200` et propose de rejoindre la session au lieu de la
recréer. La vérification est refaite côté serveur au moment de la création : le
fichier de session est créé en mode exclusif, donc deux créations simultanées du
même jeton ne peuvent pas réussir toutes les deux. Un `GET` suivi d'un `POST`
laisserait, seul, une fenêtre de course.

### Étape 3 — créer la session

```json
{
  "token_session": "sess-rapport-q3-3f9c2a7d41b8",
  "title": "Rapport Q3",
  "participants": [
    { "user_id": "alice",  "email": "alice@exemple.fr",  "permission": "write" },
    { "user_id": "bob",    "email": "bob@exemple.fr",    "permission": "write" },
    { "user_id": "carole", "email": "carole@exemple.fr", "permission": "read"  }
  ],
  "document": {
    "title": "Rapport Q3",
    "blocks": [
      { "type": "heading", "level": 1, "text": "Rapport trimestriel — Q3" },
      { "type": "paragraph", "text": "…" },
      { "type": "bullet_list", "items": ["Chiffres de clôture", "…"] },
      { "type": "ordered_list", "items": ["Valider le budget du T4", "…"] }
    ]
  }
}
```

**201 Created**

```json
{
  "token_session": "sess-rapport-q3-3f9c2a7d41b8",
  "doc_id": "01a02879-73e2-72a0-a561-e06b5f440698",
  "title": "Rapport Q3",
  "created_at": "2026-08-22T07:57:23Z",
  "created_by": "alice",
  "participants": [
    { "user_id": "alice", "email": "alice@exemple.fr", "permission": "write" }
  ],
  "sync_path": "/api/v1/sync/01a02879-73e2-72a0-a561-e06b5f440698",
  "events_path": "/api/v1/sessions/sess-rapport-q3-3f9c2a7d41b8/events"
}
```

Points à retenir :

- `user_id` est facultatif : sans lui, il est déduit de l'adresse (`alice@…` → `alice`).
- `permission` vaut `read`, `comment` ou `write`. Une valeur inconnue est **refusée**,
  pas silencieusement ramenée à `read` : une faute de frappe doit se voir.
- Le `doc_id` reste **généré par le serveur** (UUIDv7). Un client ne choisit jamais
  l'identifiant d'une ressource.
- Le contenu de `document` est converti en document CRDT et **journalisé
  immédiatement**. Il est durable avant que quiconque ouvre le navigateur.

Blocs acceptés : `paragraph`, `heading` (`level` 1 à 6), `bullet_list`,
`ordered_list`. Bornes : 2 000 blocs, 20 000 caractères par bloc, 500 entrées par
liste. Le reste de la mise en forme se fait dans l'éditeur — l'amorçage sert à
fournir un point de départ, pas à réimplémenter l'application côté serveur.

### Étape 4 — ouvrir l'application en écriture

Le script ouvre le premier participant qui a la permission d'écrire :

```
http://localhost:5173/?session=sess-rapport-q3-3f9c2a7d41b8&email=alice%40exemple.fr
```

L'application rejoint la session, reçoit la permission qui lui est accordée, et
ouvre l'éditeur — sans écran intermédiaire.

## Variante API seule

`--api` s'arrête après la création, garde le serveur debout et affiche la signature :

```bash
./lancer.py --api --nouveau
```

Le titre et le contenu se changent dans `session.json`, ou avec `--session autre.json`.

## Ensuite

```bash
cd ../join_session && ./lancer.py --token sess-rapport-q3-3f9c2a7d41b8
```

Suivre les sauvegardes en temps réel :

```bash
../../local/client_local.py --suivre --token sess-rapport-q3-3f9c2a7d41b8 --email alice@exemple.fr
```

# Technique :

Creer un doc dessaye pour founir data et un exemple de json

Etape 1 : founir la signature unique de la doc ( nom variable token_session )
Etape 2 : Vérifier que la session n'existe pas
Etape 3 : Creer une session avec le token_session et les utilisateur + email et leurs permission + data doc
Etape 4 afficher l'application direct d'ecriture
