/**
 * OpenAI Agent configuration and message processing.
 *
 * Creates an Agent with web search and wave-read tools, then
 * exposes a processMessage() function that runs the agent within
 * the per-wave session.
 */

import { Agent, run } from '@openai/agents';
import { webSearch } from './tools/web-search.js';
import { createWaveReadTool } from './tools/wave-read.js';
import { getSession } from './context.js';
import { WaveClient } from './wave-client.js';

/** Context passed to tools via RunContext. */
export interface WaveContext {
  waveId: string;
}

const SYSTEM_PROMPT = `You are gpt-bot-ts, a helpful AI assistant inside SupaWave — a collaborative real-time editor inspired by Google Wave.

Guidelines:
- You are participating in a wave conversation with other users.
- Be concise but thorough. Use markdown formatting when helpful.
- You have access to web search — use it when the user asks about current events, facts you're unsure about, or anything that benefits from fresh information.
- You can read the full wave conversation history using the read_wave tool if you need more context.
- Remember: each wave is a separate conversation thread. You maintain context within each wave.
- Do not repeat previous messages. Focus on the latest user message and respond to it.
- If multiple users are in the wave, address them naturally.`;

let agent: Agent<WaveContext> | null = null;

/** Lazily initialize the agent (needs WaveClient for tools). */
function getAgent(waveClient: WaveClient): Agent<WaveContext> {
  if (agent) return agent;

  agent = new Agent<WaveContext>({
    name: 'gpt-bot-ts',
    instructions: SYSTEM_PROMPT,
    tools: [webSearch, createWaveReadTool(waveClient)],
  });

  return agent;
}

export interface ProcessMessageOptions {
  waveId: string;
  userMessage: string;
  author: string;
  waveClient: WaveClient;
}

/**
 * Process a user message through the agent and return the reply.
 * Uses per-wave sessions for conversation memory.
 */
export async function processMessage({
  waveId,
  userMessage,
  author,
  waveClient,
}: ProcessMessageOptions): Promise<string> {
  const a = getAgent(waveClient);
  const session = getSession(waveId);

  const input = `[${author}]: ${userMessage}`;

  const result = await run(a, input, {
    session,
    maxTurns: 10,
    context: { waveId },
  });

  return result.finalOutput ?? 'I had trouble generating a response. Please try again.';
}
