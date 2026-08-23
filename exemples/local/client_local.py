#!/usr/bin/env python3
"""Client d'exemple : relier un document local au serveur distant.

Deux fonctions, celles décrites par la technique de cet exemple :

  • **fournir le document** — le JSON local devient une session sur le serveur,
    converti en document CRDT et journalisé avant que quiconque l'ouvre ;
  • **recevoir les sauvegardes en temps réel** — une trame JSON par sauvegarde
    durable arrive sur un WebSocket, tant que le programme tourne.

Ce client ne parle pas le protocole binaire de Yjs, et n'en a pas besoin : le
serveur expose, pour les observateurs, un flux texte lisible sans réimplémenter
un CRDT. Il n'obtient rien de plus pour autant — il faut être participant de la
session, exactement comme l'éditeur.

Usage :
  ./client_local.py                                     # fournir puis suivre
  ./client_local.py --document autre.json               # autre document local
  ./client_local.py --suivre --token sess-… --email …   # suivre une session existante
  ./client_local.py --fournir-seulement                 # sans suivi
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _commun import (  # noqa: E402
    ErreurApi,
    api,
    bloc_json,
    charger_json,
    demarrer_serveur,
    echouer,
    flux_sessions,
    jeton_aleatoire,
    succes,
    titre,
    url_editeur,
)

DOSSIER = Path(__file__).resolve().parent
AUTEUR_PAR_DEFAUT = "alice@exemple.fr"


def fournir(document: dict, email: str, token_session: str) -> dict:
    """Crée la session et y dépose le document local."""
    demande = {
        "token_session": token_session,
        "title": document.get("title", "Document local"),
        "participants": [{"email": email, "permission": "write"}],
        "document": document,
    }
    try:
        return api("POST", "/api/v1/sessions", demande)
    except ErreurApi as e:
        if e.statut == 409:
            echouer(
                f"La signature « {token_session} » est déjà prise.",
                "Relancez sans --token pour en générer une autre.",
            )
        raise


def rejoindre(token_session: str, email: str) -> dict:
    try:
        return api("POST", f"/api/v1/sessions/{token_session}/join", {"email": email})
    except ErreurApi as e:
        if e.statut == 404:
            echouer(f"Aucune session ne porte la signature « {token_session} ».")
        if e.statut == 403:
            echouer(f"{email} ne participe pas à cette session.")
        raise


def _rendre(bloc: dict) -> None:
    type_bloc = bloc.get("type")
    if type_bloc == "heading":
        print(f"    {'#' * int(bloc.get('level', 1))} {bloc.get('text', '')}")
    elif type_bloc == "paragraph":
        texte = bloc.get("text", "")
        print(f"    {texte}" if texte else "    ·")
    elif type_bloc in ("bullet_list", "ordered_list"):
        for rang, item in enumerate(bloc.get("items", []), start=1):
            marque = "-" if type_bloc == "bullet_list" else f"{rang}."
            print(f"    {marque} {item}")


def apercu(document: dict, tete: int = 5, queue: int = 3) -> None:
    """Rend le document en texte : c'est ce qu'on veut lire dans un terminal.

    Le début **et** la fin sont montrés : on tape le plus souvent à la fin, et un
    aperçu tronqué là n'aurait rien affiché de ce qu'on vient d'écrire.
    """
    blocs = document.get("blocks", [])
    if len(blocs) <= tete + queue:
        for bloc in blocs:
            _rendre(bloc)
        return

    for bloc in blocs[:tete]:
        _rendre(bloc)
    print(f"    … {len(blocs) - tete - queue} bloc(s) …")
    for bloc in blocs[-queue:]:
        _rendre(bloc)


def suivre(token_session: str, jeton: str) -> None:
    """Affiche les sauvegardes au fil de l'eau, jusqu'à Ctrl+C."""
    titre("\n═══ Sauvegardes en temps réel ═══")
    print("  Tapez dans le navigateur : chaque sauvegarde durable s'affiche ici.")
    print("  Ctrl+C pour arrêter.\n")

    try:
        with flux_sessions(token_session, jeton) as flux:
            for brut in flux.messages():
                evenement = json.loads(brut)
                genre = evenement.get("type")
                horodatage = evenement.get("at", "")[11:19]

                if genre == "heartbeat":
                    # Trame de vie : elle prouve que le lien tient, sans rien dire
                    # du document. L'afficher en continu masquerait les sauvegardes.
                    continue
                if genre == "snapshot":
                    succes(f"  [{horodatage}] état initial — « {evenement.get('title')} »")
                else:
                    succes(
                        f"  [{horodatage}] sauvegarde — {evenement.get('updates')} update(s), "
                        f"{evenement.get('bytes')} octets, "
                        f"{evenement.get('active_clients')} client(s) connecté(s)"
                    )
                apercu(evenement.get("document", {}))
                print()
    except KeyboardInterrupt:
        print()
    except ConnectionError as e:
        echouer(f"Flux interrompu : {e}")


def main() -> None:
    analyseur = argparse.ArgumentParser(description="Relier un document local au serveur Write.")
    analyseur.add_argument(
        "--document",
        type=Path,
        default=DOSSIER / "document_local.json",
        help="document local à fournir (défaut : document_local.json)",
    )
    analyseur.add_argument("--email", default=AUTEUR_PAR_DEFAUT, help="adresse de l'auteur")
    analyseur.add_argument("--token", help="signature de session (défaut : générée)")
    analyseur.add_argument(
        "--suivre",
        action="store_true",
        help="suivre une session existante, sans rien fournir",
    )
    analyseur.add_argument(
        "--fournir-seulement",
        action="store_true",
        help="déposer le document puis s'arrêter",
    )
    analyseur.add_argument(
        "--sans-demarrage",
        action="store_true",
        help="ne pas tenter de démarrer le serveur",
    )
    options = analyseur.parse_args()

    if not options.sans_demarrage:
        demarrer_serveur()

    if options.suivre:
        if not options.token:
            echouer("--suivre exige --token : quelle session faut-il observer ?")
        acces = rejoindre(options.token, options.email)
        suivre(options.token, acces["access_token"])
        return

    titre("═══ Document local → serveur distant ═══")

    document = charger_json(options.document)
    print(f"\n  Document local : {options.document}")
    print(f"  {len(document.get('blocks', []))} bloc(s), titre « {document.get('title')} »")
    apercu(document)

    token_session = options.token or jeton_aleatoire("sess-local")
    titre("\n  Fourniture du document au serveur…")
    session = fournir(document, options.email, token_session)
    bloc_json(session, "    ")

    acces = rejoindre(token_session, options.email)
    jeton = acces["access_token"]
    if jeton is None:
        # En mode JWT, le serveur ne délivre rien : l'appelant doit présenter le sien.
        echouer(
            "Le serveur est en mode JWT : ce client d'exemple n'a pas de jeton à présenter.",
            "Relancez le serveur sans WRITE_ENV=production pour l'exemple.",
        )

    succes(f"\n  Document fourni — doc_id {session['doc_id']}")
    print(f"  Ouvrez-le : {url_editeur(token_session, options.email)}")
    print("  Reprendre le suivi plus tard :")
    print(f"    ./client_local.py --suivre --token {token_session} --email {options.email}")

    if options.fournir_seulement:
        return
    suivre(token_session, jeton)


if __name__ == "__main__":
    try:
        main()
    except ErreurApi as e:
        echouer(str(e))
    except KeyboardInterrupt:
        print()
