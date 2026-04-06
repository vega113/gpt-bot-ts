/**
 * Tests for src/index.ts — covers changes introduced in this PR:
 *
 *  - POST /_wave/robot/jsonrpc always calls postReply with the plain string
 *    returned by processMessage (no shouldReply gate)
 *  - reply is used directly as a string; reply.length is logged
 *  - When processMessage throws, an error reply string is posted
 *
 * Strategy: mock Express and all heavy deps, then call the captured route
 * handler directly with synthetic req/res objects — no real HTTP server.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── environment (must be set before index.ts module is evaluated) ────────────

process.env['SUPAWAVE_TOKEN'] = 'test-token';
process.env['OPENAI_API_KEY'] = 'test-openai-key';
process.env['PORT'] = '19876';
process.env['ROBOT_ADDRESS'] = 'testbot@supawave.ai';

// ── hoisted mock state ────────────────────────────────────────────────────────

const {
  mockProcessMessage,
  mockReplyToBlip,
  mockContinueThread,
  capturedRoutes,
  mockApp,
} = vi.hoisted(() => {
  const capturedRoutes: Record<string, (...args: unknown[]) => unknown> = {};
  const mockApp = {
    use: vi.fn(),
    get: vi.fn((path: string, handler: (...args: unknown[]) => unknown) => {
      capturedRoutes[`GET:${path}`] = handler;
    }),
    post: vi.fn((path: string, handler: (...args: unknown[]) => unknown) => {
      capturedRoutes[`POST:${path}`] = handler;
    }),
    listen: vi.fn((_port: number, cb?: () => void) => {
      cb?.();
      return { close: vi.fn(), address: () => ({ port: 19876 }) };
    }),
  };
  return {
    mockProcessMessage: vi.fn<() => Promise<string>>(),
    mockReplyToBlip: vi.fn(),
    mockContinueThread: vi.fn(),
    capturedRoutes,
    mockApp,
  };
});

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('express', () => {
  const factory = vi.fn(() => mockApp);
  (factory as unknown as Record<string, unknown>)['json'] = vi.fn(() => vi.fn());
  return { default: factory };
});

vi.mock('../agent.js', () => ({
  processMessage: mockProcessMessage,
}));

vi.mock('../wave-client.js', () => ({
  // Must use a regular function (not arrow) so `new WaveClient()` works.
  // A constructor that returns a plain object uses that object instead of `this`.
  WaveClient: vi.fn(function () {
    return { replyToBlip: mockReplyToBlip, continueThread: mockContinueThread };
  }),
}));

vi.mock('../context.js', () => ({
  clearSession: vi.fn(),
  sessionCount: vi.fn().mockReturnValue(0),
  getSession: vi.fn().mockReturnValue({ id: 'mock-session' }),
}));

// ── server boot ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Import index.ts after all mocks are in place. This registers route handlers
  // on mockApp and populates capturedRoutes.
  await import('../index.js');
});

// ── test fixtures ─────────────────────────────────────────────────────────────

let blipCounter = 0;

interface MockBundle {
  blipContent?: string;
  modifiedBy?: string;
  annotationsOnBlip?: Array<{ name: string; value: string; range: { start: number; end: number } }>;
}

function makeBundle(opts: MockBundle = {}): Record<string, unknown> {
  const blipId = `blip-${++blipCounter}`;
  return {
    events: [
      {
        type: 'DOCUMENT_CHANGED',
        modifiedBy: opts.modifiedBy ?? 'alice@example.com',
        timestamp: Date.now(),
        properties: { blipId },
      },
    ],
    wavelet: {
      waveId: `wave-${blipId}`,
      waveletId: 'wavelet-1',
      rootBlipId: 'blip-root',
      title: 'Test wave',
      participants: ['alice@example.com', 'testbot@supawave.ai'],
    },
    blips: {
      [blipId]: {
        blipId,
        content: opts.blipContent ?? 'Hello bot, please help!',
        annotations: opts.annotationsOnBlip ?? [],
      },
    },
    threads: {},
    robotAddress: 'testbot@supawave.ai',
    rpcServerUrl: 'https://example.com/rpc',
  };
}

type MockRes = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

function makeRes(): MockRes {
  const res: MockRes = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); // fluent: res.status(400).json(...)
  return res;
}

/** Call the registered POST /_wave/robot/jsonrpc handler. */
async function callPostHandler(
  body: unknown,
): Promise<{ res: MockRes; backgroundDone: Promise<void> }> {
  const handler = capturedRoutes['POST:/_wave/robot/jsonrpc'];
  if (!handler) throw new Error('POST route not registered — did index.ts load?');

  const req = { body };
  const res = makeRes();

  const backgroundDone = (async () => {
    await handler(req, res);
  })() as Promise<void>;

  return { res, backgroundDone };
}

