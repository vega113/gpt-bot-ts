/**
 * SupaWave JSON-RPC Data API client.
 *
 * Communicates with the Wave server at /robot/dataapi/rpc using
 * Bearer token auth.
 *
 * Auto-refresh:  when `robotAddress` and `secret` are provided the client
 * will automatically call the Wave token endpoint on startup (optional) and
 * whenever a 401 is returned, then retry the original request once.
 */

import type { WaveAnnotation } from './markdown-to-wave.js';

const DATA_API_URL = 'https://supawave.ai/robot/dataapi/rpc';
const TOKEN_API_URL = 'https://supawave.ai/robot/dataapi/token';

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

export interface WaveClientOptions {
  /** JWT token — required. */
  token: string;
  /** Robot email address, e.g. gpt-ts-bot@supawave.ai */
  robotAddress?: string;
  /** Robot permanent secret used to obtain a fresh JWT.  When absent, auto-refresh is disabled. */
  secret?: string;
}

// ── client ───────────────────────────────────────────────────

export class WaveClient {
  private token: string;
  private readonly robotAddress?: string;
  private readonly secret?: string;
  /**
   * When a token refresh is in-flight this holds the pending Promise so that
   * concurrent callers can await the same refresh rather than being dropped.
   * Null when no refresh is active.
   */
  private refreshPromise: Promise<void> | null = null;

  constructor(tokenOrOptions: string | WaveClientOptions) {
    if (typeof tokenOrOptions === 'string') {
      this.token = tokenOrOptions;
    } else {
      this.token = tokenOrOptions.token;
      this.robotAddress = tokenOrOptions.robotAddress;
      this.secret = tokenOrOptions.secret;
    }
  }

  updateToken(token: string) {
    this.token = token;
  }

  /** Returns the client's current bearer token (may have been refreshed at runtime). */
  getToken(): string {
    return this.token;
  }

  /** Returns true when this client can attempt a token refresh. */
  canRefresh(): boolean {
    return Boolean(this.robotAddress && this.secret);
  }

  /**
   * Fetch a new JWT from the Wave token endpoint and update the internal token.
   *
   * The Wave server endpoint accepts GET with `robotAddress` and `secret`
   * query parameters and returns the new JWT as a plain-text or JSON body.
   *
   * Throws if the request fails or the response body is empty.
   */
  async refreshToken(): Promise<void> {
    if (!this.robotAddress || !this.secret) {
      throw new Error('Cannot refresh token: robotAddress and secret are required');
    }

    const url = new URL(TOKEN_API_URL);
    url.searchParams.set('robotAddress', this.robotAddress);
    url.searchParams.set('secret', this.secret);

    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (!res.ok) {
      throw new Error(`Token refresh failed with status ${res.status}`);
    }

    const body = await res.text();
    const trimmed = body.trim();
    if (!trimmed) {
      throw new Error('Token refresh returned an empty body');
    }

    // The endpoint may return a bare JWT string or a JSON object with a
    // "token" / "access_token" / "jwt" field.
    const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    let newToken: string;
    if (trimmed.startsWith('{')) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        throw new Error('Token refresh failed: invalid JSON response');
      }
      const candidateRaw =
        json['token'] ??
        json['access_token'] ??
        json['jwt'];
      if (typeof candidateRaw !== 'string' || !candidateRaw) {
        throw new Error('Token refresh failed: JSON did not contain a recognised token field');
      }
      if (!JWT_RE.test(candidateRaw)) {
        throw new Error('Token refresh failed: JSON token field is not a valid JWT');
      }
      newToken = candidateRaw;
    } else {
      // Bare JWT — must be three base64url segments separated by dots
      if (!JWT_RE.test(trimmed)) {
        throw new Error('Token refresh failed: unexpected response format');
      }
      newToken = trimmed;
    }

    this.token = newToken;
    console.log('[token] Token refreshed successfully');
  }

  /** Send one or more JSON-RPC calls to the data API. */
  private async rpc(requests: JsonRpcRequest[], isRetry = false): Promise<JsonRpcResponse[]> {
    // Snapshot the token at the moment this request is dispatched so we can
    // detect whether a concurrent caller already refreshed it by the time we
    // receive a 401 response.
    const tokenAtDispatch = this.token;
    const res = await fetch(DATA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenAtDispatch}`,
      },
      body: JSON.stringify(requests),
    });

    if (res.status === 401 && this.canRefresh() && !isRetry) {
      if (this.token !== tokenAtDispatch) {
        // A concurrent caller already finished a refresh and updated this.token.
        // No need to refresh again — just retry with the new token.
        console.log('[token] Token already updated by concurrent refresh — retrying...');
      } else if (this.refreshPromise) {
        // A refresh is already in-flight (started by another concurrent 401).
        // Await the shared promise so we don't issue a duplicate request.
        console.log('[token] Received 401 — awaiting in-flight token refresh...');
        await this.refreshPromise;
      } else {
        // No refresh in-flight and token still stale — start one.
        console.log('[token] Received 401 — attempting token refresh...');
        this.refreshPromise = this.refreshToken().finally(() => {
          this.refreshPromise = null;
        });
        await this.refreshPromise;
      }
      // Retry once with the refreshed token; isRetry=true prevents infinite loops.
      return this.rpc(requests, true);
    }

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
