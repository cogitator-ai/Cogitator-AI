import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      audio = {
        transcriptions: {
          create: mockCreate,
        },
      };
      constructor(public config: Record<string, unknown>) {
        MockOpenAI.lastConfig = config;
      }
      static lastConfig: Record<string, unknown> = {};
    },
  };
});

import { OpenAISTT } from '../../stt/openai-stt';

describe('OpenAISTT', () => {
  let stt: OpenAISTT;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({
      text: 'hello world',
    });
    stt = new OpenAISTT({ apiKey: 'test-key' });
  });

  it('has correct name', () => {
    expect(stt.name).toBe('openai');
  });

  it('transcribe() calls API with correct params', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio);

    expect(mockCreate).toHaveBeenCalledOnce();
    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('gpt-4o-mini-transcribe');
    expect(args.file).toBeInstanceOf(File);
  });

  it('uses gpt-4o-mini-transcribe by default', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio);

    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('gpt-4o-mini-transcribe');
  });

  it('passes language option', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio, { language: 'en' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.language).toBe('en');
  });

  it('passes prompt option', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio, { prompt: 'technical terms' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.prompt).toBe('technical terms');
  });

  it('allows custom model whisper-1', async () => {
    const customStt = new OpenAISTT({ apiKey: 'test-key', model: 'whisper-1' });
    const audio = Buffer.from('fake-audio');
    await customStt.transcribe(audio);

    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('whisper-1');
  });

  it('allows custom model gpt-4o-transcribe', async () => {
    const customStt = new OpenAISTT({ apiKey: 'test-key', model: 'gpt-4o-transcribe' });
    const audio = Buffer.from('fake-audio');
    await customStt.transcribe(audio);

    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('gpt-4o-transcribe');
  });

  it('returns TranscribeResult from API response', async () => {
    mockCreate.mockResolvedValue({
      text: 'the quick brown fox',
      language: 'en',
      duration: 3.5,
      words: [
        { word: 'the', start: 0, end: 0.3 },
        { word: 'quick', start: 0.3, end: 0.7 },
        { word: 'brown', start: 0.7, end: 1.0 },
        { word: 'fox', start: 1.0, end: 1.3 },
      ],
    });

    const result = await stt.transcribe(Buffer.from('audio'));
    expect(result.text).toBe('the quick brown fox');
    expect(result.language).toBe('en');
    expect(result.duration).toBe(3.5);
    expect(result.words).toHaveLength(4);
    expect(result.words![0]).toEqual({ word: 'the', start: 0, end: 0.3, confidence: 1 });
  });

  it('handles plain text response without metadata', async () => {
    mockCreate.mockResolvedValue({
      text: 'just text',
    });

    const result = await stt.transcribe(Buffer.from('audio'));
    expect(result.text).toBe('just text');
    expect(result.language).toBeUndefined();
    expect(result.duration).toBeUndefined();
    expect(result.words).toBeUndefined();
  });

  it('requests verbose_json format for word timestamps', async () => {
    const audio = Buffer.from('fake-audio');
    await stt.transcribe(audio);

    const args = mockCreate.mock.calls[0][0];
    expect(args.response_format).toBe('verbose_json');
    expect(args.timestamp_granularities).toContain('word');
  });

  it('passes baseURL to OpenAI client', async () => {
    const { default: MockOpenAI } = await import('openai');
    new OpenAISTT({ apiKey: 'key', baseURL: 'https://custom.api.com/v1' });

    expect((MockOpenAI as unknown as { lastConfig: Record<string, unknown> }).lastConfig).toEqual(
      expect.objectContaining({ baseURL: 'https://custom.api.com/v1' })
    );
  });

  describe('createStream()', () => {
    it('returns an STTStream', () => {
      const stream = stt.createStream();
      expect(stream).toBeDefined();
      expect(typeof stream.write).toBe('function');
      expect(typeof stream.close).toBe('function');
      expect(typeof stream.on).toBe('function');
      expect(typeof stream.off).toBe('function');
      expect(typeof stream.removeAllListeners).toBe('function');
    });

    it('accumulates chunks and transcribes on close', async () => {
      const stream = stt.createStream();
      stream.write(Buffer.from('chunk1'));
      stream.write(Buffer.from('chunk2'));

      mockCreate.mockResolvedValue({ text: 'streamed result' });
      const result = await stream.close();

      expect(mockCreate).toHaveBeenCalledOnce();
      expect(result.text).toBe('streamed result');

      const args = mockCreate.mock.calls[0][0];
      const file: File = args.file;
      const arrayBuffer = await file.arrayBuffer();
      const combined = Buffer.from(arrayBuffer);
      expect(combined).toEqual(Buffer.concat([Buffer.from('chunk1'), Buffer.from('chunk2')]));
    });

    it('emits final event on close', async () => {
      const stream = stt.createStream();
      const finalCb = vi.fn();
      stream.on('final', finalCb);

      stream.write(Buffer.from('audio'));
      mockCreate.mockResolvedValue({ text: 'done' });
      await stream.close();

      expect(finalCb).toHaveBeenCalledOnce();
      expect(finalCb).toHaveBeenCalledWith(expect.objectContaining({ text: 'done' }));
    });

    it('emits error event on failure', async () => {
      const stream = stt.createStream();
      const errorCb = vi.fn();
      stream.on('error', errorCb);

      stream.write(Buffer.from('audio'));
      mockCreate.mockRejectedValue(new Error('API error'));

      await expect(stream.close()).rejects.toThrow('API error');
      expect(errorCb).toHaveBeenCalledOnce();
      expect(errorCb.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('passes stream options to transcribe', async () => {
      const stream = stt.createStream({ language: 'fr' });
      stream.write(Buffer.from('audio'));

      mockCreate.mockResolvedValue({ text: 'bonjour' });
      await stream.close();

      const args = mockCreate.mock.calls[0][0];
      expect(args.language).toBe('fr');
    });

    it('off() removes listener', async () => {
      const stream = stt.createStream();
      const cb = vi.fn();
      stream.on('final', cb);
      stream.off('final', cb);

      stream.write(Buffer.from('audio'));
      mockCreate.mockResolvedValue({ text: 'test' });
      await stream.close();

      expect(cb).not.toHaveBeenCalled();
    });

    it('removeAllListeners() removes all listeners', async () => {
      const stream = stt.createStream();
      const cb = vi.fn();
      stream.on('final', cb);
      stream.removeAllListeners();

      stream.write(Buffer.from('audio'));
      mockCreate.mockResolvedValue({ text: 'test' });
      await stream.close();

      expect(cb).not.toHaveBeenCalled();
    });

    it('on() returns this for chaining', () => {
      const stream = stt.createStream();
      const result = stream.on('final', () => {});
      expect(result).toBe(stream);
    });
  });
});
