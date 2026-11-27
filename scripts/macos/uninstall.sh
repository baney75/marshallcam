#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/macos/env.sh
. "$ROOT/scripts/macos/env.sh"

ENV_FILE="$ROOT/.env"
LABEL_PREFIX=${LABEL_PREFIX:-$(mc_env_get "$ENV_FILE" LABEL_PREFIX)}
[ -n "$LABEL_PREFIX" ] || LABEL_PREFIX=com.marshallcam
HOME_DIR=${HOME:-$(eval echo ~)}
AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
uid=$(/usr/bin/id -u)

usage() {
  cat <<'EOF'
Usage: ./scripts/macos/uninstall.sh [--purge]

Unloads LaunchAgents installed by install.sh.
  --purge   Also remove rendered configs under ~/.config/marshallcam (not .env)
EOF
}

PURGE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --purge) PURGE=1 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

unload() {
  local plist=$1
  [ -f "$plist" ] || return 0
  launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  echo "removed $plist"
}

unload "$AGENTS_DIR/${LABEL_PREFIX}.server.plist"
unload "$AGENTS_DIR/${LABEL_PREFIX}.livekit.plist"
unload "$AGENTS_DIR/${LABEL_PREFIX}.cloudflared.plist"
unload "$AGENTS_DIR/${LABEL_PREFIX}.caffeinate.plist"
unload "$AGENTS_DIR/${LABEL_PREFIX}.avlock.plist"
unload "$AGENTS_DIR/${LABEL_PREFIX}.guard.plist"

if [ "$PURGE" -eq 1 ]; then
  rm -f "$HOME_DIR/.config/marshallcam/livekit.yaml"
  echo "removed $HOME_DIR/.config/marshallcam/livekit.yaml"
fi

echo "MarshallCam LaunchAgents unloaded. Data, logs, and .env were left in place."
