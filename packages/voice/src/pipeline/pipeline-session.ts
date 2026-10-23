import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import type {
  RawAudioFormat,
  STTStream,
  STTStreamOptions,
  TTSOptions,
  VADEvent,
  VoicePipelineConfig,
  VoicePlayback,
  VoiceTurn,
} from '../types.js';
import { pcm16ToFloat32 } from '../audio.js';
import { mulawToFloat32, mulawToPcm16 } from '../codec.js';
import { Resampler } from '../resampler.js';
import { AsyncQueue } from '../async-queue.js';
import { DEFAULT_SETTLE_TIMEOUT, bounded } from '../timing.js';
import { SentenceSplitter, maxSentenceLength } from './sentence-splitter.js';

type SessionState = 'idle' | 'listening' | 'processing' | 'speaking';

interface PipelineSessionEvents {
  speech_start: [];
  speech_end: [];
  transcript: [text: string, isFinal: boolean];
  agent_response: [content: string];
  agent_response_delta: [delta: string];
  audio: [chunk: Buffer];
  turn_end: [];
  error: [error: Error];
}

export interface PipelineSessionOptions {
  sessionId?: string;
  /**
   * Format of the audio `pushAudio` gets, such as μ-law at 8 kHz from a phone call. The STT
   * stream is opened at its rate, and gets μ-law as is when the provider lists it in
   * `streamEncodings`, decoded to PCM16 otherwise. The VAD gets the audio decoded, resampled to
   * its `sampleRate` when that differs. Without it, `pushAudio` takes PCM16 at the rates the STT
   * and VAD were configured for.
   */
  input?: RawAudioFormat;
  /** TTS options of this session, over the pipeline's `ttsOptions` */
  ttsOptions?: TTSOptions;
  /**
   * Where the session's audio is played, when the transport learns what the listener heard. The
   * session marks the end of each spoken sentence, stays `speaking` until the marks come back,
   * drops the queued audio (`clear`) when a turn is stopped, and settles a streamed turn with
   * only the sentences whose marks were played.
   */
  playback?: VoicePlayback;
}

interface SpokenSegment {
  text: string;
  played: Promise<boolean>;
}

const ABORTED: unique symbol = Symbol('aborted');

export { DEFAULT_SETTLE_TIMEOUT };

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Stops an iterator the session no longer reads, whatever it does on `return` */
function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  } catch {
    return;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(err));
      }
    );
  });
}

/** The text of the segments played, up to the first one that was not */
async function heard(segments: SpokenSegment[]): Promise<{ spoken: string; heardAll: boolean }> {
  let spoken = '';
  for (const segment of segments) {
    if (!(await segment.played)) return { spoken, heardAll: false };
    spoken += segment.text;
  }
  return { spoken, heardAll: true };
}

/**
 * One voice conversation: audio in, through the VAD and STT, to the agent, and its answer back
 * as audio. With a runner that streams (`VoiceAgentRunner.stream`) the answer is spoken sentence
 * by sentence while it is generated, `agent_response_delta` carries each piece of text and
 * `agent_response` the whole answer once it is generated. When such a turn ends, the runner's
 * `settle` hears what was spoken: the sentences whose audio was sent in full, or with a
 * `playback` (a phone call) the sentences the listener played.
 */
export class PipelineSession extends EventEmitter<PipelineSessionEvents> {
  readonly id: string;
  private readonly stt: VoicePipelineConfig['stt'];
  private readonly tts: VoicePipelineConfig['tts'];
  private readonly vad: VoicePipelineConfig['vad'];
  private readonly agent: VoicePipelineConfig['agent'];
  private readonly ttsOptions: VoicePipelineConfig['ttsOptions'];
  private readonly input: RawAudioFormat | undefined;
  private readonly sttEncodesInput: boolean;
  private readonly vadResampler: Resampler | null;
  private readonly playback: VoicePlayback | undefined;
  private readonly bargeIn: boolean;
  private readonly maxSentenceLength: number;
  private readonly settleTimeout: number;
  private state: SessionState = 'idle';
  private stream: STTStream | null = null;
  private turn = new AbortController();
  private closed = false;
  private activeProcessing: Promise<void> | null = null;
  private vadQueue: Promise<void> = Promise.resolve();
  private settling: Promise<void> = Promise.resolve();

