/**
 * Custom tool: generate an image using OpenAI's image generation API.
 *
 * The generated image (base64) is queued in RunContext.pendingImages.
 * The actual upload (importAttachment) and insertion (document.modify)
 * are deferred to index.ts — they run only after the reply blip is
 * successfully created, avoiding orphaned attachments on failure.
 */

import { tool } from '@openai/agents';
import type { RunContext } from '@openai/agents';
import { z } from 'zod';
import OpenAI from 'openai';
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
 * Create a generate_image tool.
 * The wave/wavelet context comes from RunContext, not from the model.
 */
export function createImageGenTool() {
  return tool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using AI. ' +
      'Use this when a user asks you to create, generate, draw, or visualize an image. ' +
      'The image will be automatically inserted into the reply blip after it is posted. ' +
      'Returns a confirmation message.',
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
      if (!runContext?.context) {
        return 'Error: no wave context available.';
      }

      try {
        // 1. Generate image via OpenAI
        console.log(`[image-gen] Generating image (promptLength=${args.prompt.length})`);
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

        // 2. Track the pending image in context — the actual upload
        //    (importAttachment + insertImage) is deferred until after the
        //    reply blip is successfully created by index.ts.  This avoids
        //    orphaned attachments if the reply fails.
        const attachmentId = `att+img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const fileName = `generated_${Date.now()}.png`;
        const caption = args.caption ?? args.prompt.slice(0, 100);

        if (runContext?.context) {
          const ctx = runContext.context as WaveContext;
          if (!ctx.pendingImages) ctx.pendingImages = [];
          ctx.pendingImages.push({ attachmentId, fileName, caption, base64Data });
        }

        console.log(`[image-gen] Image generated, deferred upload as ${attachmentId}`);
        return `Image generated successfully. Caption: "${caption}". The image will be inserted into the reply blip.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[image-gen] Error:`, message);
        return `Error generating image: ${message}`;
      }
    },
  });
}
