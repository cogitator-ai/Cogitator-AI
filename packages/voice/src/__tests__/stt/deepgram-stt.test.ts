import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

interface MockWS extends EventEmitter {
  send: Mock;
  close: Mock;
  readyState: number;
  OPEN: number;
}

let wsInstances: MockWS[] = [];
let wsConstructorCalls: Array<[string, string[]]> = [];

vi.mock('ws', () => {
  const MockWebSocket = vi.fn(function (this: MockWS, url: string, protocols: string[]) {
    wsConstructorCalls.push([url, protocols]);
    EventEmitter.call(this);
    this.send = vi.fn();
    this.close = vi.fn();
    this.readyState = 1;
    this.OPEN = 1;
    wsInstances.push(this);
  });
  Object.setPrototypeOf(MockWebSocket.prototype, EventEmitter.prototype);
  return { WebSocket: MockWebSocket };
});

import { DeepgramSTT } from '../../stt/deepgram-stt.js';

describe('DeepgramSTT', () => {
  let stt: DeepgramSTT;

  beforeEach(() => {
    vi.clearAllMocks();
    wsInstances = [];
    wsConstructorCalls = [];
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: {
            channels: [
              {
                alternatives: [
                  {
                    transcript: 'hello world',
                    confidence: 0.98,
                    words: [
                      { word: 'hello', start: 0, end: 0.5, confidence: 0.99 },
                      { word: 'world', start: 0.5, end: 1.0, confidence: 0.97 },
                    ],
                  },
                ],
              },
            ],
          },
          metadata: { duration: 1.0 },
        }),
    });
    stt = new DeepgramSTT({ apiKey: 'dg-test-key' });
  });

  it('has correct name', () => {
    expect(stt.name).toBe('deepgram');
  });

  it('transcribe() sends correct HTTP request', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.deepgram.com/v1/listen');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Token dg-test-key',
        'Content-Type': 'audio/wav',
      })
    );
    expect(Buffer.from(init.body as ArrayBuffer)).toEqual(audio);
  });

  it('uses nova-3 model by default', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio);

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('model')).toBe('nova-3');
  });

  it('parses batch response into TranscribeResult', async () => {
    const result = await stt.transcribe(Buffer.from('audio'));
    expect(result.text).toBe('hello world');
    expect(result.duration).toBe(1.0);
    expect(result.words).toHaveLength(2);
    expect(result.words![0]).toEqual({
      word: 'hello',
      start: 0,
      end: 0.5,
      confidence: 0.99,
    });
  });

  it('passes language option', async () => {
    await stt.transcribe(Buffer.from('audio'), { language: 'fr' });

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('language')).toBe('fr');
  });

  it('uses custom model when configured', async () => {
    const custom = new DeepgramSTT({ apiKey: 'key', model: 'nova-2' });
    await custom.transcribe(Buffer.from('audio'));

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('model')).toBe('nova-2');
  });

  it('uses configured language as default', async () => {
    const localized = new DeepgramSTT({ apiKey: 'key', language: 'de' });
    await localized.transcribe(Buffer.from('audio'));

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('language')).toBe('de');
  });

  it('option language overrides config language', async () => {
    const localized = new DeepgramSTT({ apiKey: 'key', language: 'de' });
    await localized.transcribe(Buffer.from('audio'), { language: 'es' });

    const [url] = mockFetch.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('language')).toBe('es');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(stt.transcribe(Buffer.from('audio'))).rejects.toThrow('Deepgram API error 401');
  });

  describe('createStream()', () => {
    it('opens WebSocket with correct URL', () => {
      stt.createStream();

      expect(wsConstructorCalls).toHaveLength(1);
      const [url, protocols] = wsConstructorCalls[0]!;
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('wss:');
      expect(parsed.hostname).toBe('api.deepgram.com');
      expect(parsed.pathname).toBe('/v1/listen');
      expect(parsed.searchParams.get('model')).toBe('nova-3');
      expect(parsed.searchParams.get('punctuate')).toBe('true');
      expect(parsed.searchParams.get('interim_results')).toBe('true');
      expect(protocols).toContain('token:dg-test-key');
    });

    it('emits partial on interim results', () => {
      const stream = stt.createStream();
      const partialCb = vi.fn();
      stream.on('partial', partialCb);

      const ws = wsInstances[0]!;
      ws.emit('open');
      ws.emit(
        'message',
        JSON.stringify({
          is_final: false,
          channel: {
            alternatives: [{ transcript: 'hel', confidence: 0.8 }],
          },
        })
      );

      expect(partialCb).toHaveBeenCalledWith('hel');
    });

    it('emits final on final results', () => {
      const stream = stt.createStream();
      const finalCb = vi.fn();
      stream.on('final', finalCb);

      const ws = wsInstances[0]!;
      ws.emit('open');
      ws.emit(
        'message',
        JSON.stringify({
          is_final: true,
          channel: {
            alternatives: [
              {
                transcript: 'hello world',
                confidence: 0.98,
                words: [
                  { word: 'hello', start: 0, end: 0.5, confidence: 0.99 },
                  { word: 'world', start: 0.5, end: 1.0, confidence: 0.97 },
                ],
              },
            ],
          },
          metadata: { duration: 1.0 },
        })
      );

      expect(finalCb).toHaveBeenCalledOnce();
      expect(finalCb).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world' }));
    });

    it('stream.write() sends binary data', () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;
      ws.emit('open');

      const chunk = Buffer.from('audio-data');
      stream.write(chunk);

      expect(ws.send).toHaveBeenCalledWith(chunk);
    });

    it('stream.write() buffers data before WebSocket opens', () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;

      const chunk = Buffer.from('early-data');
      stream.write(chunk);
      expect(ws.send).not.toHaveBeenCalled();

      ws.emit('open');
      expect(ws.send).toHaveBeenCalledWith(chunk);
    });

    it('stream.close() closes WebSocket and resolves', async () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;
      ws.emit('open');

      ws.emit(
        'message',
        JSON.stringify({
          is_final: true,
          channel: {
            alternatives: [{ transcript: 'final text', confidence: 0.95 }],
          },
        })
      );

      const result = await stream.close();
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'CloseStream' }));
      expect(result.text).toBe('final text');
    });

    it('emits error on WebSocket error', () => {
      const stream = stt.createStream();
      const errorCb = vi.fn();
      stream.on('error', errorCb);

      const ws = wsInstances[0]!;
      ws.emit('error', new Error('ws failed'));

      expect(errorCb).toHaveBeenCalledOnce();
      expect(errorCb.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('passes endpointing option to WebSocket URL', () => {
      stt.createStream({ endpointing: 300 });

      const [url] = wsConstructorCalls[0]!;
      const parsed = new URL(url);
      expect(parsed.searchParams.get('endpointing')).toBe('300');
    });

    it('passes language option to WebSocket URL', () => {
      stt.createStream({ language: 'ja' });

      const [url] = wsConstructorCalls[0]!;
      const parsed = new URL(url);
      expect(parsed.searchParams.get('language')).toBe('ja');
    });
  });
});
