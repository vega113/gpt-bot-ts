# Robot Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fast first-pass response pipeline so the Wave robot can ignore, clarify, answer immediately, or acknowledge-and-work while explicitly remembering per-wave reply-suppression instructions.

**Architecture:** Add isolated modules for reply preferences, fast-pass routing, reply delivery, and reply-flow orchestration. Keep the existing full OpenAI agent path for heavy work. Use delete-and-repost final delivery to preserve Markdown annotations after placeholder cleanup.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Express, OpenAI Node SDK, `@openai/agents`, Zod.

---

## Tasks Completed

- [x] Add `src/reply-preferences.ts` with deterministic wave-level quiet-mode parsing and tests.
- [x] Extend `src/context.ts` to store and clear per-wave reply preferences.
- [x] Add `src/fast-pass.ts` with structured small-model decision helpers, safety gating, and timeout handling.
- [x] Add `src/reply-delivery.ts` to post Markdown replies, post placeholders, delete placeholders, and repost final/error replies.
- [x] Add `src/reply-flow.ts` to orchestrate quiet mode, fast pass, quick answers, clarification, ack-and-work, full-pass fallback, and image insertion ordering.
- [x] Add `WaveClient.deleteBlip()` and tests for `blip.delete`.
- [x] Wire `src/index.ts` to use the responsive reply flow and preserve existing image upload/insert behavior.
- [x] Run `npm test` and `npx tsc --noEmit`.
- [x] Run Claude Code design review and apply the concrete findings.

## Follow-up Candidates

- Add true in-place placeholder replacement only if Wave supports ranged Markdown annotations for replacement or an easier full-blip content replacement operation.
- Add chunked answer delivery after the placeholder lifecycle is stable in production.
- Add per-user preference state if wave-level quiet mode becomes too coarse.
