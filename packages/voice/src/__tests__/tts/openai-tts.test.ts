import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      audio = {
        speech: {
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

import { OpenAITTS } from '../../tts/openai-tts';

describe('OpenAITTS', () => {
  let tts: OpenAITTS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
    });
    tts = new OpenAITTS({ apiKey: 'test-key' });
  });

  it('has correct name', () => {
    expect(tts.name).toBe('openai');
  });

  it('synthesize() returns audio Buffer', async () => {
    const result = await tts.synthesize('Hello world');

    expect(result).toBeInstanceOf(Buffer);
    expect(result).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('uses gpt-4o-mini-tts by default', async () => {
    await tts.synthesize('test');

    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('gpt-4o-mini-tts');
  });

  it('uses alloy voice by default', async () => {
    await tts.synthesize('test');

    const args = mockCreate.mock.calls[0][0];
    expect(args.voice).toBe('alloy');
  });

  it('passes voice option', async () => {
    await tts.synthesize('test', { voice: 'nova' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.voice).toBe('nova');
  });

  it('passes speed option', async () => {
    await tts.synthesize('test', { speed: 1.5 });

    const args = mockCreate.mock.calls[0][0];
    expect(args.speed).toBe(1.5);
  });

  it('passes instructions option', async () => {
    await tts.synthesize('test', { instructions: 'Speak slowly and calmly' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.instructions).toBe('Speak slowly and calmly');
  });

  it('passes format option and maps pcm16 to pcm', async () => {
    await tts.synthesize('test', { format: 'pcm16' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.response_format).toBe('pcm');
  });

  it('passes non-pcm16 formats as-is', async () => {
    await tts.synthesize('test', { format: 'mp3' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.response_format).toBe('mp3');
  });

  it('allows custom model', async () => {
    const customTts = new OpenAITTS({ apiKey: 'test-key', model: 'tts-1-hd' });
    await customTts.synthesize('test');

    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('tts-1-hd');
  });

  it('streamSynthesize() yields audio chunks', async () => {
    const chunk1 = new Uint8Array([10, 20]);
    const chunk2 = new Uint8Array([30, 40]);

    async function* fakeBody() {
      yield chunk1;
      yield chunk2;
    }

    mockCreate.mockResolvedValue({ body: fakeBody() });

    const chunks: Buffer[] = [];
    for await (const chunk of tts.streamSynthesize('test')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(Buffer.from([10, 20]));
    expect(chunks[1]).toEqual(Buffer.from([30, 40]));
  });

  it('passes baseURL to OpenAI client', async () => {
    const { default: MockOpenAI } = await import('openai');
    new OpenAITTS({ apiKey: 'key', baseURL: 'https://custom.api.com/v1' });

    expect((MockOpenAI as unknown as { lastConfig: Record<string, unknown> }).lastConfig).toEqual(
      expect.objectContaining({ baseURL: 'https://custom.api.com/v1' })
    );
  });

  it('passes config voice as default when no option voice', async () => {
    const customTts = new OpenAITTS({ apiKey: 'test-key', voice: 'sage' });
    await customTts.synthesize('test');

    const args = mockCreate.mock.calls[0][0];
    expect(args.voice).toBe('sage');
  });

  it('option voice overrides config voice', async () => {
    const customTts = new OpenAITTS({ apiKey: 'test-key', voice: 'sage' });
    await customTts.synthesize('test', { voice: 'echo' });

    const args = mockCreate.mock.calls[0][0];
    expect(args.voice).toBe('echo');
  });
});
