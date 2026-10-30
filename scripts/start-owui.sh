#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f data/api-key.txt ]; then
  echo "Clé du pont absente : démarre d'abord scripts/start-bridge.sh." >&2
  exit 1
fi

# Cases à cocher : OpenWebUI stock n'en a pas. Le patch est idempotent et
# recrée ses sauvegardes .orig ; il échoue bruyamment si OWUI a changé le code,
# car une carte mono-choix pour une question multiple mentirait à l'utilisateur.
if [ -x .venv-owui/Scripts/python.exe ]; then
  OWUI_PYTHON=.venv-owui/Scripts/python.exe
else
  OWUI_PYTHON=.venv-owui/bin/python
fi
"$OWUI_PYTHON" scripts/patch-owui-multiselect.py

# Tri des dossiers : OWUI les classe par nom, en dur. Le pont écrit l'activité
# réelle dans `meta.lastActivity` et ce patch fait trier dessus (du plus récent
# au plus ancien). Même contrat : idempotent, échoue bruyamment après une MAJ.
"$OWUI_PYTHON" scripts/patch-owui-folder-sort.py

# Sélecteur de projet : un bouton « ＋ Projet Freebuff » dans OWUI crée le chat
# déjà lié au dossier choisi. Même contrat que le patch ci-dessus : idempotent,
# échoue bruyamment si OWUI a changé son HTML, et se réapplique à chaque
# démarrage (une mise à jour d'OWUI remplace le paquet).
"$OWUI_PYTHON" scripts/patch-owui-picker.py --bridge "http://127.0.0.1:${BRIDGE_PORT:-7799}"

export DATA_DIR="$PWD/data/owui"
export ENABLE_FORWARD_USER_INFO_HEADERS=true
# Clé API OWUI : le pont l'utilise pour importer les conversations (jamais le
# JWT de session, qui expire). Désactivée par défaut dans cette version d'OWUI.
export ENABLE_API_KEYS=true
export OPENAI_API_BASE_URL="http://127.0.0.1:7799/v1"
export OPENAI_API_KEY="$(cat data/api-key.txt)"

# Ces tâches appellent le modèle : elles lanceraient des tours CLI parasites.
export ENABLE_TITLE_GENERATION=false
export ENABLE_TAGS_GENERATION=false
export ENABLE_FOLLOW_UP_GENERATION=false
export ENABLE_AUTOCOMPLETE_GENERATION=false

export WEBUI_NAME="Freebuff Bridge"

exec .venv-owui/Scripts/open-webui.exe serve --host 0.0.0.0 --port 8080