  constructor(config: VoicePipelineConfig, options: PipelineSessionOptions = {}) {
    super();
    this.id = options.sessionId ?? nanoid();
    this.stt = config.stt;
    this.tts = config.tts;
    this.vad = config.vad;
    this.agent = config.agent;
    this.ttsOptions = options.ttsOptions
      ? { ...config.ttsOptions, ...options.ttsOptions }
      : config.ttsOptions;
    this.input = options.input;
    this.sttEncodesInput =
      this.input?.encoding !== 'mulaw' || (config.stt.streamEncodings ?? []).includes('mulaw');
    const vadRate = config.vad?.sampleRate;
    this.vadResampler =
      this.input && vadRate !== undefined && vadRate !== this.input.sampleRate
        ? new Resampler(this.input.sampleRate, vadRate)
        : null;
    this.playback = options.playback;
    this.bargeIn = config.bargeIn ?? false;
    this.maxSentenceLength = maxSentenceLength(config.maxSentenceLength);
    this.settleTimeout = config.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT;
    if (!(this.settleTimeout >= 0)) {
      throw new RangeError(`settleTimeout must be 0 or more, got ${String(config.settleTimeout)}`);
    }
  }

  get currentState(): SessionState {
    return this.state;
  }

  pushAudio(input: Buffer): void {
    if (this.closed) return;

    const chunk = this.sttEncodesInput ? input : mulawToPcm16(input);
    if (!this.vad) {
      this.handleNoVAD(chunk);
      return;
    }

    let eventOrPromise: VADEvent | Promise<VADEvent>;
    try {
      eventOrPromise = this.vad.process(this.vadSamples(input));
    } catch (err) {
      this.emitError(err);
      return;
    }

    this.vadQueue = this.vadQueue.then(async () => {
      try {
        const event = await eventOrPromise;
        if (!this.closed) this.applyVADEvent(event, chunk);
      } catch (err) {
        this.emitError(err);
      }
    });
  }

  endAudio(): void {
    if (this.closed) return;
    void this.vadQueue.then(() => {
      if (this.state === 'listening') {
        void this.finishListening();
      }
    });
  }

  /**
   * Run an agent turn from text input, bypassing STT. Interrupts any turn in progress.
   */
  sendText(text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.interrupt();
    const signal = this.turn.signal;
    this.state = 'processing';
    return this.track(this.respond(text, signal));
  }

  interrupt(): void {
    this.stopTurn();
    this.vad?.reset();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turn.abort();
    this.playback?.clear();
    this.discardStream();
    this.state = 'idle';

    if (this.activeProcessing) {
      await this.activeProcessing.catch(() => {});
    }
    await bounded(this.settling, this.settleTimeout);

    this.removeAllListeners();
  }

  private stopTurn(): void {
    this.turn.abort();
    this.playback?.clear();
    this.turn = new AbortController();
    this.discardStream();
    this.state = 'idle';
  }

  private discardStream(): void {
    if (!this.stream) return;
    const stream = this.stream;
    this.stream = null;
    stream.removeAllListeners();
    void stream.close().catch(() => {});
  }

  private applyVADEvent(event: VADEvent, chunk: Buffer): void {
    switch (event.type) {
      case 'speech_start':
        if (this.bargeIn && (this.state === 'processing' || this.state === 'speaking')) {
          this.stopTurn();
        }
        if (this.state === 'idle') {
          this.state = 'listening';
          this.openStream();
          this.writeToStream(chunk);
          this.emit('speech_start');
        }
        break;

      case 'speech_end':
        if (this.state === 'listening') {
          this.writeToStream(chunk);
          this.emit('speech_end');
          void this.finishListening();
        }
        break;

      case 'speech':
        if (this.state === 'listening') {
          this.writeToStream(chunk);
        }
        break;

      case 'silence':
        break;
    }
  }

