# Rejoindre une session

```bash
./lancer.py                                  # session.json tel quel
./lancer.py --token sess-xxxx                # autre session
./lancer.py --email carole@exemple.fr        # autre participant
./lancer.py --derniere                       # dernière session créée sur ce serveur
./lancer.py --api                            # sans navigateur
```

[`session.json`](session.json) porte **la même signature** que
[`../create_session/session.json`](../create_session/session.json) : c'est elle qui
désigne la session à rejoindre.

```json
{
  "token_session": "sess-rapport-q3-3f9c2a7d41b8",
  "participant": { "user_id": "bob", "email": "bob@exemple.fr" }
}
```

La permission ne figure pas ici, et c'est le point : **elle est inscrite dans la
session**, pas demandée par celui qui rejoint.

## Les quatre étapes

### Étape 1 — fournir la signature unique

Reprise de `session.json`, de `--token`, ou de `--derniere` (les sessions sont
listées par `GET /api/v1/sessions`, la plus récente est retenue).

### Étape 2 — vérifier que la session existe

```
GET /api/v1/sessions/sess-rapport-q3-3f9c2a7d41b8
→ 200  elle existe
→ 404  rien à rejoindre — le script renvoie vers ../create_session
```

La réponse **masque les adresses** (`a****@exemple.fr`). Confirmer qu'une session
existe ne doit pas livrer l'annuaire de ses participants.

### Étape 3 — rejoindre

```
POST /api/v1/sessions/sess-rapport-q3-3f9c2a7d41b8/join
{ "email": "bob@exemple.fr" }
```

```json
{
  "token_session": "sess-rapport-q3-3f9c2a7d41b8",
  "doc_id": "01a02879-73e2-72a0-a561-e06b5f440698",
  "user_id": "bob",
  "email": "bob@exemple.fr",
  "permission": "write",
  "access_token": "dev.bob.write",
  "auth_mode": "dev",
  "sync_path": "/api/v1/sync/01a02879-73e2-72a0-a561-e06b5f440698",
  "editor_path": "/?session=sess-rapport-q3-3f9c2a7d41b8&email=bob%40exemple.fr"
}
```

Une adresse absente de la liste reçoit `403` — et non `404` : à ce stade,
l'existence de la session est déjà connue de l'appelant, la cacher n'apporterait rien.

`access_token` n'est délivré qu'en mode développement. En `WRITE_AUTH_MODE=jwt`,
il vaut `null` : l'appelant présente son propre jeton, et le serveur se contente de
confirmer qu'il correspond à un participant.

### Étape 4 — ouvrir l'application en écriture

```
http://localhost:5173/?session=sess-rapport-q3-3f9c2a7d41b8&email=bob%40exemple.fr
```

## Ce que l'exemple démontre

- **La permission vient de la session.** Essayez avec `--email carole@exemple.fr` :
  la session lui accorde `read`, le ruban est désactivé, la barre d'état affiche
  « Lecture seule — vous n'avez pas les droits d'écriture ». Et surtout, le serveur
  **ramène la portée** à celle du participant à l'ouverture du WebSocket : un client
  modifié qui réclamerait `write` obtiendrait quand même `read`. La sécurité ne
  repose jamais sur l'interface seule.

  Le serveur ignore les modifications au lieu de fermer la connexion, et c'est
  délibéré : le protocole impose au client d'envoyer son état à l'ouverture, y
  compris en lecture seule. Fermer déclencherait une boucle de reconnexion.

- **Hors de la liste, pas d'accès.** Une identité qui ne participe pas à la session
  se voit refuser l'ouverture du WebSocket (`4403`), même avec un jeton valide.

- **Convergence.** Tapez simultanément dans deux fenêtres, au même endroit : les
  deux vues restent identiques. Le CRDT réordonne les modifications concurrentes
  sans arbitrage serveur.

- **Présence.** Chaque participant a une couleur *dérivée du hachage de son
  identifiant*, donc identique sur tous les écrans, et son curseur porte son nom.

- **Rattrapage réseau.** Coupez le Wi-Fi ou arrêtez le serveur, continuez à écrire,
  rallumez : la synchronisation reprend seule. C'est le cas nominal du protocole,
  pas une procédure de secours.

- **Départs.** Fermez une fenêtre : l'avatar disparaît immédiatement chez les
  autres. Une page qui disparaît sans se fermer proprement est purgée sous 90 secondes.

## Essayer à trois

Dans un troisième terminal :

```bash
./lancer.py --token sess-rapport-q3-3f9c2a7d41b8 --email carole@exemple.fr
```

Le serveur et le client déjà démarrés sont réutilisés.

# Technique 
creer aussi json avec meme session ... 

Etape 1 : founir la signature unique de la doc ( nom variable token_session )
Etape 2 : Vérifier que la session existe
Etape 3 : Rejoindre la session avec le token_session et les utilisateur + email
Etape 4 afficher l'application direct d'ecriture
