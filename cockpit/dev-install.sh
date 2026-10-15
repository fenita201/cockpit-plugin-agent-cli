#!/usr/bin/env bash
# Install a development copy of the Cockpit plugin for the current user. No root needed.
#   Cockpit package : ~/.local/share/cockpit/agent-ui-dev   (menu "AI Agent (dev)")
#   Lib             : ~/.local/lib/agent-ui-dev             (app -> this repo, bin, plugins, env)
# After running, press F5 on the whole Cockpit page (the bridge only rescans packages when the Shell reloads).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$HOME/.local/lib/agent-ui-dev"
PKG="${XDG_DATA_HOME:-$HOME/.local/share}/cockpit/agent-ui-dev"
OUT="$REPO/build/cockpit-ui-dev"
NODE_BIN="$(command -v node)"
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

cd "$REPO"
log "1/5 Build backend"
npm run build:server --silent

log "2/5 Build frontend (AGENT_UI_LIB=$LIB)"
VITE_IS_PLATFORM=true AGENT_UI_LIB="$LIB" AGENT_UI_OUT_DIR="$OUT" npx vite build --config cockpit/vite.config.cockpit.ts --logLevel warn

log "3/5 Install lib"
mkdir -p "$LIB/bin" "$LIB/plugins"
rsync -a --delete "$REPO/cockpit/bin/" "$LIB/bin/"
chmod 755 "$LIB"/bin/*
ln -sfn "$REPO" "$LIB/app"
cat > "$LIB/env" <<ENVEOF
: "\${AGENT_UI_NODE:=$NODE_BIN}"
: "\${AGENT_UI_UNIT:=agent-ui-dev}"
: "\${AGENT_UI_RUN_NAME:=agent-ui-dev}"
ENVEOF

log "4/5 Bundled plugins"
"$REPO/cockpit/scripts/build-plugins.sh" "$LIB/plugins"

log "5/5 Cockpit package"
mkdir -p "$PKG"
rsync -a --delete "$OUT/" "$PKG/"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
m.name = "agent-ui-dev";
m.menu.index.label = "AI Agent (dev)";
fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
' "$REPO/cockpit/package/manifest.json" "$PKG/manifest.json"

# Next page open must run the new code.
"$LIB/bin/agent-ui-ensure" --stop || true

echo
echo "Cockpit sees: $(cockpit-bridge --packages 2>/dev/null | grep agent-ui-dev || echo 'NOT FOUND')"
echo "Now press F5 on the whole Cockpit page and open 'AI Agent (dev)'."
