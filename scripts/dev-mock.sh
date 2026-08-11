#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/azure/frontend"
NODE_DIR="$ROOT_DIR/.tmp-node"
NODE_BIN="$NODE_DIR/bin/node"
NPM_CLI="$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
NPM_CACHE="$NODE_DIR/.npm-cache"

cd "$FRONTEND_DIR"
export USE_MOCK_DATA=true

if [ -x "$NODE_BIN" ] && [ -f "$NPM_CLI" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
  mkdir -p "$NPM_CACHE"
  [ -d node_modules ] || "$NODE_BIN" "$NPM_CLI" install --no-fund --no-audit --cache "$NPM_CACHE"
  exec "$NODE_BIN" "$NPM_CLI" run dev
else
  npm install
  exec npm run dev
fi
