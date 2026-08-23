"""Plomberie partagée par les exemples.

Chaque exemple reste lisible et autonome ; seul le service (démarrage des
processus, attente de disponibilité, appels HTTP, arrêt propre) vit ici.

Bibliothèque standard uniquement : un exemple qui exige `pip install` avant de
pouvoir démontrer quoi que ce soit n'est pas un exemple.
"""

from __future__ import annotations

import atexit
import base64
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Iterator

# Sortie ligne à ligne : redirigé vers un fichier ou un tube, Python bufferise par
# blocs — les étapes n'apparaîtraient qu'à la fin, ce qui rend un exemple illisible
# quand il attend quelque chose.
sys.stdout.reconfigure(line_buffering=True)

EXEMPLES_DIR = Path(__file__).resolve().parent
WRITE_DIR = EXEMPLES_DIR.parent
CLIENT_DIR = WRITE_DIR / "client"
SERVEUR_DIR = WRITE_DIR / "server"

PORT_CLIENT = int(os.environ.get("PORT_CLIENT", "5173"))
PORT_SERVEUR = int(os.environ.get("PORT_SERVEUR", "8080"))
URL_CLIENT = f"http://localhost:{PORT_CLIENT}"
URL_SERVEUR = f"http://127.0.0.1:{PORT_SERVEUR}"

# Processus démarrés par cet exemple : eux seuls seront arrêtés à la sortie.
_PROCESSUS: list[subprocess.Popen[bytes]] = []


# ── Affichage ────────────────────────────────────────────────────────────────

def _couleur(code: str, texte: str, flux=sys.stdout) -> None:
    if flux.isatty():
        print(f"\033[{code}m{texte}\033[0m", file=flux)
    else:
        print(texte, file=flux)


def titre(texte: str) -> None:
    _couleur("1;34", texte)


def succes(texte: str) -> None:
    _couleur("1;32", texte)


def attention(texte: str) -> None:
    _couleur("1;33", texte)


def erreur(texte: str) -> None:
    _couleur("1;31", texte, sys.stderr)


def etape(numero: int, texte: str) -> None:
    """Les étapes du protocole sont numérotées à l'écran comme dans le README :
    quand un exemple échoue, on doit voir *à quelle étape*."""
    _couleur("1;36", f"\nÉtape {numero} — {texte}")


def bloc_json(valeur: Any, indentation: str = "  ") -> None:
    rendu = json.dumps(valeur, indent=2, ensure_ascii=False)
    for ligne in rendu.splitlines():
        print(f"{indentation}{ligne}")


def echouer(message: str, conseil: str | None = None) -> None:
    erreur(message)
    if conseil:
        erreur(f"  → {conseil}")
    sys.exit(1)


# ── Prérequis ────────────────────────────────────────────────────────────────

def exiger(commande: str, conseil: str) -> None:
    from shutil import which

    if which(commande) is None:
        echouer(f"Commande manquante : {commande}", conseil)


# ── HTTP ─────────────────────────────────────────────────────────────────────

class ErreurApi(Exception):
    """Erreur renvoyée par le serveur, au format RFC 9457."""

    def __init__(self, statut: int, corps: Any):
        self.statut = statut
        self.corps = corps
        detail = corps.get("detail") if isinstance(corps, dict) else corps
        super().__init__(f"HTTP {statut} — {detail}")


def api(
    methode: str,
    chemin: str,
    corps: Any | None = None,
    jeton: str | None = None,
) -> Any:
    """Appel REST. Lève `ErreurApi` sur réponse non 2xx : le code de statut fait
    partie du contrat des exemples (404 attendu à l'étape 2, 409 sur rejeu…)."""
    donnees = None if corps is None else json.dumps(corps).encode("utf-8")
    entetes = {"Content-Type": "application/json"}
    if jeton:
        entetes["Authorization"] = f"Bearer {jeton}"

    requete = urllib.request.Request(
        f"{URL_SERVEUR}{chemin}", data=donnees, headers=entetes, method=methode
    )
    try:
        with urllib.request.urlopen(requete, timeout=10) as reponse:
            brut = reponse.read().decode("utf-8")
            return json.loads(brut) if brut else None
    except urllib.error.HTTPError as e:
        brut = e.read().decode("utf-8", "replace")
        try:
            corps_erreur = json.loads(brut)
        except json.JSONDecodeError:
            corps_erreur = brut
        raise ErreurApi(e.code, corps_erreur) from None
    except urllib.error.URLError as e:
        echouer(
            f"Serveur injoignable sur {URL_SERVEUR} ({e.reason}).",
            "Démarrez-le : cd version_web/write/server && cargo run",
        )
        raise  # inatteignable, pour le vérificateur de types


# ── Processus et ports ───────────────────────────────────────────────────────

