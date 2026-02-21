import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VADEvent } from '../../types';

const mockRun = vi.fn();
const mockCreate = vi.fn();

const tensorCtor = vi.fn();

class MockTensor {
  type: string;
  data: unknown;
  dims?: number[];
  constructor(type: string, data: unknown, dims?: number[]) {
    tensorCtor(type, data, dims);
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

vi.mock('onnxruntime-node', () => {
  return {
    InferenceSession: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
    Tensor: MockTensor,
  };
});

import { SileroVAD } from '../../vad/silero-vad';

function mockModelOutput(probability: number) {
  mockRun.mockReturnValue({
    output: { data: new Float32Array([probability]) },
    hn: { data: new Float32Array(128) },
    cn: { data: new Float32Array(128) },
  });
}

describe('SileroVAD', () => {
  let vad: SileroVAD;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ run: mockRun });
    mockModelOutput(0.1);
    vad = new SileroVAD({ modelPath: '/fake/silero_vad.onnx' });
  });

  it('has correct name', () => {
    expect(vad.name).toBe('silero');
  });

  it('throws if process() called before init()', () => {
    const samples = new Float32Array(512);
    expect(() => vad.process(samples)).toThrow('must call init()');
  });

  it('init() creates inference session with model path', async () => {
    await vad.init();
    expect(mockCreate).toHaveBeenCalledWith('/fake/silero_vad.onnx');
  });

  it('process() runs model and returns VAD events', async () => {
    await vad.init();
    const event = vad.process(new Float32Array(512));
    expect(event.type).toBe('silence');
  });

  it('detects speech when probability > threshold', async () => {
    mockModelOutput(0.8);
    await vad.init();

    const event = vad.process(new Float32Array(512));
    expect(event.type).toBe('speech_start');
  });

  it('detects silence when probability < threshold', async () => {
    mockModelOutput(0.1);
    await vad.init();

    const event = vad.process(new Float32Array(512));
    expect(event.type).toBe('silence');
  });

  it('speech_start / speech_end state machine works', async () => {
    await vad.init();

    mockModelOutput(0.9);
    const start = vad.process(new Float32Array(512));
    expect(start.type).toBe('speech_start');

    mockModelOutput(0.8);
    const mid = vad.process(new Float32Array(512));
    expect(mid.type).toBe('speech');
    expect((mid as Extract<VADEvent, { type: 'speech' }>).probability).toBeCloseTo(0.8, 5);

    mockModelOutput(0.1);
    const chunkDurationMs = (512 / 16000) * 1000;
    const chunksNeeded = Math.ceil(500 / chunkDurationMs);

    const events: VADEvent[] = [];
    for (let i = 0; i < chunksNeeded; i++) {
      events.push(vad.process(new Float32Array(512)));
    }

    const speechEnd = events.find(
      (e): e is Extract<VADEvent, { type: 'speech_end' }> => e.type === 'speech_end'
    );
    expect(speechEnd).toBeDefined();
    expect(speechEnd!.duration).toBeGreaterThan(0);
  });

  it('reset() zeros hidden state and returns to idle', async () => {
    await vad.init();

    mockModelOutput(0.9);
    vad.process(new Float32Array(512));
    expect(vad.process(new Float32Array(512)).type).toBe('speech');

    vad.reset();

    mockModelOutput(0.9);
    const event = vad.process(new Float32Array(512));
    expect(event.type).toBe('speech_start');
  });

  it('passes correct tensor shapes to model', async () => {
    await vad.init();
    tensorCtor.mockClear();

    mockModelOutput(0.5);
    vad.process(new Float32Array(512));

    const calls = tensorCtor.mock.calls;

    const inputCall = calls.find(
      (c: unknown[]) => Array.isArray(c[2]) && c[2][0] === 1 && c[2][1] === 512
    );
    expect(inputCall).toBeDefined();

    const srCall = calls.find((c: unknown[]) => c[0] === 'int64');
    expect(srCall).toBeDefined();

    const hCalls = calls.filter(
      (c: unknown[]) => Array.isArray(c[2]) && c[2][0] === 2 && c[2][1] === 1 && c[2][2] === 64
    );
    expect(hCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('works with custom threshold', async () => {
    const customVad = new SileroVAD({ modelPath: '/fake/model.onnx', threshold: 0.9 });
    await customVad.init();

    mockModelOutput(0.7);
    const event = customVad.process(new Float32Array(512));
    expect(event.type).toBe('silence');
  });

  it('updates hidden state after each run', async () => {
    await vad.init();

    const hnData = new Float32Array(128).fill(0.42);
    const cnData = new Float32Array(128).fill(0.24);
    mockRun.mockReturnValue({
      output: { data: new Float32Array([0.3]) },
      hn: { data: hnData },
      cn: { data: cnData },
    });

    vad.process(new Float32Array(512));

    mockRun.mockReturnValue({
      output: { data: new Float32Array([0.3]) },
      hn: { data: new Float32Array(128) },
      cn: { data: new Float32Array(128) },
    });

    vad.process(new Float32Array(512));

    expect(mockRun).toHaveBeenCalledTimes(2);
  });
});
