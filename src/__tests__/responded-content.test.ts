import { describe, expect, it } from 'vitest';
import { clearRespondedContentIfCurrent } from '../responded-content.js';

describe('clearRespondedContentIfCurrent', () => {
  it('removes the entry when it still matches the failing run content', () => {
    const respondedContent = new Map([['b+1', 'first version']]);

    expect(clearRespondedContentIfCurrent(respondedContent, 'b+1', 'first version')).toBe(true);
    expect(respondedContent.has('b+1')).toBe(false);
  });

  it('keeps newer content when an older run tries to clear the entry', () => {
    const respondedContent = new Map([['b+1', 'newer version']]);

    expect(clearRespondedContentIfCurrent(respondedContent, 'b+1', 'older version')).toBe(false);
    expect(respondedContent.get('b+1')).toBe('newer version');
  });

  it('returns false and leaves the map unchanged when the blip is missing', () => {
    const respondedContent = new Map<string, string>();

    expect(clearRespondedContentIfCurrent(respondedContent, 'missing', 'any content')).toBe(false);
    expect(respondedContent.size).toBe(0);
  });
});
