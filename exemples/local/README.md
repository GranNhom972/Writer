# Document local relié au serveur

```bash
./lancer.py                    # les quatre étapes
./lancer.py --sans-serveur     # document en mémoire, aucun backend, aucun réseau
./lancer.py --document a.json  # autre document local
```

Le document d'exemple vit **en local**, dans [`document_local.json`](document_local.json).
Un client ([`client_local.py`](client_local.py)) le relie au serveur distant : il le
fournit, puis reçoit ses sauvegardes en temps réel.

## Ce que fait le script

| Étape | Appel | Effet |
| :---: | :--- | :--- |
| 1 | — | Lit `document_local.json` et l'affiche |
| 2 | `POST /api/v1/sessions` | Fournit le document : il devient un document CRDT, **journalisé avant toute connexion** |
| 3 | — | Ouvre l'éditeur dessus (`?session=…&email=…`) |
| 4 | `ws …/sessions/{token}/events` | Affiche chaque sauvegarde durable, au fil de la frappe |

Tapez dans le navigateur : le terminal affiche la sauvegarde et le document à jour.

```
  [08:04:38] sauvegarde — 1 update(s), 81 octets, 2 client(s) connecté(s)
    # Notes de réunion
    ## Relevé de décisions
    Décision : relire le rapport avant vendredi.
```

## Le client, séparément

`client_local.py` s'utilise seul, contre un serveur déjà démarré :

```bash
./client_local.py --fournir-seulement                      # déposer, puis rendre la main
./client_local.py --suivre --token sess-… --email alice@…  # suivre une session existante
```

## Pourquoi un flux JSON, et pas le protocole de synchronisation ?

L'éditeur parle le protocole binaire de Yjs sur `ws /api/v1/sync/{doc_id}` : c'est
le bon choix pour un éditeur — convergence, rattrapage réseau, édition hors ligne —
et un mur pour tout le reste. Un script qui veut seulement **suivre** un document
devrait sinon réimplémenter un CRDT pour lire trois paragraphes.

`ws /api/v1/sessions/{token}/events` est l'inverse : trames texte JSON, en lecture
seule. Il n'accorde aucun droit supplémentaire — il faut être participant, comme
pour la synchronisation — et n'accepte rien en écriture. Les événements sont
agrégés sur 250 ms : une frappe rapide ne produit pas un événement par caractère.

## Ce que l'exemple démontre

- Le contenu fourni est **durable avant que le navigateur s'ouvre** : chaque
  modification est écrite au journal (avec `fsync`) *avant* d'être rediffusée.
  Couper le serveur en pleine saisie et le relancer ne perd rien.
- Le modèle de document est le même en local et en collaboratif : seule la couche
  de transport change. C'est ce qui rend `--sans-serveur` possible.
- Les données vivent dans `server/data/<doc_id>/` (`journal.bin`, `snapshot.bin`,
  `meta.json`). Un instantané compacté est écrit toutes les 500 modifications.

## Mode sans serveur

`--sans-serveur` ouvre `?mode=local` : aucune requête n'est émise, la barre d'état
affiche « Document local — en mémoire », et fermer l'onglet perd le document. Le
contenu de `document_local.json` n'y est pas chargé — sans serveur, rien ne peut
le transmettre au navigateur.

## Pour aller plus loin

Le collaboratif à plusieurs : [`../online/create_session/`](../online/create_session/).

# Technique

- Creer l'exemple de document en local 
- Creer un client pour le mettre en ralation avec le server distant pour :
  - fournir le document .
  - recevoir les sauvegarde du document en temps reel via du web socket ou autre.
