import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SwarmAgentJobPayload, SwarmAgentJobResult } from '../types';

const queues = new Map<string, string[]>();
const sets = new Map<string, Set<string>>();
const published: { channel: string; message: string }[] = [];
const executeSwarmAgentJob = vi.fn();

class MockRedis {
  status = 'wait';
  connect = vi.fn(async () => {
    this.status = 'ready';
  });
  disconnect = vi.fn(() => {
    this.status = 'end';
  });
  quit = vi.fn(async () => {
    this.status = 'end';
    return 'OK';
  });
  publish = vi.fn(async (channel: string, message: string) => {
    published.push({ channel, message });
    return 1;
  });

  sismember = vi.fn(async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0));

  async blpop(key: string, timeout: number): Promise<[string, string] | null> {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      if (this.status === 'end') throw new Error('Connection is closed.');
      const item = queues.get(key)?.shift();
      if (item !== undefined) return [key, item];
      await new Promise((r) => setTimeout(r, 2));
    }
    return null;
  }
}

vi.mock('ioredis', () => ({ Redis: MockRedis }));
vi.mock('../processors/swarm-agent.js', () => ({ executeSwarmAgentJob }));

function job(id: string): SwarmAgentJobPayload {
  return {
    type: 'swarm-agent',
    jobId: id,
    swarmId: 's1',
    agentName: 'writer',
    agentConfig: {
      name: 'writer',
      instructions: 'x',
      model: 'ollama/m',
      provider: 'ollama',
      tools: [],
    },
    input: 'go',
    stateKeys: {
      blackboard: 'b',
      messages: 'm',
      results: 'swarm:s1:results',
      cancelled: 'swarm:s1:cancelled',
    },
  };
}

function result(payload: SwarmAgentJobPayload, error?: string): SwarmAgentJobResult {
  return {
    type: 'swarm-agent',
    jobId: payload.jobId,
    swarmId: payload.swarmId,
    agentName: payload.agentName,
    output: error ? '' : 'done',
    toolCalls: [],
    tokenUsage: { prompt: 1, completion: 1, total: 2 },
    ...(error && { error }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('DistributedSwarmWorker', () => {
  beforeEach(() => {
    queues.clear();
    sets.clear();
    published.length = 0;
    executeSwarmAgentJob.mockReset();
  });

  it('consumes jobs from the swarm queue and publishes results to the coordinator', async () => {
    const { DistributedSwarmWorker } = await import('../distributed-swarm-worker');
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const onJobCompleted = vi.fn();
    const worker = new DistributedSwarmWorker(
      { keyPrefix: 'swarm', queue: 'swarm-agent-jobs', pollTimeout: 0.1 },
      { onJobCompleted }
    );

    await worker.start();
    queues.set('swarm:jobs:swarm-agent-jobs', [JSON.stringify(job('j1'))]);

    await waitFor(() => published.length === 1);
    expect(published[0].channel).toBe('swarm:s1:results');
    expect(JSON.parse(published[0].message)).toMatchObject({ jobId: 'j1', output: 'done' });
    expect(onJobCompleted).toHaveBeenCalled();

    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('respects the concurrency limit', async () => {
    const { DistributedSwarmWorker } = await import('../distributed-swarm-worker');
    let inFlight = 0;
    let peak = 0;
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return result(payload);
    });
    const worker = new DistributedSwarmWorker({ concurrency: 2, pollTimeout: 0.1 });

    await worker.start();
    queues.set(
      'swarm:jobs:swarm-agent-jobs',
      ['a', 'b', 'c', 'd', 'e'].map((id) => JSON.stringify(job(id)))
    );

    await waitFor(() => published.length === 5);
    expect(peak).toBe(2);
    await worker.stop();
  });

  it('reports failed turns and discards malformed payloads', async () => {
    const { DistributedSwarmWorker } = await import('../distributed-swarm-worker');
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload, 'model offline')
    );
    const onJobFailed = vi.fn();
    const onError = vi.fn();
    const worker = new DistributedSwarmWorker({ pollTimeout: 0.1 }, { onJobFailed, onError });

    await worker.start();
    queues.set('swarm:jobs:swarm-agent-jobs', [
      'not json',
      JSON.stringify({ type: 'swarm-agent' }),
      JSON.stringify(job('bad')),
    ]);

    await waitFor(() => published.length === 1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'bad' }),
      expect.objectContaining({ message: 'model offline' })
    );
    expect(JSON.parse(published[0].message)).toMatchObject({ error: 'model offline' });
    await worker.stop();
  });

  it('waits for in-flight jobs when stopping', async () => {
    const { DistributedSwarmWorker } = await import('../distributed-swarm-worker');
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) => {
      await new Promise((r) => setTimeout(r, 30));
      return result(payload);
    });
    const worker = new DistributedSwarmWorker({ pollTimeout: 0.1 });

    await worker.start();
    queues.set('swarm:jobs:swarm-agent-jobs', [JSON.stringify(job('slow'))]);
    await waitFor(() => worker.getActiveJobCount() === 1);

    await worker.stop();
    expect(published).toHaveLength(1);
  });

  it('skips a turn the coordinator already cancelled', async () => {
    const { DistributedSwarmWorker } = await import('../distributed-swarm-worker');
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const onJobCancelled = vi.fn();
    const worker = new DistributedSwarmWorker({ pollTimeout: 0.1 }, { onJobCancelled });

    sets.set('swarm:s1:cancelled', new Set(['gone']));
    await worker.start();
    queues.set('swarm:jobs:swarm-agent-jobs', [JSON.stringify(job('gone'))]);

    await waitFor(() => onJobCancelled.mock.calls.length === 1);
    expect(executeSwarmAgentJob).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
    await worker.stop();
  });

  it('aborts a running turn once the coordinator cancels it', async () => {
    const { DistributedSwarmWorker } = await import('../distributed-swarm-worker');
    let seen: AbortSignal | undefined;
    executeSwarmAgentJob.mockImplementation(
      (payload: SwarmAgentJobPayload, _runtime: unknown, execution: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          seen = execution.signal;
          execution.signal?.addEventListener('abort', () => resolve(result(payload, 'aborted')));
        })
    );
    const onJobCancelled = vi.fn();
    const worker = new DistributedSwarmWorker(
      { pollTimeout: 0.1, cancelCheckInterval: 10 },
      { onJobCancelled }
    );

    await worker.start();
    queues.set('swarm:jobs:swarm-agent-jobs', [JSON.stringify(job('late'))]);
    await waitFor(() => seen !== undefined);
    sets.set('swarm:s1:cancelled', new Set(['late']));

    await waitFor(() => onJobCancelled.mock.calls.length === 1);
    expect(seen?.aborted).toBe(true);
    expect(published).toHaveLength(0);
    await worker.stop();
  });
});
