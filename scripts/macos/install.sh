#!/bin/bash
# One-command macOS installer for MarshallCam. bash 3.2 compatible.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/macos/env.sh
. "$ROOT/scripts/macos/env.sh"

DRY_RUN=0
WITH_CLOUDFLARED=0
SYSTEM_SETTINGS=0
PIN_ARG=""
LABEL_PREFIX=${LABEL_PREFIX:-com.marshallcam}

usage() {
  cat <<'EOF'
Usage: ./scripts/macos/install.sh [options]

  --help              Show this help
  --dry-run           Print actions without changing the system
  --pin PIN           Station PIN (4-8 digits); prompted if missing
  --with-cloudflared  Install cloudflared and load its LaunchAgent
  --system-settings   Use sudo to set power restore / no-sleep (optional)

Installs Homebrew deps, builds clients, writes .env, renders LiveKit +
LaunchAgent configs, and loads them for the current GUI session.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --with-cloudflared) WITH_CLOUDFLARED=1 ;;
    --system-settings) SYSTEM_SETTINGS=1 ;;
    --pin)
      shift
      PIN_ARG=${1:-}
      [ -n "$PIN_ARG" ] || { echo "--pin requires a value" >&2; exit 2; }
      ;;
    --pin=*) PIN_ARG=${1#--pin=} ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

echo "MarshallCam installer"
echo "root: $ROOT"

if ! need_cmd brew; then
  echo "Homebrew is required. Install it from https://brew.sh then re-run." >&2
  exit 1
fi

brew_install() {
  local formula=$1
  if brew list --formula "$formula" >/dev/null 2>&1; then
    echo "brew: $formula already installed"
    return 0
  fi
  run brew install "$formula"
}

brew_install node
brew_install ffmpeg
brew_install livekit
if [ "$WITH_CLOUDFLARED" -eq 1 ]; then
  brew_install cloudflared
fi

if [ ! -f "$ROOT/package-lock.json" ]; then
  echo "package-lock.json missing; run npm install once to generate it" >&2
fi

run npm --prefix "$ROOT" ci
run npm --prefix "$ROOT/client" ci
run npm --prefix "$ROOT/client-max" ci
run npm --prefix "$ROOT" run build

ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "creating .env from .env.example"
  if [ "$DRY_RUN" -eq 0 ]; then
    cp "$ROOT/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
fi

set_env() {
  local key=$1 value=$2 tmp
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] set $key in .env"
    return 0
  fi
  tmp=$(mktemp)
  awk -v k="$key" -v v="$value" '
    BEGIN { found=0 }
    $0 ~ "^"k"=" { print k"="v; found=1; next }
    { print }
    END { if (!found) print k"="v }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

rand_hex() {
  openssl rand -hex "$1"
}

current_pin=$(mc_env_get "$ENV_FILE" STATION_PIN 2>/dev/null || true)
if [ -n "$PIN_ARG" ]; then
  current_pin=$PIN_ARG
fi
case "$current_pin" in
  [0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9])
    ;;
  *)
    if [ "$DRY_RUN" -eq 1 ]; then
      current_pin=123456
    elif [ -t 0 ]; then
      printf "Station PIN (4-8 digits): "
      stty -echo
      read -r current_pin
      stty echo
      printf '\n'
    else
      echo "STATION_PIN is not set. Re-run with --pin NNNN" >&2
      exit 1
    fi
    ;;
esac
set_env STATION_PIN "$current_pin"

lk_key=$(mc_env_get "$ENV_FILE" LIVEKIT_API_KEY || true)
lk_secret=$(mc_env_get "$ENV_FILE" LIVEKIT_API_SECRET || true)
case "$lk_key" in
  ''|devkey|changeme) lk_key="APImc$(rand_hex 8)" ;;
esac
case "$lk_secret" in
  ''|changemechangemechangemechangeme|changeme) lk_secret=$(rand_hex 32) ;;
esac
set_env LIVEKIT_API_KEY "$lk_key"
set_env LIVEKIT_API_SECRET "$lk_secret"

sess=$(mc_env_get "$ENV_FILE" SESSION_SECRET || true)
if [ -z "$sess" ]; then
  sess=$(rand_hex 32)
  set_env SESSION_SECRET "$sess"
fi

