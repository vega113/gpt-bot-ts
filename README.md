# gpt-bot-ts

A sophisticated AI assistant for [SupaWave](https://supawave.ai) built with the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) (TypeScript).

## Features

- **OpenAI Agent** with GPT model and conversation memory
- **Web search** via OpenAI's built-in hosted web search tool
- **Wave context** — reads full wave conversations for context
- **Per-wave sessions** with automatic context compaction
- **Wave robot protocol** — receives events and posts replies asynchronously

## Architecture

```
POST /_wave/robot/jsonrpc        ← Wave server sends BLIP_SUBMITTED events
  → Acknowledge immediately (robot.notify)
  → Process with OpenAI Agent (async)
  → Post reply via Data API (wavelet.appendBlip)
```

Each wave gets its own `OpenAIResponsesCompactionSession` so the agent
remembers the full conversation and auto-compacts when history grows large.

## Setup

### Prerequisites

- Node.js 22+
- OpenAI API key
- SupaWave data API token
- Cloudflare named tunnel `gpt-bot-ts` configured

### Configuration

Copy `.env` and fill in:

```bash
OPENAI_API_KEY=sk-...
SUPAWAVE_TOKEN=eyJ...
ROBOT_ADDRESS=gpt-bot-ts@supawave.ai
PORT=8089
```

### Install & Run

```bash
npm install
npm run build
npm start

# Or with cloudflared tunnel:
./scripts/start.sh

# Or for development:
npm run dev
```

### Register the bot

```bash
curl -X POST https://supawave.ai/api/robots \
  -H "Authorization: Bearer $SUPAWAVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "gpt-bot-ts",
    "description": "AI assistant with web search and conversation memory",
    "callbackUrl": "https://gpt-bot-ts.supawave.ai"
  }'
```

## Project Structure

```
src/
├── index.ts           Express server + robot endpoints
├── agent.ts           OpenAI Agent with tools
├── wave-client.ts     SupaWave JSON-RPC Data API client
├── context.ts         Per-wave session management
└── tools/
    ├── web-search.ts  Built-in web search tool
    └── wave-read.ts   Custom wave content reading tool
```
