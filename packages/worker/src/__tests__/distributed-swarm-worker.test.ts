import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SwarmAgentJobPayload, SwarmAgentJobResult } from '../types';
import { DistributedSwarmWorker } from '../distributed-swarm-worker';

let queues = new Map<string, string[]>();
let sets = new Map<string, Set<string>>();
let strings = new Map<string, { value: string; px?: number }>();
let published: { channel: string; message: string }[] = [];
let redisTiming = { lrangeDelay: 0, lranges: 0, inLrange: 0, maxInLrange: 0 };
const { executeSwarmAgentJob } = vi.hoisted(() => ({ executeSwarmAgentJob: vi.fn() }));

/** Enough of Redis for the worker: lists, sets, strings, pub/sub */
class MockRedis {
  private readonly db = { queues, sets, strings, published, redisTiming };
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
    this.db.published.push({ channel, message });
    return 1;
  });

  sismember = vi.fn(async (key: string, member: string) =>
    this.db.sets.get(key)?.has(member) ? 1 : 0
  );

  async sadd(key: string, member: string): Promise<number> {
    const set = this.db.sets.get(key) ?? new Set<string>();
    this.db.sets.set(key, set);
    const had = set.has(member);
    set.add(member);
    return had ? 0 : 1;
  }

  async srem(key: string, member: string): Promise<number> {
    return this.db.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.db.sets.get(key) ?? [])];
  }

  async set(key: string, value: string, _mode?: 'PX', px?: number): Promise<'OK'> {
    this.db.strings.set(key, { value, ...(px !== undefined && { px }) });
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    return this.db.strings.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    return this.db.strings.delete(key) ? 1 : 0;
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.db.queues.get(key) ?? [];
    const index = list.indexOf(value);
    if (count !== 1 || index === -1) return 0;
    list.splice(index, 1);
    return 1;
  }

  async lrange(key: string): Promise<string[]> {
    this.db.redisTiming.lranges++;
    this.db.redisTiming.inLrange++;
    this.db.redisTiming.maxInLrange = Math.max(
      this.db.redisTiming.maxInLrange,
      this.db.redisTiming.inLrange
    );
    await new Promise((r) => setTimeout(r, this.db.redisTiming.lrangeDelay));
    this.db.redisTiming.inLrange--;
    return [...(this.db.queues.get(key) ?? [])];
  }

  async eval(
    script: string,
    _keys: number,
    from: string,
    to: string,
    raw: string
  ): Promise<number> {
    if (script.includes('SREM')) {
      return (await this.exists(from)) === 0 ? this.srem(to, raw) : 0;
    }
    if ((await this.lrem(from, 1, raw)) !== 1) return 0;
    const target = this.db.queues.get(to) ?? [];
    this.db.queues.set(to, target);
    target.unshift(raw);
    return 1;
  }

  async lmove(
    from: string,
    to: string,
    _whereFrom: 'RIGHT',
    _whereTo: 'LEFT'
  ): Promise<string | null> {
    const item = this.db.queues.get(from)?.pop();
    if (item === undefined) return null;
    const target = this.db.queues.get(to) ?? [];
    this.db.queues.set(to, target);
    target.unshift(item);
    return item;
  }

  async blmove(
    from: string,
    to: string,
    _whereFrom: 'LEFT',
    _whereTo: 'RIGHT',
    timeout: number
  ): Promise<string | null> {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      if (this.status === 'end') throw new Error('Connection is closed.');
      const item = this.db.queues.get(from)?.shift();
      if (item !== undefined) {
        const target = this.db.queues.get(to) ?? [];
        this.db.queues.set(to, target);
        target.push(item);
        return item;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    return null;
  }
}

vi.mock('@cogitator-ai/swarms', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSwarmRedis: () => new MockRedis(),
  closeSwarmRedis: async (client: MockRedis) => {
    await client.quit();
  },
}));
vi.mock('../processors/swarm-agent.js', () => ({ executeSwarmAgentJob }));

const QUEUE = 'swarm:jobs:{swarm-agent-jobs}';

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

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error('condition not met');
    },
    { timeout: timeoutMs, interval: 5 }
  );
}