HOME_DIR=${HOME:-$(eval echo ~)}
LOG_DIR=${LOG_DIR:-$(mc_env_get "$ENV_FILE" LOG_DIR)}
[ -n "$LOG_DIR" ] || LOG_DIR="$ROOT/logs"
DATA_DIR=${DATA_DIR:-$(mc_env_get "$ENV_FILE" DATA_DIR)}
[ -n "$DATA_DIR" ] || DATA_DIR="$ROOT/data"
run mkdir -p "$LOG_DIR" "$DATA_DIR" "$HOME_DIR/.config/marshallcam" "$HOME_DIR/Library/LaunchAgents"

NODE_BIN="$ROOT/node_modules/.bin/tsx"
if [ ! -x "$NODE_BIN" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "tsx not found at $NODE_BIN (did npm ci succeed?)" >&2
  exit 1
fi

LIVEKIT_YAML="$HOME_DIR/.config/marshallcam/livekit.yaml"
run "$ROOT/scripts/render-template.sh" "$ROOT/deploy/livekit.yaml.template" "$LIVEKIT_YAML" \
  "LIVEKIT_API_KEY=$lk_key" "LIVEKIT_API_SECRET=$lk_secret"
if [ "$DRY_RUN" -eq 0 ]; then
  chmod 600 "$LIVEKIT_YAML"
fi

render_agent() {
  local name=$1 dest=$2
  run "$ROOT/scripts/render-template.sh" "$ROOT/deploy/launchagents/${name}.plist.template" "$dest" \
    "ROOT=$ROOT" "HOME=$HOME_DIR" "LABEL_PREFIX=$LABEL_PREFIX" "NODE_BIN=$NODE_BIN" "LOG_DIR=$LOG_DIR"
}

reload_agent() {
  local plist=$1 uid
  uid=$(/usr/bin/id -u)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] launchctl bootout/bootstrap gui/$uid $plist"
    return 0
  fi
  launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$plist"
}

AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
render_agent server "$AGENTS_DIR/${LABEL_PREFIX}.server.plist"
render_agent livekit "$AGENTS_DIR/${LABEL_PREFIX}.livekit.plist"
render_agent caffeinate "$AGENTS_DIR/${LABEL_PREFIX}.caffeinate.plist"
render_agent guard "$AGENTS_DIR/${LABEL_PREFIX}.guard.plist"
reload_agent "$AGENTS_DIR/${LABEL_PREFIX}.server.plist"
reload_agent "$AGENTS_DIR/${LABEL_PREFIX}.livekit.plist"
reload_agent "$AGENTS_DIR/${LABEL_PREFIX}.caffeinate.plist"
reload_agent "$AGENTS_DIR/${LABEL_PREFIX}.guard.plist"

if [ "$WITH_CLOUDFLARED" -eq 1 ]; then
  CF_EXAMPLE="$ROOT/deploy/cloudflared/config.yml.example"
  CF_DEST="$HOME_DIR/.cloudflared/config.yml"
  run mkdir -p "$HOME_DIR/.cloudflared"
  if [ ! -f "$CF_DEST" ]; then
    run cp "$CF_EXAMPLE" "$CF_DEST"
    echo "wrote $CF_DEST from example; edit tunnel id and hostnames before it will run"
  fi
  render_agent cloudflared "$AGENTS_DIR/${LABEL_PREFIX}.cloudflared.plist"
  reload_agent "$AGENTS_DIR/${LABEL_PREFIX}.cloudflared.plist"
fi

AV_IN=$(mc_env_get "$ENV_FILE" AV_INPUT_DEVICE || true)
AV_OUT=$(mc_env_get "$ENV_FILE" AV_OUTPUT_DEVICE || true)
if [ -n "$AV_IN" ] || [ -n "$AV_OUT" ]; then
  render_agent avlock "$AGENTS_DIR/${LABEL_PREFIX}.avlock.plist"
  reload_agent "$AGENTS_DIR/${LABEL_PREFIX}.avlock.plist"
fi

if [ "$SYSTEM_SETTINGS" -eq 1 ]; then
  run sudo pmset -a autorestart 1 sleep 0 displaysleep 0 disksleep 0
  run sudo systemsetup -setrestartfreeze on
fi

cat <<EOF

Install complete.

Next (not performed by this script):
  1. System Settings → Users & Groups → automatic login for the kiosk account
  2. Safari → File → Add to Dock (or File → Save as Web App) for http://localhost:3000/?role=station
     Save as MarshallCam.app into ~/Applications
  3. Web App Settings → Websites → Camera and Microphone → Allow
  4. Plug the Mac into the TV over HDMI and set it as the default display

Health check: ./scripts/macos/status.sh
EOF
