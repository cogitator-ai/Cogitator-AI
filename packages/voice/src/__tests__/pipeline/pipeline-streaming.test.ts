import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  STTProvider,
  STTStream,
  TTSProvider,
  TranscribeResult,
  VADEvent,
  VADProvider,
  VoiceAgentRunner,
  VoiceTurnOutcome,
} from '../../types';
import { AsyncQueue } from '../../async-queue';
import { PipelineSession } from '../../pipeline/pipeline-session';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ScriptedTurn {
  input: string;
  signal: AbortSignal | undefined;
  deltas: AsyncQueue<string>;
  outcomes: VoiceTurnOutcome[];
  returned: boolean;
}

function streamingRunner(settle?: (outcome: VoiceTurnOutcome) => Promise<void>) {
  const turns: ScriptedTurn[] = [];
  const runner: VoiceAgentRunner = {
    run: vi.fn(),
    stream: vi.fn((input: string, context) => {
      const turn: ScriptedTurn = {
        input,
        signal: context.signal,
        deltas: new AsyncQueue<string>(() => {
          turn.returned = true;
        }),
        outcomes: [],
        returned: false,
      };
      context.signal?.addEventListener('abort', () => turn.deltas.fail(new Error('aborted')));
      turns.push(turn);
      return {
        [Symbol.asyncIterator]: () => turn.deltas,
        settle: async (outcome: VoiceTurnOutcome) => {
          turn.outcomes.push(outcome);
          await settle?.(outcome);
        },
      };
    }),
  };
  return { runner, turns };
}

