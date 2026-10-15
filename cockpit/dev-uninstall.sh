#!/usr/bin/env bash
# Remove the development copy installed by dev-install.sh. No root needed; user data is untouched.
set -euo pipefail
LIB="$HOME/.local/lib/agent-ui-dev"
PKG="${XDG_DATA_HOME:-$HOME/.local/share}/cockpit/agent-ui-dev"
[ -x "$LIB/bin/agent-ui-ensure" ] && "$LIB/bin/agent-ui-ensure" --stop || true
rm -rf "$PKG" "$LIB"
echo "Removed $PKG and $LIB"
