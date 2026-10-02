import type { VADEvent, VADProvider } from '../types.js';

export interface SileroVADConfig {
  modelPath: string;
  threshold?: number;
  silenceDuration?: number;
  sampleRate?: number;
}

interface OnnxTensorLike {
  data: ArrayLike<number>;
}

interface OnnxSession {
  readonly inputNames?: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike | undefined>>;
}

interface OnnxRuntime {
  InferenceSession: {
    create(path: string): Promise<OnnxSession>;
  };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims?: number[]) => unknown;
}

type ModelVersion = 'v4' | 'v5';

const V4_STATE_SIZE = 2 * 1 * 64;
const V5_STATE_SIZE = 2 * 1 * 128;

/**
 * Silero VAD (ONNX). Supports both the v4 (`h`/`c` state) and v5 (`state`) model
 * signatures, detected from the model inputs. Audio of any length is accepted:
 * samples are buffered and evaluated in fixed-size frames (512 @ 16kHz, 256 @ 8kHz).
 */
export class SileroVAD implements VADProvider {
  readonly name = 'silero';

  private readonly modelPath: string;
  private readonly threshold: number;
  private readonly silenceDuration: number;
  private readonly sampleRate: number;
  private readonly frameSize: number;
  private readonly contextSize: number;

  private session: OnnxSession | null = null;
  private ort: OnnxRuntime | null = null;
  private version: ModelVersion = 'v4';

  private hn = new Float32Array(V4_STATE_SIZE);
  private cn = new Float32Array(V4_STATE_SIZE);
  private stateV5 = new Float32Array(V5_STATE_SIZE);
  private context: Float32Array;
  private pending = new Float32Array(0);

  private state: 'idle' | 'speaking' = 'idle';
  private speechSamples = 0;
  private silenceMs = 0;
  private lastSpeechDurationMs = 0;

  constructor(config: SileroVADConfig) {
    const sampleRate = config.sampleRate ?? 16000;
    if (sampleRate !== 16000 && sampleRate !== 8000) {
      throw new Error(`SileroVAD: sampleRate must be 8000 or 16000, got ${sampleRate}`);
    }
    this.modelPath = config.modelPath;
    this.threshold = config.threshold ?? 0.5;
    this.silenceDuration = config.silenceDuration ?? 500;
    this.sampleRate = sampleRate;
    this.frameSize = sampleRate === 16000 ? 512 : 256;
    this.contextSize = sampleRate === 16000 ? 64 : 32;
    this.context = new Float32Array(this.contextSize);
  }

  async init(): Promise<void> {
    if (this.session) return;

    const moduleName = 'onnxruntime-node';
    let ort: OnnxRuntime;
    try {
      ort = (await import(/* webpackIgnore: true */ moduleName)) as OnnxRuntime;
    } catch {
      throw new Error(
        'onnxruntime-node is required for SileroVAD. Install it with: npm install onnxruntime-node'
      );
    }
    const session = await ort.InferenceSession.create(this.modelPath);
    this.version = session.inputNames?.includes('state') ? 'v5' : 'v4';
    this.ort = ort;
    this.session = session;
  }

  async process(samples: Float32Array): Promise<VADEvent> {
    if (!this.session || !this.ort) {
      throw new Error('SileroVAD: must call init() before process()');
    }

    if (samples.length === 0) {
      return this.state === 'speaking' ? { type: 'speech', probability: 0 } : { type: 'silence' };
    }

    const buffered = new Float32Array(this.pending.length + samples.length);
    buffered.set(this.pending);
    buffered.set(samples, this.pending.length);

    const startState = this.state;
    let transitioned = false;
    let lastSpeechProbability = 0;
    let offset = 0;

    while (offset + this.frameSize <= buffered.length) {
      const frame = buffered.subarray(offset, offset + this.frameSize);
      offset += this.frameSize;
      const probability = await this.infer(frame);
      const event = this.evaluate(probability, frame.length);
      if (event.type === 'speech_start' || event.type === 'speech_end') {
        transitioned = true;
      } else if (event.type === 'speech') {
        lastSpeechProbability = event.probability;
      }
    }

    this.pending = buffered.slice(offset);

    return this.summarize(startState, transitioned, lastSpeechProbability);
  }

  reset(): void {
    this.state = 'idle';
    this.speechSamples = 0;
    this.silenceMs = 0;
    this.hn = new Float32Array(V4_STATE_SIZE);
    this.cn = new Float32Array(V4_STATE_SIZE);
    this.stateV5 = new Float32Array(V5_STATE_SIZE);
    this.context = new Float32Array(this.contextSize);
    this.pending = new Float32Array(0);
  }

  dispose(): void {
    this.session = null;
    this.ort = null;
    this.reset();
  }

  private summarize(
    startState: 'idle' | 'speaking',
    transitioned: boolean,
    probability: number
  ): VADEvent {
    if (startState === 'idle' && this.state === 'speaking') {
      return { type: 'speech_start' };
    }
    if (startState === 'speaking' && this.state === 'idle') {
      return { type: 'speech_end', duration: this.lastSpeechDurationMs };
    }
    if (this.state === 'speaking') {
      return { type: 'speech', probability: transitioned ? 1 : probability };
    }
    return { type: 'silence' };
  }

  private async infer(frame: Float32Array): Promise<number> {
    const { Tensor } = this.ort!;
    const sr = new Tensor('int64', BigInt64Array.from([BigInt(this.sampleRate)]), []);

    if (this.version === 'v5') {
      const input = new Float32Array(this.contextSize + frame.length);
      input.set(this.context);
      input.set(frame, this.contextSize);
      this.context = input.slice(input.length - this.contextSize);

      const result = await this.session!.run({
        input: new Tensor('float32', input, [1, input.length]),
        state: new Tensor('float32', this.stateV5, [2, 1, 128]),
        sr,
      });
      const stateN = result.stateN?.data;
      if (stateN) this.stateV5 = Float32Array.from(stateN);
      return Number(result.output?.data[0] ?? 0);
    }

    const result = await this.session!.run({
      input: new Tensor('float32', frame, [1, frame.length]),
      sr,
      h: new Tensor('float32', this.hn, [2, 1, 64]),
      c: new Tensor('float32', this.cn, [2, 1, 64]),
    });
    const hn = result.hn?.data;
    const cn = result.cn?.data;
    if (hn) this.hn = Float32Array.from(hn);
    if (cn) this.cn = Float32Array.from(cn);
    return Number(result.output?.data[0] ?? 0);
  }

  private evaluate(probability: number, chunkLength: number): VADEvent {
    const isSpeech = probability >= this.threshold;
    const chunkDurationMs = (chunkLength / this.sampleRate) * 1000;

    if (this.state === 'idle') {
      if (isSpeech) {
        this.state = 'speaking';
        this.speechSamples = chunkLength;
        this.silenceMs = 0;
        return { type: 'speech_start' };
      }
      return { type: 'silence' };
    }

    if (isSpeech) {
      this.speechSamples += chunkLength;
      this.silenceMs = 0;
      return { type: 'speech', probability };
    }

    this.silenceMs += chunkDurationMs;

    if (this.silenceMs >= this.silenceDuration) {
      const duration = (this.speechSamples / this.sampleRate) * 1000;
      this.lastSpeechDurationMs = duration;
      this.state = 'idle';
      this.speechSamples = 0;
      this.silenceMs = 0;
      return { type: 'speech_end', duration };
    }

    return { type: 'speech', probability: 0 };
  }
}
