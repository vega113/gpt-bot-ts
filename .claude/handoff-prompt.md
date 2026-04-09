# gpt-bot-ts — Session Handoff Prompt

You are picking up work on **gpt-bot-ts**, a SupaWave (Google Wave-inspired) robot/bot server written in TypeScript. Below is everything you need to know to continue effectively.

## Project Overview

A Wave robot that receives event bundles from the SupaWave server, processes user messages through an OpenAI agent, and posts formatted replies back to Wave blips. It supports web search, wave reading, and image generation tools.

**Stack:** Node.js 22, TypeScript, Express, `@openai/agents` SDK, `openai` SDK, Vitest for tests.

**Deployment:** Docker on Contabo server via GitHub Actions CI/CD. Pushes to `master` auto-deploy. Service managed by systemd (`gpt-bot-ts`).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Express server, event routing, blip extraction, reply posting, image insertion |
| `src/agent.ts` | OpenAI Agent config, system prompt, `processMessage()` returns `ProcessResult` |
| `src/wave-client.ts` | SupaWave Data API client — RPC, blip ops, attachment upload, image insert |
| `src/helpers.ts` | Pure functions: `mentionsBot`, `isValidBundle`, `isBeingEdited`, `isBlipInThread`, `findParentBlipContext` |
| `src/sanitize-response.ts` | Strip citation artifacts, normalize whitespace, `linkifyBareUrls` |
| `src/markdown-to-wave.ts` | Convert Markdown → Wave plain text + style annotations |
| `src/tools/web-search.ts` | Built-in OpenAI web search tool |
| `src/tools/wave-read.ts` | Custom tool to read wave conversation content |
| `src/tools/image-gen.ts` | Image generation via `gpt-image-1`, deferred upload pattern |
| `src/context.ts` | Per-wave session management for conversation memory |
| `src/token-utils.ts` | JWT token expiry decoding and checking |

## Architecture & Data Flow

```text
SupaWave Server → POST /_wave/robot/jsonrpc (EventMessageBundle)
  → Validate bundle (isValidBundle)
  → Handle lifecycle (WAVELET_SELF_ADDED → welcome blip, WAVELET_SELF_REMOVED → clear session)
  → Extract finished blip (DOCUMENT_CHANGED / ANNOTATED_TEXT_CHANGED, no active editing)
  → Check shouldRespond (bot is participant or @-mentioned)
  → processMessage() via @openai/agents SDK
    → Agent runs with tools (web search, wave read, image gen)
    → Returns ProcessResult { decision: BotDecision, pendingImages: PendingImage[] }
  → sanitizeLlmResponse() → strip citations
  → postReply() via WaveClient → markdownToWave() → blip.createChild or blip.continueThread
  → If pendingImages: importAttachment() → insertImage() (deferred upload pattern)
```

## Important Patterns & Gotchas

### OpenAI Agent Tool Schemas
**CRITICAL:** OpenAI's API requires ALL properties in function tool schemas to appear in the `required` array. Using `.optional()` in Zod causes the property to be omitted from `required`, which produces a 400 error on EVERY agent run — not just when the tool is called. This was the root cause of a production outage (PR #16).

### SupaWave API Quirks
- `document.modify` returns `[null]` for successful IMAGE insertions, not `{id, data}`. Callers must use `response?.error` (optional chaining) when checking responses from this method. On `master`, `WaveClient.insertImage()` still uses `response.error`, so successful IMAGE insertions can still crash until PR #19 lands.
- Blip content must start with `\n`. WaveClient handles this via `ensureNewline()` and offsets annotation ranges by 1.
- The `threads` map key is NOT guaranteed to equal `thread.id`. Always use `thread.id` for logic.
- `user/d/{sessionId}` annotations are PERMANENT. The editing signal is in the VALUE format: `"userId,startMs,"` = still editing, `"userId,startMs,endMs"` = done.

### Citation Sanitization
OpenAI web search injects citation markers in multiple formats:
- Bracket forms such as `【turn0finance0】`, `【citeturn0finance0】`, `【cite†turn0finance0】`, and suffixed variants like `【turn0search0†source】`
- ASCII-mangled forms such as `.citeturn0finance0` and `citeturn0search0`
- `src/sanitize-response.ts` is the source of truth for the exact stripping rules and follow-up cleanup
- Must strip citation artifacts without false positives like `【cite turn2 plan】`
- Must NOT strip `【Saturn2026】` or `【return plan】` (anchored to bracket start)

