/**
 * SupaWave JSON-RPC Data API client.
 *
 * Communicates with the Wave server at /robot/dataapi/rpc using
 * Bearer token auth.  Provides typed helpers for the operations
 * the bot actually needs: fetchWave and appendBlip.
 */

const DATA_API_URL = 'https://supawave.ai/robot/dataapi/rpc';

// ── types ────────────────────────────────────────────────────

export interface BlipData {
  blipId: string;
  content: string;
  contributors?: string[];
  lastModifiedTime?: number;
  annotations?: Array<{ name: string; value: string; range: { start: number; end: number } }>;
}

export interface WaveletData {
  waveId: string;
  waveletId: string;
  rootBlipId: string;
  title: string;
  participants: string[];
}

export interface FetchWaveResult {
  waveletData: WaveletData;
  blips: Record<string, BlipData>;
  threads: Record<string, unknown>;
}

interface JsonRpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: string;
  error?: { code: number; message: string };
  data?: unknown;
}

// ── client ───────────────────────────────────────────────────

export class WaveClient {
  constructor(private token: string) {}

  updateToken(token: string) {
    this.token = token;
  }

  /** Send one or more JSON-RPC calls to the data API. */
  private async rpc(requests: JsonRpcRequest[]): Promise<JsonRpcResponse[]> {
    const res = await fetch(DATA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(requests),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Data API ${res.status}: ${text}`);
    }

    return (await res.json()) as JsonRpcResponse[];
  }

  /** Fetch full wave state (blips, threads, participants). */
  async fetchWave(waveId: string, waveletId?: string): Promise<FetchWaveResult> {
    const [response] = await this.rpc([
      {
        id: 'fetch-1',
        method: 'robot.fetchWave',
        params: {
          waveId,
          waveletId: waveletId ?? waveId.replace(/!w\+/, '!conv+root'),
        },
      },
    ]);

    if (response.error) {
      throw new Error(`fetchWave error: ${response.error.message}`);
    }

    return response.data as FetchWaveResult;
  }

  /** Append a new blip to the root thread. Content must start with \n. */
  async appendBlip(waveId: string, content: string, waveletId?: string): Promise<void> {
    const text = content.startsWith('\n') ? content : `\n${content}`;
    const [response] = await this.rpc([
      {
        id: 'append-1',
        method: 'wavelet.appendBlip',
        params: {
          waveId,
          waveletId: waveletId ?? waveId.replace(/!w\+/, '!conv+root'),
          blipData: {
            blipId: `TBD_bot_${Date.now()}`,
            content: text,
          },
        },
      },
    ]);

    if (response.error) {
      throw new Error(`appendBlip error: ${response.error.message}`);
    }
  }
}
