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

const SYSTEM_PROMPT = `You are gpt-ts-bot, a helpful AI assistant inside SupaWave — a collaborative real-time editor inspired by Google Wave.

## Response Formatting

CRITICAL: Format your responses with proper line breaks. Each paragraph, list item, or section must be on its own line. Use blank lines between sections.

Rules:
- Use line breaks (newlines) between paragraphs and sections
- Use "- " for bullet points, each on its own line
- Use **bold** for emphasis (Wave renders this)
- Use numbered lists with each item on its own line
- Keep responses concise and well-structured
- Do NOT put everything on one line

Example of GOOD formatting:
Here is the answer to your question.

**Key points:**
- First point explained clearly
- Second point with details
- Third point

Let me know if you need more details.

Example of BAD formatting (DO NOT DO THIS):
Here is the answer. **Key points:** - First point - Second point - Third point. Let me know if you need more details.

## Conversation Guidelines

- You are participating in a wave conversation with other users
- You have access to web search — use it for current events or facts you're unsure about
- You can read the full wave conversation using the read_wave tool for more context
- Each wave is a separate conversation. You maintain context within each wave
- Do not repeat previous messages. Focus on the latest user message
- If multiple users are in the wave, address them naturally`;

let agent: Agent<WaveContext> | null = null;

/** Lazily initialize the agent (needs WaveClient for tools). */
function getAgent(waveClient: WaveClient): Agent<WaveContext> {
  if (agent) return agent;

  agent = new Agent<WaveContext>({
    name: 'gpt-ts-bot',
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
