#!/usr/bin/env bash
#
# Lance ensemble le serveur de partage (Rust) et le client (Vite).
#
# Les deux sont nécessaires pour éditer à plusieurs : le client parle à
# `/api/v1/...` en relatif, et Vite relaie vers le serveur — c'est ce qui fait
# que le WebSocket partage l'origine de la page, donc que le navigateur n'a ni
# CORS ni préflight à négocier.
#
# Le script est **réentrant** : si l'un des deux tourne déjà, il le réutilise au
# lieu d'échouer, et ne le coupera pas en sortant. On ne tue que ce qu'on a
# démarré soi-même.
#
#   ./run.sh              lance ce qui manque
#   ./run.sh --release    serveur compilé en optimisé
#   Ctrl+C                arrête ce que ce script a lancé

set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE"

PORT_SERVEUR="${WRITER_PORT:-8081}"
# Le port du client est figé dans `vite.config.ts` (`strictPort`) : le changer
# ici ne ferait que décaler l'erreur.
PORT_CLIENT=5174
DONNEES="${WRITER_DATA_DIR:-$RACINE/server/data}"
PROFIL="debug"
CARGO_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --release) PROFIL="release"; CARGO_ARGS+=(--release) ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  GRAS=$'\e[1m'; VERT=$'\e[32m'; JAUNE=$'\e[33m'; ROUGE=$'\e[31m'; GRIS=$'\e[90m'; FIN=$'\e[0m'
else
  GRAS=""; VERT=""; JAUNE=""; ROUGE=""; GRIS=""; FIN=""
fi

info()   { echo "${GRAS}▸${FIN} $*"; }
succes() { echo "${VERT}✓${FIN} $*"; }
alerte() { echo "${JAUNE}!${FIN} $*"; }
echec()  { echo "${ROUGE}✗${FIN} $*" >&2; }

PID_SERVEUR=""
PID_CLIENT=""

