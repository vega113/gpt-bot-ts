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

const sessions = new Map<string, Session>();

/** Compaction triggers when history exceeds this many items. */
const COMPACTION_THRESHOLD = 20;

/**
 * Get or create a session for the given waveId.
 * Sessions are kept in-memory for the lifetime of the process.
 */
export function getSession(waveId: string): Session {
  let session = sessions.get(waveId);
  if (session) return session;

  session = new OpenAIResponsesCompactionSession({
    underlyingSession: new MemorySession(),
    shouldTriggerCompaction: ({ compactionCandidateItems }) =>
      compactionCandidateItems.length >= COMPACTION_THRESHOLD,
  });

  sessions.set(waveId, session);
  return session;
}

/** Remove a session (e.g. when bot is removed from wave). */
export function clearSession(waveId: string): void {
  sessions.delete(waveId);
}

/** Number of active sessions (for diagnostics). */
export function sessionCount(): number {
  return sessions.size;
}