describe('DistributedSwarmWorker', () => {
  const workers: DistributedSwarmWorker[] = [];
  const spawn = (...args: ConstructorParameters<typeof DistributedSwarmWorker>) => {
    const worker = new DistributedSwarmWorker(...args);
    workers.push(worker);
    return worker;
  };

  beforeEach(() => {
    queues = new Map();
    sets = new Map();
    strings = new Map();
    published = [];
    redisTiming = { lrangeDelay: 0, lranges: 0, inLrange: 0, maxInLrange: 0 };
    executeSwarmAgentJob.mockReset();
  });

  afterEach(async () => {
    await Promise.allSettled(workers.splice(0).map((worker) => worker.stop()));
  });

  it('consumes jobs from the swarm queue and publishes results to the coordinator', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const onJobCompleted = vi.fn();
    const worker = spawn(
      { keyPrefix: 'swarm', queue: 'swarm-agent-jobs', pollTimeout: 0.1 },
      { onJobCompleted }
    );

    await worker.start();
    queues.set(QUEUE, [JSON.stringify(job('j1'))]);

    await waitFor(() => published.length === 1);
    expect(published[0].channel).toBe('swarm:s1:results');
    expect(JSON.parse(published[0].message)).toMatchObject({ jobId: 'j1', output: 'done' });
    expect(onJobCompleted).toHaveBeenCalled();

    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return result(payload);
    });
    const worker = spawn({ concurrency: 2, pollTimeout: 0.1 });

    await worker.start();
    queues.set(
      QUEUE,
      ['a', 'b', 'c', 'd', 'e'].map((id) => JSON.stringify(job(id)))
    );

    await waitFor(() => published.length === 5);
    expect(peak).toBe(2);
    await worker.stop();
  });

  it('reports failed turns and discards malformed payloads', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload, 'model offline')
    );
    const onJobFailed = vi.fn();
    const onError = vi.fn();
    const worker = spawn({ pollTimeout: 0.1 }, { onJobFailed, onError });

    await worker.start();
    queues.set(QUEUE, [
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
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) => {
      await new Promise((r) => setTimeout(r, 30));
      return result(payload);
    });
    const worker = spawn({ pollTimeout: 0.1 });

    await worker.start();
    queues.set(QUEUE, [JSON.stringify(job('slow'))]);
    await waitFor(() => worker.getActiveJobCount() === 1);

    await worker.stop();
    expect(published).toHaveLength(1);
  });

  it('skips a turn the coordinator already cancelled', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const onJobCancelled = vi.fn();
    const worker = spawn({ pollTimeout: 0.1 }, { onJobCancelled });

    sets.set('swarm:s1:cancelled', new Set(['gone']));
    await worker.start();
    queues.set(QUEUE, [JSON.stringify(job('gone'))]);

    await waitFor(() => onJobCancelled.mock.calls.length === 1);
    expect(executeSwarmAgentJob).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
    await worker.stop();
  });

  it('aborts a running turn once the coordinator cancels it', async () => {
    let seen: AbortSignal | undefined;
    executeSwarmAgentJob.mockImplementation(
      (payload: SwarmAgentJobPayload, _runtime: unknown, execution: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          seen = execution.signal;
          execution.signal?.addEventListener('abort', () => resolve(result(payload, 'aborted')));
        })
    );
    const onJobCancelled = vi.fn();
    const worker = spawn({ pollTimeout: 0.1, cancelCheckInterval: 10 }, { onJobCancelled });

    await worker.start();
    queues.set(QUEUE, [JSON.stringify(job('late'))]);
    await waitFor(() => seen !== undefined);
    sets.set('swarm:s1:cancelled', new Set(['late']));

    await waitFor(() => onJobCancelled.mock.calls.length === 1);
    expect(seen?.aborted).toBe(true);
    expect(published).toHaveLength(0);
    await worker.stop();
  });

  it('keeps the result under its key for the job ttl before it publishes it', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const worker = spawn({ pollTimeout: 0.1 });
    const payload = {
      ...job('kept'),
      stateKeys: { ...job('kept').stateKeys, result: 'swarm:s1:result:kept' },
      resultTtl: 60_000,
    };

    await worker.start();
    queues.set(QUEUE, [JSON.stringify(payload)]);

    await waitFor(() => published.length === 1);
    expect(strings.get('swarm:s1:result:kept')).toEqual({
      value: published[0].message,
      px: 60_000,
    });
    await worker.stop();
  });

  it('skips a turn whose result a worker already kept', async () => {
    const onJobCancelled = vi.fn();
    const worker = spawn({ pollTimeout: 0.1 }, { onJobCancelled });
    const payload = {
      ...job('answered'),
      stateKeys: { ...job('answered').stateKeys, result: 'swarm:s1:result:answered' },
    };
    strings.set('swarm:s1:result:answered', { value: '{}' });

    await worker.start();
    queues.set(QUEUE, [JSON.stringify(payload)]);

    await waitFor(() => onJobCancelled.mock.calls.length === 1);
    expect(executeSwarmAgentJob).not.toHaveBeenCalled();
    await worker.stop();
  });

  it('moves a turn onto its own list while it runs and off it once done', async () => {
    let release: () => void = () => {};
    executeSwarmAgentJob.mockImplementation(
      (payload: SwarmAgentJobPayload) =>
        new Promise((resolve) => {
          release = () => resolve(result(payload));
        })
    );
    const worker = spawn({ pollTimeout: 0.1 });

    await worker.start();
    const raw = JSON.stringify(job('held'));
    queues.set(QUEUE, [raw]);
    const processing = `${QUEUE}:processing:${worker.getWorkerId()}`;
    await waitFor(() => worker.getActiveJobCount() === 1);

    expect(queues.get(QUEUE)).toEqual([]);
    expect(queues.get(processing)).toEqual([raw]);
    expect(sets.get(`${QUEUE}:workers`)?.has(worker.getWorkerId())).toBe(true);
    expect(strings.has(`${QUEUE}:heartbeat:${worker.getWorkerId()}`)).toBe(true);

    release();
    await waitFor(() => queues.get(processing)?.length === 0);
    await worker.stop();
    expect(sets.get(`${QUEUE}:workers`)?.has(worker.getWorkerId())).toBe(false);
    expect(strings.has(`${QUEUE}:heartbeat:${worker.getWorkerId()}`)).toBe(false);
  });

  it('runs the turns of a worker that stopped beating, and leaves a live one alone', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const onJobsRecovered = vi.fn();
    const worker = spawn({ pollTimeout: 0.1 }, { onJobsRecovered });
    sets.set(`${QUEUE}:workers`, new Set(['dead', 'alive']));
    queues.set(`${QUEUE}:processing:dead`, [JSON.stringify(job('orphan'))]);
    queues.set(`${QUEUE}:processing:alive`, [JSON.stringify(job('busy'))]);
    strings.set(`${QUEUE}:heartbeat:alive`, { value: '1' });

    await worker.start();

    await waitFor(() => published.length === 1);
    expect(JSON.parse(published[0].message)).toMatchObject({ jobId: 'orphan' });
    expect(onJobsRecovered).toHaveBeenCalledWith('dead', 1);
    expect(sets.get(`${QUEUE}:workers`)?.has('dead')).toBe(false);
    expect(queues.get(`${QUEUE}:processing:alive`)).toHaveLength(1);
    await worker.stop();
  });

  it('recovers the turns of a worker that died while it runs, on its next beat', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const worker = spawn({ pollTimeout: 0.1, heartbeatInterval: 100 });
    await worker.start();

    sets.get(`${QUEUE}:workers`)?.add('crashed');
    queues.set(`${QUEUE}:processing:crashed`, [JSON.stringify(job('late-orphan'))]);

    await waitFor(() => published.length === 1);
    expect(JSON.parse(published[0].message)).toMatchObject({ jobId: 'late-orphan' });
    await worker.stop();
  });

  it('hands back a turn on its own list it never got, after a second beat finds it', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const onJobsRecovered = vi.fn();
    const worker = spawn({ pollTimeout: 0.1, heartbeatInterval: 100 }, { onJobsRecovered });
    await worker.start();

    queues.set(`${QUEUE}:processing:${worker.getWorkerId()}`, [JSON.stringify(job('lost'))]);

    await waitFor(() => published.length === 1);
    expect(JSON.parse(published[0].message)).toMatchObject({ jobId: 'lost' });
    expect(onJobsRecovered).toHaveBeenCalledWith(worker.getWorkerId(), 1);
    await worker.stop();
  });

  it('never hands back a turn it runs, however many beats it takes', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) => {
      await new Promise((r) => setTimeout(r, 600));
      return result(payload);
    });
    const onJobsRecovered = vi.fn();
    const worker = spawn({ pollTimeout: 0.1, heartbeatInterval: 100 }, { onJobsRecovered });
    await worker.start();
    queues.set(QUEUE, [JSON.stringify(job('long'))]);

    await waitFor(() => published.length === 1);
    expect(executeSwarmAgentJob).toHaveBeenCalledTimes(1);
    expect(onJobsRecovered).not.toHaveBeenCalled();
    expect(queues.get(QUEUE)).toEqual([]);
    await worker.stop();
  });

  it('beats one at a time however slow Redis answers', async () => {
    redisTiming.lrangeDelay = 250;
    const worker = spawn({ pollTimeout: 0.1, heartbeatInterval: 100 });

    await worker.start();
    await waitFor(() => redisTiming.lranges >= 3, 3_000);
    await worker.stop();

    expect(redisTiming.maxInLrange).toBe(1);
  });

  it('keeps beating while stop() waits for a long turn', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) => {
      await new Promise((r) => setTimeout(r, 500));
      return result(payload);
    });
    const worker = spawn({ pollTimeout: 0.1, heartbeatInterval: 100 });
    await worker.start();
    queues.set(QUEUE, [JSON.stringify(job('long-stop'))]);
    await waitFor(() => worker.getActiveJobCount() === 1);

    const beatsBefore = redisTiming.lranges;
    await worker.stop();

    expect(redisTiming.lranges).toBeGreaterThan(beatsBefore + 2);
    expect(published).toHaveLength(1);
  });

  it('keeps a worker that beat again while its turns went back to the queue', async () => {
    executeSwarmAgentJob.mockImplementation(async (payload: SwarmAgentJobPayload) =>
      result(payload)
    );
    const worker = spawn({ pollTimeout: 0.1 });
    sets.set(`${QUEUE}:workers`, new Set(['revived']));
    queues.set(`${QUEUE}:processing:revived`, [JSON.stringify(job('stalled'))]);
    const lmove = MockRedis.prototype.lmove;
    const spy = vi.spyOn(MockRedis.prototype, 'lmove').mockImplementation(async function (
      this: MockRedis,
      ...args: Parameters<typeof lmove>
    ) {
      strings.set(`${QUEUE}:heartbeat:revived`, { value: 'back' });
      return lmove.apply(this, args);
    });

    await worker.start();
    await waitFor(() => published.length === 1);
    spy.mockRestore();

    expect(sets.get(`${QUEUE}:workers`)?.has('revived')).toBe(true);
    await worker.stop();
  });
});
