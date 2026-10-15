#!/usr/bin/env bash
# Run every test suite: upstream server + client tests, then the Cockpit additions.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
npm test
npm run test:client
npx tsx --tsconfig server/tsconfig.json --test cockpit/server/*.test.ts
npx vitest run --config cockpit/vitest.config.ts
