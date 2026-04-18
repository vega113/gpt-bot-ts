import type { AgentInputItem } from '@openai/agents';
import { BOT_REPLY_DECISION_KIND } from './bot-decision.js';
import { normalizeVisibleReplyText } from './sanitize-response.js';

type AssistantDecision = {
  kind?: string;
  shouldReply?: boolean;
  response?: string | null;
};

type NormalizedDecision =
  | { action: 'keep' }
  | { action: 'drop' }
  | { action: 'rewrite'; response: string };

function normalizeAssistantDecisionItem(item: AgentInputItem): NormalizedDecision {
  if (typeof item !== 'object' || item === null) return { action: 'keep' };
  if (!('role' in item) || item.role !== 'assistant') return { action: 'keep' };
  if (!('content' in item) || !Array.isArray(item.content) || item.content.length !== 1) {
    return { action: 'keep' };
  }

  const [part] = item.content;
  if (typeof part !== 'object' || part === null) return { action: 'keep' };
  if (!('type' in part) || part.type !== 'output_text') return { action: 'keep' };
  if (!('text' in part) || typeof part.text !== 'string') return { action: 'keep' };

  const text = part.text.trim();
  if (!text.startsWith('{')) return { action: 'keep' };

  try {
    const decision = JSON.parse(text) as AssistantDecision;
    if (decision.kind !== BOT_REPLY_DECISION_KIND) {
      return { action: 'keep' };
    }

    if (decision.shouldReply === false) {
      return { action: 'drop' };
    }

    if (decision.shouldReply === true) {
      return {
        action: 'rewrite',
        response: normalizeVisibleReplyText(decision.response),
      };
    }

    return { action: 'keep' };
  } catch {
    return { action: 'keep' };
  }
}

export function normalizeItemsForConversationMemory(items: AgentInputItem[]): AgentInputItem[] {
  let normalizedItems: AgentInputItem[] | null = null;

  items.forEach((item, index) => {
    const normalizedDecision = normalizeAssistantDecisionItem(item);

    if (normalizedDecision.action === 'drop') {
      if (!normalizedItems) {
        normalizedItems = items.slice(0, index);
      }
      return;
    }

    if (normalizedDecision.action === 'keep') {
      if (normalizedItems) {
        normalizedItems.push(item);
      }
      return;
    }

    if (!normalizedItems) {
      normalizedItems = items.slice(0, index);
    }

    normalizedItems.push({
      ...item,
      content: [{
        type: 'output_text',
        text: normalizedDecision.response,
      }],
    } as AgentInputItem);
  });

  return normalizedItems ?? items;
}
