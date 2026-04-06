#!/usr/bin/env bash
set -e
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

# Load env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

exec node dist/index.js
