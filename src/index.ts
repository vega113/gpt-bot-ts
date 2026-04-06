/**
 * gpt-bot-ts — SupaWave Wave robot server.
 *
 * Endpoints:
 *   GET  /_wave/capabilities.xml   – Declare subscribed events
 *   GET  /_wave/robot/profile      – Bot profile
 *   POST /_wave/robot/jsonrpc      – Receive event bundles
 *   GET  /health                   – Health check
 */

import express from 'express';
import { WaveClient } from './wave-client.js';
import { processMessage } from './agent.js';
import { clearSession, sessionCount } from './context.js';

// ── config ───────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8089', 10);
const SUPAWAVE_TOKEN = process.env['SUPAWAVE_TOKEN'] ?? '';
const ROBOT_ADDRESS = process.env['ROBOT_ADDRESS'] ?? 'gpt-bot-ts@supawave.ai';

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
  threads: Record<string, unknown>;
  robotAddress: string;
  rpcServerUrl: string;
}

// ── capabilities ─────────────────────────────────────────────

const CAPABILITIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:robot xmlns:w="http://wave.google.com/extensions/robots/1.0">
  <w:version>1</w:version>
  <w:protocolversion>0.22</w:protocolversion>
  <w:capabilities>
    <w:capability name="BLIP_SUBMITTED" context="SELF"/>
    <w:capability name="WAVELET_SELF_ADDED" context="SELF"/>
    <w:capability name="WAVELET_SELF_REMOVED" context="SELF"/>
  </w:capabilities>
</w:robot>
`;

const CAPABILITIES_HASH = 'sha256:781b6a730877';

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

/** Extract the latest submitted blip from the event bundle. */
function extractSubmittedBlip(
  bundle: EventMessageBundle,
): { blip: BlipData; author: string } | null {
  // Iterate in reverse to get the latest BLIP_SUBMITTED event
  for (let i = bundle.events.length - 1; i >= 0; i--) {
    const event = bundle.events[i];
    if (event.type !== 'BLIP_SUBMITTED') continue;

    const blipId = event.properties['blipId'] as string | undefined;
    const blip = blipId ? bundle.blips[blipId] : null;
    if (!blip) continue;

    // Skip bot's own messages
    const author = event.modifiedBy;
    if (author === ROBOT_ADDRESS) continue;

    return { blip, author };
  }
  return null;
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

  // Extract the blip to respond to
  const submitted = extractSubmittedBlip(bundle);

  if (!submitted || !shouldRespond(submitted.blip, bundle)) {
    res.json([notifyOp]);
    return;
  }

  const { blip, author } = submitted;
  const userMessage = blip.content.replace(/^\n/, '').trim();

  if (!userMessage) {
    res.json([notifyOp]);
    return;
  }

  console.log(`[processing] wave=${waveId} author=${author}`);

  // Respond immediately so the Wave server doesn't time out
  res.json([notifyOp]);

  // Process asynchronously and post reply via data API
  try {
    const reply = await processMessage({
      waveId,
      userMessage,
      author,
      waveClient,
    });

    await waveClient.appendBlip(waveId, reply, waveletId);
    console.log(`[replied] wave=${waveId} length=${reply.length}`);
  } catch (err) {
    console.error(`[error] wave=${waveId}`, err);
    try {
      await waveClient.appendBlip(
        waveId,
        'Sorry, I encountered an error processing your message. Please try again.',
        waveletId,
      );
    } catch (replyErr) {
      console.error(`[error] failed to post error reply`, replyErr);
    }
  }
});

// ── start ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`gpt-bot-ts listening on port ${PORT}`);
  console.log(`Robot address: ${ROBOT_ADDRESS}`);
  console.log(`Callback URL: https://gpt-bot-ts.supawave.ai`);
});
