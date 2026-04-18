import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_REPLY_DECISION_KIND } from '../bot-decision.js';

const createResponse = vi.fn();
const openAIConstructor = vi.fn(
  class MockOpenAI {
    responses = {
      create: createResponse,
    };
  },
);

vi.mock('openai', () => ({
  default: openAIConstructor,
}));

vi.mock('@openai/agents', () => ({
  Agent: class Agent {},
  run: vi.fn(),
}));

vi.mock('../tools/web-search.js', () => ({
  webSearch: {},
}));

vi.mock('../tools/wave-read.js', () => ({
  createWaveReadTool: vi.fn(() => ({})),
}));

vi.mock('../context.js', () => ({
  getSession: vi.fn(),
}));

vi.mock('../wave-client.js', () => ({
  WaveClient: class WaveClient {},
}));

describe('processMessageTimeoutFallback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete process.env['FULL_PASS_FALLBACK_MODEL'];
    delete process.env['FULL_PASS_FALLBACK_TIMEOUT_MS'];
    createResponse.mockResolvedValue({ output_text: 'Fallback answer' });
  });

  it('creates the OpenAI client lazily when timeout fallback is invoked', async () => {
    const agentModule = await import('../agent.js');

    expect(openAIConstructor).not.toHaveBeenCalled();

    const result = await agentModule.processMessageTimeoutFallback({
      waveId: 'wave-1',
      waveletId: 'wave-1!conv+root',
      userMessage: 'What is the latest bitcoin price today?',
      author: 'alice@example.com',
      waveClient: {} as never,
      participantCount: 2,
    });

    expect(openAIConstructor).toHaveBeenCalledTimes(1);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(result?.decision.response).toBe('Fallback answer');
  });

  it('falls back to the default model when FULL_PASS_FALLBACK_MODEL is blank', async () => {
    process.env['FULL_PASS_FALLBACK_MODEL'] = '   ';
    const agentModule = await import('../agent.js');

    await agentModule.processMessageTimeoutFallback({
      waveId: 'wave-1',
      waveletId: 'wave-1!conv+root',
      userMessage: 'What is the latest bitcoin price today?',
      author: 'alice@example.com',
      waveClient: {} as never,
      participantCount: 2,
    });

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4.1-mini' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null when the fallback API call exceeds the local timeout', async () => {
    vi.useFakeTimers();
    process.env['FULL_PASS_FALLBACK_TIMEOUT_MS'] = '5';
    createResponse.mockImplementation((_request, requestOptions) => {
      const signal = requestOptions?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });
    const agentModule = await import('../agent.js');

    const fallbackPromise = agentModule.processMessageTimeoutFallback({
      waveId: 'wave-1',
      waveletId: 'wave-1!conv+root',
      userMessage: 'What is the latest bitcoin price today?',
      author: 'alice@example.com',
      waveClient: {} as never,
      participantCount: 2,
    });

    await vi.advanceTimersByTimeAsync(5);

    await expect(fallbackPromise).resolves.toBeNull();
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying OpenAI request when the local timeout expires', async () => {
    vi.useFakeTimers();
    process.env['FULL_PASS_FALLBACK_TIMEOUT_MS'] = '5';
    let receivedSignal: AbortSignal | undefined;
    createResponse.mockImplementation((_request, requestOptions) => {
      receivedSignal = requestOptions?.signal;
      return new Promise((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(receivedSignal.reason));
      });
    });
    const agentModule = await import('../agent.js');

    const fallbackPromise = agentModule.processMessageTimeoutFallback({
      waveId: 'wave-1',
      waveletId: 'wave-1!conv+root',
      userMessage: 'What is the latest bitcoin price today?',
      author: 'alice@example.com',
      waveClient: {} as never,
      participantCount: 2,
    });

    await vi.advanceTimersByTimeAsync(5);

    await expect(fallbackPromise).resolves.toBeNull();
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('stays silent for non-mentioned messages in larger waves', async () => {
    const agentModule = await import('../agent.js');

    const result = await agentModule.processMessageTimeoutFallback({
      waveId: 'wave-1',
      waveletId: 'wave-1!conv+root',
      userMessage: 'What is the latest bitcoin price today?',
      author: 'alice@example.com',
      waveClient: {} as never,
      participantCount: 3,
      isExplicitMention: false,
    });

    expect(result).toEqual({
      decision: {
        kind: BOT_REPLY_DECISION_KIND,
        shouldReply: false,
        response: null,
      },
      pendingImages: [],
    });
    expect(openAIConstructor).not.toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it('stays silent when participant metadata is missing and there is no explicit mention', async () => {
    const agentModule = await import('../agent.js');

    const result = await agentModule.processMessageTimeoutFallback({
      waveId: 'wave-1',
      waveletId: 'wave-1!conv+root',
      userMessage: 'What is the latest bitcoin price today?',
      author: 'alice@example.com',
      waveClient: {} as never,
      isExplicitMention: false,
    });

    expect(result).toEqual({
      decision: {
        kind: BOT_REPLY_DECISION_KIND,
        shouldReply: false,
        response: null,
      },
      pendingImages: [],
    });
    expect(openAIConstructor).not.toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });
});
