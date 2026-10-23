import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type {
  STTProvider,
  STTStream,
  STTStreamOptions,
  TTSOptions,
  TTSProvider,
  TranscribeResult,
  VADEvent,
  VADProvider,
  VoiceAgentRunner,
  VoicePlayback,
  VoiceTurnOutcome,
} from '../../types';
import { AsyncQueue } from '../../async-queue';
import { PipelineSession } from '../../pipeline/pipeline-session';
import { float32ToMulaw, mulawToPcm16 } from '../../codec';

/** A playback whose marks the test plays or drops */
class FakePlayback implements VoicePlayback {
  readonly marks: Array<{ resolve: (played: boolean) => void; settled: boolean }> = [];
  clears = 0;

  mark(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const entry = {
        settled: false,
        resolve: (played: boolean) => {
          if (entry.settled) return;
          entry.settled = true;
          resolve(played);
        },
      };
      this.marks.push(entry);
    });
  }

  clear(): void {
    this.clears++;
    for (const mark of this.marks) mark.resolve(false);
  }

  play(index: number): void {
    this.marks[index]!.resolve(true);
  }
}

function streamingRunner() {
  const outcomes: VoiceTurnOutcome[] = [];
  const deltas: Array<AsyncQueue<string, string>> = [];
  const runner: VoiceAgentRunner = {
    run: vi.fn(),
    stream: vi.fn((_input: string, context) => {
      const queue = new AsyncQueue<string, string>();
      context.signal?.addEventListener('abort', () => queue.fail(new Error('aborted')));
      deltas.push(queue);
      return {
        [Symbol.asyncIterator]: () => queue,
        settle: async (outcome: VoiceTurnOutcome) => {
          outcomes.push(outcome);
        },
      };
    }),
  };
  return { runner, outcomes, deltas };
}

function echoTTS(): TTSProvider & { options: Array<TTSOptions | undefined> } {
  const options: Array<TTSOptions | undefined> = [];
  return {
    name: 'echo',
    options,
    synthesize: vi.fn(),
    async *streamSynthesize(text: string, opts?: TTSOptions) {
      options.push(opts);
      yield Buffer.from(text);
    },
  };
}

class FakeStream extends EventEmitter implements STTStream {
  readonly written: Buffer[] = [];
  write(chunk: Buffer): void {
    this.written.push(chunk);
  }
  async close(): Promise<TranscribeResult> {
    return { text: '' };
  }
}

function fakeSTT(streamEncodings?: STTProvider['streamEncodings']) {
  const streams: FakeStream[] = [];
  const options: Array<STTStreamOptions | undefined> = [];
  const stt: STTProvider = {
    name: 'fake',
    ...(streamEncodings && { streamEncodings }),
    transcribe: vi.fn(),
    createStream: (opts?: STTStreamOptions) => {
      options.push(opts);
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  };
  return { stt, streams, options };
}

describe('PipelineSession with a playback', () => {
  it('settles a turn once its sentences were played, and only then ends it', async () => {
    const { runner, outcomes, deltas } = streamingRunner();
    const playback = new FakePlayback();
    const session = new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: runner },
      { playback }
    );
    const turnEnd = vi.fn();
    session.on('turn_end', turnEnd);

    const turn = session.sendText('hi');
    await vi.waitFor(() => expect(deltas).toHaveLength(1));
    deltas[0]!.push('One. Two. ');
    deltas[0]!.end('One. Two. ');
    await vi.waitFor(() => expect(playback.marks).toHaveLength(2));

    expect(session.currentState).toBe('speaking');
    playback.play(0);
    playback.play(1);
    await turn;

    expect(turnEnd).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ spoken: 'One. Two. ', interrupted: false }]);
  });

  it('keeps only the sentences the listener heard when a turn is interrupted', async () => {
    const { runner, outcomes, deltas } = streamingRunner();
    const playback = new FakePlayback();
    const session = new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: runner },
      { playback }
    );
    const turnEnd = vi.fn();
    session.on('turn_end', turnEnd);

    const turn = session.sendText('hi');
    await vi.waitFor(() => expect(deltas).toHaveLength(1));
    deltas[0]!.push('One. Two. Three. ');
    deltas[0]!.end('One. Two. Three. ');
    await vi.waitFor(() => expect(playback.marks).toHaveLength(3));
    playback.play(0);
    const clears = playback.clears;
    session.interrupt();
    await turn;

    expect(playback.clears).toBe(clears + 1);
    expect(outcomes).toEqual([{ spoken: 'One. ', interrupted: true }]);
    expect(turnEnd).not.toHaveBeenCalled();
  });

  it('counts a sentence whose audio was sent but dropped as not spoken', async () => {
    const { runner, outcomes, deltas } = streamingRunner();
    const playback = new FakePlayback();
    const session = new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: runner },
      { playback }
    );
    const turn = session.sendText('hi');
    await vi.waitFor(() => expect(deltas).toHaveLength(1));
    deltas[0]!.push('One. Two. ');
    deltas[0]!.end('One. Two. ');
    await vi.waitFor(() => expect(playback.marks).toHaveLength(2));
    playback.play(0);
    playback.marks[1]!.resolve(false);
    await turn;
    expect(outcomes).toEqual([{ spoken: 'One. ', interrupted: true }]);
  });

  it('waits for the mark of an answer from run before the turn ends', async () => {
    const playback = new FakePlayback();
    const runner: VoiceAgentRunner = { run: vi.fn().mockResolvedValue({ content: 'Hello.' }) };
    const session = new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: runner },
      { playback }
    );
    const turnEnd = vi.fn();
    session.on('turn_end', turnEnd);
    const turn = session.sendText('hi');
    await vi.waitFor(() => expect(playback.marks).toHaveLength(1));
    expect(turnEnd).not.toHaveBeenCalled();
    playback.play(0);
    await turn;
    expect(turnEnd).toHaveBeenCalledTimes(1);
  });

  it('clears the playback when it closes', async () => {
    const playback = new FakePlayback();
    const session = new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: streamingRunner().runner },
      { playback }
    );
    await session.close();
    expect(playback.clears).toBeGreaterThan(0);
  });

  it('asks the TTS with the session options over the pipeline options', async () => {
    const tts = echoTTS();
    const runner: VoiceAgentRunner = { run: vi.fn().mockResolvedValue({ content: 'Hello.' }) };
    const session = new PipelineSession(
      { stt: fakeSTT().stt, tts, agent: runner, ttsOptions: { voice: 'v', format: 'mp3' } },
      { ttsOptions: { format: 'mulaw' } }
    );
    await session.sendText('hi');
    expect(tts.options).toEqual([{ voice: 'v', format: 'mulaw' }]);
  });
});

