import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryCheckpointStore,
  ExecutionReplayer,
  ExecutionForker,
  TraceComparator,
  TimeTravel,
} from '../time-travel/index';
import { InMemoryTraceStore } from '../learning/index';
import type {
  ExecutionCheckpoint,
  ExecutionTrace,
  RunResult,
  Span,
  Message,
} from '@cogitator-ai/types';

function createMockRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const baseSpan: Span = {
    id: 'span_1',
    traceId: 'trace_123',
    name: 'agent.run',
    kind: 'server',
    status: 'ok',
    startTime: Date.now(),
    endTime: Date.now() + 1000,
    duration: 1000,
    attributes: {},
  };

  const llmSpan: Span = {
    id: 'span_2',
    traceId: 'trace_123',
    parentId: 'span_1',
    name: 'llm.chat',
    kind: 'client',
    status: 'ok',
    startTime: Date.now(),
    endTime: Date.now() + 500,
    duration: 500,
    attributes: {
      'llm.model': 'test-model',
      'llm.input_tokens': 100,
      'llm.output_tokens': 50,
    },
  };

  const toolSpan: Span = {
    id: 'span_3',
    traceId: 'trace_123',
    parentId: 'span_1',
    name: 'tool.calculator',
    kind: 'internal',
    status: 'ok',
    startTime: Date.now() + 500,
    endTime: Date.now() + 600,
    duration: 100,
    attributes: {
      'tool.name': 'calculator',
      'tool.call_id': 'call_123',
      'tool.arguments': '{"a": 1, "b": 2}',
      'tool.success': true,
      result: 3,
    },
  };

  const messages: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is 1 + 2?' },
    { role: 'assistant', content: 'Let me calculate that.' },
    { role: 'tool', content: '3', toolCallId: 'call_123', name: 'calculator' },
    { role: 'assistant', content: 'The answer is 3.' },
  ];

  return {
    runId: 'run_123',
    agentId: 'test-agent',
    threadId: 'thread_123',
    output: 'The answer is 3.',
    toolCalls: [{ id: 'call_123', name: 'calculator', arguments: { a: 1, b: 2 } }],
    messages,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
      duration: 1000,
    },
    trace: {
      traceId: 'trace_123',
      spans: [baseSpan, llmSpan, toolSpan],
    },
    ...overrides,
  };
}

function createMockTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace_${Math.random().toString(36).slice(2, 8)}`,
    runId: 'run_123',
    agentId: 'test-agent',
    threadId: 'thread_123',
    input: 'What is 1 + 2?',
    output: 'The answer is 3.',
    steps: [
      {
        index: 0,
        type: 'llm_call',
        timestamp: Date.now(),
        duration: 500,
        tokensUsed: { input: 100, output: 50 },
      },
      {
        index: 1,
        type: 'tool_call',
        timestamp: Date.now() + 500,
        duration: 100,
        toolCall: { id: 'call_123', name: 'calculator', arguments: { a: 1, b: 2 } },
        toolResult: { callId: 'call_123', name: 'calculator', result: 3 },
      },
    ],
    toolCalls: [{ id: 'call_123', name: 'calculator', arguments: { a: 1, b: 2 } }],
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

function createMockCheckpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    id: 'ckpt_123',
    traceId: 'trace_123',
    runId: 'run_123',
    agentId: 'test-agent',
    stepIndex: 1,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 1 + 2?' },
    ],
    toolResults: {},
    pendingToolCalls: [],
    createdAt: new Date(),
    ...overrides,
  };
}

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  describe('save and load', () => {
    it('should save and load a checkpoint', async () => {
      const checkpoint = createMockCheckpoint();
      await store.save(checkpoint);

      const loaded = await store.load(checkpoint.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(checkpoint.id);
      expect(loaded?.stepIndex).toBe(checkpoint.stepIndex);
    });

    it('should return null for non-existent checkpoint', async () => {
      const loaded = await store.load('non_existent');
      expect(loaded).toBeNull();
    });
  });

  describe('indexing', () => {
    it('should find checkpoints by trace ID', async () => {
      const checkpoint1 = createMockCheckpoint({ id: 'ckpt_1', stepIndex: 0 });
      const checkpoint2 = createMockCheckpoint({ id: 'ckpt_2', stepIndex: 1 });
      await store.save(checkpoint1);
      await store.save(checkpoint2);

      const found = await store.getByTrace('trace_123');
      expect(found).toHaveLength(2);
    });

    it('should find checkpoints by agent ID', async () => {
      const checkpoint = createMockCheckpoint();
      await store.save(checkpoint);

      const found = await store.getByAgent('test-agent');
      expect(found).toHaveLength(1);
    });

    it('should find checkpoints by label', async () => {
      const checkpoint = createMockCheckpoint({ label: 'important' });
      await store.save(checkpoint);

      const found = await store.getByLabel('important');
      expect(found).toHaveLength(1);
      expect(found[0].label).toBe('important');
    });
  });

  describe('delete', () => {
    it('should delete a checkpoint', async () => {
      const checkpoint = createMockCheckpoint();
      await store.save(checkpoint);

      const deleted = await store.delete(checkpoint.id);
      expect(deleted).toBe(true);

      const loaded = await store.load(checkpoint.id);
      expect(loaded).toBeNull();
    });

    it('should return false when deleting non-existent checkpoint', async () => {
      const deleted = await store.delete('non_existent');
      expect(deleted).toBe(false);
    });
  });

  describe('list with query', () => {
    it('should filter by date range', async () => {
      const now = new Date();
      const oldCheckpoint = createMockCheckpoint({
        id: 'ckpt_old',
        createdAt: new Date(now.getTime() - 10000),
      });
      const newCheckpoint = createMockCheckpoint({
        id: 'ckpt_new',
        createdAt: now,
      });
      await store.save(oldCheckpoint);
      await store.save(newCheckpoint);

      const found = await store.list({
        after: new Date(now.getTime() - 5000),
      });
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('ckpt_new');
    });

    it('should limit results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(createMockCheckpoint({ id: `ckpt_${i}`, stepIndex: i }));
      }

      const found = await store.list({ limit: 3 });
      expect(found).toHaveLength(3);
    });
  });

  describe('createFromRunResult', () => {
    it('should create checkpoint from run result', () => {
      const runResult = createMockRunResult();
      const checkpoint = store.createFromRunResult(runResult, 0, { label: 'step0' });

      expect(checkpoint.id).toMatch(/^ckpt_/);
      expect(checkpoint.traceId).toBe('trace_123');
      expect(checkpoint.runId).toBe('run_123');
      expect(checkpoint.stepIndex).toBe(0);
      expect(checkpoint.label).toBe('step0');
      expect(checkpoint.messages.length).toBeGreaterThan(0);
    });
  });

  describe('createAllFromRunResult', () => {
    it('should create checkpoints for all steps', async () => {
      const runResult = createMockRunResult();
      const checkpoints = await store.createAllFromRunResult(runResult, {
        labelPrefix: 'auto',
      });

      expect(checkpoints.length).toBeGreaterThan(0);
      for (const cp of checkpoints) {
        expect(await store.load(cp.id)).not.toBeNull();
      }
    });
  });

  describe('clear', () => {
    it('should clear all checkpoints for an agent', async () => {
      await store.save(createMockCheckpoint({ id: 'ckpt_1' }));
      await store.save(createMockCheckpoint({ id: 'ckpt_2' }));

      await store.clear('test-agent');

      const found = await store.getByAgent('test-agent');
      expect(found).toHaveLength(0);
    });

    it('should clear all checkpoints when no agent specified', async () => {
      await store.save(createMockCheckpoint({ id: 'ckpt_1', agentId: 'agent1' }));
      await store.save(createMockCheckpoint({ id: 'ckpt_2', agentId: 'agent2' }));

      await store.clear();

      expect(await store.load('ckpt_1')).toBeNull();
      expect(await store.load('ckpt_2')).toBeNull();
    });
  });
});

describe('TraceComparator', () => {
  let comparator: TraceComparator;
  let traceStore: InMemoryTraceStore;

  beforeEach(() => {
    traceStore = new InMemoryTraceStore();
    comparator = new TraceComparator({ traceStore });
  });

  describe('compare', () => {
    it('should compare two identical traces', async () => {
      const trace1 = createMockTrace({ id: 'trace_1' });
      const trace2 = createMockTrace({ id: 'trace_2' });
      await traceStore.store(trace1);
      await traceStore.store(trace2);

      const diff = await comparator.compare('trace_1', 'trace_2');

      expect(diff.trace1Id).toBe('trace_1');
      expect(diff.trace2Id).toBe('trace_2');
      expect(diff.divergencePoint).toBeUndefined();
      expect(diff.commonSteps).toBe(2);
    });

    it('should find divergence point for different traces', async () => {
      const trace1 = createMockTrace({
        id: 'trace_1',
        steps: [
          { index: 0, type: 'llm_call', timestamp: Date.now(), duration: 100 },
          { index: 1, type: 'tool_call', timestamp: Date.now() + 100, duration: 50,
            toolCall: { id: 'call_1', name: 'tool_a', arguments: {} } },
        ],
      });
      const trace2 = createMockTrace({
        id: 'trace_2',
        steps: [
          { index: 0, type: 'llm_call', timestamp: Date.now(), duration: 100 },
          { index: 1, type: 'tool_call', timestamp: Date.now() + 100, duration: 50,
            toolCall: { id: 'call_1', name: 'tool_b', arguments: {} } },
        ],
      });
      await traceStore.store(trace1);
      await traceStore.store(trace2);

      const diff = await comparator.compare('trace_1', 'trace_2');

      expect(diff.divergencePoint).toBe(1);
    });

    it('should throw error for non-existent trace', async () => {
      await expect(comparator.compare('non_existent', 'trace_2'))
        .rejects.toThrow('Trace not found: non_existent');
    });
  });

  describe('computeDiff', () => {
    it('should compute metrics diff', () => {
      const trace1 = createMockTrace({ id: 'trace_1', score: 0.7, duration: 1000 });
      const trace2 = createMockTrace({ id: 'trace_2', score: 0.9, duration: 800 });

      const diff = comparator.computeDiff(trace1, trace2);

      expect(diff.metricsDiff.score.trace1).toBe(0.7);
      expect(diff.metricsDiff.score.trace2).toBe(0.9);
      expect(diff.metricsDiff.score.delta).toBeCloseTo(0.2);
      expect(diff.metricsDiff.duration.delta).toBe(-200);
    });

    it('should identify steps only in one trace', () => {
      const trace1 = createMockTrace({
        id: 'trace_1',
        steps: [
          { index: 0, type: 'llm_call', timestamp: Date.now(), duration: 100 },
          { index: 1, type: 'tool_call', timestamp: Date.now() + 100, duration: 50 },
        ],
      });
      const trace2 = createMockTrace({
        id: 'trace_2',
        steps: [
          { index: 0, type: 'llm_call', timestamp: Date.now(), duration: 100 },
        ],
      });

      const diff = comparator.computeDiff(trace1, trace2);

      expect(diff.trace1OnlySteps).toBe(1);
      expect(diff.trace2OnlySteps).toBe(0);
    });
  });

  describe('compareSteps', () => {
    it('should mark identical steps', () => {
      const step1 = { index: 0, type: 'llm_call' as const, timestamp: 1000, duration: 100 };
      const step2 = { index: 0, type: 'llm_call' as const, timestamp: 1000, duration: 100 };

      const diff = comparator.compareSteps(step1, step2);

      expect(diff.status).toBe('identical');
      expect(diff.differences).toBeUndefined();
    });

    it('should detect type differences', () => {
      const step1 = { index: 0, type: 'llm_call' as const, timestamp: 1000, duration: 100 };
      const step2 = { index: 0, type: 'tool_call' as const, timestamp: 1000, duration: 100 };

      const diff = comparator.compareSteps(step1, step2);

      expect(diff.status).toBe('different');
      expect(diff.differences).toContain('Type: llm_call → tool_call');
    });
  });

  describe('formatDiff', () => {
    it('should format diff as readable string', async () => {
      const trace1 = createMockTrace({ id: 'trace_1', score: 0.7 });
      const trace2 = createMockTrace({ id: 'trace_2', score: 0.9 });
      await traceStore.store(trace1);
      await traceStore.store(trace2);

      const diff = await comparator.compare('trace_1', 'trace_2');
      const formatted = comparator.formatDiff(diff);

      expect(formatted).toContain('TRACE COMPARISON');
      expect(formatted).toContain('trace_1');
      expect(formatted).toContain('trace_2');
      expect(formatted).toContain('Score');
    });
  });
});

describe('ExecutionReplayer', () => {
  let replayer: ExecutionReplayer;
  let checkpointStore: InMemoryCheckpointStore;

  beforeEach(() => {
    checkpointStore = new InMemoryCheckpointStore();
    replayer = new ExecutionReplayer({ checkpointStore });
  });

  describe('replay', () => {
    it('should throw error for non-existent checkpoint', async () => {
      const mockCogitator = {} as any;
      const mockAgent = {} as any;

      await expect(
        replayer.replay(mockCogitator, mockAgent, {
          fromCheckpoint: 'non_existent',
          mode: 'live',
        })
      ).rejects.toThrow('Checkpoint not found');
    });
  });
});

describe('ExecutionForker', () => {
  let forker: ExecutionForker;
  let checkpointStore: InMemoryCheckpointStore;
  let replayer: ExecutionReplayer;

  beforeEach(() => {
    checkpointStore = new InMemoryCheckpointStore();
    replayer = new ExecutionReplayer({ checkpointStore });
    forker = new ExecutionForker({ checkpointStore, replayer });
  });

  describe('fork', () => {
    it('should throw error for non-existent checkpoint', async () => {
      const mockCogitator = {} as any;
      const mockAgent = {} as any;

      await expect(
        forker.fork(mockCogitator, mockAgent, { checkpointId: 'non_existent' })
      ).rejects.toThrow('Checkpoint not found');
    });
  });
});

describe('TimeTravel', () => {
  it('should create with default stores', () => {
    const mockCogitator = {} as any;
    const tt = new TimeTravel(mockCogitator);

    expect(tt.getCheckpointStore()).toBeDefined();
    expect(tt.getTraceStore()).toBeDefined();
  });

  it('should use provided stores', () => {
    const mockCogitator = {} as any;
    const checkpointStore = new InMemoryCheckpointStore();
    const traceStore = new InMemoryTraceStore();

    const tt = new TimeTravel(mockCogitator, { checkpointStore, traceStore });

    expect(tt.getCheckpointStore()).toBe(checkpointStore);
    expect(tt.getTraceStore()).toBe(traceStore);
  });

  describe('checkpoint operations', () => {
    it('should checkpoint a run result', async () => {
      const mockCogitator = {} as any;
      const tt = new TimeTravel(mockCogitator);
      const runResult = createMockRunResult();

      const checkpoint = await tt.checkpoint(runResult, 0, 'test-label');

      expect(checkpoint.id).toMatch(/^ckpt_/);
      expect(checkpoint.label).toBe('test-label');
      expect(checkpoint.stepIndex).toBe(0);
    });

    it('should checkpoint all steps', async () => {
      const mockCogitator = {} as any;
      const tt = new TimeTravel(mockCogitator);
      const runResult = createMockRunResult();

      const checkpoints = await tt.checkpointAll(runResult, 'auto');

      expect(checkpoints.length).toBeGreaterThan(0);
    });

    it('should get checkpoints by trace ID', async () => {
      const mockCogitator = {} as any;
      const tt = new TimeTravel(mockCogitator);
      const runResult = createMockRunResult();

      await tt.checkpointAll(runResult);
      const checkpoints = await tt.getCheckpoints('trace_123');

      expect(checkpoints.length).toBeGreaterThan(0);
    });

    it('should get and delete a checkpoint', async () => {
      const mockCogitator = {} as any;
      const tt = new TimeTravel(mockCogitator);
      const runResult = createMockRunResult();

      const checkpoint = await tt.checkpoint(runResult, 0);
      expect(await tt.getCheckpoint(checkpoint.id)).not.toBeNull();

      await tt.deleteCheckpoint(checkpoint.id);
      expect(await tt.getCheckpoint(checkpoint.id)).toBeNull();
    });
  });

  describe('config', () => {
    it('should return config', () => {
      const mockCogitator = {} as any;
      const tt = new TimeTravel(mockCogitator, {
        config: { autoCheckpoint: true, maxCheckpointsPerTrace: 100 },
      });

      const config = tt.getConfig();
      expect(config.autoCheckpoint).toBe(true);
      expect(config.maxCheckpointsPerTrace).toBe(100);
    });
  });
});