  private handleNoVAD(chunk: Buffer): void {
    if (this.state === 'idle') {
      this.state = 'listening';
      this.openStream();
    }

    if (this.state === 'listening') {
      this.writeToStream(chunk);
    }
  }

  private writeToStream(chunk: Buffer): void {
    if (!this.stream) return;
    try {
      this.stream.write(chunk);
    } catch (err) {
      this.emitError(err);
    }
  }

  private vadSamples(input: Buffer): Float32Array {
    const samples =
      this.input?.encoding === 'mulaw' ? mulawToFloat32(input) : pcm16ToFloat32(input);
    return this.vadResampler ? this.vadResampler.process(samples) : samples;
  }

  private streamOptions(): STTStreamOptions | undefined {
    if (!this.input) return undefined;
    return {
      sampleRate: this.input.sampleRate,
      encoding: this.sttEncodesInput ? this.input.encoding : 'pcm16',
    };
  }

  private openStream(): void {
    const options = this.streamOptions();
    const stream = options ? this.stt.createStream(options) : this.stt.createStream();
    this.stream = stream;

    stream.on('partial', (text: string) => {
      this.emit('transcript', text, false);
    });

    stream.on('final', (result: { text: string }) => {
      this.emit('transcript', result.text, true);
    });

    stream.on('error', (error: Error) => {
      this.emitError(error);
    });
  }

  private finishListening(): Promise<void> {
    if (!this.stream) {
      this.state = 'idle';
      return Promise.resolve();
    }

    const currentStream = this.stream;
    this.stream = null;
    this.state = 'processing';
    const signal = this.turn.signal;

    return this.track(
      (async () => {
        let transcript: string;
        try {
          const result = await abortable(currentStream.close(), signal);
          if (result === ABORTED) return;
          transcript = result.text;
        } catch (err) {
          if (this.isCurrent(signal)) {
            this.state = 'idle';
            this.emitError(err);
          }
          return;
        } finally {
          currentStream.removeAllListeners();
        }
        await this.respond(transcript, signal);
      })()
    );
  }

  private async respond(input: string, signal: AbortSignal): Promise<void> {
    try {
      if (!this.isCurrent(signal)) return;

      if (input.trim().length === 0) {
        this.state = 'idle';
        return;
      }

      if (this.agent.stream) {
        await this.respondStreaming(input, signal);
        return;
      }

      const reply = await abortable(this.agent.run(input, { sessionId: this.id, signal }), signal);
      if (reply === ABORTED || !this.isCurrent(signal)) return;
      const { content } = reply;
      this.emit('agent_response', content);

      if (content.trim().length > 0) {
        this.state = 'speaking';
        const completed = await this.speak(content, signal);
        if (!completed) return;
        if (this.playback && !(await this.playback.mark())) return;
      }

      if (!this.isCurrent(signal)) return;
      this.state = 'idle';
      this.emit('turn_end');
    } catch (err) {
      if (!this.isCurrent(signal)) return;
      this.state = 'idle';
      this.emitError(err);
    }
  }

  /**
   * Runs a streamed turn once the turn before it settled, so a runner that keeps a conversation
   * writes the turns of the session one after another
   */
  private async respondStreaming(input: string, signal: AbortSignal): Promise<void> {
    const previous = this.settling;
    let release!: () => void;
    const own = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.settling = Promise.all([previous, own]).then(() => undefined);
    const turn: { settled?: Promise<void> } = {};
    try {
      const waited = await abortable(bounded(previous, this.settleTimeout), signal);
      if (waited === ABORTED || !this.isCurrent(signal)) return;
      await this.streamTurn(input, signal, turn);
    } finally {
      void (turn.settled ?? Promise.resolve()).then(release);
    }
  }

