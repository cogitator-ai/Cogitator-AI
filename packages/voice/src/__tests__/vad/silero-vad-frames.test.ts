import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Feed {
  type: string;
  data: ArrayLike<number> | BigInt64Array;
  dims?: number[];
}

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  inputNames: ['input', 'sr', 'h', 'c'] as string[],
}));

vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: vi.fn(async () => ({ inputNames: mocks.inputNames, run: mocks.run })),
  },
  Tensor: class {
    constructor(
      public type: string,
      public data: ArrayLike<number> | BigInt64Array,
      public dims?: number[]
    ) {}
  },
}));

import { SileroVAD } from '../../vad/silero-vad';

function probabilities(...values: number[]) {
  let i = 0;
  mocks.run.mockImplementation(async (feeds: Record<string, Feed>) => {
    const p = values[Math.min(i++, values.length - 1)]!;
    if (feeds.state) {
      return {
        output: { data: new Float32Array([p]) },
        stateN: { data: new Float32Array(256).fill(i) },
      };
    }
    return {
      output: { data: new Float32Array([p]) },
      hn: { data: new Float32Array(128).fill(i) },
      cn: { data: new Float32Array(128).fill(i) },
    };
  });
}

describe('SileroVAD frame handling', () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.inputNames = ['input', 'sr', 'h', 'c'];
  });

  it('accepts chunks of any size by buffering into 512-sample frames', async () => {
    probabilities(0.1);
    const vad = new SileroVAD({ modelPath: 'm.onnx' });
    await vad.init();

    await vad.process(new Float32Array(300));
    expect(mocks.run).not.toHaveBeenCalled();

    await vad.process(new Float32Array(800));
    expect(mocks.run).toHaveBeenCalledTimes(2);

    await vad.process(new Float32Array(500));
    expect(mocks.run).toHaveBeenCalledTimes(3);
  });

  it('summarizes multiple frames into a single transition event', async () => {
    probabilities(0.1, 0.9, 0.9, 0.9);
    const vad = new SileroVAD({ modelPath: 'm.onnx' });
    await vad.init();

    const event = await vad.process(new Float32Array(512 * 4));
    expect(event).toEqual({ type: 'speech_start' });

    probabilities(0.95);
    const next = await vad.process(new Float32Array(512));
    expect(next).toEqual({ type: 'speech', probability: expect.closeTo(0.95, 5) });
  });

  it('emits speech_end with the speech duration once silence exceeds the threshold', async () => {
    probabilities(0.9, 0.9, 0.0);
    const vad = new SileroVAD({ modelPath: 'm.onnx', silenceDuration: 64 });
    await vad.init();

    expect(await vad.process(new Float32Array(512))).toEqual({ type: 'speech_start' });
    await vad.process(new Float32Array(512));
    const event = await vad.process(new Float32Array(1024));
    expect(event).toEqual({ type: 'speech_end', duration: 64 });
  });

  it('uses v4 h/c state and a scalar sample-rate tensor', async () => {
    probabilities(0.2);
    const vad = new SileroVAD({ modelPath: 'm.onnx' });
    await vad.init();

    await vad.process(new Float32Array(1024));
    const [first, second] = mocks.run.mock.calls.map((c) => c[0] as Record<string, Feed>);
    expect(Object.keys(first!).sort()).toEqual(['c', 'h', 'input', 'sr']);
    expect(first!.sr!.dims).toEqual([]);
    expect(Array.from(first!.sr!.data as BigInt64Array)).toEqual([16000n]);
    expect(first!.input!.dims).toEqual([1, 512]);
    expect(Array.from(second!.h!.data as Float32Array).every((v) => v === 1)).toBe(true);
  });

  it('detects v5 models and feeds state plus 64 samples of context', async () => {
    mocks.inputNames = ['input', 'state', 'sr'];
    probabilities(0.2);
    const vad = new SileroVAD({ modelPath: 'v5.onnx' });
    await vad.init();

    const audio = new Float32Array(1024).map((_, i) => i / 1024);
    await vad.process(audio);

    const [first, second] = mocks.run.mock.calls.map((c) => c[0] as Record<string, Feed>);
    expect(Object.keys(first!).sort()).toEqual(['input', 'sr', 'state']);
    expect(first!.input!.dims).toEqual([1, 576]);
    expect(first!.state!.dims).toEqual([2, 1, 128]);
    const firstInput = first!.input!.data as Float32Array;
    expect(Array.from(firstInput.subarray(0, 64)).every((v) => v === 0)).toBe(true);

    const secondInput = second!.input!.data as Float32Array;
    expect(Array.from(secondInput.subarray(0, 64))).toEqual(Array.from(audio.subarray(448, 512)));
    expect(Array.from(second!.state!.data as Float32Array).every((v) => v === 1)).toBe(true);
  });

  it('uses 256-sample frames at 8kHz and rejects unsupported sample rates', async () => {
    probabilities(0.1);
    const vad = new SileroVAD({ modelPath: 'm.onnx', sampleRate: 8000 });
    await vad.init();
    await vad.process(new Float32Array(512));
    expect(mocks.run).toHaveBeenCalledTimes(2);

    expect(() => new SileroVAD({ modelPath: 'm.onnx', sampleRate: 44100 })).toThrow(
      'sampleRate must be 8000 or 16000'
    );
  });

  it('reset() drops buffered samples and model state', async () => {
    probabilities(0.1);
    const vad = new SileroVAD({ modelPath: 'm.onnx' });
    await vad.init();

    await vad.process(new Float32Array(500));
    vad.reset();
    await vad.process(new Float32Array(500));

    expect(mocks.run).not.toHaveBeenCalled();
  });
});
