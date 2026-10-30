#!/usr/bin/env bash
# Démarre le pont ET OpenWebUI en une seule commande, sur le profil Freebuff qui
# a le plus d'heures restantes (voir scripts/pick-profile.ts).
#
# La sonde ouvre chaque TUI sans consigne : aucun tour n'est consommé, mais il
# faut compter ~10 à 45 s par profil avant que le pont démarre.
# `BRIDGE_PROFILE_DIR=... bash scripts/start-all.sh` court-circuite la sonde.
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE_PROFILE_DIR="$(node scripts/pick-profile.ts)"
export BRIDGE_PROFILE_DIR

PORT="${BRIDGE_PORT:-7799}"

bash scripts/start-bridge.sh &
BRIDGE_PID=$!

# Le pont n'ouvre la CLI qu'à la première requête : s'il meurt avant de
# répondre, c'est un vrai échec, pas une lenteur.
stop_bridge() {
  if kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$BRIDGE_PID" 2>/dev/null || return 0
      sleep 0.2
    done
    # Windows : npm/node ne reçoivent pas toujours SIGTERM, et tuer le seul
    # parent laisserait le serveur (et ses sessions) vivants.
    taskkill //PID "$BRIDGE_PID" //T //F >/dev/null 2>&1 || true
  fi
}
trap stop_bridge EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=''
for _ in $(seq 1 60); do
  if curl -fsS -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "Le pont s'est arrêté avant d'être prêt (voir la sortie ci-dessus)." >&2
    exit 1
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "Le pont ne répond pas sur http://127.0.0.1:$PORT/health." >&2
  exit 1
fi

echo
echo "Pont prêt   : http://127.0.0.1:$PORT  (profil $(basename "$BRIDGE_PROFILE_DIR"))"
echo "OpenWebUI   : http://127.0.0.1:8080   (sur le LAN : http://<ip-du-pc>:8080)"
echo "Clé du pont : data/api-key.txt"
echo

# OWUI réapplique ses patches (cases à cocher, sélecteur) ; en cas de mise à
# jour d'OWUI, il échoue bruyamment plutôt que de mentir dans l'interface.
bash scripts/start-owui.sh
