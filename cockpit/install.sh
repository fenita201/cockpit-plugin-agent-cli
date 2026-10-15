#!/usr/bin/env bash
# Build Agent UI and install it into Cockpit. Idempotent: run it again to update.
#
#   sudo ./cockpit/install.sh [--skip-cli] [--uninstall ...]
#
# --skip-cli    do not install/update the claude and codex command-line tools (npm -g)
# --uninstall   alias for cockpit/uninstall.sh (remaining options are passed through)
#
# Test hooks (no root needed): AGENT_UI_TEST_PREFIX=<dir> redirects /usr/lib, /usr/share and /var/lib into <dir> and skips
# the apt, Node and CLI steps.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SKIP_CLI=0
ARGS=("$@")
for i in "${!ARGS[@]}"; do
  if [ "${ARGS[$i]}" = "--uninstall" ]; then
    unset 'ARGS[i]'
    exec "$REPO/cockpit/uninstall.sh" "${ARGS[@]}"
  fi
done
for a in "$@"; do
  case "$a" in
    --skip-cli) SKIP_CLI=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

PREFIX="${AGENT_UI_TEST_PREFIX:-}"
LIB="$PREFIX/usr/lib/agent-ui"
UI="$PREFIX/usr/share/cockpit/agent-ui"
STATE_DIR="$PREFIX/var/lib/agent-ui"
NODE_MAJOR=22
NODE_BIN=/usr/bin/node
TOTAL=7

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if [ -z "$PREFIX" ] && [ "$EUID" -ne 0 ]; then die "Run with sudo: sudo $0 $*"; fi

BUILD_USER="${SUDO_USER:-$(id -un)}"
[ "$BUILD_USER" != root ] || note "warning: building as root (no SUDO_USER); prefer 'sudo' from a normal account"
BUILD_HOME="$(getent passwd "$BUILD_USER" | cut -d: -f6)"
BUILD="$REPO/build/install"

# Build commands run with a clean environment so a developer's nvm/other Node cannot leak in: native modules must be
# compiled by the same Node that will run them ($NODE_BIN). `env -i` also drops the caller's PATH.
BUILD_PATH=/usr/local/bin:/usr/bin:/bin
as_builder() {
  if [ "$(id -un)" = "$BUILD_USER" ]; then
    env -i HOME="$BUILD_HOME" USER="$BUILD_USER" PATH="$BUILD_PATH" LANG=C.UTF-8 HUSKY=0 \
      npm_config_cache="$BUILD_HOME/.npm" npm_config_update_notifier=false bash -c "$*"
  else
    sudo -u "$BUILD_USER" -H env -i HOME="$BUILD_HOME" USER="$BUILD_USER" PATH="$BUILD_PATH" LANG=C.UTF-8 HUSKY=0 \
      npm_config_cache="$BUILD_HOME/.npm" npm_config_update_notifier=false bash -c "$*"
  fi
}

#---------------------------------------------------------------------------------------------------------------------
log "1/$TOTAL Check system"
if [ -r /etc/os-release ]; then . /etc/os-release; fi
[ "${ID:-}" = "ubuntu" ] || note "warning: only tested on Ubuntu (this is ${ID:-unknown})"
INSTALLED_BY_US_NODEJS=false
if [ -z "$PREFIX" ]; then
  missing=()
  for pkg in cockpit curl git rsync build-essential python3 ca-certificates; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    note "installing: ${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
  fi
  note "cockpit $(dpkg-query -W -f='${Version}' cockpit)"
else
  note "(test prefix: skipping apt)"
fi

