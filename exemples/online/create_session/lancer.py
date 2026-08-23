#!/usr/bin/env python3
"""Exemple 2 — CRÉER une session collaborative.

Quatre étapes, dans cet ordre :

  1. fournir la signature unique de la session (`token_session`) ;
  2. vérifier qu'aucune session ne la porte déjà ;
  3. créer la session : jeton, participants (adresse + permission) et document ;
  4. ouvrir directement l'application en écriture.

Usage :
  ./lancer.py                        # session.json tel quel
  ./lancer.py --nouveau              # même contenu, signature régénérée
  ./lancer.py --token sess-xxxxxxxx  # signature imposée
  ./lancer.py --api                  # sans navigateur : création seule
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _commun import (  # noqa: E402
    ErreurApi,
    api,
    attention,
    bloc_json,
    charger_json,
    demarrer_client,
    demarrer_serveur,
    echouer,
    etape,
    garder_ouvert,
    jeton_aleatoire,
    ouvrir_navigateur,
    succes,
    titre,
    url_editeur,
)

DOSSIER = Path(__file__).resolve().parent


def main() -> None:
    analyseur = argparse.ArgumentParser(description="Créer une session collaborative Write.")
    analyseur.add_argument("--token", help="signature unique à utiliser (token_session)")
    analyseur.add_argument(
        "--nouveau",
        action="store_true",
        help="régénérer la signature, pour rejouer l'exemple sans conflit",
    )
    analyseur.add_argument(
        "--api", action="store_true", help="s'arrêter après la création, sans navigateur"
    )
    analyseur.add_argument(
        "--session",
        type=Path,
        default=DOSSIER / "session.json",
        help="description de la session (défaut : session.json)",
    )
    options = analyseur.parse_args()

    titre("═══ Exemple : créer une session collaborative ═══")
    demande = charger_json(options.session)
    demarrer_serveur()

    # ── Étape 1 ──────────────────────────────────────────────────────────────
    etape(1, "fournir la signature unique de la session")
    if options.token:
        token_session = options.token
    elif options.nouveau:
        token_session = jeton_aleatoire("sess-rapport-q3")
    else:
        token_session = demande["token_session"]
    demande["token_session"] = token_session

    print(f"  token_session = {token_session}")
    print("  Cette signature nomme la session ; elle n'ouvre aucun droit à elle seule.")
    print("  L'accès vient de la liste des participants, et la permission avec.")

    # ── Étape 2 ──────────────────────────────────────────────────────────────
    etape(2, "vérifier que la session n'existe pas")
    try:
        existante = api("GET", f"/api/v1/sessions/{token_session}")
    except ErreurApi as e:
        if e.statut != 404:
            raise
        succes("  404 — aucune session ne porte cette signature : la voie est libre.")
    else:
        attention("  200 — cette signature est déjà prise :")
        bloc_json(existante, "    ")
        echouer(
            "Impossible de créer deux fois la même session.",
            "Relancez avec --nouveau, ou rejoignez-la : "
            "cd ../join_session && ./lancer.py --token " + token_session,
        )

    # ── Étape 3 ──────────────────────────────────────────────────────────────
    etape(3, "créer la session : participants, permissions et document")
    print("  Corps envoyé à POST /api/v1/sessions :")
    bloc_json(demande, "    ")

    session = api("POST", "/api/v1/sessions", demande)
    print("\n  Réponse (201 Created) :")
    bloc_json(session, "    ")
    succes(f"\n  Session créée — doc_id {session['doc_id']}")
    print("  Le document fourni est déjà écrit au journal : il survivra à un arrêt brutal.")

    if options.api:
        print("\n  Pour rejoindre depuis un autre poste :")
        print(f"    cd ../join_session && ./lancer.py --token {token_session}")
        # Le serveur reste debout : sans cela, la commande ci-dessus n'aurait rien
        # à rejoindre le temps de la taper.
        garder_ouvert()
        return

    # ── Étape 4 ──────────────────────────────────────────────────────────────
    etape(4, "ouvrir l'application directement en écriture")
    # La création est le seul appel qui renvoie les adresses en clair : elles
    # viennent d'être fournies par l'appelant. Les lectures ultérieures les masquent.
    redacteurs = [p for p in session["participants"] if p["permission"] == "write"]
    if not redacteurs:
        echouer("Aucun participant n'a la permission d'écrire : rien à ouvrir.")
    auteur = redacteurs[0]

    demarrer_client()
    url = url_editeur(token_session, auteur["email"])

    succes(f"  Éditeur ouvert pour {auteur['email']} (permission : write)")
    print("\n  Rejoindre depuis un autre terminal :")
    print(f"    cd ../join_session && ./lancer.py --token {token_session}")
    print("\n  Suivre les sauvegardes en temps réel :")
    print(f"    ../../local/client_local.py --token {token_session} --email {auteur['email']} --suivre")
    ouvrir_navigateur(url)
    garder_ouvert()


if __name__ == "__main__":
    try:
        main()
    except ErreurApi as e:
        echouer(str(e))
    except KeyboardInterrupt:
        print()
