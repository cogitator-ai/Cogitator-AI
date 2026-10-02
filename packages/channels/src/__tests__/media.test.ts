import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaProcessor } from '../media/media-processor';
import { GroqSttProvider, OpenAISttProvider } from '../media/whisper-api';
import { DeepgramSttProvider } from '../media/deepgram-stt';
import { LocalWhisper } from '../media/whisper-local';
import { audioExtension } from '../media/audio-format';

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function okResponse(body: Uint8Array | string, headers: Record<string, string> = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
  };
}

describe('MediaProcessor', () => {
  it('transcribes every audio attachment, including URL-only ones', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(okResponse(new Uint8Array([1, 2, 3])));
    const stt = { transcribe: vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two') };
    const processor = new MediaProcessor(null, () => true, stt);

    const result = await processor.process(
      [
        { type: 'audio', mimeType: 'audio/ogg; codecs=opus', buffer: new Uint8Array([9]) },
        { type: 'audio', mimeType: 'audio/mpeg', url: 'https://cdn/x.mp3' },
      ],
      'm'
    );

    expect(result.transcribedText).toBe('one\ntwo');
    expect(stt.transcribe.mock.calls[0][1]).toBe('audio/ogg');
    expect(fetchMock).toHaveBeenCalledWith('https://cdn/x.mp3');
  });

  it('inlines text files and notes binary files and videos', async () => {
    const processor = new MediaProcessor(null, () => true, null, { maxInlineTextChars: 5 });
    const result = await processor.process(
      [
        {
          type: 'file',
          mimeType: 'application/octet-stream',
          filename: 'notes.md',
          buffer: new TextEncoder().encode('hello world'),
        },
        { type: 'file', mimeType: 'application/zip', filename: 'a.zip', buffer: new Uint8Array(1) },
        { type: 'video', mimeType: 'video/mp4', url: 'https://v' },
      ],
      'm'
    );

    const note = result.systemNotes.find((n) => n.includes('"notes.md"')) ?? '';
    expect(note).toContain('truncated');
    expect(note).toContain('hello');
    expect(note).not.toContain('world');
    expect(result.systemNotes.some((n) => n.includes('"a.zip"') && n.includes('cannot'))).toBe(
      true
    );
    expect(result.systemNotes.some((n) => n.includes('video'))).toBe(true);
  });

  it('reports downloads that fail or exceed the size limit', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(okResponse('x'.repeat(50)));
    const processor = new MediaProcessor(
      null,
      () => true,
      { transcribe: vi.fn() },
      {
        maxDownloadBytes: 10,
      }
    );

    const result = await processor.process(
      [{ type: 'audio', mimeType: 'audio/ogg', url: 'https://big' }],
      'm'
    );

    expect(result.transcribedText).toBeNull();
    expect(result.systemNotes[0]).toContain('could not be downloaded');
  });

  it('normalizes image mime types with parameters', async () => {
    const processor = new MediaProcessor(null, () => true);
    const result = await processor.process(
      [{ type: 'image', mimeType: 'image/png; charset=binary', buffer: new Uint8Array([1]) }],
      'm'
    );
    expect(result.images[0]).toEqual({ data: 'AQ==', mimeType: 'image/png' });
  });

  it('adds a note when the model has no vision', async () => {
    const processor = new MediaProcessor(null, () => false);
    const result = await processor.process(
      [{ type: 'image', mimeType: 'image/png', buffer: new Uint8Array([1]) }],
      'm'
    );
    expect(result.images).toHaveLength(0);
    expect(result.systemNotes[0]).toContain('does not support image');
  });
});

describe('STT providers', () => {
  it('maps mime types to proper file extensions', () => {
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/x-wav')).toBe('wav');
    expect(audioExtension('audio/ogg')).toBe('ogg');
  });

  it.each([
    ['Groq', () => new GroqSttProvider({ apiKey: 'k' }), 'api.groq.com'],
    ['OpenAI', () => new OpenAISttProvider({ apiKey: 'k' }), 'api.openai.com'],
  ])('%s uploads with the right filename', async (_name, create, host) => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: ' hi ' }) });

    const text = await create().transcribe(Buffer.from('x'), 'audio/mpeg');

    expect(text).toBe('hi');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: FormData }];
    expect(url).toContain(host);
    expect((init.body.get('file') as File).name).toBe('audio.mp3');
  });

  it.each([
    ['Groq', () => new GroqSttProvider({ apiKey: 'k' }), 'whisper-large-v3'],
    ['OpenAI', () => new OpenAISttProvider({ apiKey: 'k' }), 'gpt-transcribe'],
  ])('%s uses %s by default', async (_name, create, model) => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ text: 'hi' }) });

    await create().transcribe(Buffer.from('x'), 'audio/mpeg');

    const [, init] = fetchMock.mock.calls[0] as [string, { body: FormData }];
    expect(init.body.get('model')).toBe(model);
  });

  it('Deepgram sends the real content type', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    const text = await new DeepgramSttProvider({ apiKey: 'k' }).transcribe(
      Buffer.from('x'),
      'audio/mpeg; foo=bar'
    );

    expect(text).toBe('');
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['Content-Type']).toBe('audio/mpeg');
  });
});

