#!/usr/bin/env bash
# Build the bundled plugins listed in cockpit/plugins.lock.json into <outdir>/<name>.
# Usage: build-plugins.sh <outdir>      (runs as the current user; needs git, node, npm)
# Skips a plugin whose pinned ref is already built there. Output dirs contain no .git and no devDependencies.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:?usage: build-plugins.sh <outdir>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

node -e 'for (const p of require(process.argv[1])) console.log([p.name, p.repo, p.ref].join(" "))' "$REPO/cockpit/plugins.lock.json" |
while read -r name repo ref; do
  if [ -f "$OUT/$name/.agent-ui-ref" ] && [ "$(cat "$OUT/$name/.agent-ui-ref")" = "$ref" ] && [ -f "$OUT/$name/dist/index.js" ]; then
    echo "- $name @ ${ref:0:7} (already built)"
    continue
  fi
  echo "- $name @ ${ref:0:7}"
  tmp="$OUT/.tmp-$name"
  rm -rf "$tmp"
  git clone -q "$repo" "$tmp"
  git -C "$tmp" checkout -q "$ref"
  (cd "$tmp" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent && npm prune --omit=dev --loglevel=error)
  rm -rf "$tmp/.git"
  echo "$ref" > "$tmp/.agent-ui-ref"
  rm -rf "${OUT:?}/$name"
  mv "$tmp" "$OUT/$name"
done
