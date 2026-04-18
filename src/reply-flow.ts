import {
  decideWithTimeout,
  normalizeFastPassDecision,
  type FastPassClient,
  type FastPassInput,
} from './fast-pass.js';
import {
  detectReplyPreferenceUpdate,
  shouldSuppressReply,
  type ReplyPreferenceState,
} from './reply-preferences.js';
import type { PendingImage, ProcessResult } from './agent.js';
import type { PostedReply, ReplyDelivery } from './reply-delivery.js';
import {
  DEFAULT_VISIBLE_REPLY_FALLBACK,
  normalizeVisibleReplyText,
} from './sanitize-response.js';

const ERROR_REPLY = 'Sorry, I ran into a problem while working on this. Please try again.';
const FULL_PASS_TIMEOUT_CODE = 'FULL_PASS_TIMEOUT';
const FULL_PASS_FALLBACK_TIMEOUT_CODE = 'FULL_PASS_FALLBACK_TIMEOUT';
const DEFAULT_FULL_PASS_FALLBACK_TIMEOUT_MS = 8_250;

class FullPassTimeoutError extends Error {
  code = FULL_PASS_TIMEOUT_CODE;

  constructor() {
    super('Full pass timed out');
    this.name = 'FullPassTimeoutError';
  }
}

class FullPassFallbackTimeoutError extends Error {
  code = FULL_PASS_FALLBACK_TIMEOUT_CODE;

  constructor(timeoutMs: number) {
    super(`Full pass fallback timed out after ${timeoutMs}ms`);
    this.name = 'FullPassFallbackTimeoutError';
  }
}

export interface ReplyFlowPayload {
  waveId: string;
  waveletId: string;
  parentBlipId: string;
  isInThread: boolean;
  isExplicitMention: boolean;
  userMessage: string;
  author: string;
  botAddress: string;
  parentContext?: string;
  participantCount: number;
}

export interface ReplyFlowDeps {
  replyPreference: ReplyPreferenceState;
  payload: ReplyFlowPayload;
  fastPass?: FastPassClient<FastPassInput> | null;
  fastPassTimeoutMs?: number;
  fullPassTimeoutMs?: number;
  fullPassFallbackTimeoutMs?: number;
  fullPass: () => Promise<ProcessResult>;
  fullPassFallback?: (
    reason: 'timeout' | 'error',
    error: Error,
  ) => Promise<ProcessResult | null>;
  delivery: ReplyDelivery;
  onReplyPreference: (state: ReplyPreferenceState) => void;
  onFastReply?: (assistantMessage: string) => Promise<void>;
  onImages: (replyBlipId: string | undefined, pendingImages: PendingImage[]) => Promise<void>;
}

export interface ReplyFlowResult {
  outcome:
    | 'ignored'
    | 'clarify'
    | 'quick_answer'
    | 'full_answer'
    | 'full_answer_no_fast_pass'
    | 'ignored_after_ack'
    | 'error';
}

function buildFastPassInput(
  payload: ReplyFlowPayload,
  replyPreference: ReplyPreferenceState,
): FastPassInput {
  return {
    userMessage: payload.userMessage,
    author: payload.author,
    parentContext: payload.parentContext,
    isExplicitMention: payload.isExplicitMention,
    participantCount: payload.participantCount,
    replyMode: replyPreference.mode,
  };
}

function cleanVisibleModelText(text: string | null | undefined): string {
  return normalizeVisibleReplyText(text, DEFAULT_VISIBLE_REPLY_FALLBACK);
}

function normalizeFlowError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function classifyFullPassFailure(error: Error): 'timeout' | 'error' {
  return error instanceof FullPassTimeoutError ||
    ('code' in error && error.code === FULL_PASS_TIMEOUT_CODE)
    ? 'timeout'
    : 'error';
}

