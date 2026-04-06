#!/usr/bin/env bash
set -e
cd /Users/vega/devroot/gpt-bot-ts

# Load env
set -a
source .env
set +a

exec node dist/index.js
