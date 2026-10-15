#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016,SC2034,SC2115
# Test agent-ui-ensure against a throw-away lib dir and an isolated HOME (needs a built dist-server: npm run build:server).
# Covers: start, JSON output, 600 socket, parallel starts, scoped --stop, setsid fallback, bundled-plugin symlinks.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO/dist-server/server/index.js" ] || { echo "run 'npm run build:server' first"; exit 1; }
T="$(mktemp -d "${TMPDIR:-/tmp}/aui-ensure.XXXXXX")"
RUN="aui-t$$"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
cleanup() {
  AGENT_UI_UNIT="$RUN" AGENT_UI_RUN_NAME="$RUN" HOME="$T/home" "$T/lib/bin/agent-ui-ensure" --stop >/dev/null 2>&1 || true
  AGENT_UI_UNIT="$RUN-fb" AGENT_UI_RUN_NAME="$RUN-fb" AGENT_UI_NO_SYSTEMD=1 HOME="$T/home" "$T/lib/bin/agent-ui-ensure" --stop >/dev/null 2>&1 || true
  rm -rf "$T" "$XDG_RUNTIME_DIR/$RUN" "$XDG_RUNTIME_DIR/$RUN-fb"
}
trap cleanup EXIT
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

mkdir -p "$T/lib/bin" "$T/lib/plugins/demo-plugin" "$T/home"
cp "$REPO/cockpit/bin/agent-ui-ensure" "$T/lib/bin/"
ln -s "$REPO" "$T/lib/app"
printf '{"name":"demo-plugin","displayName":"Demo","entry":"i.js","type":"module","slot":"tab"}' > "$T/lib/plugins/demo-plugin/manifest.json"
cat > "$T/lib/env" <<ENVEOF
: "\${AGENT_UI_NODE:=$(command -v node)}"
ENVEOF
export HOME="$T/home" AGENT_UI_LINGER=0 AGENT_UI_UNIT="$RUN" AGENT_UI_RUN_NAME="$RUN"
E="$T/lib/bin/agent-ui-ensure"
SOCK="$XDG_RUNTIME_DIR/$RUN/server.sock"

out="$("$E")"
check "prints socket JSON" '[ "$out" = "{\"socket\":\"$SOCK\",\"version\":\"$(node -p "require(\"$REPO/package.json\").version")\"}" ]'
check "socket is mode 600" '[ "$(stat -c %a "$SOCK")" = 600 ]'
check "runtime dir is mode 700" '[ "$(stat -c %a "$XDG_RUNTIME_DIR/$RUN")" = 700 ]'
check "health answers over the socket" 'curl -sf --unix-socket "$SOCK" http://localhost/health | grep -q "\"status\":\"ok\""'
check "bundled plugin symlinked into the user dir" '[ -L "$HOME/.claude-code-ui/plugins/demo-plugin" ]'
check "platform user seeded (API works without a token)" 'curl -sf --unix-socket "$SOCK" http://localhost/api/projects >/dev/null'
check "disabled module is a 404" '[ "$(curl -s -o /dev/null -w %{http_code} --unix-socket "$SOCK" http://localhost/api/worktrees/x)" = 404 ]'

"$E" --stop; sleep 1
check "--stop removes the socket" '[ ! -e "$SOCK" ]'
check "--status is non-zero when stopped" '! "$E" --status >/dev/null'

echo "-- parallel starts"
( "$E" >/dev/null & "$E" >/dev/null & "$E" >/dev/null & wait )
check "three simultaneous ensures give exactly one backend" '[ "$(systemctl --user list-units "$RUN.service" --no-legend | wc -l)" = 1 ]'
"$E" --stop

echo "-- setsid fallback + scoped stop"
FB="$RUN-fb"
AGENT_UI_NO_SYSTEMD=1 AGENT_UI_UNIT="$FB" AGENT_UI_RUN_NAME="$FB" "$E" >/dev/null
pid="$(cat "$XDG_RUNTIME_DIR/$FB/server.pid")"
check "fallback pid file is the backend process itself" 'tr "\0" " " < "/proc/$pid/cmdline" | grep -q dist-server/server/index.js'
"$E" >/dev/null
AGENT_UI_NO_SYSTEMD=1 AGENT_UI_UNIT="$FB" AGENT_UI_RUN_NAME="$FB" "$E" --stop
sleep 2
check "fallback backend stopped" '! kill -0 "$pid" 2>/dev/null'
check "other instance of the same user untouched" '"$E" --status >/dev/null'

[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