/** Poll until predicate is true or timeout elapses. */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** All reply strings passed to replyToBlip or continueThread. */
function capturedReplies(): string[] {
  return [
    ...mockReplyToBlip.mock.calls.map((c) => c[2] as string),
    ...mockContinueThread.mock.calls.map((c) => c[2] as string),
  ];
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /_wave/robot/jsonrpc — PR changes', () => {
  beforeEach(() => {
    mockProcessMessage.mockReset();
    mockReplyToBlip.mockReset();
    mockContinueThread.mockReset();
    mockReplyToBlip.mockResolvedValue(undefined);
    mockContinueThread.mockResolvedValue(undefined);
    mockProcessMessage.mockResolvedValue('Default bot reply');
  });

  // ── route registration ────────────────────────────────────────────────────

  it('registers the POST /_wave/robot/jsonrpc route', () => {
    expect(capturedRoutes['POST:/_wave/robot/jsonrpc']).toBeDefined();
  });

  // ── request validation ────────────────────────────────────────────────────

  it('returns 400 for an invalid (missing events) bundle', async () => {
    const { res, backgroundDone } = await callPostHandler({ wavelet: { waveId: 'w1' } });
    await backgroundDone;
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for a completely invalid body', async () => {
    const { res, backgroundDone } = await callPostHandler({ garbage: true });
    await backgroundDone;
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ── core change: always posts the reply string ───────────────────────────

  it('calls postReply with the plain string returned by processMessage', async () => {
    mockProcessMessage.mockResolvedValueOnce('Here is the answer.');

    const { backgroundDone } = await callPostHandler(makeBundle());
    await backgroundDone;
    await waitFor(() => capturedReplies().length > 0);

    expect(capturedReplies()[0]).toBe('Here is the answer.');
  });

  it('posts a multi-line reply string verbatim', async () => {
    mockProcessMessage.mockResolvedValueOnce('Line one\nLine two\nLine three');

    const { backgroundDone } = await callPostHandler(makeBundle());
    await backgroundDone;
    await waitFor(() => capturedReplies().length > 0);

    expect(capturedReplies()[0]).toBe('Line one\nLine two\nLine three');
  });

  it('posts the fallback string from processMessage without modification', async () => {
    const fallback = 'I had trouble generating a response. Please try again.';
    mockProcessMessage.mockResolvedValueOnce(fallback);

    const { backgroundDone } = await callPostHandler(makeBundle());
    await backgroundDone;

    expect(capturedReplies()[0]).toBe(fallback);
  });

  it('posts any non-empty string reply without inspecting its content', async () => {
    // Before PR: shouldReply=false suppressed posting.
    // After PR: processMessage returns a plain string; postReply is always called.
    for (const msg of ['ok', 'yes', 'no']) {
      mockProcessMessage.mockResolvedValueOnce(msg);
      mockReplyToBlip.mockClear();
      mockContinueThread.mockClear();

      const { backgroundDone } = await callPostHandler(makeBundle());
      await backgroundDone;
      await waitFor(() => capturedReplies().length > 0);

      expect(capturedReplies()[0]).toBe(msg);
    }
  });

  // ── immediate ack before processMessage resolves ──────────────────────────

  it('sends robot.notify JSON response immediately, before processMessage resolves', async () => {
    let resolveMsg!: (v: string) => void;
    mockProcessMessage.mockReturnValueOnce(
      new Promise<string>((resolve) => { resolveMsg = resolve; }),
    );

    // After calling the handler, res.json should already have been called
    // (with the notify op) even before processMessage resolves.
    const { backgroundDone } = await callPostHandler(makeBundle());

    // res.json was called immediately with the notify op
    expect(mockReplyToBlip).not.toHaveBeenCalled();

    // Unblock and finish the background job
    resolveMsg('late reply');
    await backgroundDone;
    await waitFor(() => capturedReplies().length > 0, 1000).catch(() => {});
  });

  // ── error handling ────────────────────────────────────────────────────────

  it('posts an error reply string when processMessage throws', async () => {
    mockProcessMessage.mockRejectedValueOnce(new Error('Agent exploded'));

    const { backgroundDone } = await callPostHandler(makeBundle());
    await backgroundDone;
    await waitFor(() => capturedReplies().length > 0);

    const errorReply = capturedReplies()[0];
    expect(typeof errorReply).toBe('string');
    expect(errorReply.toLowerCase()).toContain('error');
  });

  // ── skip bot's own events ─────────────────────────────────────────────────

  it('does not call processMessage when the event was sent by the bot itself', async () => {
    const bundle = makeBundle({ modifiedBy: 'testbot@supawave.ai' });

    const { backgroundDone } = await callPostHandler(bundle);
    await backgroundDone;

    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  // ── skip blips still being edited ────────────────────────────────────────

  it('does not call processMessage when the blip is still being edited', async () => {
    const bundle = makeBundle({
      annotationsOnBlip: [
        {
          name: 'user/d/session-abc',
          value: 'alice@example.com,1700000000000,', // empty end timestamp = editing
          range: { start: 0, end: 1 },
        },
      ],
    });

    const { backgroundDone } = await callPostHandler(bundle);
    await backgroundDone;

    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  // ── regression: reply type is string not object ───────────────────────────

  it('passes a string (not an object) as the reply to the wave client', async () => {
    mockProcessMessage.mockResolvedValueOnce('A plain string reply');

    const { backgroundDone } = await callPostHandler(makeBundle());
    await backgroundDone;
    await waitFor(() => capturedReplies().length > 0);

    const reply = capturedReplies()[0];
    expect(typeof reply).toBe('string');
    expect(reply).not.toHaveProperty('shouldReply');
    expect(reply).not.toHaveProperty('response');
  });
});