#!/usr/bin/env bash
# Remove the development copy installed by dev-install.sh. No root needed; user data is untouched.
set -euo pipefail
LIB="$HOME/.local/lib/agent-ui-dev"
PKG="${XDG_DATA_HOME:-$HOME/.local/share}/cockpit/agent-ui-dev"
[ -x "$LIB/bin/agent-ui-ensure" ] && "$LIB/bin/agent-ui-ensure" --stop || true
# Plugin symlinks that point into the dev lib would dangle once it is gone.
for link in "$HOME"/.claude-code-ui/plugins/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in "$LIB"/plugins/*) rm -f -- "$link"; echo "removed symlink $link" ;; esac
done
rm -rf "${PKG:?}" "${LIB:?}"
echo "Removed $PKG and $LIB"
