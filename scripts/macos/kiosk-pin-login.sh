#!/bin/bash
# Last-resort PIN entry for the kiosk Web App. Never echo or log the PIN.
# macOS bash 3.2
set -euo pipefail
set +x

ROOT=${MARSHALLCAM_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
# shellcheck source=scripts/macos/env.sh
. "$ROOT/scripts/macos/env.sh"

ENV_FILE=${ENV_FILE:-"$ROOT/.env"}
OUT_FILE=${OUT_FILE:-/tmp/tv-pin.out}
APP=${KIOSK_APP_PATH:-$(mc_env_get "$ENV_FILE" KIOSK_APP_PATH)}
[ -n "$APP" ] || APP="$HOME/Applications/MarshallCam.app"
BUNDLE_ID=${KIOSK_BUNDLE_ID:-$(mc_env_get "$ENV_FILE" KIOSK_BUNDLE_ID)}
if [ -z "$BUNDLE_ID" ]; then
  BUNDLE_ID=$(mc_discover_bundle_id "$APP" || true)
fi

pin=$(mc_env_get "$ENV_FILE" STATION_PIN)

case "$pin" in
  [0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9])
    ;;
  *)
    printf '%s\n' "no pin" > "$OUT_FILE"
    exit 1
    ;;
esac

if [ -z "$BUNDLE_ID" ]; then
  printf '%s\n' "no bundle" > "$OUT_FILE"
  exit 1
fi

result=$(
    PIN="$pin" /usr/bin/osascript \
        -e 'on buttonExists(uiContents, wantedTitle)' \
        -e '    tell application "System Events"' \
        -e '        repeat with candidate in uiContents' \
        -e '            try' \
        -e '                if class of candidate is button then' \
        -e '                    if title of candidate is wantedTitle then return true' \
        -e '                end if' \
        -e '            end try' \
        -e '        end repeat' \
        -e '    end tell' \
        -e '    return false' \
        -e 'end buttonExists' \
        -e 'on clickButton(uiContents, wantedTitle)' \
        -e '    tell application "System Events"' \
        -e '        repeat with candidate in uiContents' \
        -e '            try' \
        -e '                if class of candidate is button then' \
        -e '                    if title of candidate is wantedTitle then' \
        -e '                        click candidate' \
        -e '                        return true' \
        -e '                    end if' \
        -e '                end if' \
        -e '            end try' \
        -e '        end repeat' \
        -e '    end tell' \
        -e '    return false' \
        -e 'end clickButton' \
        -e 'set pinText to system attribute "PIN"' \
        -e 'tell application "System Events"' \
        -e "    set targetProcess to first process whose bundle identifier is \"$BUNDLE_ID\"" \
        -e '    set targetWindow to window 1 of targetProcess' \
        -e '    set uiContents to entire contents of targetWindow' \
        -e 'end tell' \
        -e 'repeat with requiredTitle in {"1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "Delete"}' \
        -e '    if not (my buttonExists(uiContents, requiredTitle as text)) then return "no pinpad"' \
        -e 'end repeat' \
        -e 'set pinLength to length of pinText' \
        -e 'repeat with pinIndex from 1 to pinLength' \
        -e '    set wantedTitle to character pinIndex of pinText' \
        -e '    if not (my clickButton(uiContents, wantedTitle)) then return "no pinpad"' \
        -e '    if pinIndex is less than pinLength then delay 0.4' \
        -e 'end repeat' \
        -e 'return "entered"' \
        2>&1
)

pin=""
unset PIN
printf '%s\n' "$result" > "$OUT_FILE"
exit 0
