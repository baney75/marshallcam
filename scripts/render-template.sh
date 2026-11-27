#!/bin/bash
# bash 3.2 compatible. Replaces {{KEY}} tokens from KEY=value arguments.
set -euo pipefail

usage() {
  echo "Usage: $0 <template> <output> [KEY=value ...]" >&2
  exit 2
}

[ "${1:-}" = "--help" ] && usage
[ "$#" -ge 2 ] || usage

template=$1
output=$2
shift 2

if [ ! -f "$template" ]; then
  echo "template not found: $template" >&2
  exit 1
fi

content=$(cat "$template")

for pair in "$@"; do
  case "$pair" in
    *=*)
      key=${pair%%=*}
      value=${pair#*=}
      ;;
    *)
      echo "expected KEY=value, got: $pair" >&2
      exit 1
      ;;
  esac
  token="{{${key}}}"
  # bash 3.2 has no ${var//from/to} with a variable pattern that is safe for slashes;
  # walk the string and splice.
  result=""
  remaining=$content
  while :; do
    prefix=${remaining%%"${token}"*}
    if [ "$prefix" = "$remaining" ]; then
      result=${result}${remaining}
      break
    fi
    result=${result}${prefix}${value}
    remaining=${remaining#*"${token}"}
  done
  content=$result
done

case "$content" in
  *'{{'*'}}'*)
    echo "unresolved template placeholders remain in $output" >&2
    echo "$content" | grep -o '{{[^}]*}}' | sort -u >&2
    exit 1
    ;;
esac

outdir=$(dirname "$output")
mkdir -p "$outdir"
printf '%s\n' "$content" > "$output"
echo "rendered $output"
