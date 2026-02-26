import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { ElevenLabsTTS } from '../../tts/elevenlabs-tts.js';

describe('ElevenLabsTTS', () => {
  let tts: ElevenLabsTTS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
    });
    tts = new ElevenLabsTTS({ apiKey: 'el-test-key' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct name', () => {
    expect(tts.name).toBe('elevenlabs');
  });

  it('synthesize() sends correct HTTP request', async () => {
    await tts.synthesize('Hello world');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.elevenlabs.io/v1/text-to-speech/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'xi-api-key': 'el-test-key',
        'Content-Type': 'application/json',
      })
    );

    const body = JSON.parse(init.body as string);
    expect(body.text).toBe('Hello world');
  });

  it('uses eleven_flash_v2_5 model by default', async () => {
    await tts.synthesize('test');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe('eleven_flash_v2_5');
  });

  it('uses default voice ID (Rachel)', async () => {
    await tts.synthesize('test');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM');
  });

  it('passes custom voiceId from config', async () => {
    const custom = new ElevenLabsTTS({ apiKey: 'key', voiceId: 'custom-voice-123' });
    await custom.synthesize('test');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/text-to-speech/custom-voice-123');
  });

  it('option voice overrides config voiceId', async () => {
    const custom = new ElevenLabsTTS({ apiKey: 'key', voiceId: 'config-voice' });
    await custom.synthesize('test', { voice: 'option-voice' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/text-to-speech/option-voice');
  });

  it('returns audio Buffer from response', async () => {
    const result = await tts.synthesize('Hello');

    expect(result).toBeInstanceOf(Buffer);
    expect(result).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('maps mp3 format to mp3_44100_128', async () => {
    await tts.synthesize('test', { format: 'mp3' });

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('output_format')).toBe('mp3_44100_128');
  });

  it('maps pcm16 format to pcm_16000', async () => {
    await tts.synthesize('test', { format: 'pcm16' });

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('output_format')).toBe('pcm_16000');
  });

  it('uses mp3_44100_128 when no format specified', async () => {
    await tts.synthesize('test');

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('output_format')).toBe('mp3_44100_128');
  });

  it('sends voice_settings in request body', async () => {
    await tts.synthesize('test');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
    });
  });

  it('passes custom model from config', async () => {
    const custom = new ElevenLabsTTS({ apiKey: 'key', model: 'eleven_multilingual_v2' });
    await custom.synthesize('test');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe('eleven_multilingual_v2');
  });

  it('handles API error responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid API key'),
    });

    await expect(tts.synthesize('test')).rejects.toThrow('ElevenLabs API error 401');
  });

  it('streamSynthesize() uses /stream endpoint', async () => {
    const rawChunk1 = new Uint8Array([10, 20]);
    const rawChunk2 = new Uint8Array([30, 40]);
    const rawChunks = [rawChunk1, rawChunk2];
    let idx = 0;

    mockFetch.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: () => {
            if (idx < rawChunks.length) {
              return Promise.resolve({ done: false, value: rawChunks[idx++] });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          releaseLock: vi.fn(),
        }),
      },
    });

    const collected: Buffer[] = [];
    for await (const chunk of tts.streamSynthesize('test')) {
      collected.push(chunk);
    }

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream');

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual(Buffer.from([10, 20]));
    expect(collected[1]).toEqual(Buffer.from([30, 40]));
  });

  it('streamSynthesize() throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    });

    const gen = tts.streamSynthesize('test');
    await expect(gen.next()).rejects.toThrow('ElevenLabs API error 429');
  });
});
