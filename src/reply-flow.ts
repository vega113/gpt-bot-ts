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
  fullPass: () => Promise<ProcessResult>;
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

async function runFullPass(deps: ReplyFlowDeps): Promise<ProcessResult> {
  if (!deps.fullPassTimeoutMs) return await deps.fullPass();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      deps.fullPass(),
      new Promise<ProcessResult>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Full pass timed out')),
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
  } catch {
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
  } catch {
    await deps.delivery.failPlaceholder(placeholder, ERROR_REPLY);
    return { outcome: 'error' };
  }
}
