#!/bin/bash
# Optional kiosk watchdog. Designed to run as a GUI-session LaunchAgent (no sudo).
set -u
set +x

ROOT=${MARSHALLCAM_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
# shellcheck source=scripts/macos/env.sh
. "$ROOT/scripts/macos/env.sh"

ENV_FILE=${ENV_FILE:-"$ROOT/.env"}
LOG_DIR=${LOG_DIR:-$(mc_env_get "$ENV_FILE" LOG_DIR)}
[ -n "$LOG_DIR" ] || LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

STATE_DIR="$ROOT/.tvguard"
LOG="$LOG_DIR/kiosk-guard.log"
APP=${KIOSK_APP_PATH:-$(mc_env_get "$ENV_FILE" KIOSK_APP_PATH)}
[ -n "$APP" ] || APP="$HOME/Applications/MarshallCam.app"
CLICKER="$ROOT/scripts/macos/kiosk-allow-camera.sh"
PINLOGIN="$ROOT/scripts/macos/kiosk-pin-login.sh"
PORT=${PORT:-$(mc_env_get "$ENV_FILE" PORT)}
[ -n "$PORT" ] || PORT=3000
REOPEN_TAILSCALE=${GUARD_REOPEN_TAILSCALE:-$(mc_env_get "$ENV_FILE" GUARD_REOPEN_TAILSCALE)}
[ -n "$REOPEN_TAILSCALE" ] || REOPEN_TAILSCALE=0

mkdir -p "$STATE_DIR"

log() {
    printf '%s [kiosk-guard] %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

guiopen() {
    /usr/bin/open "$@"
}

maybe_sudo() {
    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        sudo -n "$@"
        return $?
    fi
    "$@"
}

approve_camera() {
    /bin/rm -f /tmp/ui-ok.out
    /bin/bash "$CLICKER" >/dev/null 2>&1 || true
    if /usr/bin/grep -q 'clicked' /tmp/ui-ok.out 2>/dev/null; then
        log "approved camera prompt"
    fi
}

pin_login() {
    /bin/rm -f /tmp/tv-pin.out
    /bin/bash "$PINLOGIN" >/dev/null 2>&1 || true
    if /usr/bin/grep -q 'entered' /tmp/tv-pin.out 2>/dev/null; then
        log "entered kiosk PIN"
        return 0
    fi
    return 1
}

prompt_pending() {
    maybe_sudo /usr/bin/log show --last 5m --style compact --predicate 'process == "Web App"' 2>/dev/null |
        /usr/bin/grep -E 'UserMediaPermissionRequestManagerProxy::(processUserMediaPermissionValidRequest.*action: Prompt|grantRequest)' |
        /usr/bin/tail -1 |
        /usr/bin/grep -q 'action: Prompt'
}

read_num() {
    local v=0
    if [ -r "$1" ]; then read -r v < "$1"; fi
    case "$v" in ''|*[!0-9]*) v=0 ;; esac
    printf '%s\n' "$v"
}

write_num() {
    printf '%s\n' "$2" > "$1"
}

rotate_log() {
    local file=$1 cap=$2 size
    [ -f "$file" ] || return 0
    size=$(/usr/bin/stat -f%z "$file" 2>/dev/null || /usr/bin/stat -c%s "$file" 2>/dev/null)
    case "$size" in ''|*[!0-9]*) return 0 ;; esac
    if [ "$size" -gt "$cap" ]; then
        if /usr/bin/tail -c 20971520 "$file" > "$file.1" 2>/dev/null; then
            : > "$file"
        fi
    fi
}

rotate_log "$LOG_DIR/livekit.log" 524288000
rotate_log "$LOG_DIR/cloudflared.log" 52428800
rotate_log "$LOG_DIR/avlock.log" 52428800
rotate_log "$LOG_DIR/marshallcam.log" 52428800
rotate_log "$LOG" 52428800

if [ "$REOPEN_TAILSCALE" = "1" ]; then
    if ! /usr/bin/pgrep -f -- '/Applications/Tailscale.app/Contents/MacOS/Tailscale' >/dev/null 2>&1; then
        guiopen -g -a /Applications/Tailscale.app >/dev/null 2>&1 || true
        log "started Tailscale"
    fi
fi

