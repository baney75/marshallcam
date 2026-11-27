#!/bin/bash
# Click the Safari Web App camera/microphone permission dialog if it is showing.
set -euo pipefail

ROOT=${MARSHALLCAM_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
# shellcheck source=scripts/macos/env.sh
. "$ROOT/scripts/macos/env.sh"

ENV_FILE=${ENV_FILE:-"$ROOT/.env"}
APP=${KIOSK_APP_PATH:-$(mc_env_get "$ENV_FILE" KIOSK_APP_PATH)}
[ -n "$APP" ] || APP="$HOME/Applications/MarshallCam.app"
BUNDLE_ID=${KIOSK_BUNDLE_ID:-$(mc_env_get "$ENV_FILE" KIOSK_BUNDLE_ID)}
if [ -z "$BUNDLE_ID" ]; then
  BUNDLE_ID=$(mc_discover_bundle_id "$APP" || true)
fi
if [ -z "$BUNDLE_ID" ]; then
  printf '%s\n' "no bundle" > /tmp/ui-ok.out
  exit 1
fi

/usr/bin/osascript -e "tell application \"System Events\"
set p to first process whose bundle identifier is \"$BUNDLE_ID\"
set w to first window of p whose subrole is \"AXDialog\"
if (value of static text 1 of w) contains \"camera and microphone\" then
click button \"OK\" of w
return \"clicked\"
end if
return \"no match\"
end tell" > /tmp/ui-ok.out 2>&1
