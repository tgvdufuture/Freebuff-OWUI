#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Session réelle : la CLI n'est démarrée qu'à la première requête, puis gardée
# ouverte. Sans cette variable, le pont répondrait en mode diagnostic.
export BRIDGE_STUB=0
# Compte utilisé : celui qui a le plus d'heures restantes (PRD §8 : un seul
# profil à la fois, jamais de rotation en cours de route). Le choix se fait en
# ouvrant chaque TUI sans consigne et en lisant son bandeau — aucun tour
# consommé, mais ~10 à 45 s par profil (une reconnexion peut être lente).
# Un lancement ponctuel impose son profil et évite la sonde :
#   BRIDGE_PROFILE_DIR=C:/chemin/du/profil bash scripts/start-bridge.sh
if [ -z "${BRIDGE_PROFILE_DIR:-}" ]; then
  BRIDGE_PROFILE_DIR="$(node scripts/pick-profile.ts)"
fi
export BRIDGE_PROFILE_DIR
exec npm start
