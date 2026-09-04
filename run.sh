#!/usr/bin/env bash
#
# Lance ensemble le serveur de partage (Rust) et l'éditeur Web (Vite).
# Ouvre automatiquement le document d'exemple OpenOffice complet (doc_test.odt).
#
#   ./run.sh                  lance le serveur, le client et ouvre l'exemple ODT
#   ./run.sh --release        serveur compilé en mode release optimisé
#   ./run.sh --sans-navigateur ne lance pas le navigateur automatique
#   Ctrl+C                    arrête proprement les processus lancés par ce script

set -uo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE"

PORT_SERVEUR="${WRITER_PORT:-8081}"
PORT_CLIENT=5174
DONNEES="${WRITER_DATA_DIR:-$RACINE/server/data}"
PROFIL="debug"
CARGO_ARGS=()
OUVRIR_NAVIGATEUR=1

for arg in "$@"; do
  case "$arg" in
    --release) PROFIL="release"; CARGO_ARGS+=(--release) ;;
    --sans-navigateur|--no-browser) OUVRIR_NAVIGATEUR=0 ;;
    -h|--help) sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Préparation de l'exemple ODT dans le dossier public
mkdir -p "$RACINE/public"
if [ -f "$RACINE/exemple/doc_test.odt" ]; then
  cp "$RACINE/exemple/doc_test.odt" "$RACINE/public/doc_test.odt"
fi

nettoyer() {
  trap - INT TERM EXIT
  [ -n "$PID_SERVEUR$PID_CLIENT" ] || return 0
  echo
  for pid in "$PID_CLIENT" "$PID_SERVEUR"; do
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null
  done
  succes "arrêté."
}

trap 'nettoyer; exit 130' INT
trap 'nettoyer; exit 143' TERM
trap nettoyer EXIT

port_occupe() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

qui_occupe() {
  ss -ltnp "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

# ── Serveur de partage Rust ───────────────────────────────────────────────────

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
  info "compilation du serveur (${PROFIL})…"
  if ! cargo build --manifest-path server/Cargo.toml "${CARGO_ARGS[@]}"; then
    echec "la compilation du serveur a échoué."
    exit 1
  fi

  mkdir -p "$DONNEES"
  info "démarrage du serveur sur $PORT_SERVEUR (données : $DONNEES)"

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

# ── Client Vite ───────────────────────────────────────────────────────────────

client_repond() {
  curl -sf -m 2 "http://127.0.0.1:$PORT_CLIENT/" 2>/dev/null | grep -q '@vite/client'
}

if client_repond; then
  alerte "client déjà en ligne sur $PORT_CLIENT — réutilisé, il ne sera pas arrêté."
elif port_occupe "$PORT_CLIENT"; then
  echec "le port $PORT_CLIENT est pris par autre chose (PID $(qui_occupe "$PORT_CLIENT"))."
  echec "vite.config.ts impose ce port (strictPort) : libère-le avec kill $(qui_occupe "$PORT_CLIENT")"
  exit 1
else
  [ -d node_modules ] || { info "installation des dépendances npm…"; npm install || exit 1; }

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

# ── Ouverture du navigateur ───────────────────────────────────────────────────

URL="http://localhost:$PORT_CLIENT"

if [ "$OUVRIR_NAVIGATEUR" = "1" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$URL" >/dev/null 2>&1 &
  elif command -v google-chrome >/dev/null 2>&1; then
    google-chrome "$URL" >/dev/null 2>&1 &
  elif command -v firefox >/dev/null 2>&1; then
    firefox "$URL" >/dev/null 2>&1 &
  fi
fi

# ── Prêt ──────────────────────────────────────────────────────────────────────

cat <<FIN_MSG

  ${GRAS}✍️  Writer est en ligne avec l'exemple ODT complet (25 pages)${FIN}

    ${GRAS}$URL${FIN}

  ${VERT}✓${FIN} Document chargé : ${GRAS}doc_test.odt${FIN} (Banc d'essai OpenOffice complet)
  ${VERT}✓${FIN} Sommaire dynamique, notes de bas de page, tableaux, images, formules, commentaires

  Pour éditer à plusieurs :
    1. bouton ${GRAS}« Partager »${FIN}, en haut à droite
    2. ajoute une adresse (ex. bob@exemple.fr) en ${GRAS}Modification${FIN}
    3. ${GRAS}« Copier le lien »${FIN} à côté de cette personne
    4. ouvre ce lien dans une seconde fenêtre

  Ctrl+C pour arrêter.

FIN_MSG

if [ -z "$PID_SERVEUR" ] && [ -z "$PID_CLIENT" ]; then
  alerte "les deux services tournaient déjà : ce script n'a rien lancé, et n'arrêtera rien."
  exit 0
fi

wait -n ${PID_SERVEUR:+$PID_SERVEUR} ${PID_CLIENT:+$PID_CLIENT} 2>/dev/null || true
alerte "un des deux processus s'est arrêté."
