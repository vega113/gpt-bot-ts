import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    });

    expect(openAIConstructor).toHaveBeenCalledTimes(1);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(result?.decision.response).toBe('Fallback answer');
  });
});
