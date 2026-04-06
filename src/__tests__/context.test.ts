import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @openai/agents before importing context.ts
vi.mock('@openai/agents', () => ({
  MemorySession: class MemorySession {
    constructor() {}
  },
  OpenAIResponsesCompactionSession: class OpenAIResponsesCompactionSession {
    constructor(_opts: unknown) {}
  },
}));

import { getSession, clearSession, sessionCount } from '../context.js';

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
});
