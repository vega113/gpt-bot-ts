import { describe, expect, it, vi } from 'vitest';
import { handleReplyFlow, type ReplyFlowDeps } from '../reply-flow.js';
import type { FastPassDecision } from '../fast-pass.js';
import type { ReplyPreferenceState } from '../reply-preferences.js';
import { BOT_REPLY_DECISION_KIND } from '../bot-decision.js';

const basePayload = {
  waveId: 'wave1',
  waveletId: 'wave1!conv+root',
  parentBlipId: 'b+parent',
  isInThread: false,
  isExplicitMention: false,
  userMessage: 'Explain this',
  author: 'alice@example.com',
  botAddress: 'gpt-ts-bot@supawave.ai',
  parentContext: undefined,
  participantCount: 2,
};

function makeDecision(overrides: Partial<FastPassDecision> = {}): FastPassDecision {
  return {
    action: 'ack_and_work',
    message: 'Working on this. Should take a few seconds.',
    etaBucket: 'seconds',
    quickAnswerSafe: true,
    reason: 'default',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReplyFlowDeps> = {}): ReplyFlowDeps {
  return {
    replyPreference: { mode: 'normal' },
    payload: basePayload,
    fastPass: {
      decide: vi.fn().mockResolvedValue(makeDecision()),
    },
    fastPassTimeoutMs: 50,
    fullPass: vi.fn().mockResolvedValue({
      decision: {
        kind: BOT_REPLY_DECISION_KIND,
        shouldReply: true,
        response: 'Final answer',
      },
      pendingImages: [],
    }),
    fullPassFallback: vi.fn().mockResolvedValue(null),
    delivery: {
      postReply: vi.fn().mockResolvedValue({ blipId: 'b+final', content: 'Final answer' }),
      postPlaceholder: vi.fn().mockResolvedValue({ blipId: 'b+placeholder', content: 'Working on this.' }),
      deletePlaceholder: vi.fn().mockResolvedValue(undefined),
      completePlaceholder: vi.fn().mockResolvedValue({ blipId: 'b+final', content: 'Final answer' }),
      failPlaceholder: vi.fn().mockResolvedValue({ blipId: 'b+error', content: 'Sorry, I ran into a problem.' }),
    },
    onReplyPreference: vi.fn(),
    onFastReply: vi.fn().mockResolvedValue(undefined),
    onImages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('handleReplyFlow', () => {
  it('suppresses replies when the same message switches to only_when_mentioned mode', async () => {
    const deps = makeDeps({
      payload: {
        ...basePayload,
        userMessage: 'Please only reply when mentioned.',
      },
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('ignored');
    expect(deps.onReplyPreference).toHaveBeenCalledWith({
      mode: 'only_when_mentioned',
      updatedBy: 'alice@example.com',
      updatedAt: expect.any(Number),
    });
    expect(deps.delivery.postReply).not.toHaveBeenCalled();
    expect(deps.delivery.postPlaceholder).not.toHaveBeenCalled();
  });

  it('uses the quick-answer branch without invoking the full agent', async () => {
    const deps = makeDeps({
      fastPass: {
        decide: vi.fn().mockResolvedValue(
          makeDecision({
            action: 'quick_answer',
            message: 'Short answer',
            etaBucket: null,
            quickAnswerSafe: true,
          }),
        ),
      },
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('quick_answer');
    expect(deps.delivery.postReply).toHaveBeenCalledWith('Short answer');
    expect(deps.onFastReply).toHaveBeenCalledWith('Short answer');
    expect(deps.fullPass).not.toHaveBeenCalled();
    expect(deps.delivery.postPlaceholder).not.toHaveBeenCalled();
  });

  it('sanitizes fast-pass quick answers before posting', async () => {
    const deps = makeDeps({
      fastPass: {
        decide: vi.fn().mockResolvedValue(
          makeDecision({
            action: 'quick_answer',
            message: 'Short answer【turn0search0】 from (example.com)',
            etaBucket: null,
            quickAnswerSafe: true,
          }),
        ),
      },
    });

    await handleReplyFlow(deps);

    expect(deps.delivery.postReply).toHaveBeenCalledWith(
      'Short answer from ([example.com](https://example.com))',
    );
  });

  it('uses the clarify branch without invoking the full agent', async () => {
    const deps = makeDeps({
      fastPass: {
        decide: vi.fn().mockResolvedValue(
          makeDecision({
            action: 'clarify',
            message: 'Can you clarify which part you want explained?',
            etaBucket: null,
          }),
        ),
      },
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('clarify');
    expect(deps.delivery.postReply).toHaveBeenCalledWith(
      'Can you clarify which part you want explained?',
    );
    expect(deps.fullPass).not.toHaveBeenCalled();
  });

  it('posts and then completes a placeholder for ack_and_work', async () => {
    const deps = makeDeps();

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('full_answer');
    expect(deps.delivery.postPlaceholder).toHaveBeenCalledWith(
      'Working on this. Should take a few seconds.',
    );
    expect(deps.delivery.completePlaceholder).toHaveBeenCalledWith(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Final answer',
    );
    expect(deps.onImages).toHaveBeenCalledWith('b+final', []);
  });

  it('falls back to the default reply when the full agent returns blank text without fast pass', async () => {
    const deps = makeDeps({
      fastPass: null,
      fullPass: vi.fn().mockResolvedValue({
        decision: {
          kind: BOT_REPLY_DECISION_KIND,
          shouldReply: true,
          response: '   ',
        },
        pendingImages: [],
      }),
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('full_answer_no_fast_pass');
    expect(deps.delivery.postReply).toHaveBeenCalledWith(
      'I had trouble generating a response. Please try again.',
    );
  });

  it('falls back to the default reply when the full agent returns blank text after ack', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockResolvedValue({
        decision: {
          kind: BOT_REPLY_DECISION_KIND,
          shouldReply: true,
          response: '   ',
        },
        pendingImages: [],
      }),
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('full_answer');
    expect(deps.delivery.completePlaceholder).toHaveBeenCalledWith(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'I had trouble generating a response. Please try again.',
    );
  });

  it('deletes the placeholder when the full agent chooses not to reply after ack', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockResolvedValue({
        decision: {
          kind: BOT_REPLY_DECISION_KIND,
          shouldReply: false,
          response: null,
        },
        pendingImages: [],
      }),
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('ignored_after_ack');
    expect(deps.delivery.deletePlaceholder).toHaveBeenCalledWith({
      blipId: 'b+placeholder',
      content: 'Working on this.',
    });
    expect(deps.delivery.completePlaceholder).not.toHaveBeenCalled();
  });

  it('keeps the ignored-after-ack outcome when placeholder deletion fails', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockResolvedValue({
        decision: {
          kind: BOT_REPLY_DECISION_KIND,
          shouldReply: false,
          response: null,
        },
        pendingImages: [],
      }),
      delivery: {
        postReply: vi.fn().mockResolvedValue({ blipId: 'b+final', content: 'Final answer' }),
        postPlaceholder: vi.fn().mockResolvedValue({ blipId: 'b+placeholder', content: 'Working on this.' }),
        deletePlaceholder: vi.fn().mockRejectedValue(new Error('delete failed')), 
        completePlaceholder: vi.fn(),
        failPlaceholder: vi.fn(),
      },
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('ignored_after_ack');
    expect(deps.delivery.deletePlaceholder).toHaveBeenCalledOnce();
    expect(deps.delivery.failPlaceholder).not.toHaveBeenCalled();
    expect(deps.delivery.postReply).not.toHaveBeenCalled();
  });

  it('falls back to direct full-pass reply when fast pass times out', async () => {
    const deps = makeDeps({
      fastPass: {
        decide: vi.fn().mockImplementation(() => new Promise(() => {})),
      },
      fastPassTimeoutMs: 5,
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('full_answer_no_fast_pass');
    expect(deps.delivery.postPlaceholder).not.toHaveBeenCalled();
    expect(deps.delivery.postReply).toHaveBeenCalledWith('Final answer');
  });

  it('posts an error reply when the full pass fails after placeholder ack', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('error');
    expect(deps.delivery.failPlaceholder).toHaveBeenCalledWith(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Sorry, I ran into a problem while working on this. Please try again.',
    );
  });

  it('posts an error reply when the full pass times out after placeholder ack', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockImplementation(() => new Promise(() => {})),
      fullPassTimeoutMs: 5,
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('error');
    expect(deps.delivery.failPlaceholder).toHaveBeenCalledWith(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Sorry, I ran into a problem while working on this. Please try again.',
    );
  });

  it('uses the fallback full-pass result when the main full pass times out', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockImplementation(() => new Promise(() => {})),
      fullPassTimeoutMs: 5,
      fullPassFallback: vi.fn().mockResolvedValue({
        decision: {
          kind: BOT_REPLY_DECISION_KIND,
          shouldReply: true,
          response: 'Fallback answer',
        },
        pendingImages: [],
      }),
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('full_answer');
    expect(deps.fullPassFallback).toHaveBeenCalledWith(
      'timeout',
      expect.objectContaining({ code: 'FULL_PASS_TIMEOUT' }),
    );
    expect(deps.delivery.completePlaceholder).toHaveBeenCalledWith(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Fallback answer',
    );
    expect(deps.delivery.failPlaceholder).not.toHaveBeenCalled();
  });

  it('fails the placeholder if fallback placeholder completion throws', async () => {
    const deps = makeDeps({
      fullPass: vi.fn().mockImplementation(() => new Promise(() => {})),
      fullPassTimeoutMs: 5,
      fullPassFallback: vi.fn().mockResolvedValue({
        decision: {
          kind: BOT_REPLY_DECISION_KIND,
          shouldReply: true,
          response: 'Fallback answer',
        },
        pendingImages: [],
      }),
      delivery: {
        postReply: vi.fn().mockResolvedValue({ blipId: 'b+final', content: 'Final answer' }),
        postPlaceholder: vi.fn().mockResolvedValue({ blipId: 'b+placeholder', content: 'Working on this.' }),
        deletePlaceholder: vi.fn().mockResolvedValue(undefined),
        completePlaceholder: vi.fn().mockRejectedValue(new Error('complete failed')),
        failPlaceholder: vi.fn().mockResolvedValue({ blipId: 'b+error', content: 'Sorry, I ran into a problem.' }),
      },
    });

    await expect(handleReplyFlow(deps)).resolves.toEqual({ outcome: 'error' });
    expect(deps.delivery.failPlaceholder).toHaveBeenCalledWith(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Sorry, I ran into a problem while working on this. Please try again.',
    );
  });

  it('fails the placeholder when the fallback path also times out', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        fullPass: vi.fn().mockImplementation(() => new Promise(() => {})),
        fullPassTimeoutMs: 5,
        fullPassFallbackTimeoutMs: 7,
        fullPassFallback: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      const resultPromise = handleReplyFlow(deps);

      await vi.advanceTimersByTimeAsync(12);

      await expect(resultPromise).resolves.toEqual({ outcome: 'error' });
      expect(deps.delivery.failPlaceholder).toHaveBeenCalledWith(
        { blipId: 'b+placeholder', content: 'Working on this.' },
        'Sorry, I ran into a problem while working on this. Please try again.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to full-pass handling when fast pass ignores an explicit mention', async () => {
    const deps = makeDeps({
      payload: {
        ...basePayload,
        isExplicitMention: true,
      },
      fastPass: {
        decide: vi.fn().mockResolvedValue(
          makeDecision({
            action: 'ignore',
            message: null,
            etaBucket: null,
          }),
        ),
      },
    });

    const result = await handleReplyFlow(deps);

    expect(result.outcome).toBe('full_answer_no_fast_pass');
    expect(deps.delivery.postReply).toHaveBeenCalledWith('Final answer');
    expect(deps.delivery.postPlaceholder).not.toHaveBeenCalled();
    expect(deps.fullPass).toHaveBeenCalledOnce();
  });
});
