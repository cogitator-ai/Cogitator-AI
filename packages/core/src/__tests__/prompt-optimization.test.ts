import { describe, it, expect, vi, afterEach } from 'vitest';
import { AutoOptimizer, PromptLogger, PromptMonitor } from '../learning/index';
import type { ABTestingFramework } from '../learning/ab-testing';
import type { AgentOptimizer } from '../learning/agent-optimizer';
import type { RollbackManager } from '../learning/rollback-manager';
import type {
  CapturedPrompt,
  ChatResponse,
  ChatStreamChunk,
  DegradationAlert,
  ExecutionTrace,
  LLMBackend,
  PromptPerformanceMetrics,
} from '@cogitator-ai/types';

async function* emptyStream(): AsyncGenerator<ChatStreamChunk> {
  yield* [];
}

function createTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace_1',
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    input: 'input',
    output: 'output',
    steps: [],
    toolCalls: [],
    reflections: [],
    metrics: {
      success: true,
      toolAccuracy: 1,
      efficiency: 1,
      completeness: 1,
    },
    score: 0.8,
    model: 'test-model',
    createdAt: new Date(),
    duration: 100,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
    },
    isDemo: false,
    ...overrides,
  };
}

function createBaseline(
  overrides: Partial<PromptPerformanceMetrics> = {}
): PromptPerformanceMetrics {
  return {
    agentId: 'agent_1',
    windowStart: new Date(0),
    windowEnd: new Date(1000),
    totalRuns: 20,
    successfulRuns: 20,
    failedRuns: 0,
    avgScore: 0.9,
    minScore: 0.8,
    maxScore: 1,
    scoreP50: 0.9,
    scoreP95: 1,
    avgLatency: 100,
    p50Latency: 100,
    p95Latency: 100,
    p99Latency: 100,
    totalCost: 1,
    avgCostPerRun: 0.05,
    avgInputTokens: 10,
    avgOutputTokens: 5,
    ...overrides,
  };
}

describe('PromptMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should keep the first execution in a rotated window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const monitor = new PromptMonitor({ windowSize: 1000 });
    monitor.recordExecution(createTrace({ score: 0.8 }));

    vi.setSystemTime(new Date('2024-01-01T00:00:02Z'));
    monitor.recordExecution(createTrace({ id: 'trace_2', score: 0.4 }));

    const metrics = monitor.getCurrentMetrics('agent_1');
    expect(metrics?.totalRuns).toBe(1);
    expect(metrics?.avgScore).toBe(0.4);
  });

  it('should alert when current score drops to zero', () => {
    const monitor = new PromptMonitor({ scoreDropThreshold: 0.2 });
    monitor.setBaseline('agent_1', createBaseline({ avgScore: 0.9 }));

    let alerts: DegradationAlert[] = [];
    for (let i = 0; i < 5; i++) {
      alerts = monitor.recordExecution(createTrace({ id: `trace_${i}`, score: 0 }));
    }

    expect(alerts.some((alert) => alert.type === 'score_drop')).toBe(true);
  });
});

describe('PromptLogger', () => {
  it('should not fail chat when prompt capture fails', async () => {
    const response: ChatResponse = {
      id: 'chat_1',
      content: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    };
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn().mockResolvedValue(response),
      chatStream: vi.fn(emptyStream),
    };
    const store = {
      capture: vi
        .fn<(_: CapturedPrompt) => Promise<void>>()
        .mockRejectedValue(new Error('db down')),
    };
    const logger = new PromptLogger(backend, store);
    logger.setContext({ runId: 'run_1', agentId: 'agent_1', threadId: 'thread_1' });

    await expect(
      logger.chat({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toBe(response);
  });

  it('should preserve original backend errors when capture also fails', async () => {
    const backendError = new Error('llm failed');
    const backend: LLMBackend = {
      provider: 'openai',
      chat: vi.fn().mockRejectedValue(backendError),
      chatStream: vi.fn(emptyStream),
    };
    const store = {
      capture: vi
        .fn<(_: CapturedPrompt) => Promise<void>>()
        .mockRejectedValue(new Error('db down')),
    };
    const logger = new PromptLogger(backend, store);
    logger.setContext({ runId: 'run_1', agentId: 'agent_1', threadId: 'thread_1' });

    await expect(
      logger.chat({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] })
    ).rejects.toThrow('llm failed');
  });
});

describe('AutoOptimizer', () => {
  it('should not optimize before minRunsForOptimization is reached', async () => {
    const agentOptimizer = {
      compile: vi.fn().mockResolvedValue({
        success: false,
        improvement: 0,
        errors: [],
        instructionsAfter: 'current',
      }),
    } as unknown as AgentOptimizer;
    const abTesting = {
      getActiveTest: vi.fn().mockResolvedValue(null),
    } as unknown as ABTestingFramework;
    const monitor = {
      recordExecution: vi.fn().mockReturnValue([]),
      recordRollback: vi.fn(),
      clearWindow: vi.fn(),
    } as unknown as PromptMonitor;
    const rollbackManager = {
      getCurrentVersion: vi.fn().mockResolvedValue({ instructions: 'current' }),
      recordMetrics: vi.fn().mockResolvedValue(undefined),
      rollbackToPrevious: vi.fn(),
    } as unknown as RollbackManager;

    const optimizer = new AutoOptimizer({
      enabled: true,
      triggerAfterRuns: 1,
      minRunsForOptimization: 3,
      requireABTest: false,
      agentOptimizer,
      abTesting,
      monitor,
      rollbackManager,
    });

    await optimizer.recordExecution(createTrace({ id: 'trace_1' }));
    await optimizer.recordExecution(createTrace({ id: 'trace_2' }));
    expect(agentOptimizer.compile).not.toHaveBeenCalled();

    await optimizer.recordExecution(createTrace({ id: 'trace_3' }));
    expect(agentOptimizer.compile).toHaveBeenCalledTimes(1);
  });
});
