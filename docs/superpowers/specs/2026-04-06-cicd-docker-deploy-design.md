# CI/CD Docker Deployment Design

## Overview

Autodeploy gpt-bot-ts to Contabo VPS when PRs merge to master. GitHub Actions builds a Docker image, pushes to GHCR, SSHs to contabo, pulls the image, and restarts the container. Cloudflare tunnel (already running as systemd service on contabo) routes `gpt-bot-ts.supawave.ai` → `localhost:8089`.

## Architecture

```
GitHub (PR merged to master)
  → GitHub Actions: npm ci, tsc, docker build
  → Push to ghcr.io/vega113/gpt-bot-ts:sha-<commit> + :latest
  → SSH to contabo
  → docker pull + systemctl restart gpt-bot-ts

Contabo:
  [systemd: cloudflared-gpt-bot-ts] → Cloudflare tunnel → gpt-bot-ts.supawave.ai
  [systemd: gpt-bot-ts] → Docker container → localhost:8089
```

## Components

### 1. Dockerfile (multi-stage)

```dockerfile
# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:22-alpine
WORKDIR /app
RUN addgroup -S bot && adduser -S bot -G bot
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8089/health || exit 1
USER bot
EXPOSE 8089
CMD ["node", "dist/index.js"]
```

### 2. GitHub Actions Workflow

**Triggers:**
- `pull_request` → type-check, build Docker image (verify it builds)
- `push` to `master` → same checks + push image + deploy

**Concurrency:** `concurrency: { group: deploy, cancel-in-progress: false }` — prevents parallel deploys

**Steps (deploy job):**
1. Checkout
2. `npm ci` + `npm run build` (type-check)
3. Docker login to GHCR
4. `docker build` + tag as `:sha-<SHA>` and `:latest`
5. `docker push` both tags
6. SSH to contabo: `docker pull` + `systemctl restart gpt-bot-ts`

### 3. Contabo Setup

**Container config:**
- Bridge networking: `-p 127.0.0.1:8089:8089`
- Env file: `/home/ubuntu/gpt-bot-ts/.env` (mode 0600)
- Image: `ghcr.io/vega113/gpt-bot-ts:latest`

**systemd service (`/etc/systemd/system/gpt-bot-ts.service`):**
```ini
[Unit]
Description=gpt-bot-ts Wave robot
After=docker.service cloudflared-gpt-bot-ts.service
Requires=docker.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f gpt-bot-ts
ExecStart=/usr/bin/docker run --rm --name gpt-bot-ts \
  -p 127.0.0.1:8089:8089 \
  --env-file /home/ubuntu/gpt-bot-ts/.env \
  ghcr.io/vega113/gpt-bot-ts:latest
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Already done:**
- cloudflared installed on contabo
- Tunnel credentials transferred
- systemd service `cloudflared-gpt-bot-ts` running and enabled

### 4. GitHub Secrets

| Secret | Value |
|--------|-------|
| `DEPLOY_SSH_KEY` | Dedicated ed25519 private key for deploy |
| `DEPLOY_HOST` | `86.48.3.138` |
| `DEPLOY_USER` | `ubuntu` |

### 5. Graceful Shutdown

Add SIGTERM handler to `src/index.ts` so in-flight requests complete before the container stops:

```typescript
const server = app.listen(PORT, () => { ... });

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});
```

### 6. .env on Contabo

```
OPENAI_API_KEY=sk-...
SUPAWAVE_TOKEN=<robot data API token>
ROBOT_ADDRESS=gpt-ts-bot@supawave.ai
PORT=8089
```

Token refresh: The SUPAWAVE_TOKEN (robot data API token) expires in 24h. For now, manually refresh via `POST /robot/dataapi/token`. Future: add auto-refresh logic to the bot.

### 7. Scope Exclusions

- No blue-green deployment (single bot, brief downtime acceptable)
- No Redis/persistent session state (in-memory is fine, restarts clear sessions)
- No rollback automation (re-deploy previous commit manually)
- No deploy user creation (ubuntu is the only user)

### 8. File Changes

| File | Action |
|------|--------|
| `Dockerfile` | Create |
| `.dockerignore` | Create |
| `.github/workflows/deploy.yml` | Create |
| `src/index.ts` | Add SIGTERM handler |
| Contabo: `/etc/systemd/system/gpt-bot-ts.service` | Create |
| Contabo: `/home/ubuntu/gpt-bot-ts/.env` | Create |
| GitHub: secrets | Configure 3 secrets |
| Contabo: `docker login ghcr.io` | One-time setup |
| Contabo: SSH authorized_keys | Add deploy key |
