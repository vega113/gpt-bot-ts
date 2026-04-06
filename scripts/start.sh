#!/usr/bin/env bash
set -e

PORT="${PORT:-8089}"

# Load env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Build
echo "Building TypeScript..."
npm run build

# Start cloudflared named tunnel in background
echo "Starting cloudflared tunnel (gpt-bot-ts -> localhost:$PORT)..."
cloudflared tunnel run --url "http://127.0.0.1:$PORT" gpt-bot-ts &
TUNNEL_PID=$!

# Cleanup on exit
trap "kill $TUNNEL_PID 2>/dev/null" EXIT

# Start the server
echo "Starting gpt-bot-ts on port $PORT..."
node dist/index.js
