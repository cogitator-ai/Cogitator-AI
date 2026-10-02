import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  STTProvider,
  STTStream,
  TTSProvider,
  TranscribeResult,
  VADEvent,
  VADProvider,
} from '../../types';
import { PipelineSession } from '../../pipeline/pipeline-session';
import { VoicePipeline } from '../../pipeline/voice-pipeline';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeStream extends EventEmitter implements STTStream {
  readonly written: Buffer[] = [];
  readonly result = deferred<TranscribeResult>();
  write(chunk: Buffer): void {
    this.written.push(chunk);
  }
  close(): Promise<TranscribeResult> {
    return this.result.promise;
  }
}

function createSTT(): STTProvider & { streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  return {
    name: 'fake',
    streams,
    transcribe: vi.fn(),
    createStream: vi.fn(() => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    }),
  };
}

function createTTS(): TTSProvider {
  return {
    name: 'fake',
    synthesize: vi.fn().mockResolvedValue(Buffer.from('tts')),
    streamSynthesize: vi.fn(async function* (text: string) {
      yield Buffer.from(`audio:${text}`);
    }),
  };
}

function scriptedVAD(): VADProvider & { next: (event: VADEvent | Promise<VADEvent>) => void } {
  const queue: Array<VADEvent | Promise<VADEvent>> = [];
  return {
    name: 'scripted',
    next: (event) => queue.push(event),
    process: vi.fn(() => queue.shift() ?? { type: 'silence' as const }),
    reset: vi.fn(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PipelineSession race conditions and edge cases', () => {
  let session: PipelineSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it('interrupt during processing does not clobber the state of a new utterance', async () => {
    const stt = createSTT();
    const agentResult = deferred<{ content: string }>();
    const agent = { run: vi.fn().mockReturnValueOnce(agentResult.promise) };
    const vad = scriptedVAD();
    session = new PipelineSession({ stt, tts: createTTS(), agent, vad });
    const responses: string[] = [];
    session.on('agent_response', (text) => responses.push(text));

    vad.next({ type: 'speech_start' });
    session.pushAudio(Buffer.alloc(4));
    vad.next({ type: 'speech_end', duration: 100 });
    session.pushAudio(Buffer.alloc(4));
    await flush();
    stt.streams[0]!.result.resolve({ text: 'first' });
    await vi.waitFor(() => expect(agent.run).toHaveBeenCalledOnce());

    session.interrupt();

    vad.next({ type: 'speech_start' });
    session.pushAudio(Buffer.alloc(4));
    await flush();
    expect(session.currentState).toBe('listening');

    agentResult.resolve({ content: 'stale answer' });
    await flush();
    await flush();

    expect(session.currentState).toBe('listening');
    expect(responses).toEqual([]);
    expect(stt.streams).toHaveLength(2);
  });

  it('keeps processing VAD events after the VAD rejects once', async () => {
    const stt = createSTT();
    const vad = scriptedVAD();
    session = new PipelineSession({
      stt,
      tts: createTTS(),
      agent: { run: vi.fn().mockResolvedValue({ content: 'ok' }) },
      vad,
    });
    const errors: Error[] = [];
    session.on('error', (err) => errors.push(err));
    const speechStart = vi.fn();
    session.on('speech_start', speechStart);

    vad.next(Promise.reject(new Error('vad exploded')));
    session.pushAudio(Buffer.alloc(4));
    vad.next({ type: 'speech_start' });
    session.pushAudio(Buffer.alloc(4));

    await vi.waitFor(() => expect(speechStart).toHaveBeenCalledOnce());
    expect(errors.map((e) => e.message)).toEqual(['vad exploded']);
  });

  it('reports a synchronously throwing VAD as an error instead of throwing from pushAudio', () => {
    const vad: VADProvider = {
      name: 'throwing',
      process: () => {
        throw new Error('bad frame');
      },
      reset: vi.fn(),
    };
    session = new PipelineSession({
      stt: createSTT(),
      tts: createTTS(),
      agent: { run: vi.fn() },
      vad,
    });
    const errors: Error[] = [];
    session.on('error', (err) => errors.push(err));

    expect(() => session!.pushAudio(Buffer.alloc(4))).not.toThrow();
    expect(errors.map((e) => e.message)).toEqual(['bad frame']);
  });

  it('skips the agent and TTS when the transcript is empty', async () => {
    const stt = createSTT();
    const tts = createTTS();
    const agent = { run: vi.fn() };
    session = new PipelineSession({ stt, tts, agent });

    session.pushAudio(Buffer.alloc(4));
    session.endAudio();
    await flush();
    stt.streams[0]!.result.resolve({ text: '   ' });
    await flush();
    await flush();

    expect(agent.run).not.toHaveBeenCalled();
    expect(tts.streamSynthesize).not.toHaveBeenCalled();
    expect(session.currentState).toBe('idle');
  });

  it('does not call TTS for an empty agent response but still ends the turn', async () => {
    const stt = createSTT();
    const tts = createTTS();
    session = new PipelineSession({
      stt,
      tts,
      agent: { run: vi.fn().mockResolvedValue({ content: '' }) },
    });
    const turnEnd = vi.fn();
    session.on('turn_end', turnEnd);

    await session.sendText('hello');

    expect(tts.streamSynthesize).not.toHaveBeenCalled();
    expect(turnEnd).toHaveBeenCalledOnce();
  });

  it('sendText() runs a full turn with the session id and emits audio + turn_end', async () => {
    const agent = { run: vi.fn().mockResolvedValue({ content: 'hi there' }) };
    session = new PipelineSession(
      { stt: createSTT(), tts: createTTS(), agent },
      { sessionId: 'session-42' }
    );
    const audio: string[] = [];
    session.on('audio', (chunk) => audio.push(chunk.toString()));
    const turnEnd = vi.fn();
    session.on('turn_end', turnEnd);

    await session.sendText('hello');

    expect(session.id).toBe('session-42');
    expect(agent.run).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ sessionId: 'session-42' })
    );
    expect(audio).toEqual(['audio:hi there']);
    expect(turnEnd).toHaveBeenCalledOnce();
  });

  it('sendText() interrupts the turn in progress', async () => {
    const slow = deferred<{ content: string }>();
    const agent = {
      run: vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ content: 'second' }),
    };
    session = new PipelineSession({ stt: createSTT(), tts: createTTS(), agent });
    const responses: string[] = [];
    session.on('agent_response', (text) => responses.push(text));

    const first = session.sendText('one');
    const second = session.sendText('two');
    slow.resolve({ content: 'first' });
    await Promise.all([first, second]);

    expect(responses).toEqual(['second']);
  });

  it('ignores queued VAD events after close()', async () => {
    const stt = createSTT();
    const vadEvent = deferred<VADEvent>();
    const vad = scriptedVAD();
    session = new PipelineSession({ stt, tts: createTTS(), agent: { run: vi.fn() }, vad });

    vad.next(vadEvent.promise);
    session.pushAudio(Buffer.alloc(4));
    await session.close();
    vadEvent.resolve({ type: 'speech_start' });
    await flush();

    expect(stt.createStream).not.toHaveBeenCalled();
  });

  it('writes the trailing chunk on speech_end before closing the stream', async () => {
    const stt = createSTT();
    const vad = scriptedVAD();
    session = new PipelineSession({
      stt,
      tts: createTTS(),
      agent: { run: vi.fn().mockResolvedValue({ content: 'ok' }) },
      vad,
    });

    vad.next({ type: 'speech_start' });
    session.pushAudio(Buffer.from([1, 0]));
    vad.next({ type: 'speech_end', duration: 10 });
    session.pushAudio(Buffer.from([2, 0]));
    await flush();

    expect(stt.streams[0]!.written).toEqual([Buffer.from([1, 0]), Buffer.from([2, 0])]);
  });

  it('reports a failing stream write as a session error', async () => {
    const stt = createSTT();
    session = new PipelineSession({ stt, tts: createTTS(), agent: { run: vi.fn() } });
    const errors: Error[] = [];
    session.on('error', (err) => errors.push(err));

    session.pushAudio(Buffer.alloc(2));
    vi.spyOn(stt.streams[0]!, 'write').mockImplementation(() => {
      throw new Error('write after close');
    });
    session.pushAudio(Buffer.alloc(2));

    expect(errors.map((e) => e.message)).toEqual(['write after close']);
  });
});

describe('VoicePipeline.process edge cases', () => {
  it('returns empty response and audio for a silent input without calling agent or TTS', async () => {
    const stt = createSTT();
    (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({ text: '' });
    const tts = createTTS();
    const agent = { run: vi.fn() };
    const pipeline = new VoicePipeline({ stt, tts, agent });

    const result = await pipeline.process(Buffer.alloc(8));

    expect(result).toEqual({ transcript: '', response: '', audio: Buffer.alloc(0) });
    expect(agent.run).not.toHaveBeenCalled();
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it('skips TTS for an empty agent response and forwards the session id', async () => {
    const stt = createSTT();
    (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'hi' });
    const tts = createTTS();
    const agent = { run: vi.fn().mockResolvedValue({ content: '' }) };
    const pipeline = new VoicePipeline({ stt, tts, agent });

    const result = await pipeline.process(Buffer.alloc(8), { sessionId: 's1' });

    expect(agent.run).toHaveBeenCalledWith('hi', { sessionId: 's1' });
    expect(result.audio.length).toBe(0);
    expect(tts.synthesize).not.toHaveBeenCalled();
  });
});
