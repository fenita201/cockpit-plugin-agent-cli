#!/usr/bin/env bash
# Free disk space in this repo after Agent UI has been installed into Cockpit.
# Only build outputs and caches inside the repo are removed; the installed copy (/usr/lib/agent-ui,
# /usr/share/cockpit/agent-ui) and all user data are not touched. Everything removed is rebuilt by the next install.
#
#   ./cockpit/cleanup.sh [--all] [--dry-run] [--yes]
#
# default    build/ (install.sh cache), dist/, dist-server*/
# --all      also node_modules/ (needed again for development: npm ci)
# --dry-run  only show what would be removed
# --yes      do not ask
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALL=0; DRY=0; YES=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

targets=(build dist dist-server dist-server.next dist-server.old)
[ "$ALL" -eq 1 ] && targets+=(node_modules)

found=()
total=0
for name in "${targets[@]}"; do
  path="$REPO/$name"
  [ -e "$path" ] || continue
  size="$(du -sk "$path" 2>/dev/null | cut -f1)"
  total=$((total + ${size:-0}))
  found+=("$name")
  printf '    %-18s %s\n' "$name/" "$(du -sh "$path" 2>/dev/null | cut -f1)"
done

if [ "${#found[@]}" -eq 0 ]; then
  echo "Nothing to clean."
  exit 0
fi
echo "    total: $((total / 1024)) MB"

if [ "$DRY" -eq 1 ]; then
  echo "(dry-run: nothing was removed)"
  exit 0
fi
if [ "$YES" -eq 0 ]; then
  [ -t 0 ] || { echo "No terminal to confirm; run with --yes." >&2; exit 1; }
  read -r -p "Remove these? [y/N] " answer
  case "$answer" in y|Y|yes) ;; *) echo "Aborted."; exit 1 ;; esac
fi

for name in "${found[@]}"; do
  # Fixed names under the repo only. build/ may contain files created by `sudo install.sh`; if so, say how to remove it.
  if ! rm -rf -- "${REPO:?}/$name" 2>/dev/null; then
    echo "Could not remove $name/ (owned by root?). Run: sudo rm -rf '$REPO/$name'" >&2
  fi
done
echo "Done. The next 'sudo ./cockpit/install.sh' rebuilds what it needs (slower the first time)."
[ "$ALL" -eq 1 ] && echo "For development, run 'npm ci' again."
exit 0
