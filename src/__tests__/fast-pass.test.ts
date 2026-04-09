import { describe, expect, it } from 'vitest';
import {
  buildAckMessage,
  decideWithTimeout,
  normalizeFastPassDecision,
  shouldForceAckAndWork,
  type FastPassClient,
  type FastPassDecision,
} from '../fast-pass.js';

const baseDecision: FastPassDecision = {
  action: 'quick_answer',
  message: 'Short answer',
  etaBucket: null,
  quickAnswerSafe: true,
  reason: 'quick',
};

describe('buildAckMessage', () => {
  it('maps seconds bucket to a short ETA message', () => {
    expect(buildAckMessage('seconds')).toBe('Working on this. Should take a few seconds.');
  });

  it('maps tens_of_seconds bucket to the medium ETA message', () => {
    expect(buildAckMessage('tens_of_seconds')).toBe(
      'Working on this. This may take around 10-20 seconds.',
    );
  });

  it('omits duration when no bucket is available', () => {
    expect(buildAckMessage(null)).toBe('Working on this.');
  });
});

describe('shouldForceAckAndWork', () => {
  it('forces ack_and_work for unsafe quick answers', () => {
    expect(
      shouldForceAckAndWork(
        { ...baseDecision, quickAnswerSafe: false },
        'What medicine should I take for this chest pain?',
      ),
    ).toBe(true);
  });

  it('forces ack_and_work for quick answers that imply current web facts', () => {
    expect(
      shouldForceAckAndWork(
        baseDecision,
        'What happened in the markets today?',
      ),
    ).toBe(true);
  });
});

describe('normalizeFastPassDecision', () => {
  it('falls back to ack_and_work when quick_answer is missing text', () => {
    expect(
      normalizeFastPassDecision({
        ...baseDecision,
        message: null,
      }, 'Explain this'),
    ).toEqual({
      action: 'ack_and_work',
      message: 'Working on this. Should take a few seconds.',
      etaBucket: 'seconds',
      quickAnswerSafe: false,
      reason: 'quick:missing_message',
    });
  });

  it('downgrades unsafe quick answers to ack_and_work', () => {
    expect(
      normalizeFastPassDecision({
        ...baseDecision,
        quickAnswerSafe: false,
      }, 'What medicine should I take for this chest pain?').action,
    ).toBe('ack_and_work');
  });
});

describe('decideWithTimeout', () => {
  it('returns null when fast pass exceeds timeout', async () => {
    const slowClient: FastPassClient = {
      decide: () => new Promise(() => {}),
    };

    await expect(decideWithTimeout(slowClient, 'hello', 5)).resolves.toBeNull();
  });
});