# On n'arrête que nos propres processus : couper le serveur d'à côté, lancé à la
# main dans un autre terminal, serait une surprise désagréable.
nettoyer() {
  trap - INT TERM EXIT
  # Rien lancé, rien à annoncer : afficher « arrêté » après avoir seulement
  # réutilisé des services laisserait croire qu'on vient de les couper.
  [ -n "$PID_SERVEUR$PID_CLIENT" ] || return 0
  echo
  for pid in "$PID_CLIENT" "$PID_SERVEUR"; do
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    kill -TERM "$pid" 2>/dev/null
    # Laisser le temps de fermer les sockets proprement avant d'insister.
    for _ in $(seq 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null
  done
  succes "arrêté."
}
# Un signal doit **terminer** le script : sans le `exit`, `wait` rendrait la main
# et l'on annoncerait ensuite un arrêt inopiné après avoir déjà tout arrêté.
trap 'nettoyer; exit 130' INT
trap 'nettoyer; exit 143' TERM
trap nettoyer EXIT

port_occupe() {
  # `ss` d'abord, `nc` en secours : ni l'un ni l'autre n'est garanti partout.
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

qui_occupe() {
  ss -ltnp "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

# ── Serveur de partage ────────────────────────────────────────────────────────

serveur_repond() {
  curl -sf -m 2 "http://127.0.0.1:$PORT_SERVEUR/healthz" >/dev/null 2>&1
}

if serveur_repond; then
  alerte "serveur de partage déjà en ligne sur $PORT_SERVEUR — réutilisé, il ne sera pas arrêté."
elif port_occupe "$PORT_SERVEUR"; then
  echec "le port $PORT_SERVEUR est pris par autre chose (PID $(qui_occupe "$PORT_SERVEUR")) qui ne répond pas à /healthz."
  echec "libère-le, ou choisis un autre port : WRITER_PORT=8082 ./run.sh"
  exit 1
else
  # Compiler **avant** de lancer quoi que ce soit : une erreur de compilation
  # doit s'afficher seule, pas noyée sous les journaux du client.
  info "compilation du serveur (${PROFIL})…"
  if ! cargo build --manifest-path server/Cargo.toml "${CARGO_ARGS[@]}"; then
    echec "la compilation a échoué."
    exit 1
  fi

  mkdir -p "$DONNEES"
  info "démarrage du serveur sur $PORT_SERVEUR (données : $DONNEES)"

  # `> >(sed …)` plutôt qu'un tube : `$!` reste le PID du serveur lui-même, et
  # non celui d'un `sed` dont tuer le processus laisserait le serveur orphelin.
  # `WRITER_AUTH_MODE` est EXPLICITE : le mode `dev` accepte des jetons
  # `dev.<user>.<scope>` non signés, et ne doit jamais s'obtenir par omission.
  # Ce script est celui du poste de développement ; pour un serveur adossé à
  # CloudServ, c'est `CloudServ/start_writer.sh` qui impose `jwt`.
  WRITER_BIND="127.0.0.1:$PORT_SERVEUR" WRITER_DATA_DIR="$DONNEES" \
    WRITER_AUTH_MODE="${WRITER_AUTH_MODE:-dev}" \
    "server/target/$PROFIL/writer-server" \
    > >(sed -u "s/^/${GRIS}[serveur]${FIN} /") 2>&1 &
  PID_SERVEUR=$!

  for _ in $(seq 100); do
    serveur_repond && break
    kill -0 "$PID_SERVEUR" 2>/dev/null || { echec "le serveur s'est arrêté au démarrage."; exit 1; }
    sleep 0.1
  done

  if serveur_repond; then
    succes "serveur de partage prêt."
  else
    echec "le serveur n'a pas répondu à /healthz après 10 s."
    exit 1
  fi
fi

# ── Client ────────────────────────────────────────────────────────────────────

client_repond() {
  curl -sf -m 2 "http://127.0.0.1:$PORT_CLIENT/" 2>/dev/null | grep -q '@vite/client'
}

if client_repond; then
  alerte "client déjà en ligne sur $PORT_CLIENT — réutilisé, il ne sera pas arrêté."
  alerte "recharge la page avec Ctrl+Shift+R : l'onglet peut garder un module d'avant tes modifications."
elif port_occupe "$PORT_CLIENT"; then
  echec "le port $PORT_CLIENT est pris par autre chose (PID $(qui_occupe "$PORT_CLIENT"))."
  echec "vite.config.ts impose ce port (strictPort) : libère-le avec  kill $(qui_occupe "$PORT_CLIENT")"
  exit 1
else
  [ -d node_modules ] || { info "installation des dépendances…"; npm install || exit 1; }

  info "démarrage du client sur $PORT_CLIENT"
  ./node_modules/.bin/vite > >(sed -u "s/^/${GRIS}[client]${FIN} /") 2>&1 &
  PID_CLIENT=$!

  for _ in $(seq 150); do
    client_repond && break
    kill -0 "$PID_CLIENT" 2>/dev/null || { echec "le client s'est arrêté au démarrage."; exit 1; }
    sleep 0.1
  done
  client_repond && succes "client prêt." || { echec "le client n'a pas répondu."; exit 1; }
fi

# ── Prêt ──────────────────────────────────────────────────────────────────────

cat <<FIN_MSG

  ${GRAS}Writer est en ligne${FIN}

    ${GRAS}http://localhost:$PORT_CLIENT${FIN}

  Pour éditer à plusieurs :
    1. bouton ${GRAS}« Partager »${FIN}, en haut à droite
    2. ajoute une adresse (ex. bob@exemple.fr) en ${GRAS}Modification${FIN}
    3. ${GRAS}« Copier le lien »${FIN} à côté de cette personne
    4. ouvre ce lien dans une seconde fenêtre

  Ctrl+C pour arrêter.

FIN_MSG

if [ -z "$PID_SERVEUR" ] && [ -z "$PID_CLIENT" ]; then
  # Les deux tournaient déjà : il n'y a rien à surveiller, et surtout rien à
  # arrêter. On rend la main sans que le `trap` ait quoi que ce soit à faire.
  alerte "les deux services tournaient déjà : ce script n'a rien lancé, et n'arrêtera rien."
  exit 0
fi

# Rendre la main uniquement quand l'un des deux s'arrête : sans cette attente,
# le script rendrait le prompt et le `trap EXIT` tuerait tout aussitôt.
wait -n ${PID_SERVEUR:+$PID_SERVEUR} ${PID_CLIENT:+$PID_CLIENT} 2>/dev/null || true
alerte "un des deux processus s'est arrêté."