  /**
   * Speaks a streamed turn, then settles it. The settle is waited for at most `settleTimeout`
   * before the turn ends, and `held.settled` resolves once it is really done
   */
  private async streamTurn(
    input: string,
    signal: AbortSignal,
    held: { settled?: Promise<void> }
  ): Promise<void> {
    let turn: VoiceTurn;
    let deltas: AsyncIterator<string, string | void, undefined>;
    try {
      turn = this.agent.stream!(input, { sessionId: this.id, signal });
      deltas = turn[Symbol.asyncIterator]();
    } catch (err) {
      if (!this.isCurrent(signal)) return;
      this.state = 'idle';
      this.emitError(err);
      return;
    }

    const stop = new AbortController();
    const stopOnAbort = () => stop.abort();
    signal.addEventListener('abort', stopOnAbort, { once: true });
    let failure: Error | undefined;
    const fail = (err: unknown) => {
      failure ??= toError(err);
      stop.abort();
    };

    const sentences = new AsyncQueue<string>();
    let generated = false;
    const generation = this.generate(deltas, sentences, signal, stop.signal).then((done) => {
      generated = done;
    }, fail);

    const segments: SpokenSegment[] = [];
    let spokeAll = false;
    try {
      for (;;) {
        const next = await abortable(sentences.next(), stop.signal);
        if (next === ABORTED || !this.isCurrent(stop.signal)) break;
        if (next.done) {
          spokeAll = true;
          break;
        }
        const words = next.value.trim();
        if (words.length > 0) {
          this.state = 'speaking';
          if (!(await this.speak(words, stop.signal))) break;
        }
        segments.push({
          text: next.value,
          played: this.playback && words.length > 0 ? this.playback.mark() : Promise.resolve(true),
        });
      }
    } catch (err) {
      fail(err);
    }

    if (!spokeAll) {
      stop.abort();
      closeIterator(deltas);
    }
    await generation;
    signal.removeEventListener('abort', stopOnAbort);

    const { spoken, heardAll } = this.playback
      ? await heard(segments)
      : { spoken: segments.map((segment) => segment.text).join(''), heardAll: true };
    const outcome = { spoken, interrupted: !(generated && spokeAll && !failure && heardAll) };
    held.settled = Promise.resolve()
      .then(() => turn.settle?.(outcome))
      .catch((err: unknown) => this.emitError(err));
    await bounded(held.settled, this.settleTimeout);

    if (!this.isCurrent(signal)) return;
    this.state = 'idle';
    if (failure) {
      this.emitError(failure);
      return;
    }
    this.emit('turn_end');
  }

  /** Reads the answer's deltas into sentences: true once it ended, false when `stop` aborted */
  private async generate(
    deltas: AsyncIterator<string, string | void, undefined>,
    sentences: AsyncQueue<string>,
    signal: AbortSignal,
    stop: AbortSignal
  ): Promise<boolean> {
    const splitter = new SentenceSplitter({ maxLength: this.maxSentenceLength });
    let text = '';
    let answer: string | undefined;
    for (;;) {
      const next = await abortable(deltas.next(), stop);
      if (next === ABORTED) return false;
      if (next.done) {
        if (typeof next.value === 'string') answer = next.value;
        break;
      }
      const delta = next.value;
      if (delta.length === 0) continue;
      text += delta;
      if (this.isCurrent(signal)) this.emit('agent_response_delta', delta);
      for (const sentence of splitter.push(delta)) sentences.push(sentence);
    }
    if (stop.aborted) return false;
    for (const sentence of splitter.flush()) sentences.push(sentence);
    sentences.end();
    if (this.isCurrent(signal)) this.emit('agent_response', answer ?? text);
    return true;
  }

  private async speak(content: string, signal: AbortSignal): Promise<boolean> {
    const iterator = this.tts.streamSynthesize(content, this.ttsOptions)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(iterator.next(), signal);
        if (next === ABORTED || !this.isCurrent(signal)) return false;
        if (next.done) return true;
        this.emit('audio', next.value);
      }
    } finally {
      if (signal.aborted) {
        void iterator.return?.(undefined).catch(() => {});
      }
    }
  }

  private track(processing: Promise<void>): Promise<void> {
    this.activeProcessing = processing;
    const release = () => {
      if (this.activeProcessing === processing) {
        this.activeProcessing = null;
      }
    };
    processing.then(release, release);
    return processing;
  }

  private isCurrent(signal: AbortSignal): boolean {
    return !this.closed && !signal.aborted;
  }

  private emitError(err: unknown): void {
    if (this.closed) return;
    this.emit('error', toError(err));
  }
}
