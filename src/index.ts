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
import {
  mentionsBot,
  isValidBundle,
  isBeingEdited,
  isBlipInThread,
  findParentBlipContext,
} from './helpers.js';
import type { BlipData, EventMessageBundle } from './helpers.js';
import { markdownToWave } from './markdown-to-wave.js';
import { decodeTokenExpiry, checkTokenExpiry } from './token-utils.js';

// ── config ───────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8089', 10);
const SUPAWAVE_TOKEN = process.env['SUPAWAVE_TOKEN'] ?? '';
const SUPAWAVE_SECRET = process.env['SUPAWAVE_SECRET'] ?? '';
const ROBOT_ADDRESS = process.env['ROBOT_ADDRESS'] ?? 'gpt-ts-bot@supawave.ai';

if (!SUPAWAVE_TOKEN) {
  console.error('SUPAWAVE_TOKEN environment variable is required');
  process.exit(1);
}

if (!process.env['OPENAI_API_KEY']) {
  console.error('OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

// ── token expiry check ───────────────────────────────────────

checkTokenExpiry(SUPAWAVE_TOKEN, Boolean(SUPAWAVE_SECRET));

const waveClient = new WaveClient({
  token: SUPAWAVE_TOKEN,
  robotAddress: ROBOT_ADDRESS,
  secret: SUPAWAVE_SECRET || undefined,
});

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
// Pure helpers (mentionsBot, isValidBundle, isBeingEdited, isBlipInThread)
// are imported from ./helpers.js above.

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

/** Check if the bot should respond to this blip. */
function shouldRespond(blip: BlipData, bundle: EventMessageBundle): boolean {
  if (mentionsBot(blip.content, ROBOT_ADDRESS)) return true;
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

// ── welcome blip ────────────────────────────────────────────

/** Build a welcome message using the bot name from the event bundle. */
function buildWelcomeMarkdown(botName: string): string {
  return `**Hi there! I'm ${botName}** — your AI assistant inside this wave.

I'm ready to help! Here are some things I can do:

**Ask me anything**
- Research topics on the web
- Summarize articles or complex subjects
- Answer factual questions

**Real-time information**
- "What's the current Bitcoin price?"
- "What's the weather in Tel Aviv?"
- "How is NVDA stock doing today?"

**Create and brainstorm**
- Draft emails, messages, or documents
- Brainstorm ideas for projects
- Generate images — just ask me to draw something!

**Collaborate**
- Reply to any of my blips to continue the conversation
- Select text in a blip and create an inline reply for focused discussion
- @-mention me anywhere: **@${botName}**

Just type your question below and I'll get right on it!`;
}

/**
 * Handle WAVELET_SELF_ADDED — post a welcome blip when the bot joins a wave.
 * Uses bundle.robotAddress (not the env var) so the displayed @-mention
 * always matches what Wave believes the bot's address is.
 * Runs asynchronously (fire-and-forget) so the HTTP response is not delayed.
 */
function handleSelfAdded(bundle: EventMessageBundle): void {
  const hasSelfAdded = bundle.events.some((e) => e.type === 'WAVELET_SELF_ADDED');
  if (!hasSelfAdded) return;

  const { waveId, waveletId } = bundle.wavelet;
  const botName = bundle.robotAddress.split('@')[0];
  console.log(`[welcome] wave=${waveId} bot added, posting welcome blip`);

  // Fire-and-forget — errors are logged but don't block the response.
  (async () => {
    try {
      const { content, annotations } = markdownToWave(buildWelcomeMarkdown(botName));
      await waveClient.appendBlip(waveId, content, waveletId, annotations);
      console.log(`[welcome] wave=${waveId} welcome blip posted`);
    } catch (err) {
      console.error(`[welcome-error] wave=${waveId}`, err);
    }
  })();
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
  // Use the client's current token — it may have been refreshed at runtime.
  const expiry = decodeTokenExpiry(waveClient.getToken());
  const now = Date.now();
  // Guard against Date objects that carry NaN (e.g. if decodeTokenExpiry receives
  // an `exp` claim with a value outside the valid JS Date range).  NaN propagates
  // silently: `expiryMs <= now` is false, but toISOString() would throw a RangeError.
  const expiryMs = expiry?.getTime();
  const hasValidExpiry = expiryMs !== undefined && Number.isFinite(expiryMs);
  const tokenExpiresAt = hasValidExpiry ? new Date(expiryMs!).toISOString() : null;
  // When the token can't be decoded treat it as non-expired (indeterminate) — boolean false.
  const tokenExpired = hasValidExpiry ? expiryMs! <= now : false;
  const hoursUntilExpiry = hasValidExpiry ? (expiryMs! - now) / (1000 * 60 * 60) : null;

  let tokenWarning: string | null = null;
  if (tokenExpired) {
    tokenWarning = 'Token is expired';
  } else if (!hasValidExpiry) {
    tokenWarning = 'Token expiry could not be determined';
  } else if (hoursUntilExpiry !== null && hoursUntilExpiry <= 24 * 7) {
    tokenWarning = `Token expires in ${hoursUntilExpiry.toFixed(1)}h`;
  }

  res.json({
    status: tokenExpired ? 'degraded' : 'ok',
    sessions: sessionCount(),
    tokenExpiresAt,
    tokenExpired,
    tokenWarning,
    autoRefresh: waveClient.canRefresh(),
  });
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
  handleSelfAdded(bundle);

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
  // Markdown is converted to Wave annotations so formatting renders correctly.
  // markdownToWave() already enforces safe schemes (http/https/mailto) internally;
  // the filter below is a defense-in-depth guard in case other annotation sources
  // are added in future.
  const SAFE_LINK_RE = /^https?:\/\/|^mailto:/i;
  const postReply = async (markdown: string): Promise<string | undefined> => {
    const { content, annotations } = markdownToWave(markdown);
    const safeAnnotations = annotations.filter(
      (a) => a.name !== 'link/manual' || SAFE_LINK_RE.test(a.value),
    );
    if (isInThread) {
      return waveClient.continueThread(waveId, blip.blipId, content, waveletId, safeAnnotations);
    } else {
      return waveClient.replyToBlip(waveId, blip.blipId, content, waveletId, safeAnnotations);
    }
  };

  // For inline-thread blips, find the parent blip content for context
  let parentContext: string | undefined;
  if (isInThread) {
    parentContext = findParentBlipContext(blip.blipId, bundle) ?? undefined;
    if (parentContext) {
      console.log(`[context] wave=${waveId} parentContextLength=${parentContext.length}`);
    }
  }

  // Track in-flight job for graceful shutdown
  activeJobs++;
  // Process asynchronously and post reply via data API
  try {
    const { decision, pendingImages } = await processMessage({
      waveId,
      waveletId,
      userMessage,
      author,
      waveClient,
      parentContext,
    });

    if (!decision.shouldReply) {
      console.log(`[skipped] wave=${waveId} bot chose not to reply`);
      respondedContent.delete(blip.blipId); // allow retry
      return;
    }

    // Guard: shouldReply=true with null response is a malformed model output
    const replyText = decision.response ?? 'I had trouble generating a response. Please try again.';
    const newBlipId = await postReply(replyText);
    console.log(`[replied] wave=${waveId} length=${replyText.length} blipId=${newBlipId}`);

    // Upload and insert any images generated during the agent run.
    // Both importAttachment and insertImage are deferred until the reply
    // blip exists — this avoids orphaned attachments if the reply fails.
    if (pendingImages.length > 0 && newBlipId) {
      for (const img of pendingImages) {
        try {
          await waveClient.importAttachment(
            waveId, waveletId, img.attachmentId, img.fileName, ROBOT_ADDRESS, img.base64Data,
          );
          await waveClient.insertImage(waveId, waveletId, newBlipId, img.attachmentId, img.caption);
          console.log(`[image] wave=${waveId} uploaded+inserted ${img.attachmentId} into blip=${newBlipId}`);
        } catch (imgErr) {
          console.error(`[image-error] wave=${waveId} failed to upload/insert ${img.attachmentId}`, imgErr);
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : '';
    console.error(`[error] wave=${waveId} msg=${errMsg}`);
    if (errStack) console.error(`[error] stack=${errStack}`);
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
