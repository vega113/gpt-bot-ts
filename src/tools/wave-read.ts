/**
 * Custom tool: read the current wave's content via SupaWave Data API.
 *
 * The tool is scoped to the current wave via RunContext — the model
 * cannot specify an arbitrary waveId, preventing cross-wave exfil.
 */

import { tool } from '@openai/agents';
import type { RunContext } from '@openai/agents';
import { z } from 'zod';
import type { WaveClient } from '../wave-client.js';
import type { WaveContext } from '../agent.js';

/**
 * Create a read_wave tool bound to a specific WaveClient instance.
 * The waveId comes from RunContext, not from the model.
 */
export function createWaveReadTool(waveClient: WaveClient) {
  return tool({
    name: 'read_wave',
    description:
      'Read the full content of the current wave conversation. ' +
      'Returns all blips (messages) with their authors and content. ' +
      'Use this when you need to review earlier parts of the conversation.',
    parameters: z.object({}),
    async execute(_args, runContext?: RunContext<WaveContext>) {
      const waveId = runContext?.context.waveId;
      if (!waveId) {
        return 'Error: no wave context available.';
      }

      const wave = await waveClient.fetchWave(waveId);

      const rootBlipId = wave.waveletData.rootBlipId;
      const threads = (wave.threads ?? {}) as Record<string, { id: string; blipIds: string[] }>;

      // Sort blips by lastModifiedTime for chronological order
      const blips = Object.values(wave.blips)
        .sort((a, b) => (a.lastModifiedTime ?? 0) - (b.lastModifiedTime ?? 0))
        .map((b) => {
          // Determine if this blip is in an inline (non-root) thread
          let parentBlipId: string | undefined;
          for (const [tid, thread] of Object.entries(threads)) {
            if (!thread?.blipIds?.includes(b.blipId)) continue;
            if (thread.blipIds.includes(rootBlipId)) continue; // skip root thread
            // thread ID often equals parent blip ID
            if (wave.blips[tid]) parentBlipId = tid;
            break;
          }
          return {
            blipId: b.blipId,
            author: b.contributors?.[0] ?? 'unknown',
            content: b.content.replace(/^\n/, '').trim(),
            ...(parentBlipId ? { inlineReplyTo: parentBlipId } : {}),
          };
        });

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
