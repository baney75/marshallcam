#!/bin/bash
# Helpers for reading MarshallCam .env without printing secrets.
# bash 3.2 compatible. Source this file; do not execute.

mc_root_from_script() {
  # scripts/macos -> repo root
  local here
  here=$(cd "$(dirname "$0")" && pwd)
  cd "$here/../.." && pwd
}

mc_strip_quotes() {
  local v=$1
  case "$v" in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}

# mc_env_get FILE KEY
mc_env_get() {
  local file=$1 key=$2 line k v
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      ''|\#*) continue ;;
    esac
    k=${line%%=*}
    if [ "$k" = "$key" ]; then
      v=${line#*=}
      mc_strip_quotes "$v"
      return 0
    fi
  done < "$file"
}

mc_discover_bundle_id() {
  local app=$1 plist
  plist="$app/Contents/Info.plist"
  if [ -r "$plist" ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null && return 0
  fi
  return 1
}
