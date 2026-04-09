import { describe, expect, it } from 'vitest';
import {
  detectReplyPreferenceUpdate,
  shouldSuppressReply,
  type ReplyPreferenceState,
} from '../reply-preferences.js';

function pref(mode: ReplyPreferenceState['mode']): ReplyPreferenceState {
  return { mode };
}

describe('detectReplyPreferenceUpdate', () => {
  it('switches to only_when_mentioned for direct quiet commands', () => {
    expect(
      detectReplyPreferenceUpdate('Please only reply when mentioned.', {
        isExplicitMention: false,
        author: 'alice@example.com',
        now: 123,
      }),
    ).toEqual({
      mode: 'only_when_mentioned',
      updatedBy: 'alice@example.com',
      updatedAt: 123,
    });
  });

  it('accepts explicit mention as direction toward the bot', () => {
    expect(
      detectReplyPreferenceUpdate('@gpt-ts-bot be quiet for now', {
        isExplicitMention: true,
        author: 'alice@example.com',
        now: 456,
      }),
    ).toEqual({
      mode: 'only_when_mentioned',
      updatedBy: 'alice@example.com',
      updatedAt: 456,
    });
  });

  it('switches back to normal for resume commands', () => {
    expect(
      detectReplyPreferenceUpdate('Okay, you can reply normally again.', {
        isExplicitMention: false,
        author: 'alice@example.com',
        now: 789,
      }),
    ).toEqual({
      mode: 'normal',
      updatedBy: 'alice@example.com',
      updatedAt: 789,
    });
  });

  it('does not false-positive on unrelated text', () => {
    expect(
      detectReplyPreferenceUpdate('This is about reply buttons, not you.', {
        isExplicitMention: false,
        author: 'alice@example.com',
      }),
    ).toBeNull();
  });

  it('does not treat third-person quiet text as a bot command', () => {
    expect(
      detectReplyPreferenceUpdate('Tell the team to be quiet during the demo.', {
        isExplicitMention: false,
        author: 'alice@example.com',
      }),
    ).toBeNull();
  });
});

describe('shouldSuppressReply', () => {
  it('suppresses non-mentioned replies in only_when_mentioned mode', () => {
    expect(shouldSuppressReply(pref('only_when_mentioned'), false)).toBe(true);
  });

  it('allows mention override in only_when_mentioned mode', () => {
    expect(shouldSuppressReply(pref('only_when_mentioned'), true)).toBe(false);
  });

  it('does not suppress replies in normal mode', () => {
    expect(shouldSuppressReply(pref('normal'), false)).toBe(false);
  });
});
