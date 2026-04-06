/**
 * Custom tool: read wave content via SupaWave Data API.
 *
 * Lets the agent inspect the full conversation in the current wave,
 * including blips it hasn't seen via the event bundle.
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import type { WaveClient } from '../wave-client.js';

/**
 * Create a read_wave tool bound to a specific WaveClient instance.
 */
export function createWaveReadTool(waveClient: WaveClient) {
  return tool({
    name: 'read_wave',
    description:
      'Read the full content of a SupaWave wave conversation. ' +
      'Returns all blips (messages) with their authors and content. ' +
      'Use this when you need to review earlier parts of the conversation.',
    parameters: z.object({
      waveId: z.string().describe('The wave ID to read, e.g. "supawave.ai!w+abc123"'),
    }),
    async execute({ waveId }) {
      const wave = await waveClient.fetchWave(waveId);

      const blips = Object.values(wave.blips).map((b) => ({
        blipId: b.blipId,
        author: b.contributors?.[0] ?? 'unknown',
        content: b.content.replace(/^\n/, '').trim(),
      }));

      return JSON.stringify(
        {
          title: wave.waveletData.title,
          participants: wave.waveletData.participants,
          blips,
        },
        null,
        2,
      );
    },
  });
}
