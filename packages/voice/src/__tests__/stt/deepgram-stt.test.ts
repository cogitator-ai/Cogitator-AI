import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

interface MockWS extends EventEmitter {
  send: Mock;
  close: Mock;
  terminate: Mock;
  readyState: number;
}

let wsInstances: MockWS[] = [];
let wsConstructorCalls: Array<[string, { headers: Record<string, string> }]> = [];

vi.mock('ws', () => {
  const MockWebSocket = vi.fn(function (
    this: MockWS,
    url: string,
    options: { headers: Record<string, string> }
  ) {
    wsConstructorCalls.push([url, options]);
    EventEmitter.call(this);
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from(''));
    });
    this.terminate = vi.fn(() => {
      this.readyState = 3;
      this.emit('close', 1006, Buffer.from(''));
    });
    this.readyState = 0;
    this.on('open', () => {
      this.readyState = 1;
    });
    wsInstances.push(this);
  });
  Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Object.setPrototypeOf(MockWebSocket.prototype, EventEmitter.prototype);
  return { WebSocket: MockWebSocket };
});

import { DeepgramSTT } from '../../stt/deepgram-stt.js';
import { pcmToWav } from '../../audio.js';

function finalResult(transcript: string, start: number, duration: number, words?: unknown[]) {
  return JSON.stringify({
    type: 'Results',
    is_final: true,
    start,
    duration,
    channel: { alternatives: [{ transcript, confidence: 0.9, ...(words && { words }) }] },
  });
}

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
        'Content-Type': 'application/octet-stream',
      })
    );
    expect(Buffer.from(init.body as ArrayBuffer)).toEqual(audio);
  });

  it('transcribe() declares linear16 encoding for headerless PCM', async () => {
    await stt.transcribe(Buffer.alloc(64));
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(params.get('encoding')).toBe('linear16');
    expect(params.get('sample_rate')).toBe('16000');
    expect(params.get('channels')).toBe('1');
  });

  it('transcribe() sends containerized audio with its mime type and no encoding params', async () => {
    const wav = pcmToWav(Buffer.alloc(64), 16000);
    await stt.transcribe(wav);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get('encoding')).toBeNull();
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
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
      const [url, options] = wsConstructorCalls[0]!;
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('wss:');
      expect(parsed.hostname).toBe('api.deepgram.com');
      expect(parsed.pathname).toBe('/v1/listen');
      expect(parsed.searchParams.get('model')).toBe('nova-3');
      expect(parsed.searchParams.get('punctuate')).toBe('true');
      expect(parsed.searchParams.get('interim_results')).toBe('true');
      expect(parsed.searchParams.get('encoding')).toBe('linear16');
      expect(parsed.searchParams.get('sample_rate')).toBe('16000');
      expect(parsed.searchParams.get('channels')).toBe('1');
      expect(options.headers).toEqual({ Authorization: 'Token dg-test-key' });
    });

    it('uses configured / per-stream sample rate', () => {
      new DeepgramSTT({ apiKey: 'k', sampleRate: 8000 }).createStream();
      stt.createStream({ sampleRate: 24000 });
      expect(new URL(wsConstructorCalls[0]![0]).searchParams.get('sample_rate')).toBe('8000');
      expect(new URL(wsConstructorCalls[1]![0]).searchParams.get('sample_rate')).toBe('24000');
    });

    it('close() returns all final segments joined, not only the last one', async () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;
      ws.emit('open');
      ws.emit(
        'message',
        finalResult('turn on', 0, 0.8, [{ word: 'turn', start: 0, end: 0.3, confidence: 0.9 }])
      );
      ws.emit(
        'message',
        finalResult('the lights', 0.8, 0.7, [
          { word: 'lights', start: 1, end: 1.4, confidence: 0.8 },
        ])
      );
      ws.emit('message', JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1.4 }));
      (ws.send as Mock).mockImplementation((data: unknown) => {
        if (typeof data === 'string' && data.includes('CloseStream')) ws.close();
      });

      const result = await stream.close();
      expect(result.text).toBe('turn on the lights');
      expect(result.duration).toBeCloseTo(1.5);
      expect(result.words?.map((w) => w.word)).toEqual(['turn', 'lights']);
    });

    it('reports an unexpected remote close as an error and drops later writes', () => {
      const stream = stt.createStream();
      const errorCb = vi.fn();
      stream.on('error', errorCb);
      const ws = wsInstances[0]!;
      ws.emit('open');

      ws.emit('close', 1011, Buffer.from('NET-0001'));
      expect(errorCb).toHaveBeenCalledOnce();
      expect((errorCb.mock.calls[0]![0] as Error).message).toContain('1011');

      stream.write(Buffer.from('late'));
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('flushes buffered audio before CloseStream when closed while connecting', async () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;
      stream.write(Buffer.from('early'));
      const closing = stream.close();

      (ws.send as Mock).mockImplementation((data: unknown) => {
        if (typeof data === 'string' && data.includes('CloseStream')) ws.close();
      });
      ws.emit('open');

      await closing;
      expect((ws.send as Mock).mock.calls.map((c) => c[0])).toEqual([
        Buffer.from('early'),
        JSON.stringify({ type: 'CloseStream' }),
      ]);
    });

    it('throws when writing after close', async () => {
      const stream = stt.createStream();
      await stream.close();
      expect(() => stream.write(Buffer.from('x'))).toThrow('cannot write after close');
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

      (ws.send as Mock).mockImplementation((data: string | Buffer) => {
        if (typeof data === 'string') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'CloseStream') {
              setTimeout(() => ws.close(), 0);
            }
          } catch {}
        }
      });

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

    it('stream.close() before WebSocket ready resolves immediately and terminates', async () => {
      const stream = stt.createStream();
      const result = await stream.close();
      expect(result.text).toBe('');
      expect(wsInstances[0]!.terminate).toHaveBeenCalledOnce();
    });

    it('ignores malformed JSON from WebSocket', () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;
      ws.emit('open');

      const errorCb = vi.fn();
      stream.on('error', errorCb);

      ws.emit('message', 'not valid json {{{');

      expect(errorCb).not.toHaveBeenCalled();
    });

    it('ignores messages with empty transcript', () => {
      const stream = stt.createStream();
      const ws = wsInstances[0]!;
      ws.emit('open');

      const partialCb = vi.fn();
      const finalCb = vi.fn();
      stream.on('partial', partialCb);
      stream.on('final', finalCb);

      ws.emit(
        'message',
        JSON.stringify({
          is_final: true,
          channel: { alternatives: [{ transcript: '', confidence: 0 }] },
        })
      );

      expect(partialCb).not.toHaveBeenCalled();
      expect(finalCb).not.toHaveBeenCalled();
    });
  });
});
