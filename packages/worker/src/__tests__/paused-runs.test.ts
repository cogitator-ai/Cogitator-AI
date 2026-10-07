import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { Agent, AgentRunPausedError, Cogitator, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import type { AgentJobResult, JobPayload, JobResult, SerializedWorkflow } from '../types';
import { serializeAgent } from '../serialize';
import { processAgentJob } from '../processors/agent';
import { processWorkflowJob } from '../processors/workflow';
import { executeSwarmAgentJob } from '../processors/swarm-agent';

type Processor = (job: Job<JobPayload>, token?: string, signal?: AbortSignal) => Promise<JobResult>;

const mocks = vi.hoisted(() => {
  const workerInstances: { processor: Processor }[] = [];
  const queueAdd = vi.fn();

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

  class MockQueue {
    add = queueAdd;
    close = vi.fn().mockResolvedValue(undefined);
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

  return { workerInstances, queueAdd, MockWorker, MockQueue, MockRedis, UnrecoverableError };
});

vi.mock('bullmq', () => ({
  Worker: mocks.MockWorker,
  Queue: mocks.MockQueue,
  UnrecoverableError: mocks.UnrecoverableError,
}));
vi.mock('ioredis', () => ({ Redis: mocks.MockRedis, Cluster: mocks.MockRedis }));

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});

const refundCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };

function refundingBackend(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me refund that.',
        toolCalls: [refundCall],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'r2',
      content: `Done: ${results.map((m) => String(m.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const cogitators: Cogitator[] = [];
function worker() {
  const cogitator = new Cogitator({ llm: { backends: { mock: refundingBackend() } } });
  cogitators.push(cogitator);
  return { cogitator, tools: [refund] };
}

const agentConfig = serializeAgent(
  new Agent({ name: 'support', model: 'mock/m', instructions: 'Refund orders.', tools: [refund] })
);

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

beforeEach(() => {
  refundImpl.mockClear();
  mocks.queueAdd.mockReset();
  mocks.workerInstances.length = 0;
});

afterEach(async () => {
  await Promise.all(cogitators.splice(0).map((c) => c.close()));
});

describe('agent jobs that pause for approval', () => {
  it('complete with the pause, the waiting calls and the checkpoint', async () => {
    const result = await processAgentJob(
      { type: 'agent', jobId: 'j1', agentConfig, input: 'Refund A-1', threadId: 't1' },
      worker()
    );

    expect(result.status).toBe('paused');
    expect(result.pendingApprovals?.map((p) => p.toolCallId)).toEqual(['c1']);
    expect(result.checkpoint?.threadId).toBe('t1');
    expect(refundImpl).not.toHaveBeenCalled();
  });

  it('resume on another worker from the checkpoint the paused job returned', async () => {
    const paused = roundTrip(
      await processAgentJob(
        { type: 'agent', jobId: 'j1', agentConfig, input: 'Refund A-1', threadId: 't1' },
        worker()
      )
    );

    const result = await processAgentJob(
      {
        type: 'agent',
        jobId: 'j2',
        agentConfig,
        input: '',
        threadId: 't1',
        resume: { checkpoint: paused.checkpoint, decisions: { c1: { approved: true } } },
      },
      worker()
    );

    expect(result.status).toBe('completed');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('"refunded":"A-1"');
    expect(result.threadId).toBe('t1');
  });

  it('resume by thread from the worker store, and decline with the reason', async () => {
    const runtime = worker();
    await processAgentJob(
      { type: 'agent', jobId: 'j1', agentConfig, input: 'Refund A-1', threadId: 't1' },
      runtime
    );

    const result = await processAgentJob(
      {
        type: 'agent',
        jobId: 'j2',
        agentConfig,
        input: '',
        threadId: 't1',
        resume: { defaultDecision: { approved: false, reason: 'not eligible' } },
      },
      runtime
    );

    expect(result.status).toBe('completed');
    expect(refundImpl).not.toHaveBeenCalled();
    expect(result.output).toContain('not eligible');
  });
});

describe('JobQueue.resumeAgentJob', () => {
  it('queues the checkpoint and the decisions of a paused job', async () => {
    mocks.queueAdd.mockResolvedValue({ id: 'job' });
    const paused = roundTrip(
      await processAgentJob(
        { type: 'agent', jobId: 'j1', agentConfig, input: 'Refund A-1', threadId: 't1' },
        worker()
      )
    );
    const { JobQueue } = await import('../queue');
    const queue = new JobQueue({ redis: { host: 'h', port: 1 } });

    await queue.resumeAgentJob(agentConfig, paused, { decisions: { c1: { approved: true } } });

    const [name, payload] = mocks.queueAdd.mock.calls[0] as [string, JobPayload];
    expect(name).toBe('agent');
    expect(payload).toMatchObject({
      type: 'agent',
      agentConfig,
      threadId: 't1',
      resume: { checkpoint: paused.checkpoint, decisions: { c1: { approved: true } } },
    });
    await queue.close();
  });

  it('refuses a job whose run completed', async () => {
    const { JobQueue } = await import('../queue');
    const queue = new JobQueue({ redis: { host: 'h', port: 1 } });
    const completed: Pick<AgentJobResult, 'status' | 'threadId'> = {
      status: 'completed',
      threadId: 't1',
    };

    await expect(queue.resumeAgentJob(agentConfig, completed)).rejects.toThrow(
      'whose run is completed, not paused'
    );
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    await queue.close();
  });
});

const workflow: SerializedWorkflow = {
  id: 'wf',
  name: 'refunds',
  nodes: [
    { id: 'pay', type: 'agent', config: { agentConfig, prompt: 'Refund A-1' } },
    { id: 'shout', type: 'transform', config: { transform: 'uppercase', inputKey: 'pay' } },
  ],
  edges: [{ from: 'pay', to: 'shout' }],
};

describe('workflow jobs whose agent pauses', () => {
  it('fail with AgentRunPausedError instead of passing the pre-tool text on', async () => {
    const error = await processWorkflowJob(
      { type: 'workflow', jobId: 'w', runId: 'r', input: {}, workflowConfig: workflow },
      worker()
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentRunPausedError);
    expect((error as AgentRunPausedError).message).toContain(
      'Agent "support" paused in workflow "refunds", node "pay"'
    );
    expect((error as AgentRunPausedError).pendingApprovals.map((p) => p.toolName)).toEqual([
      'refund',
    ]);
    expect(refundImpl).not.toHaveBeenCalled();
  });

  it('fail without retries in the worker pool', async () => {
    const runtime = worker();
    const { WorkerPool } = await import('../worker');
    const pool = new WorkerPool({ redis: { host: 'h', port: 1 }, ...runtime });
    await pool.start();
    const job = {
      id: 'job_1',
      data: { type: 'workflow', jobId: 'w', runId: 'r', input: {}, workflowConfig: workflow },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<JobPayload>;

    const error = await mocks.workerInstances[0].processor(job, 'token').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(mocks.UnrecoverableError);
    expect((error as Error).message).toContain('paused in workflow "refunds"');
    await pool.forceStop();
  });
});

describe('distributed swarm turns that pause', () => {
  it('report the pause to the coordinator', async () => {
    const result = await executeSwarmAgentJob(
      {
        type: 'swarm-agent',
        jobId: 'job_1',
        swarmId: 'swarm_1',
        agentName: 'support',
        agentConfig,
        input: 'Refund A-1',
        stateKeys: { blackboard: 'b', messages: 'm', results: 'r' },
      },
      worker()
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('paused');
    expect(result.pendingApprovals?.map((p) => p.toolName)).toEqual(['refund']);
  });
});
