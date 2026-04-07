/**
 * SupaWave JSON-RPC Data API client.
 *
 * Communicates with the Wave server at /robot/dataapi/rpc using
 * Bearer token auth.
 */

import type { WaveAnnotation } from './markdown-to-wave.js';

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

export interface ThreadData {
  id: string;
  blipIds: string[];
}

export interface FetchWaveResult {
  waveletData: WaveletData;
  blips: Record<string, BlipData>;
  threads: Record<string, ThreadData>;
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

  private defaultWaveletId(waveId: string, waveletId?: string): string {
    return waveletId ?? waveId.replace(/!w\+.*$/, '!conv+root');
  }

  private ensureNewline(content: string): string {
    return content.startsWith('\n') ? content : `\n${content}`;
  }

  /**
   * Offset annotation ranges by `delta` characters.
   *
   * Required because Wave blip content must start with `\n` (offset = 1).
   * Annotations from `markdownToWave` are relative to the plain text without
   * the leading newline, so all ranges must be shifted forward by 1.
   */
  private offsetAnnotations(
    annotations: WaveAnnotation[],
    delta: number,
  ): WaveAnnotation[] {
    return annotations.map((a) => ({
      ...a,
      range: { start: a.range.start + delta, end: a.range.end + delta },
    }));
  }

  /**
   * Build the blipData payload, including annotations if provided.
   * The leading `\n` is added here, and annotation ranges are shifted by 1.
   */
  private buildBlipData(
    blipId: string,
    content: string,
    annotations?: WaveAnnotation[],
  ): Record<string, unknown> {
    const finalContent = this.ensureNewline(content);
    // Calculate how many chars were prepended (0 if content already started with \n)
    const delta = finalContent.length - content.length;
    const blipData: Record<string, unknown> = { blipId, content: finalContent };
    if (annotations && annotations.length > 0) {
      blipData['annotations'] = delta > 0 ? this.offsetAnnotations(annotations, delta) : annotations;
    }
    return blipData;
  }

  /** Fetch full wave state (blips, threads, participants). */
  async fetchWave(waveId: string, waveletId?: string): Promise<FetchWaveResult> {
    const [response] = await this.rpc([
      {
        id: 'fetch-1',
        method: 'robot.fetchWave',
        params: {
          waveId,
          waveletId: this.defaultWaveletId(waveId, waveletId),
        },
      },
    ]);

    if (response.error) {
      throw new Error(`fetchWave error: ${response.error.message}`);
    }

    return response.data as FetchWaveResult;
  }

  /** Append a new blip to the root thread. */
  async appendBlip(
    waveId: string,
    content: string,
    waveletId?: string,
    annotations?: WaveAnnotation[],
  ): Promise<void> {
    const [response] = await this.rpc([
      {
        id: 'append-1',
        method: 'wavelet.appendBlip',
        params: {
          waveId,
          waveletId: this.defaultWaveletId(waveId, waveletId),
          blipData: this.buildBlipData(`TBD_bot_${Date.now()}`, content, annotations),
        },
      },
    ]);

    if (response.error) {
      throw new Error(`appendBlip error: ${response.error.message}`);
    }
  }

  /** Create a reply thread under a specific blip. */
  async replyToBlip(
    waveId: string,
    parentBlipId: string,
    content: string,
    waveletId?: string,
    annotations?: WaveAnnotation[],
  ): Promise<void> {
    const [response] = await this.rpc([
      {
        id: 'reply-1',
        method: 'blip.createChild',
        params: {
          waveId,
          waveletId: this.defaultWaveletId(waveId, waveletId),
          blipId: parentBlipId,
          blipData: this.buildBlipData(`TBD_reply_${Date.now()}`, content, annotations),
        },
      },
    ]);

    if (response.error) {
      throw new Error(`replyToBlip error: ${response.error.message}`);
    }
  }

  /** Continue an existing thread (add a sibling blip). */
  async continueThread(
    waveId: string,
    siblingBlipId: string,
    content: string,
    waveletId?: string,
    annotations?: WaveAnnotation[],
  ): Promise<void> {
    const [response] = await this.rpc([
      {
        id: 'continue-1',
        method: 'blip.continueThread',
        params: {
          waveId,
          waveletId: this.defaultWaveletId(waveId, waveletId),
          blipId: siblingBlipId,
          blipData: this.buildBlipData(`TBD_cont_${Date.now()}`, content, annotations),
        },
      },
    ]);

    if (response.error) {
      throw new Error(`continueThread error: ${response.error.message}`);
    }
  }
}
