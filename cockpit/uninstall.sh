#!/usr/bin/env bash
# Remove Agent UI from the system. Self-contained: it is also installed as /usr/lib/agent-ui/bin/agent-ui-uninstall
# so it still works after the repo is deleted.
#
#   sudo ./cockpit/uninstall.sh [--purge] [--remove-cli] [--dry-run] [--yes]
#
# Default removes only what install.sh put on the system (and the per-user symlinks/sockets it caused).
# User data (~/.claude, ~/.codex, ~/.cloudcli, ~/.claude-code-ui) is kept unless --purge, and ~/.claude and ~/.codex are never touched.
set -euo pipefail

PURGE=0; REMOVE_CLI=0; DRY=0; YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --remove-cli) REMOVE_CLI=1 ;;
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# AGENT_UI_TEST_PREFIX redirects every system path into a sandbox so this script can be tested without root.
PREFIX="${AGENT_UI_TEST_PREFIX:-}"
LIB="$PREFIX/usr/lib/agent-ui"
UI="$PREFIX/usr/share/cockpit/agent-ui"
STATE_DIR="$PREFIX/var/lib/agent-ui"
STATE="$STATE_DIR/install-state.json"
RUN_ROOT="${AGENT_UI_TEST_RUN_ROOT:-/run/user}"
PASSWD_FILE="${AGENT_UI_TEST_PASSWD:-}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

if [ -z "$PREFIX" ] && [ "$EUID" -ne 0 ] && [ "$DRY" -eq 0 ]; then
  echo "Run with sudo: sudo $0 $*" >&2
  exit 1
fi

# When this script lives inside the directory it is about to delete, continue from a temporary copy.
SELF="$(readlink -f "$0")"
if [ "${AGENT_UI_UNINSTALL_REEXEC:-0}" != "1" ] && [[ "$SELF" == "$LIB"/* ]]; then
  tmp="$(mktemp /tmp/agent-ui-uninstall.XXXXXX)"
  cp "$SELF" "$tmp"
  AGENT_UI_UNINSTALL_REEXEC=1 exec bash "$tmp" "$@"
fi
# The re-executed copy removes itself when done.
if [ "${AGENT_UI_UNINSTALL_REEXEC:-0}" = "1" ]; then trap 'rm -f -- "$SELF"' EXIT; fi

# run: execute, or only print under --dry-run.
run() {
  if [ "$DRY" -eq 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

# safe_rm: recursive delete restricted to known locations, never an empty or relative path.
safe_rm() {
  local target="$1" ok=0 allowed
  [ -n "$target" ] || { echo "safe_rm: empty path" >&2; return 1; }
  case "$target" in /*) ;; *) echo "safe_rm: refusing relative path: $target" >&2; return 1 ;; esac
  case "$target" in *..*) echo "safe_rm: refusing path with '..': $target" >&2; return 1 ;; esac
  for allowed in "$LIB" "$UI" "$STATE_DIR" "$RUN_ROOT"/*/agent-ui "$RUN_ROOT"/*/agent-ui-dev; do
    [ "$target" = "$allowed" ] && ok=1
  done
  case "$target" in
    */.cloudcli|*/.claude-code-ui) [ "$PURGE" -eq 1 ] && ok=1 ;;
  esac
  [ "$ok" -eq 1 ] || { echo "safe_rm: refusing to remove $target" >&2; return 1; }
  [ -e "$target" ] || [ -L "$target" ] || return 0
  run rm -rf -- "$target"
  if [ "$DRY" -eq 1 ]; then note "would remove $target"; else note "removed $target"; fi
}

# Real users (uid >= 1000 with an existing home) plus root.
list_users() {
  if [ -n "$PASSWD_FILE" ]; then cat "$PASSWD_FILE"; else getent passwd; fi |
    awk -F: '($3 >= 1000 && $3 < 60000) || $3 == 0 { print $1 ":" $3 ":" $6 }' |
    while IFS=: read -r name uid home; do
      [ -d "$home" ] && printf '%s:%s:%s\n' "$name" "$uid" "$home"
    done
}

json_get() { # json_get <file> <js-expression-on-s>
  [ -f "$1" ] || return 0
  node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);if(v!==undefined)console.log(Array.isArray(v)?v.join(" "):v)}catch{}' "$1" "$2" 2>/dev/null || true
}

# ---------------------------------------------------------------------------------------------------------------------
found=0
for p in "$LIB" "$UI" "$STATE_DIR"; do [ -e "$p" ] && found=1; done
if [ "$found" -eq 0 ] && [ "$PURGE" -eq 0 ]; then
  log "Agent UI"
  echo "Nothing to do: Agent UI is not installed."
  exit 0
fi

