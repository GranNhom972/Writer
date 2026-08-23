#!/usr/bin/env python3
"""Exemple 3 — REJOINDRE une session existante.

Quatre étapes, dans cet ordre :

  1. fournir la signature unique de la session (`token_session`) ;
  2. vérifier que la session existe ;
  3. rejoindre : signature + adresse du participant → permission accordée ;
  4. ouvrir directement l'application en écriture.

La permission n'est **jamais** demandée par le client : elle est celle que la
session accorde à cette adresse. Rejoindre en réclamant `write` quand la session
dit `read` donne `read`.

Usage :
  ./lancer.py                                  # session.json tel quel
  ./lancer.py --token sess-xxxx                # autre session
  ./lancer.py --email carole@exemple.fr        # autre participant
  ./lancer.py --derniere                       # dernière session créée sur ce serveur
  ./lancer.py --api                            # sans navigateur
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _commun import (  # noqa: E402
    ErreurApi,
    api,
    bloc_json,
    charger_json,
    demarrer_client,
    demarrer_serveur,
    echouer,
    etape,
    garder_ouvert,
    ouvrir_navigateur,
    succes,
    titre,
    url_editeur,
)

DOSSIER = Path(__file__).resolve().parent


def main() -> None:
    analyseur = argparse.ArgumentParser(description="Rejoindre une session collaborative Write.")
    analyseur.add_argument("--token", help="signature unique de la session (token_session)")
    analyseur.add_argument("--email", help="adresse du participant qui rejoint")
    analyseur.add_argument(
        "--derniere",
        action="store_true",
        help="rejoindre la dernière session créée sur ce serveur",
    )
    analyseur.add_argument(
        "--api", action="store_true", help="s'arrêter après avoir rejoint, sans navigateur"
    )
    analyseur.add_argument(
        "--session",
        type=Path,
        default=DOSSIER / "session.json",
        help="description du participant (défaut : session.json)",
    )
    options = analyseur.parse_args()

    titre("═══ Exemple : rejoindre une session ═══")
    demande = charger_json(options.session)
    email = options.email or demande["participant"]["email"]
    demarrer_serveur()

    # ── Étape 1 ──────────────────────────────────────────────────────────────
    etape(1, "fournir la signature unique de la session")
    if options.derniere:
        inventaire = api("GET", "/api/v1/sessions")["sessions"]
        if not inventaire:
            echouer(
                "Aucune session sur ce serveur.",
                "Créez-en une : cd ../create_session && ./lancer.py",
            )
        token_session = inventaire[-1]["token_session"]
        print(f"  Dernière session créée : {token_session}")
    else:
        token_session = options.token or demande["token_session"]
        print(f"  token_session = {token_session}")
    print(f"  participant   = {email}")

    # ── Étape 2 ──────────────────────────────────────────────────────────────
    etape(2, "vérifier que la session existe")
    try:
        session = api("GET", f"/api/v1/sessions/{token_session}")
    except ErreurApi as e:
        if e.statut == 404:
            echouer(
                "Aucune session ne porte cette signature.",
                "Créez-la d'abord : cd ../create_session && ./lancer.py",
            )
        raise
    succes("  200 — la session existe.")
    bloc_json(session, "    ")
    print(
        "\n  Les adresses sont masquées : confirmer une session ne doit pas livrer\n"
        "  l'annuaire de ses participants."
    )

    # ── Étape 3 ──────────────────────────────────────────────────────────────
    etape(3, "rejoindre la session avec la signature et l'adresse")
    print(f"  POST /api/v1/sessions/{token_session}/join")
    bloc_json({"email": email}, "    ")
    try:
        acces = api("POST", f"/api/v1/sessions/{token_session}/join", {"email": email})
    except ErreurApi as e:
        if e.statut == 403:
            echouer(
                f"{email} ne figure pas parmi les participants de cette session.",
                "Ajoutez cette adresse à ../create_session/session.json, ou utilisez --email.",
            )
        raise

    print("\n  Réponse :")
    bloc_json(acces, "    ")
    succes(f"\n  {acces['user_id']} rejoint avec la permission « {acces['permission']} »")
    if acces["permission"] != "write":
        print("  Le ruban sera désactivé, et le serveur ignorera toute modification :")
        print("  la sécurité ne repose jamais sur l'interface seule.")

    if options.api:
        return

    # ── Étape 4 ──────────────────────────────────────────────────────────────
    etape(4, "ouvrir l'application directement en écriture")
    demarrer_client()
    url = url_editeur(token_session, email)
    print("\n  Suivre les sauvegardes de cette session en temps réel :")
    print(f"    ../../local/client_local.py --token {token_session} --email {email} --suivre")
    ouvrir_navigateur(url)
    garder_ouvert()


if __name__ == "__main__":
    try:
        main()
    except ErreurApi as e:
        echouer(str(e))
    except KeyboardInterrupt:
        print()