function wav(opts: { bits: number; channels: number; rate: number; frames: number[][] }): Buffer {
  const bytes = opts.bits / 8;
  const dataSize = opts.frames.length * opts.channels * bytes;
  const list = Buffer.from('LIST\u0004\u0000\u0000\u0000data', 'latin1');
  const buf = Buffer.alloc(12 + 24 + list.length + 8 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(opts.channels, 22);
  buf.writeUInt32LE(opts.rate, 24);
  buf.writeUInt32LE(opts.rate * opts.channels * bytes, 28);
  buf.writeUInt16LE(opts.channels * bytes, 32);
  buf.writeUInt16LE(opts.bits, 34);
  list.copy(buf, 36);
  let offset = 36 + list.length;
  buf.write('data', offset, 'ascii');
  buf.writeUInt32LE(dataSize, offset + 4);
  offset += 8;
  for (const frame of opts.frames) {
    for (const sample of frame) {
      if (opts.bits === 16) buf.writeInt16LE(sample, offset);
      else if (opts.bits === 24) buf.writeIntLE(sample, offset, 3);
      else if (opts.bits === 8) buf.writeUInt8(sample, offset);
      offset += bytes;
    }
  }
  return buf;
}

describe('LocalWhisper WAV decoding', () => {
  const decode = (buf: Buffer) =>
    (
      new LocalWhisper('/nonexistent') as unknown as { decodeWav(b: Buffer): Float32Array }
    ).decodeWav(buf);

  it('skips non-data chunks containing the word "data" and downmixes stereo', () => {
    const samples = decode(
      wav({
        bits: 16,
        channels: 2,
        rate: 16000,
        frames: [
          [16384, -16384],
          [32767, 32767],
        ],
      })
    );
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(0, 5);
    expect(samples[1]).toBeCloseTo(32767 / 32768, 5);
  });

  it('supports 24-bit and 8-bit audio', () => {
    const s24 = decode(wav({ bits: 24, channels: 1, rate: 16000, frames: [[4194304]] }));
    expect(s24[0]).toBeCloseTo(0.5, 5);
    const s8 = decode(wav({ bits: 8, channels: 1, rate: 16000, frames: [[192]] }));
    expect(s8[0]).toBeCloseTo(0.5, 5);
  });

  it('resamples to 16 kHz', () => {
    const frames = Array.from({ length: 32 }, () => [1000]);
    const samples = decode(wav({ bits: 16, channels: 1, rate: 32000, frames }));
    expect(samples.length).toBe(16);
  });

  it('rejects invalid files', () => {
    expect(() => decode(Buffer.from('not a wav file at all'))).toThrow('RIFF');
  });

  it('transcribes through the public pipeline options and trims the text', async () => {
    const whisper = new LocalWhisper('/nonexistent');
    const pipe = vi.fn().mockResolvedValue({ text: '  Hello world  ' });
    (whisper as unknown as { pipeline: unknown }).pipeline = pipe;

    const text = await whisper.transcribe(
      wav({ bits: 16, channels: 1, rate: 16000, frames: [[1000], [2000]] }),
      'audio/wav'
    );

    expect(text).toBe('Hello world');
    expect(pipe).toHaveBeenCalledWith(expect.any(Float32Array), { return_timestamps: false });
  });

  it('rejects unsupported formats with a clear error', async () => {
    const whisper = new LocalWhisper('/nonexistent');
    (whisper as unknown as { pipeline: unknown }).pipeline = {};
    await expect(whisper.transcribe(Buffer.from('ID3....'), 'audio/mpeg')).rejects.toThrow(
      'supports only OGG/Opus and WAV'
    );
  });
});