/** TTS that sends each sentence as two chunks, and waits for a gate before a chosen sentence's second one */
function chunkedTTS() {
  const gates = new Map<string, Deferred>();
  const failures = new Map<string, Error>();
  const tts: TTSProvider = {
    name: 'chunked',
    synthesize: vi.fn(),
    streamSynthesize: vi.fn(async function* (text: string) {
      const failure = failures.get(text);
      if (failure) throw failure;
      yield Buffer.from(`${text}|1`);
      await gates.get(text)?.promise;
      yield Buffer.from(`${text}|2`);
    }),
  };
  return {
    tts,
    gate(sentence: string): Deferred {
      const gate = deferred();
      gates.set(sentence, gate);
      return gate;
    },
    failOn(sentence: string, error: Error): void {
      failures.set(sentence, error);
    },
  };
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

function scriptedVAD(): VADProvider & { next: (event: VADEvent) => void } {
  const queue: VADEvent[] = [];
  return {
    name: 'scripted',
    next: (event) => queue.push(event),
    process: vi.fn(() => queue.shift() ?? { type: 'silence' as const }),
    reset: vi.fn(),
  };
}

interface Recorded {
  audio: string[];
  deltas: string[];
  responses: string[];
  errors: string[];
  turnEnds: number;
  speechStarts: number;
}

function record(session: PipelineSession): Recorded {
  const recorded: Recorded = {
    audio: [],
    deltas: [],
    responses: [],
    errors: [],
    turnEnds: 0,
    speechStarts: 0,
  };
  session.on('audio', (chunk) => recorded.audio.push(chunk.toString()));
  session.on('agent_response_delta', (delta) => recorded.deltas.push(delta));
  session.on('agent_response', (text) => recorded.responses.push(text));
  session.on('error', (err) => recorded.errors.push(err.message));
  session.on('turn_end', () => recorded.turnEnds++);
  session.on('speech_start', () => recorded.speechStarts++);
  return recorded;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PipelineSession with a streaming runner', () => {
  let session: PipelineSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  function start(
    runner: VoiceAgentRunner,
    tts: TTSProvider,
    extra: { vad?: VADProvider; stt?: STTProvider; bargeIn?: boolean } = {}
  ) {
    session = new PipelineSession({
      stt: extra.stt ?? createSTT(),
      tts,
      agent: runner,
      ttsOptions: { voice: 'nova' },
      ...(extra.vad && { vad: extra.vad }),
      ...(extra.bargeIn !== undefined && { bargeIn: extra.bargeIn }),
    });
    return { session, recorded: record(session) };
  }

  it('speaks each sentence in order while the answer is still generated', async () => {
    const { runner, turns } = streamingRunner();
    const { tts } = chunkedTTS();
    const { session, recorded } = start(runner, tts);

    const done = session.sendText('hello');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0]!;
    turn.deltas.push('Hi there');
    turn.deltas.push('. How');

    await vi.waitFor(() => expect(recorded.audio).toEqual(['Hi there.|1', 'Hi there.|2']));
    expect(session.currentState).toBe('speaking');
    expect(recorded.responses).toEqual([]);

    turn.deltas.push(' are you? Fine');
    turn.deltas.end();
    await done;

    expect(recorded.audio).toEqual([
      'Hi there.|1',
      'Hi there.|2',
      'How are you?|1',
      'How are you?|2',
      'Fine|1',
      'Fine|2',
    ]);
    expect(recorded.deltas).toEqual(['Hi there', '. How', ' are you? Fine']);
    expect(recorded.responses).toEqual(['Hi there. How are you? Fine']);
    expect(recorded.turnEnds).toBe(1);
    expect(tts.streamSynthesize).toHaveBeenCalledWith('Hi there.', { voice: 'nova' });
    expect(turn.outcomes).toEqual([{ spoken: 'Hi there. How are you? Fine', interrupted: false }]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(turn.input).toBe('hello');
    expect(session.currentState).toBe('idle');
  });

  it('settles only the sentences already spoken when interrupted mid-generation', async () => {
    const { runner, turns } = streamingRunner();
    const { tts } = chunkedTTS();
    const { session, recorded } = start(runner, tts);

    const done = session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0]!;
    turn.deltas.push('First part. Second');
    await vi.waitFor(() => expect(recorded.audio).toHaveLength(2));

    session.interrupt();
    await done;
    await vi.waitFor(() => expect(turn.outcomes).toHaveLength(1));

    expect(turn.signal?.aborted).toBe(true);
    expect(turn.outcomes[0]).toEqual({ spoken: 'First part. ', interrupted: true });
    expect(recorded.responses).toEqual([]);
    expect(recorded.turnEnds).toBe(0);
    expect(recorded.errors).toEqual([]);
    expect(session.currentState).toBe('idle');
  });

  it('leaves out a sentence whose audio was cut off mid-speech', async () => {
    const { runner, turns } = streamingRunner();
    const control = chunkedTTS();
    control.gate('Two.');
    const { session, recorded } = start(runner, control.tts);

    void session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0]!;
    turn.deltas.push('One. Two. Three.');
    turn.deltas.end();
    await vi.waitFor(() => expect(recorded.audio).toContain('Two.|1'));
    expect(recorded.responses).toEqual(['One. Two. Three.']);

    session.interrupt();
    await vi.waitFor(() => expect(turn.outcomes).toHaveLength(1));

    expect(turn.outcomes[0]).toEqual({ spoken: 'One. ', interrupted: true });
    expect(recorded.audio).toEqual(['One.|1', 'One.|2', 'Two.|1']);
    expect(recorded.turnEnds).toBe(0);
  });

  it('settles with nothing spoken when interrupted before the first sentence', async () => {
    const { runner, turns } = streamingRunner();
    const { session, recorded } = start(runner, chunkedTTS().tts);

    void session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.push('Still thinking');
    await flush();
    session.interrupt();

    await vi.waitFor(() => expect(turns[0]!.outcomes).toEqual([{ spoken: '', interrupted: true }]));
    expect(recorded.audio).toEqual([]);
  });

  it('ends an empty answer without TTS', async () => {
    const { runner, turns } = streamingRunner();
    const { tts } = chunkedTTS();
    const { session, recorded } = start(runner, tts);

    const done = session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.end();
    await done;

    expect(tts.streamSynthesize).not.toHaveBeenCalled();
    expect(recorded.responses).toEqual(['']);
    expect(recorded.turnEnds).toBe(1);
    expect(turns[0]!.outcomes).toEqual([{ spoken: '', interrupted: false }]);
  });

  it('reports a failing answer stream and settles what was spoken', async () => {
    const { runner, turns } = streamingRunner();
    const { session, recorded } = start(runner, chunkedTTS().tts);

    const done = session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.push('Said this. And');
    await vi.waitFor(() => expect(recorded.audio).toHaveLength(2));
    turns[0]!.deltas.fail(new Error('model down'));
    await done;

    expect(recorded.errors).toEqual(['model down']);
    expect(turns[0]!.outcomes).toEqual([{ spoken: 'Said this. ', interrupted: true }]);
    expect(recorded.turnEnds).toBe(0);
    expect(session.currentState).toBe('idle');
  });

  it('stops generating when speech synthesis fails', async () => {
    const { runner, turns } = streamingRunner();
    const control = chunkedTTS();
    control.failOn('Two.', new Error('tts quota'));
    const { session, recorded } = start(runner, control.tts);

    const done = session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.push('One. Two. Three');
    await done;

    expect(recorded.errors).toEqual(['tts quota']);
    expect(turns[0]!.returned).toBe(true);
    expect(turns[0]!.outcomes).toEqual([{ spoken: 'One. ', interrupted: true }]);
    expect(recorded.audio).toEqual(['One.|1', 'One.|2']);
    expect(session.currentState).toBe('idle');
  });

  it('starts the next turn once the interrupted one settled', async () => {
    const settled = deferred();
    const { runner, turns } = streamingRunner(() => settled.promise);
    const { session, recorded } = start(runner, chunkedTTS().tts);

    void session.sendText('first');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.push('Partial. Answer');
    await vi.waitFor(() => expect(recorded.audio).toHaveLength(2));

    const second = session.sendText('second');
    await flush();
    await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.outcomes).toEqual([{ spoken: 'Partial. ', interrupted: true }]);

    settled.resolve();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.deltas.push('Second answer.');
    turns[1]!.deltas.end();
    await second;

    expect(recorded.responses).toEqual(['Second answer.']);
    expect(recorded.turnEnds).toBe(1);
  });

  it('reports a failing settle as an error', async () => {
    const { runner, turns } = streamingRunner(async () => {
      throw new Error('memory down');
    });
    const { session, recorded } = start(runner, chunkedTTS().tts);

    const done = session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.push('Fine.');
    turns[0]!.deltas.end();
    await done;

    expect(recorded.errors).toEqual(['memory down']);
    expect(recorded.turnEnds).toBe(1);
  });

  it('settles the turn in progress when the session closes', async () => {
    const { runner, turns } = streamingRunner();
    const { session } = start(runner, chunkedTTS().tts);

    void session.sendText('question');
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0]!.deltas.push('Never finished');

    await session.close();

    expect(turns[0]!.signal?.aborted).toBe(true);
    expect(turns[0]!.outcomes).toEqual([{ spoken: '', interrupted: true }]);
  });

  describe('barge-in', () => {
    async function speakingSession(bargeIn: boolean | undefined) {
      const { runner, turns } = streamingRunner();
      const control = chunkedTTS();
      control.gate('Long answer.');
      const vad = scriptedVAD();
      const stt = createSTT();
      const { session, recorded } = start(runner, control.tts, { vad, stt, bargeIn });

      void session.sendText('question');
      await vi.waitFor(() => expect(turns).toHaveLength(1));
      turns[0]!.deltas.push('Long answer. More');
      await vi.waitFor(() => expect(session.currentState).toBe('speaking'));
      return { session, recorded, turns, vad, stt };
    }

    it('interrupts the reply and listens when the user speaks over it', async () => {
      const { session, recorded, turns, vad, stt } = await speakingSession(true);
      const resets = vi.mocked(vad.reset).mock.calls.length;

      vad.next({ type: 'speech_start' });
      session.pushAudio(Buffer.alloc(64));

      await vi.waitFor(() => expect(session.currentState).toBe('listening'));
      expect(turns[0]!.signal?.aborted).toBe(true);
      expect(recorded.speechStarts).toBe(1);
      expect(stt.streams).toHaveLength(1);
      expect(stt.streams[0]!.written).toHaveLength(1);
      expect(vad.reset).toHaveBeenCalledTimes(resets);
      await vi.waitFor(() =>
        expect(turns[0]!.outcomes).toEqual([{ spoken: '', interrupted: true }])
      );
    });

    it('interrupts a turn that is still thinking', async () => {
      const { runner, turns } = streamingRunner();
      const vad = scriptedVAD();
      const { session } = start(runner, chunkedTTS().tts, { vad, bargeIn: true });

      void session.sendText('question');
      await vi.waitFor(() => expect(turns).toHaveLength(1));
      expect(session.currentState).toBe('processing');

      vad.next({ type: 'speech_start' });
      session.pushAudio(Buffer.alloc(64));

      await vi.waitFor(() => expect(session.currentState).toBe('listening'));
      expect(turns[0]!.signal?.aborted).toBe(true);
    });

    it('ignores speech while the agent speaks when off (the default)', async () => {
      const { session, recorded, turns, vad, stt } = await speakingSession(undefined);

      vad.next({ type: 'speech_start' });
      session.pushAudio(Buffer.alloc(64));
      await flush();

      expect(session.currentState).toBe('speaking');
      expect(turns[0]!.signal?.aborted).toBe(false);
      expect(recorded.speechStarts).toBe(0);
      expect(stt.streams).toHaveLength(0);
    });
  });
});
