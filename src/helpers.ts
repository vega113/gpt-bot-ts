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
  rpcServerUrl: string;
}

// ── pure helpers ─────────────────────────────────────────────

/** Check if a blip mentions the bot by @-mention. */
export function mentionsBot(content: string, robotAddress: string): boolean {
  const name = robotAddress.split('@')[0];
  return content.includes(`@${name}`) || content.includes(robotAddress);
}

/** Validate that the request body looks like an EventMessageBundle. */
export function isValidBundle(body: unknown): body is EventMessageBundle {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b['events'])) return false;
  if (b['blips'] == null || typeof b['blips'] !== 'object') return false;
  if (b['threads'] == null || typeof b['threads'] !== 'object') return false;

  const wavelet = b['wavelet'];
  if (wavelet == null || typeof wavelet !== 'object') return false;
  const w = wavelet as Record<string, unknown>;
  return (
    typeof w['waveId'] === 'string' &&
    typeof w['waveletId'] === 'string' &&
    typeof w['rootBlipId'] === 'string' &&
    Array.isArray(w['participants'])
  );
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
