/**
 * Custom tool: generate an image using OpenAI's image generation API
 * and upload it to the current wave as an attachment.
 *
 * The tool returns the attachmentId so the calling code can insert
 * the image into a blip via document.modify after the reply is posted.
 */

import { tool } from '@openai/agents';
import type { RunContext } from '@openai/agents';
import { z } from 'zod';
import OpenAI from 'openai';
import type { WaveClient } from '../wave-client.js';
import type { WaveContext } from '../agent.js';

const ROBOT_ADDRESS = process.env['ROBOT_ADDRESS'] ?? 'gpt-ts-bot@supawave.ai';

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

/**
 * Create a generate_image tool bound to a specific WaveClient instance.
 * The waveId comes from RunContext, not from the model.
 */
export function createImageGenTool(waveClient: WaveClient) {
  return tool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using AI and insert it into the current wave. ' +
      'Use this when a user asks you to create, generate, draw, or visualize an image. ' +
      'The image will appear in the wave as an inline attachment. ' +
      'Returns a confirmation message with the attachment ID.',
    parameters: z.object({
      prompt: z.string().describe('Detailed description of the image to generate'),
      size: z
        .enum(['1024x1024', '1536x1024', '1024x1536'])
        .optional()
        .describe('Image dimensions. Default: 1024x1024. Use 1536x1024 for landscape, 1024x1536 for portrait'),
      caption: z
        .string()
        .optional()
        .describe('Short caption for the image (shown below it in Wave). Defaults to a shortened version of the prompt'),
    }),
    async execute(
      args: { prompt: string; size?: '1024x1024' | '1536x1024' | '1024x1536'; caption?: string },
      runContext?: RunContext<WaveContext>,
    ) {
      const waveId = runContext?.context.waveId;
      if (!waveId) {
        return 'Error: no wave context available.';
      }

      const waveletId = waveId.replace(/!w\+.*$/, '!conv+root');

      try {
        // 1. Generate image via OpenAI
        console.log(`[image-gen] Generating image: "${args.prompt.slice(0, 80)}..."`);
        const openai = getOpenAI();
        const result = await openai.images.generate({
          model: 'gpt-image-1',
          prompt: args.prompt,
          size: args.size ?? '1024x1024',
          quality: 'medium',
          n: 1,
        });

        const base64Data = result.data?.[0]?.b64_json;
        if (!base64Data) {
          return 'Error: image generation returned no data.';
        }

        // 2. Upload as attachment to the wavelet
        const attachmentId = `att+img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const fileName = `generated_${Date.now()}.png`;

        await waveClient.importAttachment(
          waveId,
          waveletId,
          attachmentId,
          fileName,
          ROBOT_ADDRESS,
          base64Data,
        );

        console.log(`[image-gen] Uploaded attachment ${attachmentId} to wave=${waveId}`);

        // 3. Track the pending image in context so the reply code can insert it
        const caption = args.caption ?? args.prompt.slice(0, 100);
        if (runContext?.context) {
          const ctx = runContext.context as WaveContext;
          if (!ctx.pendingImages) ctx.pendingImages = [];
          ctx.pendingImages.push({ attachmentId, caption });
        }

        return `Image generated and uploaded as attachment ${attachmentId}. Caption: "${caption}". The image will be inserted into the reply blip.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[image-gen] Error:`, message);
        return `Error generating image: ${message}`;
      }
    },
  });
}
