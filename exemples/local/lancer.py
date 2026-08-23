#!/usr/bin/env python3
"""Exemple 1 — Document LOCAL, relié au serveur distant.

Ce que fait cet exemple, dans l'ordre :

  1. le document d'exemple existe **en local**, dans `document_local.json` ;
  2. un client le **fournit** au serveur : il devient un document CRDT, journalisé
     avant même que le navigateur s'ouvre ;
  3. l'application s'ouvre dessus ;
  4. le client **reçoit les sauvegardes en temps réel** par WebSocket, et les
     affiche dans ce terminal au fil de la frappe.

Usage :
  ./lancer.py                    # les quatre étapes ci-dessus
  ./lancer.py --sans-serveur     # document en mémoire, aucun réseau, aucun backend
  ./lancer.py --document a.json  # autre document local
"""

from __future__ import annotations

import argparse
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _commun import (  # noqa: E402
    ErreurApi,
    URL_CLIENT,
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
from client_local import apercu, fournir, rejoindre, suivre  # noqa: E402

DOSSIER = Path(__file__).resolve().parent


def sans_serveur(document: dict) -> None:
    """Mode démonstration hors ligne : le document ne quitte pas l'onglet."""
    titre("═══ Exemple : document local, sans serveur ═══")
    demarrer_client()
    titre_document = document.get("title", "Document local")
    url = f"{URL_CLIENT}/?mode=local&title={urllib.parse.quote(titre_document)}"

    succes(f"  Document local ouvert — « {titre_document} »")
    print("\n  • Aucun serveur, aucune requête : le modèle de document est le même,")
    print("    seule la couche de transport disparaît.")
    print("  • Fermer l'onglet perd le document : c'est le comportement attendu ici.")
    print("  • Le contenu de document_local.json n'est pas chargé dans ce mode :")
    print("    sans serveur, rien ne peut le transmettre au navigateur.")
    ouvrir_navigateur(url)
    garder_ouvert()


def main() -> None:
    analyseur = argparse.ArgumentParser(description="Document local relié au serveur Write.")
    analyseur.add_argument(
        "--document",
        type=Path,
        default=DOSSIER / "document_local.json",
        help="document local (défaut : document_local.json)",
    )
    analyseur.add_argument("--email", default="alice@exemple.fr", help="adresse de l'auteur")
    analyseur.add_argument(
        "--sans-serveur",
        action="store_true",
        help="ouvrir un document en mémoire, sans backend ni réseau",
    )
    options = analyseur.parse_args()

    document = charger_json(options.document)
    if options.sans_serveur:
        sans_serveur(document)
        return

    titre("═══ Exemple : document local relié au serveur ═══")

    # ── Étape 1 ──────────────────────────────────────────────────────────────
    etape(1, "le document existe en local")
    print(f"  Fichier : {options.document}")
    print(f"  {len(document.get('blocks', []))} bloc(s), titre « {document.get('title')} »")
    apercu(document)

    demarrer_serveur()

    # ── Étape 2 ──────────────────────────────────────────────────────────────
    etape(2, "fournir le document au serveur distant")
    token_session = jeton_aleatoire("sess-local")
    session = fournir(document, options.email, token_session)
    succes(f"  Document fourni — doc_id {session['doc_id']}")
    print(f"  token_session : {token_session}")
    print("  Le contenu est écrit au journal avant toute connexion : couper le")
    print("  serveur maintenant ne perdrait rien.")

    acces = rejoindre(token_session, options.email)
    if acces["access_token"] is None:
        echouer(
            "Le serveur est en mode JWT : ce client d'exemple n'a pas de jeton à présenter.",
            "Relancez le serveur sans WRITE_ENV=production pour l'exemple.",
        )

    # ── Étape 3 ──────────────────────────────────────────────────────────────
    etape(3, "ouvrir l'application sur ce document")
    demarrer_client()
    ouvrir_navigateur(url_editeur(token_session, options.email))

    # ── Étape 4 ──────────────────────────────────────────────────────────────
    etape(4, "recevoir les sauvegardes en temps réel")
    suivre(token_session, acces["access_token"])


if __name__ == "__main__":
    try:
        main()
    except ErreurApi as e:
        echouer(str(e))
    except KeyboardInterrupt:
        print()
