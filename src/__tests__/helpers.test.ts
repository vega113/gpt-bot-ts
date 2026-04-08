import { describe, it, expect } from 'vitest';
import {
  mentionsBot,
  isValidBundle,
  isBeingEdited,
  isBlipInThread,
  findParentBlipContext,
} from '../helpers.js';
import type { EventMessageBundle, BlipData } from '../helpers.js';

// ── helpers ──────────────────────────────────────────────────

function makeBundle(overrides: Partial<EventMessageBundle> = {}): EventMessageBundle {
  return {
    events: [],
    wavelet: {
      waveId: 'wave1',
      waveletId: 'wave1!conv+root',
      rootBlipId: 'root-blip',
      title: 'Test Wave',
      participants: [],
    },
    blips: {},
    threads: {},
    robotAddress: 'gpt-ts-bot@supawave.ai',
    rpcServerUrl: 'https://supawave.ai',
    ...overrides,
  };
}

function makeBlip(overrides: Partial<BlipData> = {}): BlipData {
  return {
    blipId: 'blip1',
    content: 'hello',
    ...overrides,
  };
}

// ── mentionsBot ──────────────────────────────────────────────

describe('mentionsBot', () => {
  const addr = 'gpt-ts-bot@supawave.ai';

  it('returns true when @botname is mid-sentence', () => {
    expect(mentionsBot('hey @gpt-ts-bot what is 2+2?', addr)).toBe(true);
  });

  it('returns true when @botname is at start of message', () => {
    expect(mentionsBot('@gpt-ts-bot please help', addr)).toBe(true);
  });

  it('returns true when @botname is at end of message', () => {
    expect(mentionsBot('hello @gpt-ts-bot', addr)).toBe(true);
  });

  it('returns true when message contains full robot address', () => {
    expect(mentionsBot('hello gpt-ts-bot@supawave.ai', addr)).toBe(true);
  });

  it('returns false when message has no mention', () => {
    expect(mentionsBot('what is the weather today?', addr)).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(mentionsBot('', addr)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(mentionsBot('@GPT-TS-BOT', addr)).toBe(false);
  });

  it('does not false-positive on a longer handle (@gpt-ts-bot-foo)', () => {
    expect(mentionsBot('hey @gpt-ts-bot-foo do this', addr)).toBe(false);
  });
});

// ── isValidBundle ─────────────────────────────────────────────

describe('isValidBundle', () => {
  const validBundle = {
    events: [],
    blips: {},
    threads: {},
    robotAddress: 'gpt-ts-bot@supawave.ai',
    rpcServerUrl: 'https://supawave.ai',
    wavelet: {
      waveId: 'wave1',
      waveletId: 'wave1!conv+root',
      rootBlipId: 'root-blip',
      title: 'Test Wave',
      participants: ['user@supawave.ai'],
    },
  };

  it('returns false for null', () => {
    expect(isValidBundle(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidBundle('string')).toBe(false);
    expect(isValidBundle(42)).toBe(false);
  });

  it('returns false when events is not an array', () => {
    expect(isValidBundle({ ...validBundle, events: {} })).toBe(false);
  });

  it('returns false when blips is missing', () => {
    const { blips: _, ...rest } = validBundle;
    expect(isValidBundle(rest)).toBe(false);
  });

  it('returns true when threads is missing (treated as {})', () => {
    const { threads: _, ...rest } = validBundle;
    expect(isValidBundle(rest)).toBe(true);
  });

  it('returns false when threads is present but not an object', () => {
    expect(isValidBundle({ ...validBundle, threads: 'bad' })).toBe(false);
  });

  it('returns false when robotAddress is missing', () => {
    const { robotAddress: _, ...rest } = validBundle;
    expect(isValidBundle(rest)).toBe(false);
  });

  it('returns true when rpcServerUrl is missing (optional field)', () => {
    const { rpcServerUrl: _, ...rest } = validBundle;
    expect(isValidBundle(rest)).toBe(true);
  });

  it('returns false when rpcServerUrl is present but not a string', () => {
    expect(isValidBundle({ ...validBundle, rpcServerUrl: 42 })).toBe(false);
  });

  it('returns false when wavelet is missing', () => {
    expect(isValidBundle({ events: [], blips: {}, threads: {} })).toBe(false);
  });

  it('returns false when waveId is not a string', () => {
    expect(isValidBundle({ ...validBundle, wavelet: { ...validBundle.wavelet, waveId: 42 } })).toBe(false);
  });

  it('returns false when rootBlipId is missing', () => {
    const { rootBlipId: _, ...wavelet } = validBundle.wavelet;
    expect(isValidBundle({ ...validBundle, wavelet })).toBe(false);
  });

  it('returns false when title is missing', () => {
    const { title: _, ...wavelet } = validBundle.wavelet;
    expect(isValidBundle({ ...validBundle, wavelet })).toBe(false);
  });

  it('returns false when participants is not an array', () => {
    expect(isValidBundle({ ...validBundle, wavelet: { ...validBundle.wavelet, participants: {} } })).toBe(false);
  });

  it('returns false when participants contains non-strings', () => {
    expect(isValidBundle({ ...validBundle, wavelet: { ...validBundle.wavelet, participants: [42] } })).toBe(false);
  });

  it('returns false when a thread entry is malformed', () => {
    expect(isValidBundle({ ...validBundle, threads: { t1: { id: 'x', blipIds: [42] } } })).toBe(false);
  });

  it('returns true for a valid bundle with empty threads', () => {
    expect(isValidBundle(validBundle)).toBe(true);
  });

  it('returns true for a valid bundle with well-formed threads', () => {
    expect(isValidBundle({
      ...validBundle,
      threads: { root: { id: 'root', blipIds: ['blip1'] } },
    })).toBe(true);
  });
});

// ── isBeingEdited ─────────────────────────────────────────────

describe('isBeingEdited', () => {
  it('returns false when blip has no annotations', () => {
    expect(isBeingEdited(makeBlip())).toBe(false);
  });

  it('returns false for empty annotations array', () => {
    expect(isBeingEdited(makeBlip({ annotations: [] }))).toBe(false);
  });

  it('returns false for non-user/d/ annotations', () => {
    const blip = makeBlip({
      annotations: [{ name: 'style/color', value: 'red', range: { start: 0, end: 5 } }],
    });
    expect(isBeingEdited(blip)).toBe(false);
  });

  it('returns true when user/d/ annotation has no end timestamp', () => {
    const blip = makeBlip({
      annotations: [
        { name: 'user/d/session1', value: 'user1,1234567890000,', range: { start: 0, end: 1 } },
      ],
    });
    expect(isBeingEdited(blip)).toBe(true);
  });

  it('returns true when user/d/ annotation has only two parts', () => {
    const blip = makeBlip({
      annotations: [
        { name: 'user/d/session1', value: 'user1,1234567890000', range: { start: 0, end: 1 } },
      ],
    });
    expect(isBeingEdited(blip)).toBe(true);
  });

  it('returns false when user/d/ annotation has end timestamp (done editing)', () => {
    const blip = makeBlip({
      annotations: [
        {
          name: 'user/d/session1',
          value: 'user1,1234567890000,1234567899000',
          range: { start: 0, end: 1 },
        },
      ],
    });
    expect(isBeingEdited(blip)).toBe(false);
  });

  it('returns true if any annotation is still editing', () => {
    const blip = makeBlip({
      annotations: [
        {
          name: 'user/d/session1',
          value: 'user1,1000,2000', // done
          range: { start: 0, end: 1 },
        },
        {
          name: 'user/d/session2',
          value: 'user2,3000,', // still editing
          range: { start: 0, end: 1 },
        },
      ],
    });
    expect(isBeingEdited(blip)).toBe(true);
  });

  it('returns false when value is empty', () => {
    const blip = makeBlip({
      annotations: [{ name: 'user/d/s', value: '', range: { start: 0, end: 1 } }],
    });
    expect(isBeingEdited(blip)).toBe(false);
  });
});

// ── isBlipInThread ────────────────────────────────────────────

describe('isBlipInThread', () => {
  it('returns false when threads is empty', () => {
    const bundle = makeBundle({ threads: {} });
    expect(isBlipInThread('blip1', bundle)).toBe(false);
  });

  it('returns false when blip is in the root thread', () => {
    const bundle = makeBundle({
      threads: {
        root: { id: 'root', blipIds: ['root-blip', 'blip1'] },
      },
    });
    expect(isBlipInThread('blip1', bundle)).toBe(false);
  });

  it('returns true when blip is in a non-root thread', () => {
    const bundle = makeBundle({
      threads: {
        root: { id: 'root', blipIds: ['root-blip'] },
        reply: { id: 'reply', blipIds: ['blip1', 'blip2'] },
      },
    });
    expect(isBlipInThread('blip1', bundle)).toBe(true);
  });

  it('returns false when blip is not in any thread', () => {
    const bundle = makeBundle({
      threads: {
        root: { id: 'root', blipIds: ['root-blip'] },
        reply: { id: 'reply', blipIds: ['other-blip'] },
      },
    });
    expect(isBlipInThread('blip1', bundle)).toBe(false);
  });

  it('handles missing threads gracefully (nullish coalesce)', () => {
    const bundle = makeBundle({ threads: undefined as unknown as Record<string, never> });
    expect(isBlipInThread('blip1', bundle)).toBe(false);
  });
});

// ── findParentBlipContext ─────────────────────────────────────

describe('findParentBlipContext', () => {
  it('returns null when threads is empty', () => {
    const bundle = makeBundle({ threads: {} });
    expect(findParentBlipContext('blip1', bundle)).toBeNull();
  });

  it('returns null when the blip is not in any thread', () => {
    const bundle = makeBundle({
      blips: { other: makeBlip({ blipId: 'other', content: 'some content' }) },
      threads: {
        root: { id: 'root', blipIds: ['root-blip', 'other'] },
      },
    });
    expect(findParentBlipContext('blip1', bundle)).toBeNull();
  });

  it('returns parent blip content when thread ID matches a blip ID (strategy 1)', () => {
    // In Wave, the inline thread ID often equals the parent blip's ID
    const bundle = makeBundle({
      blips: {
        'parent-blip': makeBlip({ blipId: 'parent-blip', content: '\nIsrael – Iran | Ongoing proxy conflict' }),
        'child-blip': makeBlip({ blipId: 'child-blip', content: '\ntell me more about this' }),
      },
      threads: {
        root: { id: 'root', blipIds: ['root-blip', 'parent-blip'] },
        // Thread ID equals the parent blip's ID — the classic Wave inline thread pattern
        'parent-blip': { id: 'parent-blip', blipIds: ['child-blip'] },
      },
    });
    expect(findParentBlipContext('child-blip', bundle)).toBe('Israel – Iran | Ongoing proxy conflict');
  });

  it('strips leading newline from parent content', () => {
    const bundle = makeBundle({
      blips: {
        'parent-blip': makeBlip({ blipId: 'parent-blip', content: '\nHello world' }),
        'child-blip': makeBlip({ blipId: 'child-blip', content: '\nreply' }),
      },
      threads: {
        'parent-blip': { id: 'parent-blip', blipIds: ['child-blip'] },
      },
    });
    expect(findParentBlipContext('child-blip', bundle)).toBe('Hello world');
  });

  it('falls back to most recent root-thread blip (strategy 2)', () => {
    // Thread ID does not match any blip ID — use fallback restricted to root thread
    const bundle = makeBundle({
      blips: {
        'root-blip': makeBlip({ blipId: 'root-blip', content: '\nOlder content', lastModifiedTime: 1000 }),
        'other-blip': makeBlip({ blipId: 'other-blip', content: '\nNewer content', lastModifiedTime: 2000 }),
        'sibling-thread-blip': makeBlip({ blipId: 'sibling-thread-blip', content: '\nUnrelated sibling thread', lastModifiedTime: 3000 }),
        'child-blip': makeBlip({ blipId: 'child-blip', content: '\nreply' }),
      },
      threads: {
        root: { id: 'root', blipIds: ['root-blip', 'other-blip'] },
        // Sibling inline thread (more recently modified but unrelated)
        'sibling-blip': { id: 'sibling-blip', blipIds: ['sibling-thread-blip'] },
        // Thread ID 'inline-thread-xyz' does not match any blip ID
        'inline-thread-xyz': { id: 'inline-thread-xyz', blipIds: ['child-blip'] },
      },
    });
    // Should return the most recently modified ROOT-THREAD blip, not the sibling thread blip
    expect(findParentBlipContext('child-blip', bundle)).toBe('Newer content');
  });

  it('returns null when blip is only in the root thread (not an inline reply)', () => {
    const bundle = makeBundle({
      blips: {
        'root-blip': makeBlip({ blipId: 'root-blip', content: '\nRoot content' }),
        'another-root': makeBlip({ blipId: 'another-root', content: '\nAnother root blip' }),
      },
      threads: {
        root: { id: 'root', blipIds: ['root-blip', 'another-root'] },
      },
    });
    // Blip is in the root thread — not an inline reply, no parent context
    expect(findParentBlipContext('another-root', bundle)).toBeNull();
  });

  it('returns null when parent blip content is empty', () => {
    const bundle = makeBundle({
      blips: {
        'parent-blip': makeBlip({ blipId: 'parent-blip', content: '\n   ' }),
        'child-blip': makeBlip({ blipId: 'child-blip', content: '\nreply' }),
      },
      threads: {
        'parent-blip': { id: 'parent-blip', blipIds: ['child-blip'] },
      },
    });
    expect(findParentBlipContext('child-blip', bundle)).toBeNull();
  });

  it('handles missing threads gracefully', () => {
    const bundle = makeBundle({ threads: undefined as unknown as Record<string, never> });
    expect(findParentBlipContext('blip1', bundle)).toBeNull();
  });
});
