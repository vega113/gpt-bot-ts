/**
 * gpt-bot-ts — SupaWave Wave robot server.
 *
 * Endpoints:
 *   GET  /_wave/capabilities.xml   – Declare subscribed events
 *   GET  /_wave/robot/profile      – Bot profile
 *   POST /_wave/robot/jsonrpc      – Receive event bundles
 *   GET  /health                   – Health check
 *
 * Editing detection:
 *   BLIP_SUBMITTED is deprecated. Instead we subscribe to DOCUMENT_CHANGED
 *   and check for the absence of `user/d/{sessionId}` annotations which
 *   indicate active editing. When no user/d/ annotations remain on a blip
 *   the user has finished editing and we can respond.
 */

import express from 'express';
import { WaveClient } from './wave-client.js';
import { processMessage } from './agent.js';
import { clearSession, sessionCount } from './context.js';

// ── config ───────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8089', 10);
const SUPAWAVE_TOKEN = process.env['SUPAWAVE_TOKEN'] ?? '';
const ROBOT_ADDRESS = process.env['ROBOT_ADDRESS'] ?? 'gpt-ts-bot@supawave.ai';

if (!SUPAWAVE_TOKEN) {
  console.error('SUPAWAVE_TOKEN environment variable is required');
  process.exit(1);
}

