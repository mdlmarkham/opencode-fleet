#!/usr/bin/env bash
# Repo-relative verification gate: build + full test suite must pass.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npx vitest run --config ./vitest.config.ts