CLI_PKGS=""
if [ -f "$STATE" ] && command -v node >/dev/null 2>&1; then
  CLI_PKGS="$(json_get "$STATE" 's.installedByUs.cliGlobal')"
  NODEJS_APT="$(json_get "$STATE" 's.installedByUs.nodejsApt')"
else
  NODEJS_APT=""
fi

if [ "$YES" -eq 0 ] && [ "$DRY" -eq 0 ] && [ -t 0 ]; then
  echo "This will remove Agent UI from this system."
  if [ "$PURGE" -eq 1 ]; then
    echo "--purge: it will ALSO delete ~/.cloudcli and ~/.claude-code-ui of every user (auth.db, plugin settings)."
    read -r -p "Type 'purge' to continue: " answer
    [ "$answer" = "purge" ] || { echo "Aborted."; exit 1; }
  else
    read -r -p "Continue? [y/N] " answer
    case "$answer" in y|Y|yes) ;; *) echo "Aborted."; exit 1 ;; esac
  fi
fi

log "1/5 Stop backends"
if [ -n "$PREFIX" ]; then
  note "(test prefix: skipping process control)"
else
  while IFS=: read -r name uid home; do
    if [ -d "$RUN_ROOT/$uid" ]; then
      run systemctl --user -M "$name@" stop agent-ui >/dev/null 2>&1 || true
    fi
  done < <(list_users)
  if pgrep -f "$LIB/app/dist-server/server/index.js" >/dev/null 2>&1; then
    run pkill -TERM -f "$LIB/app/dist-server/server/index.js" || true
    if [ "$DRY" -eq 0 ]; then
      for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$LIB/app/dist-server/server/index.js" >/dev/null 2>&1 || break; sleep 1; done
      pkill -KILL -f "$LIB/app/dist-server/server/index.js" 2>/dev/null || true
    fi
  fi
  note "backends stopped"
fi

log "2/5 Clean per-user files"
while IFS=: read -r name uid home; do
  pdir="$home/.claude-code-ui/plugins"
  if [ -d "$pdir" ]; then
    for link in "$pdir"/*; do
      [ -L "$link" ] || continue
      target="$(readlink -f "$link" 2>/dev/null || true)"
      # Only symlinks into our own plugin dir (including dangling ones whose target was ours).
      raw="$(readlink "$link")"
      if [[ "$target" == "$LIB"/plugins/* ]] || [[ "$raw" == "$LIB"/plugins/* ]]; then
        run rm -f -- "$link"
        note "removed symlink $link"
      fi
    done
  fi
  if [ -e "$RUN_ROOT/$uid/agent-ui" ]; then safe_rm "$RUN_ROOT/$uid/agent-ui"; fi
  if [ "$PURGE" -eq 1 ]; then
    # Read the linger marker before ~/.cloudcli disappears.
    if [ -e "$home/.cloudcli/agent-ui-linger-enabled" ] && [ -z "$PREFIX" ]; then
      run loginctl disable-linger "$name" || true
      note "linger disabled for $name"
    fi
    for d in "$home/.cloudcli" "$home/.claude-code-ui"; do
      if [ -e "$d" ]; then safe_rm "$d"; fi
    done
  fi
done < <(list_users)

log "3/5 Remove system files"
safe_rm "$UI"
safe_rm "$LIB"

log "4/5 Command-line tools"
if [ "$REMOVE_CLI" -eq 1 ]; then
  if [ -n "$CLI_PKGS" ]; then
    # shellcheck disable=SC2086
    run /usr/bin/npm uninstall -g $CLI_PKGS || true
    note "removed global packages: $CLI_PKGS"
  else
    note "no global CLI packages were installed by install.sh; nothing to remove"
  fi
else
  note "kept (use --remove-cli to remove CLIs that install.sh installed${CLI_PKGS:+: $CLI_PKGS})"
fi

log "5/5 Install state"
safe_rm "$STATE_DIR"

log "Done"
echo "Removed: $LIB, $UI, $STATE_DIR"
if [ "$PURGE" -eq 1 ]; then
  echo "Purged Agent UI data (~/.cloudcli, ~/.claude-code-ui) for every user."
else
  echo "Kept: user data (~/.cloudcli, ~/.claude-code-ui). ~/.claude and ~/.codex are never touched."
fi
echo "Kept: cockpit, nodejs and other system packages (they may be used by other software)."
if [ "${NODEJS_APT:-}" = "true" ]; then echo "Note: install.sh installed nodejs/npm from apt; remove with: sudo apt remove nodejs npm"; fi
[ "$DRY" -eq 1 ] && echo "(dry-run: nothing was changed)"
echo "Press F5 in Cockpit so the 'AI Agent' menu disappears."