### Image Support (New, may need debugging)
- `generate_image` tool generates image via OpenAI, stores base64 in `pendingImages`
- Upload (`importAttachment`) and insertion (`insertImage`) are DEFERRED to `index.ts` — only after the reply blip is successfully created
- The image ⚠️ warning icon in Wave is a known rendering issue being investigated on the SupaWave side
- `getAgent()` is currently synchronous and caches a single `agent` instance
- Image tool currently imports `OpenAI` statically from the `openai` SDK; PR #17 proposes dynamic import + single-flight init

### Wave Thread Model
- Root thread contains `rootBlipId` — blips there are top-level
- Non-root threads are inline reply threads
- `isBlipInThread()` checks if a blip is in a non-root thread
- `findParentBlipContext()` finds the parent blip content for context-aware replies
- Context is passed to LLM in `<wave-context>` XML tags

## Development Workflow

### Branching
- `master` = production (auto-deploys on push)
- Feature branches: `feat/xxx`, fix branches: `fix/xxx`, hotfixes: `hotfix/xxx`
- User wants work done in "separate lanes" (separate branches/PRs)

### PR Review Process
The user's standard request is: "check review comments for PR, we need to make sure that all review comments are addressed and all threads resolved — there should be 0 unresolved threads so the checks pass."

**Workflow:**
1. `gh api graphql` to list unresolved review threads
2. Read each comment, evaluate if valid
3. Implement fixes
4. Reply to each comment with the fix commit hash
5. Resolve threads via GraphQL mutation: `resolveReviewThread`
6. Verify 0 unresolved and `mergeStateStatus: CLEAN`

**Reviewers:** CodeRabbit (coderabbitai), Copilot (copilot-pull-request-reviewer), Codex (chatgpt-codex-connector). CodeRabbit's status check can be slow — sometimes takes 2+ minutes.

### Testing
```bash
npm test                    # Run all tests (vitest)
npx tsc --noEmit           # Type check without emitting
npm test -- --reporter=verbose src/__tests__/specific.test.ts  # Run specific test file
```

### Production Access
```bash
ssh supawave                                    # SSH to Contabo server
sudo docker logs gpt-bot-ts --tail 50           # Bot container logs
sudo journalctl -u gpt-bot-ts --no-pager -n 50  # Systemd logs
```

### Copilot Review (Optional)
The user has a `/copilot` skill for code review:
```bash
DIFF=$(git diff HEAD)
copilot -p "Review: $DIFF" --model gpt-5.4-mini --effort high --silent 2>&1
```

## Open PRs & Status (as of April 9, 2026)

| PR | Branch | Status | Description |
|---|---|---|---|
| #14 | fix/linkify-source-refs | MERGED | Bare URL linkification + citation hardening |
| #17 | fix/pr16-review-followup | OPEN/CLEAN | Dynamic import, single-flight agent init, logging |
| #18 | feat/welcome-blip | OPEN/CLEAN | Welcome blip on WAVELET_SELF_ADDED |
| #19 | fix/image-insert-null-response | OPEN/BLOCKED | Fix null response crash in insertImage |

## Known Issues

1. **Image ⚠️ in Wave:** Attachment uploads and IMAGE element insertions succeed (server confirms), but the Wave client shows a warning icon instead of the image. This may be a SupaWave rendering bug or a format issue. The base64 PNG data from OpenAI is ~2.8MB. This needs investigation on the SupaWave side.

2. **Open PRs still pending merge (as of April 9, 2026):** PR #14's `linkifyBareUrls` function and hardened citation stripping logic are already on `master`. PR #17 (dynamic import + logging), PR #18 (welcome blip), and PR #19 (null-response fix for `insertImage`) are still open.

## User Preferences

- Wants work in "separate lanes" (separate branches per feature/fix)
- Expects all PR review threads to be resolved before merge
- Wants Copilot review on significant changes
- Prefers investigating production issues via logs (`ssh supawave` + `docker logs`)
- Values defensive coding — graceful degradation over hard failures
- Expects tests to pass and TypeScript to compile clean before pushing
