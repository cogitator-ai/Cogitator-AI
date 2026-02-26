import type { VADEvent, VADProvider } from '../types.js';

export interface SileroVADConfig {
  modelPath: string;
  threshold?: number;
  silenceDuration?: number;
  sampleRate?: number;
}

interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<unknown>;
}

interface OnnxRuntime {
  InferenceSession: {
    create(path: string): Promise<OnnxSession>;
  };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims?: number[]) => unknown;
}

interface ModelOutput {
  output: { data: Float32Array };
  hn: { data: Float32Array };
  cn: { data: Float32Array };
}

export class SileroVAD implements VADProvider {
  readonly name = 'silero';

  private readonly modelPath: string;
  private readonly threshold: number;
  private readonly silenceDuration: number;
  private readonly sampleRate: number;

  private session: OnnxSession | null = null;
  private ort: OnnxRuntime | null = null;

  private hn: Float32Array;
  private cn: Float32Array;

  private state: 'idle' | 'speaking' = 'idle';
  private speechSamples = 0;
  private silenceMs = 0;

  constructor(config: SileroVADConfig) {
    this.modelPath = config.modelPath;
    this.threshold = config.threshold ?? 0.5;
    this.silenceDuration = config.silenceDuration ?? 500;
    this.sampleRate = config.sampleRate ?? 16000;

    this.hn = new Float32Array(2 * 1 * 64);
    this.cn = new Float32Array(2 * 1 * 64);
  }

  async init(): Promise<void> {
    if (this.session) return;

    const moduleName = 'onnxruntime-node';
    try {
      this.ort = (await import(/* webpackIgnore: true */ moduleName)) as OnnxRuntime;
    } catch {
      throw new Error(
        'onnxruntime-node is required for SileroVAD. Install it with: npm install onnxruntime-node'
      );
    }
    this.session = await this.ort.InferenceSession.create(this.modelPath);
  }

  async process(samples: Float32Array): Promise<VADEvent> {
    if (!this.session || !this.ort) {
      throw new Error('SileroVAD: must call init() before process()');
    }

    const { Tensor } = this.ort;
    const input = new Tensor('float32', samples, [1, samples.length]);
    const sr = new Tensor('int64', BigInt64Array.from([BigInt(this.sampleRate)]), [1]);
    const h = new Tensor('float32', this.hn, [2, 1, 64]);
    const c = new Tensor('float32', this.cn, [2, 1, 64]);

    const feeds = { input, sr, h, c };
    const result = (await this.session.run(feeds)) as ModelOutput;

    const probability = result.output.data[0];
    this.hn = new Float32Array(result.hn.data);
    this.cn = new Float32Array(result.cn.data);

    return this.evaluate(probability, samples.length);
  }

  reset(): void {
    this.state = 'idle';
    this.speechSamples = 0;
    this.silenceMs = 0;
    this.hn = new Float32Array(2 * 1 * 64);
    this.cn = new Float32Array(2 * 1 * 64);
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
      this.state = 'idle';
      this.speechSamples = 0;
      this.silenceMs = 0;
      return { type: 'speech_end', duration };
    }

    return { type: 'speech', probability: 0 };
  }
}
