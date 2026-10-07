import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import { Agent, Cogitator } from '@cogitator-ai/core';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import type { JobPayload, JobResult } from '../types';
import { serializeAgent } from '../serialize';
import { processAgentJob } from '../processors/agent';
import { processWorkflowJob } from '../processors/workflow';
import { processSwarmJob } from '../processors/swarm';
import { executeSwarmAgentJob } from '../processors/swarm-agent';

type Processor = (job: Job<JobPayload>, token?: string, signal?: AbortSignal) => Promise<JobResult>;

const mocks = vi.hoisted(() => {
  const workerInstances: {
    processor: Processor;
    close: ReturnType<typeof vi.fn<(force?: boolean) => Promise<void>>>;
    cancelJob: ReturnType<typeof vi.fn<(jobId: string, reason?: string) => boolean>>;
    cancelAllJobs: ReturnType<typeof vi.fn<(reason?: string) => void>>;
  }[] = [];

  class MockWorker {
    close = vi.fn<(force?: boolean) => Promise<void>>().mockResolvedValue(undefined);
    cancelJob = vi.fn<(jobId: string, reason?: string) => boolean>().mockReturnValue(false);
    cancelAllJobs = vi.fn<(reason?: string) => void>();

    constructor(
      readonly name: string,
      readonly processor: Processor,
      readonly options: Record<string, unknown>
    ) {
      workerInstances.push(this);
    }

    on(): this {
      return this;
    }
  }

  class MockRedis {
    quit = vi.fn().mockResolvedValue('OK');
    constructor(readonly options: Record<string, unknown>) {}
  }

  class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  }

  return { workerInstances, MockWorker, MockRedis, UnrecoverableError };
});

const { workerInstances, UnrecoverableError } = mocks;

vi.mock('bullmq', () => ({
  Worker: mocks.MockWorker,
  UnrecoverableError: mocks.UnrecoverableError,
}));
vi.mock('ioredis', () => ({ Redis: mocks.MockRedis, Cluster: mocks.MockRedis }));
/** A backend whose answers wait until the run is aborted. */
function hangingBackend() {
  const signals: AbortSignal[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(
      (request: ChatRequest) =>
        new Promise<ChatResponse>((_resolve, reject) => {
          if (request.signal) signals.push(request.signal);
          request.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
        })
    ),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, signals };
}

const cogitators: Cogitator[] = [];
function setup() {
  const { backend, signals } = hangingBackend();
  const cogitator = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
  cogitators.push(cogitator);
  const agent = serializeAgent(new Agent({ name: 'slow', model: 'mock/m', instructions: 'x' }));
  return { cogitator, signals, agent };
}

afterEach(async () => {
  await Promise.all(cogitators.splice(0).map((c) => c.close()));
});

async function expectAbortedBy(
  start: (signal: AbortSignal) => Promise<unknown>,
  signals: AbortSignal[]
): Promise<void> {
  const controller = new AbortController();
  const running = start(controller.signal);
  await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
  controller.abort(new Error('job cancelled'));
  await expect(running).rejects.toThrow();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
}

describe('job processors honour the job signal', () => {
  it('agent jobs', async () => {
    const { cogitator, signals, agent } = setup();
    await expectAbortedBy(
      (signal) =>
        processAgentJob(
          { type: 'agent', jobId: 'j', agentConfig: agent, input: 'hi', threadId: 't' },
          { cogitator },
          { signal }
        ),
      signals
    );
  });

  it('workflow jobs', async () => {
    const { cogitator, signals, agent } = setup();
    await expectAbortedBy(
      (signal) =>
        processWorkflowJob(
          {
            type: 'workflow',
            jobId: 'w',
            runId: 'r',
            input: {},
            workflowConfig: {
              id: 'wf',
              name: 'wf',
              nodes: [{ id: 'a', type: 'agent', config: { agentConfig: agent } }],
              edges: [],
            },
          },
          { cogitator },
          { signal }
        ),
      signals
    );
  });

  it('swarm jobs', async () => {
    const { cogitator, signals, agent } = setup();
    await expectAbortedBy(
      (signal) =>
        processSwarmJob(
          {
            type: 'swarm',
            jobId: 's',
            input: 'go',
            swarmConfig: { topology: 'sequential', agents: [agent] },
          },
          { cogitator },
          { signal }
        ),
      signals
    );
  });

  it('distributed swarm turns', async () => {
    const { cogitator, signals, agent } = setup();
    const controller = new AbortController();
    const running = executeSwarmAgentJob(
      {
        type: 'swarm-agent',
        jobId: 'job_1',
        swarmId: 'swarm_1',
        agentName: 'slow',
        agentConfig: agent,
        input: 'go',
        stateKeys: { blackboard: 'b', messages: 'm', results: 'r' },
      },
      { cogitator },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort(new Error('turn cancelled'));

    const result = await running;
    expect(result.error).toBeDefined();
    expect(signals[0].aborted).toBe(true);
  });
});

describe('WorkerPool cancellation', () => {
  beforeEach(() => {
    workerInstances.length = 0;
  });

  it('declares the signal parameter so BullMQ hands it over, and passes it to the run', async () => {
    const { cogitator, signals, agent } = setup();
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: { host: 'h', port: 1 }, cogitator });
    await pool.start();
    const processor = workerInstances[0].processor;

    expect(processor.length).toBeGreaterThanOrEqual(3);

    const controller = new AbortController();
    const job = {
      id: 'job_1',
      data: { type: 'agent', jobId: 'job_1', agentConfig: agent, input: 'hi', threadId: 't' },
      attemptsMade: 0,
      opts: {},
    } as unknown as Job<JobPayload>;
    const running = processor(job, 'token', controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort(new Error('cancelled by user'));

    const error = await running.catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(signals[0].aborted).toBe(true);
    await pool.forceStop();
  });

  it('cancels a job on whichever worker runs it', async () => {
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: { host: 'h', port: 1 }, workerCount: 2 });
    await pool.start();
    workerInstances[1].cancelJob.mockReturnValue(true);

    expect(pool.cancelJob('job_9', 'not needed')).toBe(true);
    expect(workerInstances[0].cancelJob).toHaveBeenCalledWith('job_9', 'not needed');
    await pool.forceStop();
  });

  it('aborts the jobs still running when stop() runs out of time', async () => {
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: { host: 'h', port: 1 } });
    await pool.start();
    const worker = workerInstances[0];
    worker.close.mockImplementation((force?: boolean) =>
      force ? Promise.resolve() : new Promise<void>(() => {})
    );

    await pool.stop(10);

    expect(worker.cancelAllJobs).toHaveBeenCalled();
    expect(worker.cancelAllJobs.mock.invocationCallOrder[0]).toBeLessThan(
      worker.close.mock.invocationCallOrder.at(-1)!
    );
    expect(worker.close).toHaveBeenLastCalledWith(true);
  });

  it('aborts running jobs on forceStop()', async () => {
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: { host: 'h', port: 1 } });
    await pool.start();

    await pool.forceStop();

    expect(workerInstances[0].cancelAllJobs).toHaveBeenCalled();
  });
});
