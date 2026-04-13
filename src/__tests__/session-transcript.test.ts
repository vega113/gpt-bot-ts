import { describe, expect, it } from 'vitest';
import { normalizeItemsForConversationMemory } from '../session-transcript.js';

describe('normalizeItemsForConversationMemory', () => {
  it('replaces assistant decision JSON with the sanitized visible reply text', () => {
    const items = [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: '{"shouldReply":true,"response":"Here is the chart summary【turn0search0】 from (example.com)."}',
          },
        ],
      },
    ];

    expect(normalizeItemsForConversationMemory(items)).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'Here is the chart summary from ([example.com](https://example.com)).',
          },
        ],
      },
    ]);
  });

  it('drops assistant decisions that choose not to reply', () => {
    const items = [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: '{"shouldReply":false,"response":null}',
          },
        ],
      },
    ];

    expect(normalizeItemsForConversationMemory(items)).toEqual([]);
  });

  it('leaves non-decision items untouched', () => {
    const items = [
      {
        type: 'message',
        role: 'user',
        content: '[Yuri]: tell me more about that',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'Plain assistant text',
          },
        ],
      },
    ];

    expect(normalizeItemsForConversationMemory(items)).toEqual(items);
  });
});
