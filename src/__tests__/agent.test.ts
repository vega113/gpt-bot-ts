/**
 * Tests for src/agent.ts — covers changes introduced in this PR:
 *
 *  - processMessage() now returns Promise<string> (plain text, not BotDecision)
 *  - Fallback string returned when result.finalOutput is null / undefined
 *  - BotDecision / outputType no longer used — Agent constructed without it
 *  - Input to run() formatted as "[author]: message"
 *  - run() called with correct session, maxTurns and context
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ── hoisted mock state (available when vi.mock factories run) ─────────────────

const { mockRun, MockAgent, mockWaveReadTool, mockSession } = vi.hoisted(() => ({
  mockRun: vi.fn(),
  MockAgent: vi.fn(),
  mockWaveReadTool: { name: 'read_wave' },
  mockSession: { id: 'mock-session' },
}));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('@openai/agents', () => ({
  Agent: MockAgent,
  run: mockRun,
}));

vi.mock('../tools/web-search.js', () => ({
  webSearch: { name: 'web_search' },
}));

vi.mock('../tools/wave-read.js', () => ({
  createWaveReadTool: vi.fn(() => mockWaveReadTool),
}));

vi.mock('../context.js', () => ({
  getSession: vi.fn(() => mockSession),
}));

vi.mock('../wave-client.js', () => ({
  WaveClient: vi.fn(),
}));

// ── imports (after mock declarations) ────────────────────────────────────────

import { processMessage } from '../agent.js';
import { getSession } from '../context.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFakeWaveClient() {
  return {} as import('../wave-client.js').WaveClient;
}

const DEFAULT_OPTS = {
  waveId: 'wave-123',
  userMessage: 'Hello, bot!',
  author: 'alice@example.com',
  waveClient: makeFakeWaveClient(),
};

// ── Agent construction checks (must run before vi.clearAllMocks) ─────────────
//
// The agent is a module-level singleton. MockAgent's constructor is called
// exactly once — on the very first processMessage() invocation. We capture
// that call here, in a dedicated describe with its own beforeAll, so that
// vi.clearAllMocks() in later tests does not erase the evidence.

describe('Agent construction (no outputType / BotDecision)', () => {
  let agentConfig: Record<string, unknown>;

  beforeAll(async () => {
    mockRun.mockResolvedValue({ finalOutput: 'ok' });
    await processMessage(DEFAULT_OPTS); // triggers singleton initialization
    agentConfig = MockAgent.mock.calls[0]?.[0] as Record<string, unknown>;
  });

  it('constructs Agent without an outputType property', () => {
    expect(agentConfig).toBeDefined();
    expect(agentConfig).not.toHaveProperty('outputType');
  });

  it('includes the wave-read tool in the Agent tools array', () => {
    expect(agentConfig.tools).toEqual(expect.arrayContaining([mockWaveReadTool]));
  });

  it('includes the web-search tool in the Agent tools array', () => {
    expect(agentConfig.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web_search' })]),
    );
  });
});

// ── processMessage behaviour ──────────────────────────────────────────────────

describe('processMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ finalOutput: 'Agent reply' });
  });

  // ── return type is plain string ───────────────────────────────────────────

  it('returns the finalOutput string from the agent run', async () => {
    mockRun.mockResolvedValueOnce({ finalOutput: 'This is the answer.' });

    const result = await processMessage(DEFAULT_OPTS);

    expect(result).toBe('This is the answer.');
  });

  it('result is a plain string, not an object with shouldReply/response', async () => {
    mockRun.mockResolvedValueOnce({ finalOutput: 'Plain text reply' });

    const result = await processMessage(DEFAULT_OPTS);

    expect(typeof result).toBe('string');
    // Regression: BotDecision shape is gone — no shouldReply or response property
    expect(result).not.toHaveProperty('shouldReply');
    expect(result).not.toHaveProperty('response');
  });

  // ── fallback when finalOutput is absent ───────────────────────────────────

  it('returns the fallback message when finalOutput is null', async () => {
    mockRun.mockResolvedValueOnce({ finalOutput: null });

    const result = await processMessage(DEFAULT_OPTS);

    expect(result).toBe('I had trouble generating a response. Please try again.');
  });

  it('returns the fallback message when finalOutput is undefined', async () => {
    mockRun.mockResolvedValueOnce({ finalOutput: undefined });

    const result = await processMessage(DEFAULT_OPTS);

    expect(result).toBe('I had trouble generating a response. Please try again.');
  });

  it('uses nullish coalescing — empty string finalOutput is returned as-is', async () => {
    // '' ?? fallback → '' (not falsy substitution; only null/undefined triggers fallback)
    mockRun.mockResolvedValueOnce({ finalOutput: '' });

    const result = await processMessage(DEFAULT_OPTS);

    expect(result).toBe('');
  });

  // ── input formatting ──────────────────────────────────────────────────────

  it('formats the run input as "[author]: message"', async () => {
    await processMessage({
      ...DEFAULT_OPTS,
      author: 'bob@wave.ai',
      userMessage: 'What time is it?',
    });

    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      '[bob@wave.ai]: What time is it?',
      expect.anything(),
    );
  });

  it('includes special characters in the author and message without escaping', async () => {
    await processMessage({
      ...DEFAULT_OPTS,
      author: 'user+tag@example.com',
      userMessage: 'Hello & <world>!',
    });

    const callInput = mockRun.mock.calls[0][1];
    expect(callInput).toBe('[user+tag@example.com]: Hello & <world>!');
  });

  // ── run() options ─────────────────────────────────────────────────────────

  it('passes the session from getSession(waveId) to run()', async () => {
    await processMessage(DEFAULT_OPTS);

    expect(getSession).toHaveBeenCalledWith('wave-123');
    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ session: mockSession }),
    );
  });

  it('passes maxTurns: 10 to run()', async () => {
    await processMessage(DEFAULT_OPTS);

    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ maxTurns: 10 }),
    );
  });

  it('passes waveId in the run context', async () => {
    await processMessage({ ...DEFAULT_OPTS, waveId: 'wave-abc' });

    expect(mockRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ context: { waveId: 'wave-abc' } }),
    );
  });

  // ── error propagation ────────────────────────────────────────────────────

  it('propagates errors thrown by run()', async () => {
    const error = new Error('API failure');
    mockRun.mockRejectedValueOnce(error);

    await expect(processMessage(DEFAULT_OPTS)).rejects.toThrow('API failure');
  });

  // ── per-wave session isolation ────────────────────────────────────────────

  it('uses distinct sessions for different waveIds', async () => {
    const sessionA = { id: 'session-a' };
    const sessionB = { id: 'session-b' };
    const mockGetSession = vi.mocked(getSession);
    mockGetSession
      .mockReturnValueOnce(sessionA as ReturnType<typeof getSession>)
      .mockReturnValueOnce(sessionB as ReturnType<typeof getSession>);

    await processMessage({ ...DEFAULT_OPTS, waveId: 'wave-A' });
    await processMessage({ ...DEFAULT_OPTS, waveId: 'wave-B' });

    const firstCallSession = (mockRun.mock.calls[0][2] as Record<string, unknown>)['session'];
    const secondCallSession = (mockRun.mock.calls[1][2] as Record<string, unknown>)['session'];
    expect(firstCallSession).toBe(sessionA);
    expect(secondCallSession).toBe(sessionB);
  });
});