code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${PORT}/healthz" || echo 000)
if [ "$code" != "200" ]; then
    if [ ! -f "$STATE_DIR/server_down" ]; then
        : > "$STATE_DIR/server_down"
        log "server unavailable (HTTP $code); leaving restart to launchd"
    fi
    exit 0
elif [ -f "$STATE_DIR/server_down" ]; then
    /bin/rm -f "$STATE_DIR/server_down"
    log "server responding"
fi

boot=$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null)
boot=${boot#*sec = }
boot=${boot%%,*}
case "$boot" in ''|*[!0-9]*) ;; *)
    now=$(/bin/date +%s)
    [ $((now - boot)) -lt 90 ] && exit 0
esac

now=$(/bin/date +%s)
fail_count=$(read_num "$STATE_DIR/fail_count")
last_action=$(read_num "$STATE_DIR/last_action")
attempt=$(read_num "$STATE_DIR/attempt")

can_act() {
    [ "$last_action" -eq 0 ] && return 0
    local delay=120 n=$attempt
    [ "$n" -lt 1 ] && n=1
    while [ "$n" -gt 1 ] && [ "$delay" -lt 1800 ]; do
        delay=$((delay * 2))
        n=$((n - 1))
    done
    [ "$delay" -gt 1800 ] && delay=1800
    [ $((now - last_action)) -ge "$delay" ]
}

record_action() {
    attempt=$((attempt + 1))
    last_action=$(/bin/date +%s)
    write_num "$STATE_DIR/attempt" "$attempt"
    write_num "$STATE_DIR/last_action" "$last_action"
}

mark_unhealthy() {
    if [ ! -f "$STATE_DIR/station_down" ]; then
        : > "$STATE_DIR/station_down"
        log "$1"
    fi
}

station_healthy() {
    local body
    body=$(/usr/bin/curl -s -m 5 "http://127.0.0.1:${PORT}/station/health" 2>/dev/null || true)
    case "$body" in
        *'"stationConnected":true'*|*'"stationConnected": true'*) return 0 ;;
    esac
    if /usr/sbin/lsof -nP -iTCP:7880 -sTCP:ESTABLISHED 2>/dev/null |
       /usr/bin/grep -q -E '->(127\.0\.0\.1|\[::1\]|localhost):7880 \(ESTABLISHED\)$'
    then
        return 0
    fi
    return 1
}

pattern="--bundlepath $APP"
if [ ! -d "$APP" ]; then
    log "kiosk app not found at $APP"
    exit 0
fi

if ! /usr/bin/pgrep -f -- "$pattern" >/dev/null 2>&1; then
    mark_unhealthy "MarshallCam is not running"
    write_num "$STATE_DIR/fail_count" 0
    if can_act; then
        guiopen -a "$APP" >/dev/null 2>&1 || true
        /bin/sleep 6
        approve_camera
        record_action
        log "opened MarshallCam (attempt $attempt)"
    fi
    exit 0
fi

if prompt_pending; then
    approve_camera
fi

if station_healthy; then
    if [ -f "$STATE_DIR/station_down" ] || [ "$fail_count" -gt 0 ]; then
        log "station connected"
    fi
    /bin/rm -f "$STATE_DIR/station_down"
    write_num "$STATE_DIR/fail_count" 0
    write_num "$STATE_DIR/attempt" 0
    write_num "$STATE_DIR/last_action" 0
    exit 0
fi

mark_unhealthy "station not connected"
if pin_login; then
    /bin/sleep 6
    approve_camera
    write_num "$STATE_DIR/fail_count" 0
    exit 0
fi
fail_count=$((fail_count + 1))
write_num "$STATE_DIR/fail_count" "$fail_count"
[ "$fail_count" -lt 3 ] && exit 0
can_act || exit 0

pids=$(/usr/bin/pgrep -f -- "$pattern" || true)
if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    n=0
    while [ "$n" -lt 10 ] && /usr/bin/pgrep -f -- "$pattern" >/dev/null 2>&1; do
        /bin/sleep 1
        n=$((n + 1))
    done
fi

guiopen -a "$APP" >/dev/null 2>&1 || true
/bin/sleep 6
approve_camera
record_action
write_num "$STATE_DIR/fail_count" 0
log "station recovery attempt $attempt (relaunch)"
exit 0
