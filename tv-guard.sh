#!/bin/bash
set -u

STATE_DIR=/Users/__USER__/MarshallOS/.tvguard
LOG=/Users/__USER__/MarshallOS/tvguard.log
APP=/Users/__USER__/Applications/MarshallCam.app
CLICKER=/Users/__USER__/MarshallOS/tv-allow-camera.sh
PINLOGIN=/Users/__USER__/MarshallOS/tv-pin-login.sh
BASE=/Users/__USER__/MarshallOS
GUI_UID=$(/usr/bin/id -u __USER__)
# cron runs outside the GUI session; open apps inside marshall's Aqua session
guiopen() { /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /usr/bin/open "$@"; }

/bin/mkdir -p "$STATE_DIR"

log() {
    printf '%s [tvguard] %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

approve_camera() {
    /bin/rm -f /tmp/ui-ok.out
    /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /bin/launchctl remove com.marshallcam.tvallow >/dev/null 2>&1
    /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /bin/launchctl submit -l com.marshallcam.tvallow -- /bin/bash "$CLICKER" >/dev/null 2>&1
    /bin/sleep 8
    /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /bin/launchctl remove com.marshallcam.tvallow >/dev/null 2>&1
    if /usr/bin/grep -q 'clicked' /tmp/ui-ok.out 2>/dev/null; then
        log "approved camera prompt"
    fi
}

pin_login() {
    /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /bin/launchctl remove com.marshallcam.tvpin >/dev/null 2>&1
    /bin/rm -f /tmp/tv-pin.out
    /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /bin/launchctl submit -l com.marshallcam.tvpin -- /bin/bash "$PINLOGIN" >/dev/null 2>&1
    local n=0
    while [ "$n" -lt 30 ]; do
        if [ -s /tmp/tv-pin.out ]; then
            break
        fi
        /bin/sleep 1
        n=$((n + 1))
    done
    /usr/bin/sudo -n /bin/launchctl asuser "$GUI_UID" /usr/bin/sudo -n -u __USER__ /bin/launchctl remove com.marshallcam.tvpin >/dev/null 2>&1
    if /usr/bin/grep -q 'entered' /tmp/tv-pin.out 2>/dev/null; then
        log "entered kiosk PIN"
        return 0
    fi
    return 1
}

prompt_pending() {
    /usr/bin/sudo -n /usr/bin/log show --last 5m --style compact --predicate 'process == "Web App"' 2>/dev/null |
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

# Rotate by copying a tail, then truncate without replacing the live file.
for entry in livekit.log:524288000 cloudflared.log:52428800 \
             avlock.log:52428800 marshallcam.log:52428800 tvguard.log:52428800
do
    name=${entry%%:*}
    cap=${entry##*:}
    file="$BASE/$name"
    [ -f "$file" ] || continue
    size=$(/usr/bin/stat -f%z "$file" 2>/dev/null)
    case "$size" in ''|*[!0-9]*) continue ;; esac
    if [ "$size" -gt "$cap" ]; then
        if /usr/bin/tail -c 20971520 "$file" > "$file.1" 2>/dev/null; then
            : > "$file"
        fi
    fi
done

if ! /usr/bin/pgrep -f -- '/Applications/Tailscale.app/Contents/MacOS/Tailscale' >/dev/null 2>&1; then
    guiopen -g -a /Applications/Tailscale.app >/dev/null 2>&1
    log "started Tailscale"
fi

code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:3000/)
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
case "$boot" in ''|*[!0-9]*) exit 0 ;; esac
now=$(/bin/date +%s)
[ $((now - boot)) -lt 90 ] && exit 0

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

pattern="--bundlepath $APP"
if ! /usr/bin/pgrep -f -- "$pattern" >/dev/null 2>&1; then
    mark_unhealthy "MarshallCam is not running"
    write_num "$STATE_DIR/fail_count" 0
    if can_act; then
        guiopen -a "$APP" >/dev/null 2>&1
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

if /usr/bin/sudo -n /usr/sbin/lsof -nP -iTCP:7880 -sTCP:ESTABLISHED 2>/dev/null |
   /usr/bin/grep -q -E '^com\.apple.*->(127\.0\.0\.1|\[::1\]|localhost):7880 \(ESTABLISHED\)$'
then
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

pids=$(/usr/bin/pgrep -f -- "$pattern")
[ -n "$pids" ] || exit 0
kill -TERM $pids 2>/dev/null
n=0
while [ "$n" -lt 10 ] && /usr/bin/pgrep -f -- "$pattern" >/dev/null 2>&1; do
    /bin/sleep 1
    n=$((n + 1))
done

guiopen -a "$APP" >/dev/null 2>&1
/bin/sleep 6
approve_camera
record_action
write_num "$STATE_DIR/fail_count" 0
log "station recovery attempt $attempt (relaunch)"
exit 0
