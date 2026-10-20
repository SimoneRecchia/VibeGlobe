#!/usr/bin/env bash
# Installs dependencies, builds, starts the playground and runs the tests.
# Safe to re-run: an already running playground is reused.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PLAYGROUND_PORT:-5173}"
URL="http://localhost:${PORT}"
export PLAYGROUND_PORT="$PORT"

# Cloud containers ship a preinstalled Chromium for Playwright.
if [[ -z "${VIBEGLOBE_CHROMIUM_PATH:-}" && -x /opt/pw-browsers/chromium ]]; then
  export VIBEGLOBE_CHROMIUM_PATH=/opt/pw-browsers/chromium
fi

echo "==> Installing dependencies"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

echo "==> Building"
npm run build

echo "==> Starting the playground"
if curl -sf --noproxy '*' "$URL" >/dev/null; then
  echo "Playground already running at $URL"
else
  # Run Vite directly (not through npm) so the recorded pid is the server itself.
  (cd apps/playground && exec nohup ../../node_modules/.bin/vite >../../.playground.log 2>&1) &
  echo $! >.playground.pid
  for _ in $(seq 1 60); do
    curl -sf --noproxy '*' "$URL" >/dev/null && break
    sleep 1
  done
  curl -sf --noproxy '*' "$URL" >/dev/null || { echo "Playground did not start; see .playground.log" >&2; exit 1; }
fi

echo "==> Unit tests"
npm test

echo "==> End-to-end tests"
npm run test:e2e

echo "==> Feature status"
npm run status --silent

echo
echo "Playground running at $URL (log: .playground.log; stop: kill \$(cat .playground.pid))"
