import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { WaveClient } from '../wave-client.js';

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterAll(() => {
  vi.unstubAllGlobals();
});

function mockJsonResponse(data: unknown, ok = true, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

// ── WaveClient ────────────────────────────────────────────────

describe('WaveClient', () => {
  const TOKEN = 'test-token';
  const WAVE_ID = 'wavesandbox.com!w+abc123';
  const DERIVED_WAVELET_ID = 'wavesandbox.com!conv+root';
  const WAVELET_ID = 'wavesandbox.com!conv+root';

  describe('defaultWaveletId (via public methods)', () => {
    it('derives waveletId from waveId when not provided', async () => {
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      const client = new WaveClient(TOKEN);
      await client.fetchWave(WAVE_ID);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.waveletId).toBe(DERIVED_WAVELET_ID);
    });

    it('uses provided waveletId when given', async () => {
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      const client = new WaveClient(TOKEN);
      await client.fetchWave(WAVE_ID, 'custom!wavelet');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.waveletId).toBe('custom!wavelet');
    });
  });

  describe('ensureNewline (via appendBlip)', () => {
    it('prepends newline to content that does not start with one', async () => {
      mockJsonResponse([{ id: 'append-1', data: null }]);
      const client = new WaveClient(TOKEN);
      await client.appendBlip(WAVE_ID, 'hello world', WAVELET_ID);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.content).toBe('\nhello world');
    });

    it('does not double-prepend newline if content already starts with one', async () => {
      mockJsonResponse([{ id: 'append-1', data: null }]);
      const client = new WaveClient(TOKEN);
      await client.appendBlip(WAVE_ID, '\nhello world', WAVELET_ID);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.content).toBe('\nhello world');
    });
  });

  describe('annotations offset (via appendBlip)', () => {
    it('offsets annotation ranges by 1 when content does not start with newline', async () => {
      mockJsonResponse([{ id: 'append-1', data: null }]);
      const client = new WaveClient(TOKEN);
      const anns = [{ name: 'style/fontWeight', value: 'bold', range: { start: 0, end: 5 } }];
      await client.appendBlip(WAVE_ID, 'Hello world', WAVELET_ID, anns);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.content).toBe('\nHello world');
      expect(body[0].params.blipData.annotations).toEqual([
        { name: 'style/fontWeight', value: 'bold', range: { start: 1, end: 6 } },
      ]);
    });

    it('does not offset annotation ranges when content already starts with newline', async () => {
      mockJsonResponse([{ id: 'append-1', data: null }]);
      const client = new WaveClient(TOKEN);
      const anns = [{ name: 'style/fontWeight', value: 'bold', range: { start: 1, end: 6 } }];
      await client.appendBlip(WAVE_ID, '\nHello world', WAVELET_ID, anns);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.annotations).toEqual([
        { name: 'style/fontWeight', value: 'bold', range: { start: 1, end: 6 } },
      ]);
    });

    it('omits annotations field when no annotations provided', async () => {
      mockJsonResponse([{ id: 'append-1', data: null }]);
      const client = new WaveClient(TOKEN);
      await client.appendBlip(WAVE_ID, 'plain text', WAVELET_ID);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.annotations).toBeUndefined();
    });
  });

  describe('appendBlip', () => {
    it('calls the data API with correct method and auth header', async () => {
      mockJsonResponse([{ id: 'append-1', data: null }]);
      const client = new WaveClient(TOKEN);
      await client.appendBlip(WAVE_ID, 'reply text', WAVELET_ID);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://supawave.ai/robot/dataapi/rpc');
      expect(opts.headers['Authorization']).toBe('Bearer test-token');
      const body = JSON.parse(opts.body);
      expect(body[0].method).toBe('wavelet.appendBlip');
    });

    it('throws when the API returns an error response', async () => {
      mockJsonResponse([{ id: 'append-1', error: { code: 500, message: 'Server error' } }]);
      const client = new WaveClient(TOKEN);
      await expect(client.appendBlip(WAVE_ID, 'text', WAVELET_ID)).rejects.toThrow(
        'appendBlip error: Server error',
      );
    });

    it('throws when fetch response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });
      const client = new WaveClient(TOKEN);
      await expect(client.appendBlip(WAVE_ID, 'text', WAVELET_ID)).rejects.toThrow('403');
    });
  });

  describe('replyToBlip', () => {
    it('calls blip.createChild with the correct blipId', async () => {
      mockJsonResponse([{ id: 'reply-1', data: null }]);
      const client = new WaveClient(TOKEN);
      await client.replyToBlip(WAVE_ID, 'parent-blip-id', 'reply text', WAVELET_ID);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].method).toBe('blip.createChild');
      expect(body[0].params.blipId).toBe('parent-blip-id');
    });

    it('forwards annotations with offset to blipData', async () => {
      mockJsonResponse([{ id: 'reply-1', data: null }]);
      const client = new WaveClient(TOKEN);
      const anns = [{ name: 'style/fontWeight', value: 'bold', range: { start: 0, end: 5 } }];
      await client.replyToBlip(WAVE_ID, 'parent', 'Hello world', WAVELET_ID, anns);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.annotations).toEqual([
        { name: 'style/fontWeight', value: 'bold', range: { start: 1, end: 6 } },
      ]);
    });

    it('throws when API returns an error', async () => {
      mockJsonResponse([{ id: 'reply-1', error: { code: 404, message: 'Blip not found' } }]);
      const client = new WaveClient(TOKEN);
      await expect(
        client.replyToBlip(WAVE_ID, 'parent', 'text', WAVELET_ID),
      ).rejects.toThrow('replyToBlip error: Blip not found');
    });
  });

  describe('continueThread', () => {
    it('calls blip.continueThread with the sibling blipId', async () => {
      mockJsonResponse([{ id: 'continue-1', data: null }]);
      const client = new WaveClient(TOKEN);
      await client.continueThread(WAVE_ID, 'sibling-blip', 'continuation', WAVELET_ID);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].method).toBe('blip.continueThread');
      expect(body[0].params.blipId).toBe('sibling-blip');
    });

    it('forwards annotations with offset to blipData', async () => {
      mockJsonResponse([{ id: 'continue-1', data: null }]);
      const client = new WaveClient(TOKEN);
      const anns = [{ name: 'style/fontStyle', value: 'italic', range: { start: 2, end: 7 } }];
      await client.continueThread(WAVE_ID, 'sibling', 'continuation', WAVELET_ID, anns);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body[0].params.blipData.annotations).toEqual([
        { name: 'style/fontStyle', value: 'italic', range: { start: 3, end: 8 } },
      ]);
    });
  });

  describe('fetchWave', () => {
    it('returns parsed wave data on success', async () => {
      const mockData = {
        waveletData: { waveId: WAVE_ID, rootBlipId: 'root' },
        blips: { root: { blipId: 'root', content: 'hello' } },
        threads: {},
      };
      mockJsonResponse([{ id: 'fetch-1', data: mockData }]);
      const client = new WaveClient(TOKEN);
      const result = await client.fetchWave(WAVE_ID, WAVELET_ID);

      expect(result).toEqual(mockData);
    });

    it('throws when API returns an error', async () => {
      mockJsonResponse([{ id: 'fetch-1', error: { code: 404, message: 'Wave not found' } }]);
      const client = new WaveClient(TOKEN);
      await expect(client.fetchWave(WAVE_ID)).rejects.toThrow('fetchWave error: Wave not found');
    });
  });

  // ── WaveClientOptions constructor ────────────────────────────

  describe('WaveClientOptions constructor', () => {
    it('accepts a plain string token (legacy path)', async () => {
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      const client = new WaveClient(TOKEN);
      await client.fetchWave(WAVE_ID);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Authorization']).toBe('Bearer test-token');
    });

    it('accepts WaveClientOptions object', async () => {
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'my-secret' });
      await client.fetchWave(WAVE_ID);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Authorization']).toBe('Bearer test-token');
    });
  });

  // ── canRefresh ───────────────────────────────────────────────

  describe('canRefresh', () => {
    it('returns false when constructed with a plain string token', () => {
      const client = new WaveClient(TOKEN);
      expect(client.canRefresh()).toBe(false);
    });

    it('returns false when robotAddress or secret is missing', () => {
      expect(new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai' }).canRefresh()).toBe(false);
      expect(new WaveClient({ token: TOKEN, secret: 'sec' }).canRefresh()).toBe(false);
    });

    it('returns true when both robotAddress and secret are set', () => {
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      expect(client.canRefresh()).toBe(true);
    });
  });

  // ── refreshToken ─────────────────────────────────────────────

  describe('refreshToken', () => {
    it('throws when robotAddress and secret are not configured', async () => {
      const client = new WaveClient(TOKEN);
      await expect(client.refreshToken()).rejects.toThrow('robotAddress and secret are required');
    });

    it('throws when the token endpoint returns a non-ok status', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('Token refresh failed with status 403');
    });

    it('throws when the token endpoint returns an empty body', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '   ' });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('empty body');
    });

    it('updates the token when the endpoint returns a bare JWT string', async () => {
      const newToken = 'new.jwt.token';
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => newToken });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await client.refreshToken();
      // Verify the client uses the new token on the next RPC call
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      await client.fetchWave(WAVE_ID);
      const [, rpcOpts] = fetchMock.mock.calls[1];
      expect(rpcOpts.headers['Authorization']).toBe(`Bearer ${newToken}`);
    });

    it('updates the token when the endpoint returns JSON with a "token" field', async () => {
      const newToken = 'newheader.newpayload.newsig';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: newToken }),
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await client.refreshToken();
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      await client.fetchWave(WAVE_ID);
      const [, rpcOpts] = fetchMock.mock.calls[1];
      expect(rpcOpts.headers['Authorization']).toBe(`Bearer ${newToken}`);
    });

    it('updates the token when JSON has "access_token" field', async () => {
      const newToken = 'new.access.token';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: newToken }),
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await client.refreshToken();
      mockJsonResponse([{ id: 'fetch-1', data: { waveletData: {}, blips: {}, threads: {} } }]);
      await client.fetchWave(WAVE_ID);
      const [, rpcOpts] = fetchMock.mock.calls[1];
      expect(rpcOpts.headers['Authorization']).toBe(`Bearer ${newToken}`);
    });

    it('throws when JSON does not contain a recognised token field', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: 'no token here' }),
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('recognised token field');
    });

    it('throws when JSON token field is an object, not a string', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: { nested: 'object' } }),
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('recognised token field');
    });

    it('throws when JSON token field is a string but not a valid JWT', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: 'not-a-jwt' }),
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('not a valid JWT');
    });
  });

  // ── 401 auto-refresh and retry ───────────────────────────────

  describe('401 auto-refresh', () => {
    it('refreshes token and retries on 401 when secret is set', async () => {
      const newToken = 'refreshed.jwt.token';
      const mockData = { waveletData: {}, blips: {}, threads: {} };

      // First call → 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      // Token refresh call → new token
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => newToken });
      // Retry RPC call → success
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'fetch-1', data: mockData }],
        text: async () => JSON.stringify([{ id: 'fetch-1', data: mockData }]),
      });

      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      const result = await client.fetchWave(WAVE_ID);

      expect(result).toEqual(mockData);
      // Three fetch calls: initial RPC, token refresh, retry RPC
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // The retry should use the refreshed token
      const [, retryOpts] = fetchMock.mock.calls[2];
      expect(retryOpts.headers['Authorization']).toBe(`Bearer ${newToken}`);
    });

    it('throws on 401 when no secret is configured (no retry)', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      const client = new WaveClient(TOKEN); // no secret
      await expect(client.fetchWave(WAVE_ID)).rejects.toThrow('Data API 401');
      // Only one fetch call — no retry attempted
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry if token refresh itself fails', async () => {
      // First call → 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      // Token refresh → also fails
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });

      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.fetchWave(WAVE_ID)).rejects.toThrow('Token refresh failed');
      // Two fetch calls: initial RPC + failed refresh; no third retry
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on 401 after a successful refresh (no infinite loop)', async () => {
      const newToken = 'refreshed.jwt.token';

      // First RPC → 401
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      // Token refresh → success
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => newToken });
      // Retry RPC → still 401 (e.g. server rejects even the new token)
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.fetchWave(WAVE_ID)).rejects.toThrow('Data API 401');
      // Exactly three fetch calls: initial RPC, token refresh, one retry — no further loops
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('concurrent 401 callers share the in-flight refresh and both retry', async () => {
      const newToken = 'shared.jwt.token';
      const mockData = { waveletData: {}, blips: {}, threads: {} };

      // Both concurrent RPCs get 401
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
      // Single token refresh
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => newToken });
      // Both retries succeed
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ id: 'fetch-1', data: mockData }],
          text: async () => JSON.stringify([{ id: 'fetch-1', data: mockData }]),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ id: 'fetch-1', data: mockData }],
          text: async () => JSON.stringify([{ id: 'fetch-1', data: mockData }]),
        });

      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      const [result1, result2] = await Promise.all([
        client.fetchWave(WAVE_ID),
        client.fetchWave(WAVE_ID),
      ]);

      expect(result1).toEqual(mockData);
      expect(result2).toEqual(mockData);
      // 5 fetch calls: 2 initial RPCs + 1 token refresh + 2 retries (not 6 = no double refresh)
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  });

  // ── refreshToken bare-string validation ──────────────────────

  describe('refreshToken bare-string validation', () => {
    it('rejects a non-JWT bare string (e.g. HTML)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<html>Not a token</html>',
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('unexpected response format');
    });

    it('rejects a bare string with only two dot-separated segments', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'header.payload',
      });
      const client = new WaveClient({ token: TOKEN, robotAddress: 'bot@supawave.ai', secret: 'sec' });
      await expect(client.refreshToken()).rejects.toThrow('unexpected response format');
    });
  });
});
