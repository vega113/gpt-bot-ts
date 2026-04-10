# Robot Responsiveness Design

**Goal:** Make `gpt-bot-ts` feel more human and responsive by replying immediately when possible, acknowledging slower work quickly, asking for clarification when needed, and explicitly remembering per-wave "be quiet / only reply when mentioned" instructions.

## Design

The bot uses a two-stage response pipeline.

### Stage A: Fast pass

A small, configurable model classifies the user message into one of four actions:

- `ignore`
- `clarify`
- `quick_answer`
- `ack_and_work`

The fast pass returns a short message, an optional ETA bucket, a `quickAnswerSafe` flag, and a reason string. The fast pass has no tools and must not handle high-risk or freshness-sensitive requests directly. Runtime code applies a deterministic safety gate and downgrades unsafe `quick_answer` candidates to `ack_and_work`.

Default model/configuration:

- `FAST_PASS_MODEL=gpt-5.4-mini`
- `FAST_PASS_TIMEOUT_MS=2500`
- `FAST_PASS_ENABLED=1`
- `FAST_PASS_MAX_QUICK_ANSWER_CHARS=280`

If fast pass is disabled, times out, throws, or returns malformed structured output, the bot falls back to the previous full-agent flow without posting a placeholder first. Fast-pass visible replies for clarification and quick answers are recorded into the per-wave agent session best-effort so later full-agent turns retain continuity.

### Stage B: Full pass

The existing `processMessage()` agent path remains the source of truth for heavy work:

- web search
- wave reading
- image generation
- long synthesis
- rich final Markdown answers

For `ack_and_work`, the bot posts an immediate placeholder such as:

- `Working on this.`
- `Working on this. Should take a few seconds.`
- `Working on this. This may take around 10-20 seconds.`
- `Working on this. This could take up to about a minute.`

When the full answer is ready, the bot posts the final answer in the same thread first and then best-effort deletes the placeholder blip. This post-then-delete approach intentionally preserves existing Markdown-to-Wave annotation behavior; in-place `document.modify REPLACE` does not carry arbitrary ranged Markdown annotations cleanly enough for this slice, and posting first avoids leaving the conversation empty if placeholder deletion succeeds but the final post fails.

If placeholder deletion fails, the bot keeps the posted final answer and logs the stale placeholder. If the full pass fails or times out, the bot deletes the placeholder when possible and posts a short error reply.

## Reply Preferences

The bot stores explicit per-wave reply preference state outside LLM memory:

```ts
{
  mode: 'normal' | 'only_when_mentioned';
  updatedBy?: string;
  updatedAt?: number;
}
```

Ordering for each incoming message:

1. detect explicit bot mention
2. load stored per-wave preference
3. parse the current message for a preference update
4. compute the effective preference as `update ?? stored state`
5. persist the effective preference
6. if effective mode is `only_when_mentioned` and there is no explicit mention, stay silent
7. otherwise run fast pass

Direct preference commands like `Please only reply when mentioned.` take effect immediately. Explicit mentions override quiet mode.

## Components

- `src/reply-preferences.ts`
  - deterministic parser and suppress/allow helper
- `src/fast-pass.ts`
  - structured small-model decision client, ETA text, safety gate, timeout wrapper
- `src/reply-delivery.ts`
  - Markdown-to-Wave delivery abstraction, placeholder post/delete/final post lifecycle
- `src/reply-flow.ts`
  - end-to-end orchestration for one message
- `src/context.ts`
  - per-wave reply preference storage plus existing agent session storage
- `src/wave-client.ts`
  - `deleteBlip()` wrapper for `blip.delete`
- `src/index.ts`
  - request extraction and orchestration wiring

## Testing

Coverage required and implemented:

- reply-preference parsing, suppression, and false-positive avoidance
- context persistence and cleanup of reply preferences
- fast-pass ETA mapping, quick-answer safety downgrade, missing message downgrade, and timeout fallback
- reply-flow state machine for quiet mode, clarification, quick answers, ack/full answer, fast-pass timeout, full-pass failure, and full-pass timeout
- WaveClient `blip.delete` request and error handling

## Non-goals

This slice does not implement:

- true token streaming
- incremental answer chunking
- automatic multi-question decomposition into multiple inline replies
- per-user reply preferences
- in-place Markdown-preserving placeholder replacement
