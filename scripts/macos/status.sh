#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=scripts/macos/env.sh
. "$ROOT/scripts/macos/env.sh"

ENV_FILE="$ROOT/.env"
LABEL_PREFIX=${LABEL_PREFIX:-$(mc_env_get "$ENV_FILE" LABEL_PREFIX)}
[ -n "$LABEL_PREFIX" ] || LABEL_PREFIX=com.marshallcam
PORT=${PORT:-$(mc_env_get "$ENV_FILE" PORT)}
[ -n "$PORT" ] || PORT=3000
uid=$(/usr/bin/id -u)

echo "MarshallCam status"
echo "root: $ROOT"
echo

check_agent() {
  local label=$1
  if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    echo "LaunchAgent $label: loaded"
  else
    echo "LaunchAgent $label: not loaded"
  fi
}

check_agent "${LABEL_PREFIX}.server"
check_agent "${LABEL_PREFIX}.livekit"
check_agent "${LABEL_PREFIX}.guard"
check_agent "${LABEL_PREFIX}.caffeinate"
check_agent "${LABEL_PREFIX}.cloudflared"
check_agent "${LABEL_PREFIX}.avlock"

echo
code=$(curl -s -o /tmp/mc-healthz.json -w '%{http_code}' -m 3 "http://127.0.0.1:${PORT}/healthz" || echo 000)
if [ "$code" = "200" ]; then
  echo "/healthz: OK $(cat /tmp/mc-healthz.json 2>/dev/null)"
else
  echo "/healthz: down (HTTP $code)"
fi

scode=$(curl -s -o /tmp/mc-station.json -w '%{http_code}' -m 3 "http://127.0.0.1:${PORT}/station/health" || echo 000)
if [ "$scode" = "200" ]; then
  echo "/station/health: $(cat /tmp/mc-station.json 2>/dev/null)"
else
  echo "/station/health: HTTP $scode (loopback-only; 403 from a proxy is expected)"
fi

if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 7880 >/dev/null 2>&1; then
  echo "LiveKit :7880: listening"
elif lsof -nP -iTCP:7880 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "LiveKit :7880: listening"
else
  echo "LiveKit :7880: not listening"
fi
