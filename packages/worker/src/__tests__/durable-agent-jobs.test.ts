import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { Agent, Cogitator, InMemoryDurableRunStore, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import type { AgentJobPayload, JobPayload, JobResult } from '../types';
import { serializeAgent } from '../serialize';
import { durableJobRunId, processAgentJob } from '../processors/agent';
import { WorkerPool } from '../worker';

type Processor = (job: Job<JobPayload>, token?: string, signal?: AbortSignal) => Promise<JobResult>;

const mocks = vi.hoisted(() => {
  const workerInstances: { processor: Processor }[] = [];

  class MockWorker {
    close = vi.fn().mockResolvedValue(undefined);
    cancelJob = vi.fn().mockReturnValue(false);
    cancelAllJobs = vi.fn();
    constructor(
      readonly name: string,
      readonly processor: Processor
    ) {
      workerInstances.push(this);
    }
    on(): this {
      return this;
    }
  }

  class MockRedis {
    quit = vi.fn().mockResolvedValue('OK');
  }

  class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  }

  class DelayedError extends Error {
    constructor() {
      super('delayed');
      this.name = 'DelayedError';
    }
  }

  return { workerInstances, MockWorker, MockRedis, UnrecoverableError, DelayedError };
});

vi.mock('bullmq', () => ({
  Worker: mocks.MockWorker,
  Queue: class {},
  UnrecoverableError: mocks.UnrecoverableError,
  DelayedError: mocks.DelayedError,
}));
vi.mock('ioredis', () => ({ Redis: mocks.MockRedis, Cluster: mocks.MockRedis }));

const packImpl = vi.fn(async () => 'packed');
const labelStarted = vi.fn();
const pack = tool({
  name: 'pack',
  description: 'Pack the order',
  parameters: z.object({}),
  execute: packImpl,
});
const label = tool({
  name: 'label',
  description: 'Print the label',
  parameters: z.object({}),
  execute: async () => {
    labelStarted();
    return new Promise<string>(() => undefined);
  },
});

const calls: ToolCall[] = [
  { id: 'p', name: 'pack', arguments: {} },
  { id: 'l', name: 'label', arguments: {} },
];

/** Plans both calls, then answers with what the tools returned */
function shippingBackend(): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const respond = (request: ChatRequest): ChatResponse => {
    requests.push(request);
    const results = request.messages.filter((message) => message.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'plan',
        content: '',
        toolCalls: calls,
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'done',
      content: `Done: ${results.map((message) => String(message.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  return {
    provider: 'openai',
    requests,
    chat: async (request) => respond(request),
    chatStream: async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    },
  };
}

const agentConfig = serializeAgent(
  new Agent({ name: 'shipper', model: 'mock/m', instructions: 'Ship.', tools: [pack, label] })
);

function job(jobId: string): AgentJobPayload {
  return { type: 'agent', jobId, agentConfig, input: 'Ship order 7', threadId: `t-${jobId}` };
}

beforeEach(() => {
  packImpl.mockClear();
  labelStarted.mockReset();
  mocks.workerInstances.length = 0;
});

describe('durable agent jobs', () => {
  it('go on from the last step on the next attempt, on another worker', async () => {
    let now = 0;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const crashedBackend = shippingBackend();
    const crashed = new Cogitator({
      llm: { backends: { mock: crashedBackend } },
      durable: { store, owner: 'worker-1', enabled: false },
    });
    const started = new Promise<void>((resolve) => labelStarted.mockImplementation(resolve));
    processAgentJob(
      job('j1'),
      { cogitator: crashed, tools: [pack, label] },
      { durable: true }
    ).catch(() => undefined);
    await started;
    expect(await crashed.durableRuns()).toEqual([
      expect.objectContaining({ runId: durableJobRunId('j1'), threadId: 't-j1' }),
    ]);

    now += 120_000;
    const nextBackend = shippingBackend();
    const next = new Cogitator({
      llm: { backends: { mock: nextBackend } },
      durable: { store, owner: 'worker-2', enabled: false },
    });
    const result = await processAgentJob(
      job('j1'),
      { cogitator: next, tools: [pack, label] },
      { durable: true }
    );

    expect(result.status).toBe('completed');
    expect(result.output).toContain('packed');
    expect(result.output).toContain('outcome unknown');
    expect(packImpl).toHaveBeenCalledTimes(1);
    expect(nextBackend.requests).toHaveLength(1);
    expect(await store.list()).toEqual([]);
  });

  it('start over without durable, as before', async () => {
    const backend = shippingBackend();
    const cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
    const started = new Promise<void>((resolve) => labelStarted.mockImplementation(resolve));
    processAgentJob(job('j2'), { cogitator, tools: [pack, label] }).catch(() => undefined);
    await started;
    expect(await cogitator.durableRuns()).toEqual([]);
  });

  it('hand their run over when the pool stops, keeping the checkpoint', async () => {
    const store = new InMemoryDurableRunStore();
    const cogitator = new Cogitator({
      llm: { backends: { mock: shippingBackend() } },
      durable: { store, owner: 'worker-1', enabled: false },
    });
    const pool = new WorkerPool({
      redis: { host: 'localhost', port: 6379 },
      cogitator,
      tools: [pack, label],
      durable: true,
    });
    await pool.start();
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => labelStarted.mockImplementation(resolve));
    const running = mocks.workerInstances[0].processor(
      {
        id: 'j3',
        data: job('j3'),
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as unknown as Job<JobPayload>,
      undefined,
      controller.signal
    );
    running.catch(() => undefined);
    await started;

    await pool.forceStop();
    controller.abort('Worker pool stopped');
    await expect(running).rejects.toThrow('The worker pool stopped');

    const [kept] = await store.list();
    expect(kept).toMatchObject({ runId: durableJobRunId('j3') });
    expect(kept.lease).toBeUndefined();
  });

  it('wait for a run another worker still holds instead of using up their attempts', async () => {
    let now = 0;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const holding = new Cogitator({
      llm: { backends: { mock: shippingBackend() } },
      durable: { store, owner: 'worker-1', enabled: false },
    });
    const started = new Promise<void>((resolve) => labelStarted.mockImplementation(resolve));
    processAgentJob(
      job('j4'),
      { cogitator: holding, tools: [pack, label] },
      { durable: true }
    ).catch(() => undefined);
    await started;
    now = 1_000;

    const pool = new WorkerPool({
      redis: { host: 'localhost', port: 6379 },
      cogitator: new Cogitator({
        llm: { backends: { mock: shippingBackend() } },
        durable: { store, owner: 'worker-2', enabled: false },
      }),
      tools: [pack, label],
      durable: true,
    });
    await pool.start();
    const moveToDelayed = vi.fn(async () => undefined);
    const attempt = mocks.workerInstances[0].processor(
      {
        id: 'j4',
        data: job('j4'),
        attemptsMade: 1,
        opts: { attempts: 3 },
        moveToDelayed,
      } as unknown as Job<JobPayload>,
      'token-1'
    );

    await expect(attempt).rejects.toThrow('delayed');
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-1');
    const [until] = moveToDelayed.mock.calls[0] as unknown as [number];
    expect(until).toBeGreaterThan(Date.now());
    expect(packImpl).toHaveBeenCalledTimes(1);
    await pool.forceStop();
  });
});