async function tryFullPassFallback(
  deps: ReplyFlowDeps,
  error: Error,
): Promise<ProcessResult | null> {
  if (!deps.fullPassFallback) return null;

  const reason = classifyFullPassFailure(error);
  const fallbackTimeoutMs = deps.fullPassFallbackTimeoutMs ?? DEFAULT_FULL_PASS_FALLBACK_TIMEOUT_MS;
  console.warn(`[reply-flow] full pass ${reason}`, error);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      deps.fullPassFallback(reason, error),
      new Promise<ProcessResult | null>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new FullPassFallbackTimeoutError(fallbackTimeoutMs)),
          fallbackTimeoutMs,
        );
      }),
    ]);
  } catch (fallbackError) {
    console.warn('[reply-flow] full pass fallback failed', fallbackError);
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function runFullPass(deps: ReplyFlowDeps): Promise<ProcessResult> {
  if (!deps.fullPassTimeoutMs) return await deps.fullPass();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      deps.fullPass(),
      new Promise<ProcessResult>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new FullPassTimeoutError()),
          deps.fullPassTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function postDirectFullPassReply(
  deps: ReplyFlowDeps,
): Promise<ReplyFlowResult> {
  try {
    const full = await runFullPass(deps);
    if (!full.decision.shouldReply) {
      return { outcome: 'ignored' };
    }
    const replyText = cleanVisibleModelText(full.decision.response);
    const posted = await deps.delivery.postReply(replyText);
    await deps.onImages(posted.blipId, full.pendingImages);
    return { outcome: 'full_answer_no_fast_pass' };
  } catch (error) {
    const normalizedError = normalizeFlowError(error);
    const fallback = await tryFullPassFallback(deps, normalizedError);
    if (fallback) {
      if (!fallback.decision.shouldReply) {
        return { outcome: 'ignored' };
      }
      const replyText = cleanVisibleModelText(fallback.decision.response);
      const posted = await deps.delivery.postReply(replyText);
      await deps.onImages(posted.blipId, fallback.pendingImages);
      return { outcome: 'full_answer_no_fast_pass' };
    }

    await deps.delivery.postReply(ERROR_REPLY);
    return { outcome: 'error' };
  }
}

export async function handleReplyFlow(
  deps: ReplyFlowDeps,
): Promise<ReplyFlowResult> {
  const update = detectReplyPreferenceUpdate(deps.payload.userMessage, {
    isExplicitMention: deps.payload.isExplicitMention,
    author: deps.payload.author,
  });
  const effectiveReplyPreference = update ?? deps.replyPreference;
  deps.onReplyPreference(effectiveReplyPreference);

  if (shouldSuppressReply(effectiveReplyPreference, deps.payload.isExplicitMention)) {
    return { outcome: 'ignored' };
  }

  if (!deps.fastPass) {
    return await postDirectFullPassReply(deps);
  }

  let fastPassDecision;
  try {
    fastPassDecision = await decideWithTimeout(
      deps.fastPass,
      buildFastPassInput(deps.payload, effectiveReplyPreference),
      deps.fastPassTimeoutMs,
    );
  } catch {
    fastPassDecision = null;
  }

  if (!fastPassDecision) {
    return await postDirectFullPassReply(deps);
  }

  const fast = normalizeFastPassDecision(fastPassDecision, deps.payload.userMessage);

  if (fast.action === 'ignore') {
    if (deps.payload.isExplicitMention) {
      return await postDirectFullPassReply(deps);
    }
    return { outcome: 'ignored' };
  }

  if (fast.action === 'clarify' || fast.action === 'quick_answer') {
    const message = cleanVisibleModelText(fast.message);
    await deps.delivery.postReply(message);
    await deps.onFastReply?.(message);
    return { outcome: fast.action };
  }

  const placeholder = await deps.delivery.postPlaceholder(
    cleanVisibleModelText(fast.message),
  );

  try {
    const full = await runFullPass(deps);
    if (!full.decision.shouldReply) {
      try {
        await deps.delivery.deletePlaceholder(placeholder);
      } catch (error) {
        console.warn('Failed to delete reply placeholder after silent full-pass decision.', error);
      }
      return { outcome: 'ignored_after_ack' };
    }

    const finalReply = cleanVisibleModelText(full.decision.response);
    const posted = await deps.delivery.completePlaceholder(placeholder, finalReply);
    await deps.onImages(posted.blipId, full.pendingImages);
    return { outcome: 'full_answer' };
  } catch (error) {
    const normalizedError = normalizeFlowError(error);
    const fallback = await tryFullPassFallback(deps, normalizedError);
    if (fallback) {
      if (!fallback.decision.shouldReply) {
        try {
          await deps.delivery.deletePlaceholder(placeholder);
        } catch (deleteError) {
          console.warn('[reply-flow] failed to delete placeholder after fallback silence', deleteError);
        }
        return { outcome: 'ignored_after_ack' };
      }

      try {
        const finalReply = cleanVisibleModelText(fallback.decision.response);
        const posted = await deps.delivery.completePlaceholder(placeholder, finalReply);
        await deps.onImages(posted.blipId, fallback.pendingImages);
        return { outcome: 'full_answer' };
      } catch (fallbackDeliveryError) {
        console.warn('[reply-flow] failed to deliver fallback placeholder reply', fallbackDeliveryError);
        await deps.delivery.failPlaceholder(placeholder, ERROR_REPLY);
        return { outcome: 'error' };
      }
    }

    await deps.delivery.failPlaceholder(placeholder, ERROR_REPLY);
    return { outcome: 'error' };
  }
}
