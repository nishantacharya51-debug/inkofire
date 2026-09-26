#!/usr/bin/env bash
# Bundles a headless TypeScript harness with esbuild and runs it on Node.
# Usage: bash scripts/run.sh scripts/simulate.ts [script args...]
set -e
cd "$(dirname "$0")/.."
ENTRY="$1"; shift || true
OUT=".qa/$(basename "${ENTRY%.ts}").cjs"
npx esbuild "$ENTRY" --bundle --platform=node --target=node20 --format=cjs \
  --outfile="$OUT" --packages=external --log-level=warning
node "$OUT" "$@"
