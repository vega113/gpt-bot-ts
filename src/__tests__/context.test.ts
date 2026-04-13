import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BOT_REPLY_DECISION_KIND } from '../bot-decision.js';

// Mock @openai/agents before importing context.ts
vi.mock('@openai/agents', () => ({
  MemorySession: class MemorySession {
    private readonly items: unknown[] = [];

    constructor() {}

    async getSessionId() {
      return 'memory-session';
    }

    async getItems(limit?: number) {
      if (typeof limit === 'number') {
        return this.items.slice(-limit);
      }

      return [...this.items];
    }

    async addItems(items: unknown[]) {
      this.items.push(...items);
    }

    async popItem() {
      return this.items.pop();
    }

    async clearSession() {
      this.items.length = 0;
    }
  },
  OpenAIResponsesCompactionSession: class OpenAIResponsesCompactionSession {
    constructor(private readonly opts: { underlyingSession: InstanceType<typeof MemorySession> }) {}

    async getSessionId() {
      return this.opts.underlyingSession.getSessionId();
    }

    async getItems(limit?: number) {
      return this.opts.underlyingSession.getItems(limit);
    }

    async addItems(items: unknown[]) {
      await this.opts.underlyingSession.addItems(items);
    }

    async popItem() {
      return this.opts.underlyingSession.popItem();
    }

    async clearSession() {
      await this.opts.underlyingSession.clearSession();
    }
  },
}));

import { getSession, clearSession, sessionCount, getReplyPreference, setReplyPreference } from '../context.js';

describe('context', () => {
  beforeEach(() => {
    // Clear all sessions between tests
    // We do this by clearing each known session
    clearSession('wave-a');
    clearSession('wave-b');
    clearSession('wave-c');
  });

  describe('getSession', () => {
    it('returns a session object for a waveId', () => {
      const session = getSession('wave-a');
      expect(session).toBeDefined();
    });

    it('returns the same session for the same waveId', () => {
      const s1 = getSession('wave-a');
      const s2 = getSession('wave-a');
      expect(s1).toBe(s2);
    });

    it('returns different sessions for different waveIds', () => {
      const s1 = getSession('wave-a');
      const s2 = getSession('wave-b');
      expect(s1).not.toBe(s2);
    });

    it('popItem skips dropped decision envelopes until it finds a visible item', async () => {
      const session = getSession('wave-a') as any;

      await session.delegate.addItems([
        {
          type: 'message',
          role: 'user',
          content: '[alice]: earlier visible context',
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: `{"kind":"${BOT_REPLY_DECISION_KIND}","shouldReply":false,"response":null}`,
            },
          ],
        },
      ]);

      await expect(session.popItem()).resolves.toEqual({
        type: 'message',
        role: 'user',
        content: '[alice]: earlier visible context',
      });
      await expect(session.popItem()).resolves.toBeUndefined();
    });

    it('matches the SDK single-argument runCompaction signature in source', async () => {
      const source = await readFile(new URL('../context.ts', import.meta.url), 'utf8');

      expect(source).toContain('OpenAIResponsesCompactionArgs');
      expect(source).toContain('OpenAIResponsesCompactionAwareSession');
      expect(source).toContain("Partial<Pick<OpenAIResponsesCompactionAwareSession, 'runCompaction'>>");
      expect(source).toContain('async runCompaction(args?: OpenAIResponsesCompactionArgs)');
      expect(source).not.toContain('runCompaction?: (...args: any[]) => Promise<unknown> | unknown;');
    });
  });

  describe('clearSession', () => {
    it('removes the session so a new one is created on next getSession', () => {
      const s1 = getSession('wave-a');
      clearSession('wave-a');
      const s2 = getSession('wave-a');
      expect(s1).not.toBe(s2);
    });

    it('is a no-op for a non-existent waveId', () => {
      expect(() => clearSession('nonexistent')).not.toThrow();
    });
  });

  describe('sessionCount', () => {
    it('starts at 0 after clearing known sessions', () => {
      // All sessions cleared in beforeEach
      expect(sessionCount()).toBe(0);
    });

    it('increments when new sessions are created', () => {
      getSession('wave-a');
      getSession('wave-b');
      expect(sessionCount()).toBe(2);
    });

    it('decrements when a session is cleared', () => {
      getSession('wave-a');
      getSession('wave-b');
      clearSession('wave-a');
      expect(sessionCount()).toBe(1);
    });
  });

  describe('reply preferences', () => {
    it('defaults to normal when no preference is stored', () => {
      expect(getReplyPreference('wave-a')).toEqual({ mode: 'normal' });
    });

    it('stores and retrieves a wave-level reply preference', () => {
      setReplyPreference('wave-a', { mode: 'only_when_mentioned', updatedBy: 'alice', updatedAt: 123 });
      expect(getReplyPreference('wave-a')).toEqual({
        mode: 'only_when_mentioned',
        updatedBy: 'alice',
        updatedAt: 123,
      });
    });

    it('clears the reply preference with the session', () => {
      setReplyPreference('wave-a', { mode: 'only_when_mentioned' });
      clearSession('wave-a');
      expect(getReplyPreference('wave-a')).toEqual({ mode: 'normal' });
    });
  });
});
