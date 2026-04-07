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
});
