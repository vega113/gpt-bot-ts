/**
 * Pure helper functions for the Wave robot request handler.
 * Extracted here for testability (no module-level side effects).
 */

// ── types ────────────────────────────────────────────────────

export interface Annotation {
  name: string;
  value?: string | null;
  range: { start: number; end: number };
}

export interface WaveEvent {
  type: string;
  modifiedBy: string;
  timestamp: number;
  properties: Record<string, unknown>;
}

export interface BlipData {
  blipId: string;
  content: string;
  contributors?: string[];
  lastModifiedTime?: number;
  annotations?: Annotation[];
}

export interface EventMessageBundle {
  events: WaveEvent[];
  wavelet: {
    waveId: string;
    waveletId: string;
    rootBlipId: string;
    title: string;
    participants: string[];
  };
  blips: Record<string, BlipData>;
  threads: Record<string, { id: string; blipIds: string[] }>;
  robotAddress: string;
  rpcServerUrl?: string;
}

// ── pure helpers ─────────────────────────────────────────────

/** Check if a blip mentions the bot by @-mention (boundary-aware). */
export function mentionsBot(content: string, robotAddress: string): boolean {
  const name = robotAddress.split('@')[0];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionRx = new RegExp(`(^|\\s)@${esc(name)}(?=\\s|$|[.,!?;:])`);
  const addressRx = new RegExp(`(^|\\s)${esc(robotAddress)}(?=\\s|$|[.,!?;:])`);
  return mentionRx.test(content) || addressRx.test(content);
}

/** Validate that the request body looks like an EventMessageBundle. */
export function isValidBundle(body: unknown): body is EventMessageBundle {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b['events'])) return false;
  if (b['blips'] == null || typeof b['blips'] !== 'object') return false;
  // `threads` is optional — absent is treated as {} (consistent with isBlipInThread's nullish coalesce)
  if (b['threads'] != null && typeof b['threads'] !== 'object') return false;
  if (typeof b['robotAddress'] !== 'string') return false;
  if (b['rpcServerUrl'] != null && typeof b['rpcServerUrl'] !== 'string') return false;

  const wavelet = b['wavelet'];
  if (wavelet == null || typeof wavelet !== 'object') return false;
  const w = wavelet as Record<string, unknown>;
  if (
    typeof w['waveId'] !== 'string' ||
    typeof w['waveletId'] !== 'string' ||
    typeof w['rootBlipId'] !== 'string' ||
    typeof w['title'] !== 'string' ||
    !Array.isArray(w['participants']) ||
    !(w['participants'] as unknown[]).every((p) => typeof p === 'string')
  ) return false;

  // Validate each thread entry matches { id: string; blipIds: string[] } when present
  const threads = (b['threads'] ?? {}) as Record<string, unknown>;
  return Object.values(threads).every((t) => {
    if (!t || typeof t !== 'object') return false;
    const thread = t as Record<string, unknown>;
    return (
      typeof thread['id'] === 'string' &&
      Array.isArray(thread['blipIds']) &&
      (thread['blipIds'] as unknown[]).every((id) => typeof id === 'string')
    );
  });
}

/**
 * Check if a blip is currently being edited.
 *
 * user/d/{sessionId} annotations are PERMANENT — they stay on the blip
 * forever after editing. The signal is in the VALUE format:
 *   "userId,startTimeMs,"          → still editing (empty end timestamp)
 *   "userId,startTimeMs,endTimeMs" → editing done
 */
export function isBeingEdited(blip: BlipData): boolean {
  if (!blip.annotations) return false;
  return blip.annotations.some((a) => {
    if (!a.name.startsWith('user/d/')) return false;
    if (a.value == null || a.value === '') return false;
    const parts = a.value.split(',');
    return parts.length < 3 || parts[2] === '';
  });
}

/** Check if a blip is inside a reply thread (not the root thread). */
export function isBlipInThread(blipId: string, bundle: EventMessageBundle): boolean {
  const threads = bundle.threads ?? {};
  const rootBlipId = bundle.wavelet.rootBlipId;

  for (const thread of Object.values(threads)) {
    if (!thread?.blipIds?.includes(blipId)) continue;
    // Skip the root thread — blips there are top-level, not in a reply thread.
    if (thread.blipIds.includes(rootBlipId)) continue;
    return true;
  }
  return false;
}

/**
 * Find the content of the parent blip that a threaded blip is replying to.
 *
 * In Wave, inline blips are created when a user selects text in a parent blip
 * and creates a reply. The thread ID typically equals the parent blip's ID.
 * If not, we fall back to the most recently modified blip from the root thread.
 *
 * Returns the parent blip's trimmed content, or null if no parent found.
 */
export function findParentBlipContext(blipId: string, bundle: EventMessageBundle): string | null {
  const threads = bundle.threads ?? {};
  const rootBlipId = bundle.wavelet.rootBlipId;

  // Find which non-root thread this blip belongs to (mirrors isBlipInThread logic).
  // Use thread.id (not the map key) — the Wave data model only guarantees that
  // thread.id and blipIds are present; it does not require the map key to equal
  // thread.id.
  let threadId: string | null = null;
  for (const thread of Object.values(threads)) {
    if (!thread?.blipIds?.includes(blipId)) continue;
    // Skip the root thread — same guard as isBlipInThread
    if (thread.blipIds.includes(rootBlipId)) continue;
    threadId = thread.id;
    break;
  }

  if (!threadId) return null;

  // Strategy 1: thread.id matches a blip ID (most common in Wave inline threads)
  const parentByThreadId = bundle.blips[threadId];
  if (parentByThreadId) {
    const text = parentByThreadId.content.replace(/^\n/, '').trim();
    return text || null;
  }

  // Strategy 2: most recently modified blip from the root thread.
  // Restricting to the root thread avoids picking up unrelated content from
  // sibling inline threads that happen to be more recently modified.
  const rootThread = Object.values(threads).find((t) => t?.blipIds?.includes(rootBlipId));
  const rootThreadBlipIds = new Set(rootThread?.blipIds ?? [rootBlipId]);

  const candidates = Object.values(bundle.blips)
    .filter((b) => rootThreadBlipIds.has(b.blipId) && b.blipId !== blipId)
    .sort((a, b) => (b.lastModifiedTime ?? 0) - (a.lastModifiedTime ?? 0));

  const mostRecent = candidates[0];
  if (mostRecent) {
    const text = mostRecent.content.replace(/^\n/, '').trim();
    return text || null;
  }

  return null;
}