#---------------------------------------------------------------------------------------------------------------------
log "2/$TOTAL Node.js $NODE_MAJOR or newer"
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ -z "$PREFIX" ]; then
  if [ ! -x "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt "$NODE_MAJOR" ] || [ ! -x /usr/bin/npm ]; then
    candidate="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}')"
    cand_major="${candidate%%.*}"
    if [[ "$cand_major" =~ ^[0-9]+$ ]] && [ "$cand_major" -ge "$NODE_MAJOR" ]; then
      note "installing nodejs $candidate and npm from apt"
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm >/dev/null
    else
      note "apt has no nodejs >= $NODE_MAJOR (candidate: ${candidate:-none}); using NodeSource"
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
    fi
    INSTALLED_BY_US_NODEJS=true
  fi
  [ -x "$NODE_BIN" ] || die "$NODE_BIN not found after installing Node.js"
  [ "$(node_major "$NODE_BIN")" -ge "$NODE_MAJOR" ] || die "$NODE_BIN is too old ($("$NODE_BIN" -v)); need >= $NODE_MAJOR"
else
  NODE_BIN="$(command -v node)"
  BUILD_PATH="$(dirname "$NODE_BIN"):$BUILD_PATH"
  note "(test prefix: using $NODE_BIN)"
fi
note "node $("$NODE_BIN" -v) at $NODE_BIN, npm $(as_builder 'npm -v')"

#---------------------------------------------------------------------------------------------------------------------
CLI_INSTALLED=()
if [ "$SKIP_CLI" -eq 0 ] && [ -z "$PREFIX" ]; then
  log "3/$TOTAL Install/update Claude Code and Codex CLIs"
  for pkg in @anthropic-ai/claude-code @openai/codex; do
    /usr/bin/npm ls -g --depth=0 "$pkg" >/dev/null 2>&1 || CLI_INSTALLED+=("$pkg")
  done
  /usr/bin/npm install -g --silent @anthropic-ai/claude-code @openai/codex
  note "claude: $(claude --version 2>/dev/null || echo 'not on root PATH')"
  note "codex:  $(codex --version 2>/dev/null || echo 'not on root PATH')"
else
  log "3/$TOTAL Skip CLI install"
fi

#---------------------------------------------------------------------------------------------------------------------
log "4/$TOTAL Build app (Cockpit frontend + backend)"
mkdir -p "$BUILD"
chown -R "$BUILD_USER" "$REPO/build" 2>/dev/null || true
# A private copy keeps node_modules built here (for $NODE_BIN) separate from a developer's own build in the repo.
as_builder "mkdir -p '$BUILD/src' && rsync -a --delete --exclude .git --exclude node_modules --exclude build --exclude dist --exclude 'dist-server*' '$REPO/' '$BUILD/src/'"
LOCK_HASH="$(sha256sum "$REPO/package-lock.json" | cut -d' ' -f1)-$("$NODE_BIN" -v)"
if [ ! -d "$BUILD/src/node_modules" ] || [ "$(cat "$BUILD/lock.hash" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  note "npm ci"
  as_builder "cd '$BUILD/src' && npm ci --no-audit --no-fund --loglevel=error"
  echo "$LOCK_HASH" > "$BUILD/lock.hash"
else
  note "node_modules up to date (package-lock.json and node unchanged)"
fi
note "frontend"
as_builder "cd '$BUILD/src' && VITE_IS_PLATFORM=true AGENT_UI_LIB=/usr/lib/agent-ui AGENT_UI_OUT_DIR='$BUILD/ui' npx vite build --config cockpit/vite.config.cockpit.ts --logLevel warn"
note "backend"
as_builder "cd '$BUILD/src' && npm run build:server --silent"

STAGE="$BUILD/stage"
as_builder "rm -rf '$STAGE' && mkdir -p '$STAGE/app/scripts' '$STAGE/app/cockpit' \
  && cp -a '$BUILD/src/dist-server' '$BUILD/src/package.json' '$BUILD/src/package-lock.json' '$STAGE/app/' \
  && cp '$BUILD/src/scripts/fix-node-pty.js' '$STAGE/app/scripts/' \
  && cp '$BUILD/src/cockpit/features.json' '$STAGE/app/cockpit/'"
note "production dependencies"
# --ignore-scripts avoids the husky 'prepare' hook (a devDependency); the native modules and ripgrep are then rebuilt explicitly.
as_builder "cd '$STAGE/app' && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
  && npm rebuild bcrypt better-sqlite3 node-pty @vscode/ripgrep --loglevel=error && node scripts/fix-node-pty.js"
as_builder "'$NODE_BIN' -e \"require('$STAGE/app/node_modules/better-sqlite3'); require('$STAGE/app/node_modules/node-pty'); require('$STAGE/app/node_modules/bcrypt')\"" \
  || die "native modules do not load under $NODE_BIN (Node ABI mismatch?)"
note "native modules load under $("$NODE_BIN" -v)"

#---------------------------------------------------------------------------------------------------------------------
log "5/$TOTAL Build bundled plugins"
as_builder "'$REPO/cockpit/scripts/build-plugins.sh' '$BUILD/plugins'"

#---------------------------------------------------------------------------------------------------------------------
log "6/$TOTAL Smoke-test the staged backend"
SMOKE_DIR="$(as_builder 'mktemp -d /tmp/agent-ui-smoke.XXXXXX')"
as_builder "cd '$SMOKE_DIR' && mkdir -p home && \
  (HOME='$SMOKE_DIR/home' AGENT_UI_SOCKET='$SMOKE_DIR/s.sock' VITE_IS_PLATFORM=true NODE_ENV=production AGENT_UI_IDLE_MINUTES=0 \
   '$NODE_BIN' '$STAGE/app/dist-server/server/index.js' >'$SMOKE_DIR/log' 2>&1 & echo \$! >'$SMOKE_DIR/pid') ; \
  for i in \$(seq 1 50); do curl -sf --unix-socket '$SMOKE_DIR/s.sock' http://localhost/health >/dev/null 2>&1 && break; sleep 0.3; done; \
  curl -sf --unix-socket '$SMOKE_DIR/s.sock' http://localhost/health; echo; \
  curl -sf --unix-socket '$SMOKE_DIR/s.sock' http://localhost/api/projects >/dev/null; \
  r=\$?; kill \$(cat '$SMOKE_DIR/pid') 2>/dev/null; exit \$r" \
  || { cat "$SMOKE_DIR/log" >&2; die "staged backend failed its smoke test"; }
rm -rf "$SMOKE_DIR"

#---------------------------------------------------------------------------------------------------------------------
log "7/$TOTAL Install"
# Stop running backends first so files are not replaced under them. A short-lived copy of uninstall's logic is overkill:
# pkill by the unique entry path is what ensure uses as a fallback too.
if [ -z "$PREFIX" ]; then
  while IFS=: read -r name uid; do
    [ -d "/run/user/$uid" ] && systemctl --user -M "$name@" stop agent-ui >/dev/null 2>&1 || true
  done < <(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 { print $1 ":" $3 }')
  pkill -TERM -f "$LIB/app/dist-server/server/index.js" 2>/dev/null || true
fi
mkdir -p "$LIB" "$UI" "$STATE_DIR"
rsync -a --delete "$STAGE/app/" "$LIB/app/"
rsync -a --delete --exclude '.agent-ui-ref' "$BUILD/plugins/" "$LIB/plugins/"
rsync -a --delete "$REPO/cockpit/bin/" "$LIB/bin/"
install -m 755 "$REPO/cockpit/uninstall.sh" "$LIB/bin/agent-ui-uninstall"
chmod 755 "$LIB"/bin/*
rsync -a --delete "$BUILD/ui/" "$UI/"
install -m 644 "$REPO/cockpit/package/manifest.json" "$UI/manifest.json"
cat > "$LIB/env" <<EOF
# Sourced by agent-ui-ensure. Values already in the environment win.
: "\${AGENT_UI_NODE:=$NODE_BIN}"
: "\${AGENT_UI_UNIT:=agent-ui}"
: "\${AGENT_UI_RUN_NAME:=agent-ui}"
EOF
VERSION="$(git -C "$REPO" describe --tags --always 2>/dev/null || date +%F)"
echo "$VERSION" > "$LIB/VERSION"

# Record what this run installed, merging with earlier runs so uninstall knows what is ours.
"$NODE_BIN" - "$STATE_DIR/install-state.json" "$VERSION" "$LIB" "$UI" "$NODE_BIN" "$INSTALLED_BY_US_NODEJS" "${CLI_INSTALLED[*]:-}" <<'JS'
const fs = require('fs');
const [file, version, lib, ui, nodeBin, nodejsApt, cli] = process.argv.slice(2);
let old = {};
try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const prior = old.installedByUs ?? {};
const cliGlobal = [...new Set([...(prior.cliGlobal ?? []), ...cli.split(' ').filter(Boolean)])];
const state = {
  version, installedAt: new Date().toISOString(), lib, ui, nodeBin,
  installedByUs: { nodejsApt: prior.nodejsApt === true || nodejsApt === 'true', cliGlobal },
};
fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
JS

if [ -z "$PREFIX" ]; then chown -R root:root "$LIB" "$UI" "$STATE_DIR"; fi
chmod -R a+rX "$LIB" "$UI"

echo
echo "Agent UI $VERSION installed."
echo "- Open Cockpit (https://<server>:9090), sign in with your Linux user, press F5, then use the 'AI Agent' menu."
echo "- First time: Settings > Agents > log in to Claude / Codex (right in the page)."
echo "- Running backends were stopped; each starts again with the new version when its user opens the page."
echo "- Update: git pull && sudo ./cockpit/install.sh      Remove: sudo ./cockpit/uninstall.sh"