describe('PipelineSession with μ-law input', () => {
  const mulaw = float32ToMulaw(new Float32Array(160).fill(0.25));

  it('writes μ-law as is to an STT that takes it', () => {
    const { stt, streams, options } = fakeSTT(['pcm16', 'mulaw']);
    const session = new PipelineSession(
      { stt, tts: echoTTS(), agent: streamingRunner().runner },
      { input: { encoding: 'mulaw', sampleRate: 8000 } }
    );
    session.pushAudio(mulaw);
    expect(options).toEqual([{ sampleRate: 8000, encoding: 'mulaw' }]);
    expect(streams[0]!.written).toEqual([mulaw]);
  });

  it('decodes μ-law to PCM16 for an STT that does not', () => {
    const { stt, streams, options } = fakeSTT();
    const session = new PipelineSession(
      { stt, tts: echoTTS(), agent: streamingRunner().runner },
      { input: { encoding: 'mulaw', sampleRate: 8000 } }
    );
    session.pushAudio(mulaw);
    expect(options).toEqual([{ sampleRate: 8000, encoding: 'pcm16' }]);
    expect(streams[0]!.written).toEqual([mulawToPcm16(mulaw)]);
  });

  it('gives the VAD decoded audio at its own rate', async () => {
    const seen: Float32Array[] = [];
    const vad = (sampleRate: number): VADProvider => ({
      name: 'spy',
      sampleRate,
      process(samples: Float32Array): VADEvent {
        seen.push(samples);
        return { type: 'silence' };
      },
      reset() {},
    });
    const input = { encoding: 'mulaw', sampleRate: 8000 } as const;
    const runner = streamingRunner().runner;

    new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: runner, vad: vad(8000) },
      { input }
    ).pushAudio(mulaw);
    expect(seen[0]).toHaveLength(160);
    expect(seen[0]![0]).toBeCloseTo(0.25, 1);

    const upsampled = new PipelineSession(
      { stt: fakeSTT().stt, tts: echoTTS(), agent: runner, vad: vad(16000) },
      { input }
    );
    let total = 0;
    for (let i = 0; i < 10; i++) {
      upsampled.pushAudio(mulaw);
      total += seen.at(-1)!.length;
    }
    expect(total).toBeGreaterThan(2 * 160 * 10 - 100);
    expect(total).toBeLessThanOrEqual(2 * 160 * 10);
  });

  it('opens the STT stream without options when no input format is given', () => {
    const { stt, options } = fakeSTT();
    new PipelineSession({ stt, tts: echoTTS(), agent: streamingRunner().runner }).pushAudio(
      Buffer.alloc(320)
    );
    expect(options).toEqual([undefined]);
  });
});
