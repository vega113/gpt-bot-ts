import { describe, it, expect } from 'vitest';
import {
  mentionsBot,
  isValidBundle,
  isBeingEdited,
  isBlipInThread,
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

  it('returns true when message contains @botname', () => {
    expect(mentionsBot('hey @gpt-ts-bot what is 2+2?', addr)).toBe(true);
  });

  it('returns true when message contains full robot address', () => {
    expect(mentionsBot(`hello gpt-ts-bot@supawave.ai`, addr)).toBe(true);
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
});

// ── isValidBundle ─────────────────────────────────────────────

describe('isValidBundle', () => {
  it('returns false for null', () => {
    expect(isValidBundle(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidBundle('string')).toBe(false);
    expect(isValidBundle(42)).toBe(false);
  });

  it('returns false when events is missing', () => {
    expect(isValidBundle({ wavelet: { waveId: 'w1' } })).toBe(false);
  });

  it('returns false when events is not an array', () => {
    expect(isValidBundle({ events: {}, wavelet: { waveId: 'w1' } })).toBe(false);
  });

  it('returns false when wavelet is missing', () => {
    expect(isValidBundle({ events: [] })).toBe(false);
  });

  it('returns false when waveId is not a string', () => {
    expect(isValidBundle({ events: [], wavelet: { waveId: 42 } })).toBe(false);
  });

  it('returns true for a valid minimal bundle', () => {
    expect(
      isValidBundle({ events: [], wavelet: { waveId: 'wave1' }, blips: {}, threads: {} }),
    ).toBe(true);
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