if (!process.env['OPENAI_API_KEY']) {
  console.error('OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

const waveClient = new WaveClient(SUPAWAVE_TOKEN);

// ── types ────────────────────────────────────────────────────

interface Annotation {
  name: string;
  value: string;
  range: { start: number; end: number };
}

interface WaveEvent {
  type: string;
  modifiedBy: string;
  timestamp: number;
  properties: Record<string, unknown>;
}

interface BlipData {
  blipId: string;
  content: string;
  contributors?: string[];
  lastModifiedTime?: number;
  annotations?: Annotation[];
}

interface EventMessageBundle {
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

// ── capabilities ─────────────────────────────────────────────

const CAPABILITIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:robot xmlns:w="http://wave.google.com/extensions/robots/1.0">
  <w:version>3</w:version>
  <w:protocolversion>0.22</w:protocolversion>
  <w:capabilities>
    <w:capability name="DOCUMENT_CHANGED" context="SELF"/>
    <w:capability name="ANNOTATED_TEXT_CHANGED" context="SELF"/>
    <w:capability name="WAVELET_SELF_ADDED" context="SELF"/>
    <w:capability name="WAVELET_SELF_REMOVED" context="SELF"/>
  </w:capabilities>
</w:robot>
`;

const CAPABILITIES_HASH = 'sha256:gpt-bot-ts-v3';

// ── in-flight tracking ───────────────────────────────────────

/** Count of active background reply jobs for graceful shutdown. */
let activeJobs = 0;
let shutdownRequested = false;

// ── deduplication ────────────────────────────────────────────

/** Track content we've already responded to, keyed by blipId. */
const respondedContent = new Map<string, string>();

// ── helpers ──────────────────────────────────────────────────

/** Check if a blip mentions the bot by @-mention. */
function mentionsBot(content: string): boolean {
  const name = ROBOT_ADDRESS.split('@')[0];
  return content.includes(`@${name}`) || content.includes(ROBOT_ADDRESS);
}

/** Validate that the request body looks like an EventMessageBundle. */
function isValidBundle(body: unknown): body is EventMessageBundle {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    Array.isArray(b['events']) &&
    b['wavelet'] != null &&
    typeof b['wavelet'] === 'object' &&
    typeof (b['wavelet'] as Record<string, unknown>)['waveId'] === 'string'
  );
}

/**
 * Check if a blip is currently being edited.
 *
 * user/d/{sessionId} annotations are PERMANENT — they stay on the blip
 * forever after editing. The signal is in the VALUE format:
 *
 *   "userId,startTimeMs,"          → still editing (empty end timestamp)
 *   "userId,startTimeMs,endTimeMs" → editing done (end timestamp present)
 *
 * A blip is "being edited" if ANY user/d/ annotation has an empty
 * third field (no end timestamp).
 */
function isBeingEdited(blip: BlipData): boolean {
  if (!blip.annotations) return false;
  return blip.annotations.some((a) => {
    if (!a.name.startsWith('user/d/')) return false;
    if (a.value == null || a.value === '') return false;
    // Parse "userId,startMs,endMs" — if endMs is empty, still editing
    const parts = a.value.split(',');
    // parts[2] is the end timestamp: empty or missing = still editing
    return parts.length < 3 || parts[2] === '';
  });
}

/**
 * Extract blips that are done being edited.
 *
 * We subscribe to both DOCUMENT_CHANGED and ANNOTATED_TEXT_CHANGED because:
 * - DOCUMENT_CHANGED fires for content changes (typing) but NOT annotation changes
 * - ANNOTATED_TEXT_CHANGED fires when user/d/ annotations change (editing start/stop)
 *
 * The "editing done" signal (end timestamp filled in user/d/) only generates
 * ANNOTATED_TEXT_CHANGED, so we need both to reliably detect completion.
 *
 * Returns the latest changed blip that has no active editing sessions
 * and hasn't been responded to yet.
 */
function extractFinishedBlip(
  bundle: EventMessageBundle,
): { blip: BlipData; author: string; isInThread: boolean } | null {
  const candidateEvents = ['DOCUMENT_CHANGED', 'ANNOTATED_TEXT_CHANGED'];

  // Iterate events in reverse to get the latest
  for (let i = bundle.events.length - 1; i >= 0; i--) {
    const event = bundle.events[i];
    if (!candidateEvents.includes(event.type)) continue;

    const blipId = event.properties['blipId'] as string | undefined;
    const blip = blipId ? bundle.blips[blipId] : null;
    if (!blip) continue;

    // Skip if any user is still editing this blip
    if (isBeingEdited(blip)) continue;

    // Skip bot's own edits
    const author = event.modifiedBy;
    if (author === ROBOT_ADDRESS) continue;

    // Deduplicate: skip if we already responded to this exact content
    const content = blip.content.replace(/^\n/, '').trim();
    if (!content) continue;
    if (respondedContent.get(blip.blipId) === content) continue;

    // Determine if this blip is in a non-root thread
    const isInThread = isBlipInThread(blipId!, bundle);

    return { blip, author, isInThread };
  }
  return null;
}

/** Check if a blip is inside a reply thread (not the root thread). */
function isBlipInThread(blipId: string, bundle: EventMessageBundle): boolean {
  const threads = bundle.threads ?? {};
  const rootBlipId = bundle.wavelet.rootBlipId;

  for (const thread of Object.values(threads)) {
    if (!thread?.blipIds?.includes(blipId)) continue;
    // Skip the root thread — blips there are top-level, not in a reply thread.
    // The root thread contains the rootBlipId.
    if (thread.blipIds.includes(rootBlipId)) continue;
    return true;
  }
  return false;
}

/** Check if the bot should respond to this blip. */
function shouldRespond(blip: BlipData, bundle: EventMessageBundle): boolean {
  if (mentionsBot(blip.content)) return true;
  if (bundle.wavelet.participants.includes(ROBOT_ADDRESS)) return true;
  return false;
}

/** Handle WAVELET_SELF_REMOVED — clean up session. */
function handleSelfRemoved(bundle: EventMessageBundle): void {
  for (const event of bundle.events) {
    if (event.type === 'WAVELET_SELF_REMOVED') {
      clearSession(bundle.wavelet.waveId);
      console.log(`[session-cleared] wave=${bundle.wavelet.waveId}`);
    }
  }
}

// ── express app ──────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/_wave/capabilities.xml', (_req, res) => {
  res.type('application/xml').send(CAPABILITIES_XML);
});

app.get('/_wave/robot/profile', (_req, res) => {
  res.json({
    address: ROBOT_ADDRESS,
    name: 'GPT Bot TS',
    imageUrl: '',
    profileUrl: '',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: sessionCount() });
});

app.post('/_wave/robot/jsonrpc', async (req, res) => {
  // Validate payload
  if (!isValidBundle(req.body)) {
    res.status(400).json({ error: 'Invalid event bundle' });
    return;
  }

  const bundle = req.body;
  const { waveId, waveletId } = bundle.wavelet;

  console.log(
    `[event] wave=${waveId} events=${bundle.events.map((e) => e.type).join(',')}`,
  );

  // Acknowledge immediately
  const notifyOp = {
    method: 'robot.notify',
    id: 'notify-1',
    params: {
      capabilitiesHash: CAPABILITIES_HASH,
      protocolVersion: '0.22',
    },
  };

  // Handle lifecycle events
  handleSelfRemoved(bundle);

  // Extract a finished blip to respond to
  const finished = extractFinishedBlip(bundle);

  if (!finished || !shouldRespond(finished.blip, bundle)) {
    res.json([notifyOp]);
    return;
  }

  const { blip, author, isInThread } = finished;
  const userMessage = blip.content.replace(/^\n/, '').trim();

  // Mark as responded before processing to prevent duplicate processing
  // from concurrent DOCUMENT_CHANGED events for the same blip
  respondedContent.set(blip.blipId, userMessage);

  console.log(`[processing] wave=${waveId} author=${author} blip=${blip.blipId} inThread=${isInThread}`);

  // Respond immediately so the Wave server doesn't time out
  res.json([notifyOp]);

  // Skip new work if shutting down
  if (shutdownRequested) return;

  // Post reply contextually:
  // - If user's blip is in a thread → continue that thread
  // - Otherwise → reply to the user's blip (creates a child thread)
  const postReply = async (content: string) => {
    if (isInThread) {
      await waveClient.continueThread(waveId, blip.blipId, content, waveletId);
    } else {
      await waveClient.replyToBlip(waveId, blip.blipId, content, waveletId);
    }
  };

  // Track in-flight job for graceful shutdown
  activeJobs++;
  // Process asynchronously and post reply via data API
  try {
    const reply = await processMessage({
      waveId,
      userMessage,
      author,
      waveClient,
    });

    await postReply(reply);
    console.log(`[replied] wave=${waveId} length=${reply.length}`);
  } catch (err) {
    console.error(`[error] wave=${waveId}`, err);
    respondedContent.delete(blip.blipId);
    try {
      await postReply(
        'Sorry, I encountered an error processing your message. Please try again.',
      );
    } catch (replyErr) {
      console.error(`[error] failed to post error reply`, replyErr);
    }
  } finally {
    activeJobs--;
  }
});

// ── start ────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`gpt-bot-ts listening on port ${PORT}`);
  console.log(`Robot address: ${ROBOT_ADDRESS}`);
  console.log(`Callback URL: https://gpt-bot-ts.supawave.ai`);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received, draining...');
  shutdownRequested = true;
  server.close(() => {
    console.log('[shutdown] Server closed, waiting for in-flight jobs...');
    const check = setInterval(() => {
      if (activeJobs === 0) {
        clearInterval(check);
        console.log('[shutdown] All jobs drained, exiting');
        process.exit(0);
      }
    }, 500);
    // Force exit after 25s (systemd TimeoutStopSec=30)
    setTimeout(() => {
      console.log(`[shutdown] Force exit with ${activeJobs} jobs still running`);
      process.exit(1);
    }, 25_000);
  });
});
