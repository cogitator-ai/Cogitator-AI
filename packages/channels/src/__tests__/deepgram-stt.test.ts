import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeepgramSttProvider } from '../media/deepgram-stt';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe('DeepgramSttProvider', () => {
  it('transcribes audio with default model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: { channels: [{ alternatives: [{ transcript: 'hello world' }] }] },
        }),
    });

    const provider = new DeepgramSttProvider({ apiKey: 'test-key' });
    const result = await provider.transcribe(Buffer.from('audio'), 'audio/ogg');

    expect(result).toBe('hello world');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('api.deepgram.com/v1/listen');
    expect(url).toContain('model=nova-3');
    expect(opts.headers.Authorization).toBe('Token test-key');
    expect(opts.method).toBe('POST');
  });

  it('uses custom model and language', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: { channels: [{ alternatives: [{ transcript: 'привет мир' }] }] },
        }),
    });

    const provider = new DeepgramSttProvider({
      apiKey: 'key',
      model: 'nova-2',
      language: 'ru',
    });
    const result = await provider.transcribe(Buffer.from('audio'), 'audio/ogg');

    expect(result).toBe('привет мир');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('model=nova-2');
    expect(url).toContain('language=ru');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const provider = new DeepgramSttProvider({ apiKey: 'bad-key' });

    await expect(provider.transcribe(Buffer.from('audio'), 'audio/ogg')).rejects.toThrow(
      'Deepgram STT failed (401): Unauthorized'
    );
  });

  it('returns empty string when no transcript in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: { channels: [{ alternatives: [] }] } }),
    });

    const provider = new DeepgramSttProvider({ apiKey: 'key' });
    const result = await provider.transcribe(Buffer.from('silence'), 'audio/ogg');

    expect(result).toBe('');
  });

  it('handles network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));

    const provider = new DeepgramSttProvider({ apiKey: 'key' });

    await expect(provider.transcribe(Buffer.from('audio'), 'audio/ogg')).rejects.toThrow(
      'Network unreachable'
    );
  });
});
