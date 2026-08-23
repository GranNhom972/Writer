#!/usr/bin/env bash
# Enveloppe : l'exemple lui-même est écrit en Python (lancer.py).
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lancer.py" "$@"
