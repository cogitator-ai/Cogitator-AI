import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryTraceStore,
  MetricEvaluator,
  DemoSelector,
  InstructionOptimizer,
  AgentOptimizer,
  createSuccessMetric,
  createExactMatchMetric,
  createContainsMetric,
} from '../learning/index';
import type {
  ExecutionTrace,
  TraceMetrics,
  LLMBackend,
  ChatResponse,
  RunResult,
  Span,
} from '@cogitator-ai/types';

function createMockTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace_${Math.random().toString(36).slice(2, 8)}`,
    runId: `run_${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'test-agent',
    threadId: 'thread_123',
    input: 'test input',
    output: 'test output',
    steps: [],
    toolCalls: [],
    reflections: [],
    metrics: {
      success: true,
      toolAccuracy: 1,
      efficiency: 0.8,
      completeness: 0.9,
    },
    score: 0.85,
    model: 'test-model',
    createdAt: new Date(),
    duration: 1000,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.01,
    },
    isDemo: false,
    ...overrides,
  };
}

function createMockLLM(): LLMBackend {
  return {
    chat: vi.fn().mockResolvedValue({
      content: '{"score": 0.85, "strengths": ["good"], "weaknesses": [], "reasoning": "test"}',
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: 'stop',
    } as ChatResponse),
    chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
  };
}

function createMockRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const span: Span = {
    name: 'test-span',
    startTime: Date.now(),
    endTime: Date.now() + 100,
    duration: 100,
    status: 'ok',
    attributes: {},
  };

  return {
    runId: `run_${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'test-agent',
    threadId: 'thread_123',
    output: 'test output',
    toolCalls: [],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
      duration: 1000,
    },
    model: 'test-model',
    trace: {
      runId: 'run_123',
      spans: [span],
      startTime: Date.now(),
      endTime: Date.now() + 100,
    },
    ...overrides,
  };
}

describe('InMemoryTraceStore', () => {
  let store: InMemoryTraceStore;

  beforeEach(() => {
    store = new InMemoryTraceStore();
  });

  it('should store and retrieve a trace', async () => {
    const trace = createMockTrace();
    await store.store(trace);

    const retrieved = await store.get(trace.id);
    expect(retrieved).toEqual(trace);
  });

  it('should return null for non-existent trace', async () => {
    const retrieved = await store.get('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should get trace by runId', async () => {
    const trace = createMockTrace();
    await store.store(trace);

    const retrieved = await store.getByRunId(trace.runId);
    expect(retrieved).toEqual(trace);
  });

  it('should get all traces for an agent', async () => {
    const trace1 = createMockTrace({ agentId: 'agent1' });
    const trace2 = createMockTrace({ agentId: 'agent1' });
    const trace3 = createMockTrace({ agentId: 'agent2' });

    await store.storeMany([trace1, trace2, trace3]);

    const agent1Traces = await store.getAll('agent1');
    expect(agent1Traces).toHaveLength(2);

    const agent2Traces = await store.getAll('agent2');
    expect(agent2Traces).toHaveLength(1);
  });

  it('should query traces with filters', async () => {
    const highScore = createMockTrace({ score: 0.9, agentId: 'agent1' });
    const lowScore = createMockTrace({ score: 0.5, agentId: 'agent1' });
    const demo = createMockTrace({ score: 0.95, isDemo: true, agentId: 'agent1' });

    await store.storeMany([highScore, lowScore, demo]);

    const highScoreTraces = await store.query({ agentId: 'agent1', minScore: 0.8 });
    expect(highScoreTraces).toHaveLength(2);

    const demoTraces = await store.query({ agentId: 'agent1', isDemo: true });
    expect(demoTraces).toHaveLength(1);
    expect(demoTraces[0].id).toBe(demo.id);
  });

  it('should mark and unmark traces as demos', async () => {
    const trace = createMockTrace({ isDemo: false });
    await store.store(trace);

    await store.markAsDemo(trace.id);
    const demos = await store.getDemos(trace.agentId);
    expect(demos).toHaveLength(1);
    expect(demos[0].isDemo).toBe(true);

    await store.unmarkAsDemo(trace.id);
    const noDemos = await store.getDemos(trace.agentId);
    expect(noDemos).toHaveLength(0);
  });

  it('should prune traces keeping highest scored', async () => {
    const traces = [
      createMockTrace({ score: 0.9, agentId: 'agent1' }),
      createMockTrace({ score: 0.5, agentId: 'agent1' }),
      createMockTrace({ score: 0.7, agentId: 'agent1' }),
      createMockTrace({ score: 0.3, agentId: 'agent1' }),
    ];

    await store.storeMany(traces);

    const pruned = await store.prune('agent1', 2);
    expect(pruned).toBe(2);

    const remaining = await store.getAll('agent1');
    expect(remaining).toHaveLength(2);
    expect(remaining.every((t) => t.score >= 0.7)).toBe(true);
  });

  it('should clear all traces for an agent', async () => {
    const trace1 = createMockTrace({ agentId: 'agent1' });
    const trace2 = createMockTrace({ agentId: 'agent1' });

    await store.storeMany([trace1, trace2]);
    expect(await store.getAll('agent1')).toHaveLength(2);

    await store.clear('agent1');
    expect(await store.getAll('agent1')).toHaveLength(0);
  });

  it('should get stats for an agent', async () => {
    const traces = [
      createMockTrace({ score: 0.9, isDemo: true, agentId: 'agent1' }),
      createMockTrace({ score: 0.8, isDemo: false, agentId: 'agent1' }),
      createMockTrace({ score: 0.7, isDemo: false, agentId: 'agent1' }),
    ];

    await store.storeMany(traces);

    const stats = await store.getStats('agent1');
    expect(stats.totalTraces).toBe(3);
    expect(stats.demoCount).toBe(1);
    expect(stats.averageScore).toBeCloseTo(0.8, 1);
    expect(stats.topPerformers).toHaveLength(3);
  });
});

describe('MetricEvaluator', () => {
  let evaluator: MetricEvaluator;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    mockLLM = createMockLLM();
    evaluator = new MetricEvaluator({ llm: mockLLM, model: 'test-model' });
  });

  describe('built-in metrics', () => {
    it('should evaluate success metric', () => {
      const successMetric = createSuccessMetric();

      const successTrace = createMockTrace({ steps: [] });
      const failTrace = createMockTrace({
        steps: [
          {
            index: 0,
            type: 'tool_call',
            timestamp: Date.now(),
            duration: 100,
            toolResult: { callId: '1', name: 'test', result: null, error: 'something failed' },
          },
        ],
      });

      expect(successMetric(successTrace).value).toBe(1);
      expect(successMetric(successTrace).passed).toBe(true);

      expect(successMetric(failTrace).value).toBe(0);
      expect(successMetric(failTrace).passed).toBe(false);
    });

    it('should evaluate exact match metric', () => {
      const exactMatch = createExactMatchMetric();

      const matchTrace = createMockTrace({ output: 'Paris' });
      const noMatchTrace = createMockTrace({ output: 'London' });

      expect(exactMatch(matchTrace, 'Paris').value).toBe(1);
      expect(exactMatch(matchTrace, 'Paris').passed).toBe(true);

      expect(exactMatch(noMatchTrace, 'Paris').value).toBe(0);
      expect(exactMatch(noMatchTrace, 'Paris').passed).toBe(false);
    });

    it('should evaluate contains metric', () => {
      const containsMetric = createContainsMetric(['Paris', 'France']);

      const containsTrace = createMockTrace({ output: 'The capital is Paris, France' });
      const partialTrace = createMockTrace({ output: 'I love Paris' });
      const noMatchTrace = createMockTrace({ output: 'Hello world' });

      expect(containsMetric(containsTrace).value).toBe(1);
      expect(containsMetric(containsTrace).passed).toBe(true);

      expect(containsMetric(partialTrace).value).toBe(0.5);
      expect(containsMetric(partialTrace).passed).toBe(true);

      expect(containsMetric(noMatchTrace).value).toBe(0);
      expect(containsMetric(noMatchTrace).passed).toBe(false);
    });
  });

  describe('evaluate', () => {
    it('should evaluate trace with default metrics', async () => {
      const trace = createMockTrace({
        output: 'Paris',
        metrics: { success: true, toolAccuracy: 1, efficiency: 0.8, completeness: 0.9 },
      });

      const result = await evaluator.evaluate(trace, 'Paris');

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(0);
      expect(typeof result.passed).toBe('boolean');
    });

    it('should use registered custom metrics', async () => {
      const customMetric = vi.fn().mockReturnValue({ name: 'custom', value: 0.5, passed: true });

      const customEvaluator = new MetricEvaluator({
        llm: mockLLM,
        model: 'test-model',
        config: {
          metrics: [{ name: 'custom', type: 'numeric', description: 'Custom metric', weight: 1 }],
          aggregation: 'average',
          passThreshold: 0.5,
        },
      });

      customEvaluator.registerMetric('custom', customMetric);

      const trace = createMockTrace();
      await customEvaluator.evaluate(trace);

      expect(customMetric).toHaveBeenCalledWith(trace, undefined);
    });
  });
});

describe('DemoSelector', () => {
  let selector: DemoSelector;
  let store: InMemoryTraceStore;

  beforeEach(() => {
    store = new InMemoryTraceStore();
    selector = new DemoSelector({
      traceStore: store,
      maxDemos: 5,
      minScore: 0.8,
    });
  });

  it('should add a demo from high-quality trace', async () => {
    const trace = createMockTrace({ score: 0.9, agentId: 'agent1' });
    await store.store(trace);

    const demo = await selector.addDemo(trace);

    expect(demo.traceId).toBe(trace.id);
    expect(demo.agentId).toBe(trace.agentId);
    expect(demo.input).toBe(trace.input);
    expect(demo.output).toBe(trace.output);
  });

  it('should reject low-quality traces', async () => {
    const trace = createMockTrace({ score: 0.5 });
    await store.store(trace);

    await expect(selector.addDemo(trace)).rejects.toThrow('below minimum');
  });

  it('should select demos for new input', async () => {
    const traces = [
      createMockTrace({ input: 'What is AI?', score: 0.9, agentId: 'agent1' }),
      createMockTrace({ input: 'Explain machine learning', score: 0.85, agentId: 'agent1' }),
      createMockTrace({ input: 'Weather today?', score: 0.8, agentId: 'agent1' }),
    ];

    for (const trace of traces) {
      await store.store(trace);
      await selector.addDemo(trace);
    }

    const demos = await selector.selectDemos('agent1', 'What is deep learning?', 2);
    expect(demos.length).toBeLessThanOrEqual(2);
  });

  it('should remove a demo', async () => {
    const trace = createMockTrace({ score: 0.9, agentId: 'agent1' });
    await store.store(trace);
    const demo = await selector.addDemo(trace);

    await selector.removeDemo(demo.id);

    const allDemos = selector.getAllDemos('agent1');
    expect(allDemos.find((d) => d.id === demo.id)).toBeUndefined();
  });

  it('should format demos for prompt', async () => {
    const trace = createMockTrace({
      input: 'What is 2+2?',
      output: '4',
      score: 0.9,
      agentId: 'agent1',
    });
    await store.store(trace);
    const demo = await selector.addDemo(trace);

    const formatted = selector.formatDemosForPrompt([demo]);

    expect(formatted).toContain('Example');
    expect(formatted).toContain('What is 2+2?');
    expect(formatted).toContain('4');
  });

  it('should get demo stats', async () => {
    const traces = [
      createMockTrace({ score: 0.9, agentId: 'agent1' }),
      createMockTrace({ score: 0.85, agentId: 'agent1' }),
    ];

    for (const trace of traces) {
      await store.store(trace);
      await selector.addDemo(trace);
    }

    const stats = await selector.getDemoStats('agent1');
    expect(stats.totalDemos).toBe(2);
    expect(stats.averageScore).toBeCloseTo(0.875, 2);
  });
});

describe('InstructionOptimizer', () => {
  let optimizer: InstructionOptimizer;
  let store: InMemoryTraceStore;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    store = new InMemoryTraceStore();
    mockLLM = createMockLLM();
    optimizer = new InstructionOptimizer({
      llm: mockLLM,
      model: 'test-model',
      traceStore: store,
    });
  });

  it('should return original instructions when no traces', async () => {
    const result = await optimizer.optimize('agent1', 'Be helpful');

    expect(result.originalInstructions).toBe('Be helpful');
    expect(result.optimizedInstructions).toBe('Be helpful');
    expect(result.improvement).toBe(0);
    expect(result.reasoning).toContain('No traces');
  });

  it('should analyze failures and generate candidates', async () => {
    const failedTrace = createMockTrace({
      agentId: 'agent1',
      metrics: { success: false, toolAccuracy: 0.5 } as TraceMetrics,
      score: 0.4,
    });
    await store.store(failedTrace);

    vi.mocked(mockLLM.chat)
      .mockResolvedValueOnce({
        content: JSON.stringify({
          gaps: [
            {
              description: 'Missing error handling',
              frequency: 3,
              suggestedFix: 'Add error handling',
            },
          ],
          overallAnalysis: 'Needs improvement',
        }),
        usage: { inputTokens: 10, outputTokens: 20 },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          candidates: [
            { instructions: 'Be helpful and handle errors', reasoning: 'Added error handling' },
          ],
        }),
        usage: { inputTokens: 10, outputTokens: 20 },
        finishReason: 'stop',
      })
      .mockResolvedValue({
        content: JSON.stringify({
          score: 0.8,
          strengths: ['good'],
          weaknesses: [],
          reasoning: 'improved',
        }),
        usage: { inputTokens: 10, outputTokens: 20 },
        finishReason: 'stop',
      });

    const result = await optimizer.optimize('agent1', 'Be helpful');

    expect(result.gapsAddressed.length).toBeGreaterThan(0);
    expect(result.candidatesEvaluated).toBeGreaterThan(0);
  });
});

describe('AgentOptimizer', () => {
  let optimizer: AgentOptimizer;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    mockLLM = createMockLLM();
    optimizer = new AgentOptimizer({
      llm: mockLLM,
      model: 'test-model',
    });
  });

  it('should capture trace from run result', async () => {
    const runResult = createMockRunResult();

    const trace = await optimizer.captureTrace(runResult, 'test input');

    expect(trace.runId).toBe(runResult.runId);
    expect(trace.agentId).toBe(runResult.agentId);
    expect(trace.input).toBe('test input');
    expect(trace.output).toBe(runResult.output);
    expect(trace.score).toBeGreaterThanOrEqual(0);
    expect(trace.score).toBeLessThanOrEqual(1);
  });

  it('should capture trace with expected output', async () => {
    const runResult = createMockRunResult({ output: 'Paris' });

    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({
        score: 0.9,
        strengths: ['correct'],
        weaknesses: [],
        reasoning: 'good',
      }),
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: 'stop',
    });

    const trace = await optimizer.captureTrace(runResult, 'What is the capital of France?', {
      expected: 'Paris',
    });

    expect(trace.expected).toBe('Paris');
  });

  it('should bootstrap demos from high-quality traces', async () => {
    const runResults = [
      createMockRunResult({ agentId: 'agent1' }),
      createMockRunResult({ agentId: 'agent1' }),
    ];

    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({
        score: 0.9,
        strengths: ['good'],
        weaknesses: [],
        reasoning: 'good',
      }),
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: 'stop',
    });

    for (const result of runResults) {
      await optimizer.captureTrace(result, 'test input');
    }

    const demos = await optimizer.bootstrapDemos('agent1');
    expect(demos.length).toBeGreaterThanOrEqual(0);
  });

  it('should get demos for prompt', async () => {
    const runResult = createMockRunResult({ agentId: 'agent1' });

    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({
        score: 0.95,
        strengths: ['excellent'],
        weaknesses: [],
        reasoning: 'great',
      }),
      usage: { inputTokens: 10, outputTokens: 20 },
      finishReason: 'stop',
    });

    await optimizer.captureTrace(runResult, 'What is AI?');
    await optimizer.bootstrapDemos('agent1');

    const demos = await optimizer.getDemosForPrompt('agent1', 'What is ML?', 3);
    expect(Array.isArray(demos)).toBe(true);
  });

  it('should format demos for prompt', () => {
    const demos = [
      {
        id: 'demo1',
        agentId: 'agent1',
        traceId: 'trace1',
        input: 'What is 2+2?',
        output: '4',
        keySteps: [],
        score: 0.9,
        usageCount: 0,
        createdAt: new Date(),
      },
    ];

    const formatted = optimizer.formatDemosForPrompt(demos);
    expect(formatted).toContain('What is 2+2?');
    expect(formatted).toContain('4');
  });

  it('should get learning stats', async () => {
    const stats = await optimizer.getStats('agent1');

    expect(stats).toHaveProperty('traces');
    expect(stats).toHaveProperty('demos');
    expect(stats).toHaveProperty('optimization');
  });

  it('should expose internal components', () => {
    expect(optimizer.getTraceStore()).toBeDefined();
    expect(optimizer.getMetricEvaluator()).toBeDefined();
    expect(optimizer.getDemoSelector()).toBeDefined();
    expect(optimizer.getInstructionOptimizer()).toBeDefined();
  });
});
