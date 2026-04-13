/**
 * Per-wave conversation context management.
 *
 * Each waveId gets its own OpenAIResponsesCompactionSession backed
 * by a MemorySession.  This gives us:
 *   - Automatic conversation history per wave
 *   - Auto-compaction when the history grows large
 */

import {
  MemorySession,
  OpenAIResponsesCompactionSession,
} from '@openai/agents';
import type { Session } from '@openai/agents';
import type { ReplyPreferenceState } from './reply-preferences.js';
import { normalizeItemsForConversationMemory } from './session-transcript.js';

const sessions = new Map<string, Session>();
const replyPreferences = new Map<string, ReplyPreferenceState>();

/** Compaction triggers when history exceeds this many items. */
const COMPACTION_THRESHOLD = 20;

type CompactionAwareSession = Session & {
  runCompaction?: (...args: any[]) => Promise<unknown> | unknown;
};

class WaveConversationSession implements Session {
  constructor(private readonly delegate: CompactionAwareSession) {}

  async getSessionId(): Promise<string> {
    return this.delegate.getSessionId();
  }

  async getItems(limit?: number) {
    const items = await this.delegate.getItems(limit);
    return normalizeItemsForConversationMemory(items);
  }

  async addItems(items: Parameters<Session['addItems']>[0]): Promise<void> {
    await this.delegate.addItems(normalizeItemsForConversationMemory(items));
  }

  async popItem() {
    while (true) {
      const item = await this.delegate.popItem();
      if (!item) return item;

      const normalizedItem = normalizeItemsForConversationMemory([item])[0];
      if (normalizedItem) {
        return normalizedItem;
      }
    }
  }

  async clearSession(): Promise<void> {
    await this.delegate.clearSession();
  }

  async runCompaction(args?: unknown): Promise<unknown> {
    if (typeof this.delegate.runCompaction !== 'function') return null;
    return this.delegate.runCompaction(args);
  }
}

/**
 * Get or create a session for the given waveId.
 * Sessions are kept in-memory for the lifetime of the process.
 */
export function getSession(waveId: string): Session {
  let session = sessions.get(waveId);
  if (session) return session;

  session = new WaveConversationSession(
    new OpenAIResponsesCompactionSession({
      underlyingSession: new MemorySession(),
      shouldTriggerCompaction: ({ compactionCandidateItems }) =>
        compactionCandidateItems.length >= COMPACTION_THRESHOLD,
    }),
  );

  sessions.set(waveId, session);
  return session;
}

/** Remove a session (e.g. when bot is removed from wave). */
export function clearSession(waveId: string): void {
  sessions.delete(waveId);
  replyPreferences.delete(waveId);
}

/** Number of active sessions (for diagnostics). */
export function sessionCount(): number {
  return sessions.size;
}

export function getReplyPreference(waveId: string): ReplyPreferenceState {
  return replyPreferences.get(waveId) ?? { mode: 'normal' };
}

export function setReplyPreference(waveId: string, replyPreference: ReplyPreferenceState): void {
  replyPreferences.set(waveId, replyPreference);
}
