import { markdownToWave, type WaveAnnotation } from './markdown-to-wave.js';
import type { WaveClient } from './wave-client.js';

const SAFE_LINK_RE = /^https?:\/\/|^mailto:/i;

export interface PostedReply {
  blipId?: string;
  content: string;
}

export interface ReplyDelivery {
  postReply(markdown: string): Promise<PostedReply>;
  postPlaceholder(markdown: string): Promise<PostedReply>;
  deletePlaceholder(posted: PostedReply): Promise<void>;
  completePlaceholder(posted: PostedReply, markdown: string): Promise<PostedReply>;
  failPlaceholder(posted: PostedReply, markdown: string): Promise<PostedReply>;
}

export interface ReplyDeliveryTarget {
  waveId: string;
  waveletId: string;
  parentBlipId: string;
  isInThread: boolean;
}

function filterSafeAnnotations(annotations: WaveAnnotation[]): WaveAnnotation[] {
  return annotations.filter((a) => a.name !== 'link/manual' || SAFE_LINK_RE.test(a.value));
}

function renderMarkdown(markdown: string): { content: string; annotations: WaveAnnotation[] } {
  const { content, annotations } = markdownToWave(markdown);
  return { content, annotations: filterSafeAnnotations(annotations) };
}

export function createReplyDelivery(
  waveClient: WaveClient,
  target: ReplyDeliveryTarget,
): ReplyDelivery {
  async function post(markdown: string): Promise<PostedReply> {
    const rendered = renderMarkdown(markdown);
    const blipId = target.isInThread
      ? await waveClient.continueThread(
          target.waveId,
          target.parentBlipId,
          rendered.content,
          target.waveletId,
          rendered.annotations,
        )
      : await waveClient.replyToBlip(
          target.waveId,
          target.parentBlipId,
          rendered.content,
          target.waveletId,
          rendered.annotations,
        );
    return { blipId, content: rendered.content };
  }

  async function deletePosted(posted: PostedReply): Promise<void> {
    if (!posted.blipId) return;
    await waveClient.deleteBlip(target.waveId, target.waveletId, posted.blipId);
  }

  return {
    postReply: post,
    postPlaceholder: post,
    deletePlaceholder: deletePosted,
    async completePlaceholder(posted: PostedReply, markdown: string): Promise<PostedReply> {
      try {
        await deletePosted(posted);
      } catch (err) {
        console.warn('[reply-delivery] failed to delete placeholder before final reply', err);
      }
      return await post(markdown);
    },
    async failPlaceholder(posted: PostedReply, markdown: string): Promise<PostedReply> {
      try {
        await deletePosted(posted);
      } catch (err) {
        console.warn('[reply-delivery] failed to delete placeholder before error reply', err);
      }
      return await post(markdown);
    },
  };
}
