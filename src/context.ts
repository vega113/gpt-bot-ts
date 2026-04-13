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
import type {
  OpenAIResponsesCompactionArgs,
  OpenAIResponsesCompactionAwareSession,
  Session,
} from '@openai/agents';
import type { ReplyPreferenceState } from './reply-preferences.js';
import { normalizeItemsForConversationMemory } from './session-transcript.js';

const sessions = new Map<string, Session>();
const replyPreferences = new Map<string, ReplyPreferenceState>();

/** Compaction triggers when history exceeds this many items. */
const COMPACTION_THRESHOLD = 20;

type CompactionAwareSession = Session & Partial<Pick<OpenAIResponsesCompactionAwareSession, 'runCompaction'>>;

class WaveConversationSession implements Session {
  constructor(private readonly delegate: CompactionAwareSession) {}

  async getSessionId(): Promise<string> {
    return this.delegate.getSessionId();
  }

  async getItems(limit?: number) {
    if (limit === undefined) {
      const items = await this.delegate.getItems();
      return normalizeItemsForConversationMemory(items);
    }

    if (limit <= 0) {
      return [];
    }

    let rawLimit = limit;
    while (true) {
      const items = await this.delegate.getItems(rawLimit);
      const normalizedItems = normalizeItemsForConversationMemory(items);

      if (normalizedItems.length >= limit || items.length < rawLimit) {
        return normalizedItems.slice(-limit);
      }

      rawLimit *= 2;
    }
  }

  async addItems(items: Parameters<Session['addItems']>[0]): Promise<void> {
    const normalized = normalizeItemsForConversationMemory(items);
    await this.delegate.addItems(normalized === items ? items : normalized);
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

  async runCompaction(args?: OpenAIResponsesCompactionArgs): Promise<unknown> {
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
