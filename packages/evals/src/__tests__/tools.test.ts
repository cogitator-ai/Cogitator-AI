import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRunEvalTool, evalTools } from '../tools';
import type { EvalSuite, EvalSuiteResult } from '../eval-suite';

function mockSuiteResult(overrides?: Partial<EvalSuiteResult>): EvalSuiteResult {
  return {
    results: [
      {
        case: { input: 'hello', expected: 'world' },
        output: 'world',
        duration: 100,
        scores: [{ name: 'accuracy', score: 0.9 }],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
      },
      {
        case: { input: 'foo', expected: 'bar' },
        output: 'bar',
        duration: 150,
        scores: [{ name: 'accuracy', score: 0.8 }],
        usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40, cost: 0.002, duration: 150 },
      },
      {
        case: { input: 'ping', expected: 'pong' },
        output: 'pong',
        duration: 80,
        scores: [{ name: 'accuracy', score: 0.95 }],
        usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20, cost: 0.0005, duration: 80 },
      },
    ],
    aggregated: {
      accuracy: {
        name: 'accuracy',
        mean: 0.883,
        median: 0.9,
        min: 0.8,
        max: 0.95,
        stdDev: 0.06,
        p50: 0.9,
        p95: 0.95,
        p99: 0.95,
      },
    },
    assertions: [{ name: 'accuracy >= 0.8', passed: true, message: 'ok' }],
    stats: { total: 3, duration: 500, cost: 0.0035 },
    report: vi.fn(),
    saveBaseline: vi.fn(),
    ...overrides,
  };
}

function mockSuite(result?: EvalSuiteResult) {
  return {
    run: vi.fn().mockResolvedValue(result ?? mockSuiteResult()),
  } as unknown as EvalSuite;
}

describe('createRunEvalTool', () => {
  let suite: EvalSuite;

  beforeEach(() => {
    suite = mockSuite();
  });

  it('has correct name and description', () => {
    const tool = createRunEvalTool(suite);
    expect(tool.name).toBe('run_eval');
    expect(tool.description).toContain('evaluation suite');
  });

  it('has valid parameter schema with optional maxCases', () => {
    const tool = createRunEvalTool(suite);

    const parsed = tool.parameters.parse({});
    expect(parsed).toEqual({});

    const withMax = tool.parameters.parse({ maxCases: 5 });
    expect(withMax).toEqual({ maxCases: 5 });
  });

  it('rejects invalid maxCases', () => {
    const tool = createRunEvalTool(suite);
    expect(() => tool.parameters.parse({ maxCases: -1 })).toThrow();
    expect(() => tool.parameters.parse({ maxCases: 0 })).toThrow();
    expect(() => tool.parameters.parse({ maxCases: 1.5 })).toThrow();
  });

  it('calls suite.run() and returns summary', async () => {
    const tool = createRunEvalTool(suite);
    const result = await tool.execute({});

    expect(suite.run).toHaveBeenCalledOnce();
    expect(result).toEqual({
      success: true,
      total: 3,
      duration: 500,
      cost: 0.0035,
      metrics: { accuracy: 0.883 },
      assertionsPassed: true,
    });
  });

  it('returns assertionsPassed false when any assertion fails', async () => {
    const failedResult = mockSuiteResult({
      assertions: [
        { name: 'accuracy >= 0.8', passed: true, message: 'ok' },
        { name: 'latency < 200ms', passed: false, message: 'too slow' },
      ],
    });
    suite = mockSuite(failedResult);

    const tool = createRunEvalTool(suite);
    const result = await tool.execute({});

    expect(result).toMatchObject({ assertionsPassed: false });
  });

  it('limits results when maxCases is provided', async () => {
    const tool = createRunEvalTool(suite);
    const result = (await tool.execute({ maxCases: 2 })) as Record<string, unknown>;

    expect(suite.run).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
  });

  it('uses all cases when maxCases exceeds dataset size', async () => {
    const tool = createRunEvalTool(suite);
    const result = (await tool.execute({ maxCases: 100 })) as Record<string, unknown>;

    expect(result.total).toBe(3);
  });

  it('returns error object when suite.run() throws', async () => {
    vi.mocked(suite.run).mockRejectedValue(new Error('connection timeout'));

    const tool = createRunEvalTool(suite);
    const result = await tool.execute({});

    expect(result).toEqual({ success: false, error: 'connection timeout' });
  });

  it('handles non-Error throws', async () => {
    vi.mocked(suite.run).mockRejectedValue('string error');

    const tool = createRunEvalTool(suite);
    const result = await tool.execute({});

    expect(result).toEqual({ success: false, error: 'string error' });
  });

  it('returns empty metrics when no aggregated data', async () => {
    const emptyResult = mockSuiteResult({
      results: [],
      aggregated: {},
      assertions: [],
      stats: { total: 0, duration: 10, cost: 0 },
    });
    suite = mockSuite(emptyResult);

    const tool = createRunEvalTool(suite);
    const result = await tool.execute({});

    expect(result).toEqual({
      success: true,
      total: 0,
      duration: 10,
      cost: 0,
      metrics: {},
      assertionsPassed: true,
    });
  });
});

describe('evalTools', () => {
  it('returns array containing the run eval tool', () => {
    const suite = mockSuite();
    const tools = evalTools(suite);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('run_eval');
  });
});
