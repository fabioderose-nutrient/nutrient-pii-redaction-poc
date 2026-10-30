#!/usr/bin/env bash
# macOS / Linux shortcut for: npm install + npm run demo
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
npm run demo
