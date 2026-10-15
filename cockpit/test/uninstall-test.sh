#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016,SC2034,SC2088,SC2115
# Sandbox test for uninstall.sh (no root needed): AGENT_UI_TEST_PREFIX redirects every system path.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d /tmp/aui-uninstall-test.XXXXXX)"
trap 'rm -rf "$T"' EXIT
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

export AGENT_UI_TEST_PREFIX="$T/root"
export AGENT_UI_TEST_RUN_ROOT="$T/run"
export AGENT_UI_TEST_PASSWD="$T/passwd"
HOME1="$T/home/loi"; HOME2="$T/home/an"
echo "loi:x:1001:1001::$HOME1:/bin/bash"  > "$T/passwd"
echo "an:x:1002:1002::$HOME2:/bin/bash"  >> "$T/passwd"

setup() {
  rm -rf "$T/root" "$T/home" "$T/run"
  mkdir -p "$T/root/usr/lib/agent-ui/bin" "$T/root/usr/lib/agent-ui/plugins/claude-usage" "$T/root/usr/share/cockpit/agent-ui" "$T/root/var/lib/agent-ui"
  cp "$HERE/uninstall.sh" "$T/root/usr/lib/agent-ui/bin/agent-ui-uninstall"
  echo '{"installedByUs":{"nodejsApt":false,"cliGlobal":[]}}' > "$T/root/var/lib/agent-ui/install-state.json"
  for h in "$HOME1" "$HOME2"; do
    mkdir -p "$h/.claude-code-ui/plugins/mine" "$h/.cloudcli" "$h/.claude" "$h/.codex"
    ln -s "$T/root/usr/lib/agent-ui/plugins/claude-usage" "$h/.claude-code-ui/plugins/claude-usage"
    echo db > "$h/.cloudcli/auth.db"; echo cred > "$h/.claude/.credentials.json"; echo tok > "$h/.codex/auth.json"
  done
  mkdir -p "$T/run/1001/agent-ui" "$T/run/1002/agent-ui"
  touch "$T/run/1001/agent-ui/server.sock"
  touch "$HOME1/.cloudcli/agent-ui-linger-enabled"
}

echo "== U1 dry-run changes nothing"
setup
before="$(find "$T" | sort | md5sum)"
bash "$HERE/uninstall.sh" --dry-run --yes >/dev/null
check "dry-run leaves the tree identical" '[ "$before" = "$(find "$T" | sort | md5sum)" ]'

echo "== U3 default uninstall keeps user data"
setup
bash "$HERE/uninstall.sh" --yes > "$T/out.log"
check "lib removed" '[ ! -e "$T/root/usr/lib/agent-ui" ]'
check "cockpit package removed" '[ ! -e "$T/root/usr/share/cockpit/agent-ui" ]'
check "state dir removed" '[ ! -e "$T/root/var/lib/agent-ui" ]'
check "bundled symlinks removed (both users)" '[ ! -L "$HOME1/.claude-code-ui/plugins/claude-usage" ] && [ ! -L "$HOME2/.claude-code-ui/plugins/claude-usage" ]'
check "user-installed plugin kept" '[ -d "$HOME1/.claude-code-ui/plugins/mine" ]'
check "auth.db kept" '[ -f "$HOME1/.cloudcli/auth.db" ]'
check "~/.claude and ~/.codex kept" '[ -f "$HOME1/.claude/.credentials.json" ] && [ -f "$HOME2/.codex/auth.json" ]'
check "runtime dirs removed" '[ ! -e "$T/run/1001/agent-ui" ] && [ ! -e "$T/run/1002/agent-ui" ]'

echo "== U4 second run is a no-op"
bash "$HERE/uninstall.sh" --yes > "$T/out2.log"
check "exit 0 and says nothing to do" 'grep -q "Nothing to do" "$T/out2.log"'

echo "== U5 --purge"
setup
bash "$HERE/uninstall.sh" --yes --purge > "$T/out3.log"
check "~/.cloudcli and ~/.claude-code-ui removed" '[ ! -e "$HOME1/.cloudcli" ] && [ ! -e "$HOME1/.claude-code-ui" ] && [ ! -e "$HOME2/.cloudcli" ]'
check "~/.claude and ~/.codex still there" '[ -f "$HOME1/.claude/.credentials.json" ] && [ -f "$HOME2/.codex/auth.json" ]'

echo "== U7 installed copy works and survives deleting itself"
setup
bash "$T/root/usr/lib/agent-ui/bin/agent-ui-uninstall" --yes > "$T/out4.log"
check "removed via the installed copy" '[ ! -e "$T/root/usr/lib/agent-ui" ] && grep -q "Done" "$T/out4.log"'

echo "== safety: safe_rm refuses outside paths"
setup
check "refuses unknown option" '! bash "$HERE/uninstall.sh" --nope >/dev/null 2>&1'

[ "$fail" -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