def port_occupe(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def attendre_url(url: str, libelle: str, essais: int = 60) -> None:
    for _ in range(essais):
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:
            time.sleep(1)
    echouer(f"{libelle} n'a pas répondu sur {url}")


def _lancer(commande: list[str], repertoire: Path, journal: Path, env: dict | None = None) -> None:
    journal.parent.mkdir(parents=True, exist_ok=True)
    sortie = journal.open("wb")
    processus = subprocess.Popen(
        commande,
        cwd=repertoire,
        stdout=sortie,
        stderr=subprocess.STDOUT,
        # Groupe de processus dédié : `npm run dev` et `cargo run` créent des
        # enfants, et les tuer un par un laisserait des serveurs orphelins.
        start_new_session=True,
        env={**os.environ, **(env or {})},
    )
    _PROCESSUS.append(processus)


def demarrer_serveur() -> None:
    if port_occupe(PORT_SERVEUR):
        attention(f"Serveur déjà en écoute sur le port {PORT_SERVEUR} : réutilisation.")
        verifier_serveur_a_jour()
        return

    exiger("cargo", "installez Rust (https://rustup.rs)")
    titre(f"Compilation et démarrage du serveur Rust (port {PORT_SERVEUR})…")
    _lancer(
        ["cargo", "run", "--quiet"],
        SERVEUR_DIR,
        Path("/tmp/write-exemple-serveur.log"),
        {"WRITE_BIND": f"127.0.0.1:{PORT_SERVEUR}"},
    )
    attendre_url(f"{URL_SERVEUR}/healthz", "Le serveur", essais=180)
    verifier_serveur_a_jour()


def verifier_serveur_a_jour() -> None:
    """Un serveur déjà en écoute peut être une version antérieure, sans les routes
    de session. Sans ce contrôle, l'exemple échouerait plus loin sur un 404 obscur."""
    try:
        api("GET", "/api/v1/sessions")
    except ErreurApi as e:
        if e.statut == 404:
            echouer(
                f"Le serveur en écoute sur le port {PORT_SERVEUR} ne connaît pas les sessions.",
                "C'est une version antérieure : arrêtez-le, puis relancez cet exemple.",
            )
        raise


def demarrer_client() -> None:
    exiger("npm", "installez Node.js 20 ou plus récent (https://nodejs.org)")

    if not (CLIENT_DIR / "node_modules").is_dir():
        titre("Installation des dépendances du client (première exécution)…")
        subprocess.run(["npm", "install"], cwd=CLIENT_DIR, check=True)

    if port_occupe(PORT_CLIENT):
        attention(f"Client déjà en écoute sur le port {PORT_CLIENT} : réutilisation.")
        return

    titre(f"Démarrage du client React (port {PORT_CLIENT})…")
    _lancer(
        ["npm", "run", "dev", "--", "--port", str(PORT_CLIENT)],
        CLIENT_DIR,
        Path("/tmp/write-exemple-client.log"),
    )
    attendre_url(URL_CLIENT, "Le client")


def ouvrir_navigateur(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:
        attention("Ouvrez cette adresse dans votre navigateur :")
    print(f"\n  {url}\n")


def arreter(*_args) -> None:
    for processus in _PROCESSUS:
        if processus.poll() is not None:
            continue
        try:
            os.killpg(os.getpgid(processus.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            processus.terminate()
    _PROCESSUS.clear()


def garder_ouvert() -> None:
    """Maintient l'exemple en vie tant qu'il possède des processus.

    Quand les services tournaient déjà, il n'y a rien à garder : afficher
    « Ctrl+C pour arrêter » serait doublement trompeur — rien ne serait arrêté,
    et l'attente n'aurait aucun objet.
    """
    if not _PROCESSUS:
        attention(
            "Les services étaient déjà démarrés : ils continuent de tourner après cet exemple."
        )
        return

    attention("Ctrl+C pour arrêter les services démarrés par cet exemple.")
    try:
        while any(p.poll() is None for p in _PROCESSUS):
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()


atexit.register(arreter)


# ── WebSocket (client texte minimal, RFC 6455) ───────────────────────────────

class FluxWebSocket:
    """Client WebSocket en lecture, réduit à ce dont les exemples ont besoin.

    Pourquoi ne pas dépendre de `websockets` ou `websocket-client` ? Parce qu'un
    exemple doit démarrer sans installation préalable. La lecture de trames texte
    tient en quelques dizaines de lignes ; la complexité de la RFC est ailleurs
    (extensions, fragmentation agressive, compression), et ce flux ne s'en sert pas.
    """

    OP_TEXTE, OP_BINAIRE, OP_FERMETURE, OP_PING, OP_PONG = 0x1, 0x2, 0x8, 0x9, 0xA

    def __init__(self, url: str, sous_protocole: str | None = None, delai: float = 30.0):
        self._url = urllib.parse.urlparse(url)
        self._sous_protocole = sous_protocole
        self._delai = delai
        self._socket: socket.socket | None = None
        self._tampon = b""

    def __enter__(self) -> "FluxWebSocket":
        hote = self._url.hostname or "127.0.0.1"
        port = self._url.port or (443 if self._url.scheme == "wss" else 80)
        chemin = self._url.path + (f"?{self._url.query}" if self._url.query else "")

        self._socket = socket.create_connection((hote, port), timeout=self._delai)
        if self._url.scheme == "wss":
            import ssl

            self._socket = ssl.create_default_context().wrap_socket(
                self._socket, server_hostname=hote
            )

        cle = base64.b64encode(os.urandom(16)).decode()
        lignes = [
            f"GET {chemin} HTTP/1.1",
            f"Host: {hote}:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {cle}",
            "Sec-WebSocket-Version: 13",
        ]
        if self._sous_protocole:
            # Le jeton voyage dans le sous-protocole, jamais en query string :
            # même règle que le navigateur (pas de fuite par les journaux d'accès).
            lignes.append(f"Sec-WebSocket-Protocol: {self._sous_protocole}")
        self._socket.sendall(("\r\n".join(lignes) + "\r\n\r\n").encode())

        entete = self._lire_jusqua(b"\r\n\r\n")
        premiere = entete.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in premiere:
            self.close()
            raise ConnectionError(f"Le serveur a refusé l'ouverture : {premiere}")
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def close(self) -> None:
        if self._socket is not None:
            try:
                self._socket.close()
            finally:
                self._socket = None

    # -- lecture ------------------------------------------------------------

    def _lire_jusqua(self, marqueur: bytes) -> bytes:
        assert self._socket is not None
        while marqueur not in self._tampon:
            morceau = self._socket.recv(4096)
            if not morceau:
                raise ConnectionError("Connexion fermée pendant la négociation.")
            self._tampon += morceau
        entete, self._tampon = self._tampon.split(marqueur, 1)
        return entete

    def _lire_exact(self, taille: int) -> bytes:
        assert self._socket is not None
        while len(self._tampon) < taille:
            morceau = self._socket.recv(max(4096, taille - len(self._tampon)))
            if not morceau:
                raise ConnectionError("Connexion fermée.")
            self._tampon += morceau
        donnees, self._tampon = self._tampon[:taille], self._tampon[taille:]
        return donnees

    def _envoyer(self, opcode: int, charge: bytes = b"") -> None:
        assert self._socket is not None
        entete = bytearray([0x80 | opcode])
        # Une trame émise par un client DOIT être masquée (RFC 6455 §5.3).
        masque = os.urandom(4)
        taille = len(charge)
        if taille < 126:
            entete.append(0x80 | taille)
        elif taille < 1 << 16:
            entete.append(0x80 | 126)
            entete += struct.pack("!H", taille)
        else:
            entete.append(0x80 | 127)
            entete += struct.pack("!Q", taille)
        masquee = bytes(o ^ masque[i % 4] for i, o in enumerate(charge))
        self._socket.sendall(bytes(entete) + masque + masquee)

    def messages(self) -> Iterator[str]:
        """Itère sur les trames texte reçues, jusqu'à la fermeture du flux."""
        fragments: list[bytes] = []
        while True:
            try:
                premier, second = self._lire_exact(2)
            except (ConnectionError, OSError):
                return

            fin = bool(premier & 0x80)
            opcode = premier & 0x0F
            taille = second & 0x7F
            if taille == 126:
                (taille,) = struct.unpack("!H", self._lire_exact(2))
            elif taille == 127:
                (taille,) = struct.unpack("!Q", self._lire_exact(8))
            # Le serveur ne masque jamais ses trames ; on garde le cas par sûreté.
            masque = self._lire_exact(4) if second & 0x80 else None
            charge = self._lire_exact(taille) if taille else b""
            if masque:
                charge = bytes(o ^ masque[i % 4] for i, o in enumerate(charge))

            if opcode == self.OP_FERMETURE:
                self._envoyer(self.OP_FERMETURE)
                return
            if opcode == self.OP_PING:
                self._envoyer(self.OP_PONG, charge)
                continue
            if opcode == self.OP_PONG:
                continue

            fragments.append(charge)
            if fin:
                trame = b"".join(fragments)
                fragments = []
                if opcode in (self.OP_TEXTE, 0x0):
                    yield trame.decode("utf-8", "replace")


def flux_sessions(token_session: str, jeton: str) -> FluxWebSocket:
    """Flux des sauvegardes d'une session, en JSON."""
    chemin = f"/api/v1/sessions/{urllib.parse.quote(token_session)}/events"
    return FluxWebSocket(
        f"ws://127.0.0.1:{PORT_SERVEUR}{chemin}", sous_protocole=f"bearer.{jeton}"
    )


def url_editeur(token_session: str, email: str) -> str:
    return (
        f"{URL_CLIENT}/?session={urllib.parse.quote(token_session)}"
        f"&email={urllib.parse.quote(email)}"
    )


def charger_json(chemin: Path) -> Any:
    try:
        return json.loads(chemin.read_text(encoding="utf-8"))
    except FileNotFoundError:
        echouer(f"Fichier introuvable : {chemin}")
    except json.JSONDecodeError as e:
        echouer(f"JSON invalide dans {chemin} : {e}")


def jeton_aleatoire(prefixe: str = "sess") -> str:
    """Signature unique non devinable — le serveur exige au moins 12 caractères."""
    import secrets

    return f"{prefixe}-{secrets.token_hex(8)}"
