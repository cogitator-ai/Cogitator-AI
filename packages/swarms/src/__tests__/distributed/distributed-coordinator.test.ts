import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { Agent } from '@cogitator-ai/core';
import type { DistributedSwarmConfig } from '@cogitator-ai/types';
import { DistributedSwarmCoordinator } from '../../distributed/distributed-coordinator';
import type { SwarmAgentJobPayload } from '../../distributed/distributed-coordinator';
import { createMockAgent } from '../strategies/__mocks__/mock-helpers';

type JobHandler = (job: SwarmAgentJobPayload, attempt: number) => { error?: string };

const redisState = vi.hoisted(() => ({
  keys: new Set<string>(),
  expirations: new Map<string, number>(),
  jobs: [] as unknown[],
  channels: new Map<string, Set<(channel: string, message: string) => void>>(),
  handler: undefined as ((job: unknown) => void) | undefined,
}));

vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeRedis extends EventEmitter {
    status = 'wait';

    private ready(): void {
      this.status = 'ready';
    }

    duplicate(): FakeRedis {
      return new FakeRedis();
    }

    async subscribe(channel: string): Promise<void> {
      this.ready();
      let listeners = redisState.channels.get(channel);
      if (!listeners) {
        listeners = new Set();
        redisState.channels.set(channel, listeners);
      }
      listeners.add((ch, message) => this.emit('message', ch, message));
    }

    async psubscribe(): Promise<void> {
      this.ready();
    }

    async unsubscribe(): Promise<void> {}

    async punsubscribe(): Promise<void> {}

    async publish(channel: string, message: string): Promise<number> {
      this.ready();
      const listeners = redisState.channels.get(channel) ?? new Set();
      for (const listener of listeners) listener(channel, message);
      return listeners.size;
    }

    async eval(_script: string, numKeys: number, ...args: string[]): Promise<number> {
      this.ready();
      for (const key of args.slice(0, numKeys)) redisState.keys.add(key);
      return 1;
    }

    async rpush(key: string, value: string): Promise<number> {
      this.ready();
      redisState.keys.add(key);
      if (key.includes(':jobs:')) {
        redisState.jobs.push(JSON.parse(value));
        setTimeout(() => redisState.handler?.(JSON.parse(value)), 0);
      }
      return 1;
    }

    async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
      this.ready();
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...redisState.keys].filter((key) => key.startsWith(prefix))];
    }

    pipeline() {
      const commands: [string, number][] = [];
      const pipeline = {
        pexpire: (key: string, ms: number) => {
          commands.push([key, ms]);
          return pipeline;
        },
        exec: async () => {
          for (const [key, ms] of commands) redisState.expirations.set(key, ms);
          return [];
        },
      };
      return pipeline;
    }

    async quit(): Promise<string> {
      this.status = 'end';
      return 'OK';
    }

    disconnect(): void {
      this.status = 'end';
    }
  }

  return { default: FakeRedis, Redis: FakeRedis };
});

function onJobs(handler: JobHandler): void {
  const attempts = new Map<string, number>();
  redisState.handler = (raw) => {
    const job = raw as SwarmAgentJobPayload;
    const attempt = (attempts.get(job.agentName) ?? 0) + 1;
    attempts.set(job.agentName, attempt);
    const { error } = handler(job, attempt);
    const result = {
      jobId: job.jobId,
      swarmId: job.swarmId,
      agentName: job.agentName,
      output: error ? '' : `${job.agentName} done`,
      toolCalls: [],
      tokenUsage: { prompt: 1, completion: 1, total: 2 },
      ...(error !== undefined && { error }),
    };
    for (const listener of redisState.channels.get(job.stateKeys.results) ?? []) {
      listener(job.stateKeys.results, JSON.stringify(result));
    }
  };
}

function coordinator(distributed: Partial<DistributedSwarmConfig> = {}) {
  return new DistributedSwarmCoordinator({
    config: { name: 'remote', strategy: 'round-robin', agents: [createMockAgent('worker')] },
    distributed: { enabled: true, ...distributed },
  });
}

describe('DistributedSwarmCoordinator jobs', () => {
  beforeEach(() => {
    redisState.keys.clear();
    redisState.expirations.clear();
    redisState.jobs.length = 0;
    redisState.channels.clear();
    redisState.handler = undefined;
  });

  it('re-dispatches a failed job per distributed.retry', async () => {
    onJobs((_job, attempt) => (attempt < 3 ? { error: 'worker crashed' } : {}));
    const coord = coordinator({ retry: { maxRetries: 2, backoff: 'constant', initialDelay: 1 } });

    const result = await coord.runAgent('worker', 'go');

    expect(result.output).toBe('worker done');
    expect(redisState.jobs).toHaveLength(3);
    await coord.close();
  });

  it('gives up after maxRetries re-dispatches', async () => {
    onJobs(() => ({ error: 'worker crashed' }));
    const coord = coordinator({ retry: { maxRetries: 1, initialDelay: 1 } });

    await expect(coord.runAgent('worker', 'go')).rejects.toThrow('worker crashed');
    expect(redisState.jobs).toHaveLength(2);
    await coord.close();
  });

  it('does not retry failed jobs without distributed.retry', async () => {
    onJobs(() => ({ error: 'worker crashed' }));
    const coord = coordinator();

    await expect(coord.runAgent('worker', 'go')).rejects.toThrow('worker crashed');
    expect(redisState.jobs).toHaveLength(1);
    await coord.close();
  });

  it('expires the swarm state in Redis cleanupAfter ms after close', async () => {
    onJobs(() => ({}));
    const coord = coordinator({ cleanupAfter: 60000 });

    await coord.runAgent('worker', 'go');
    await coord.close();

    const swarmKeys = [...redisState.keys].filter((key) =>
      key.startsWith(`swarm:${coord.getSwarmId()}:`)
    );
    expect(swarmKeys.length).toBeGreaterThan(0);
    for (const key of swarmKeys) {
      expect(redisState.expirations.get(key)).toBe(60000);
    }
  });

  it('sends each agent model so the worker routes it like the agent in-process', async () => {
    onJobs(() => ({}));
    const custom = createMockAgent('custom', { model: 'openrouter/deepseek/deepseek-v4-pro' });
    const proxied = createMockAgent('proxied', { model: 'openai/gpt-4o' });
    proxied.config.provider = 'openrouter';
    const coord = new DistributedSwarmCoordinator({
      config: { name: 'remote', strategy: 'round-robin', agents: [custom, proxied] },
      distributed: { enabled: true },
    });

    await coord.runAgent('custom', 'go');
    await coord.runAgent('proxied', 'go');
    await coord.close();

    const configs = (redisState.jobs as SwarmAgentJobPayload[]).map((job) => job.agentConfig);
    expect(configs[0].model).toBe('openrouter/deepseek/deepseek-v4-pro');
    expect(configs[0]).not.toHaveProperty('provider');
    expect(configs[1]).toMatchObject({
      model: 'openrouter/openai/gpt-4o',
      provider: 'openrouter',
    });
  });

  it('keeps the swarm state for an hour by default', async () => {
    onJobs(() => ({}));
    const coord = coordinator();

    await coord.runAgent('worker', 'go');
    await coord.close();

    const eventsKey = `swarm:${coord.getSwarmId()}:events`;
    expect(redisState.expirations.get(eventsKey)).toBe(3600000);
  });
});

describe('DistributedSwarmCoordinator agent transport', () => {
  beforeEach(() => {
    redisState.keys.clear();
    redisState.expirations.clear();
    redisState.jobs.length = 0;
    redisState.channels.clear();
    redisState.handler = undefined;
  });

  it('sends the whole agent configuration to the worker', async () => {
    onJobs(() => ({}));
    const Verdict = z.object({ verdict: z.enum(['run', 'hold']) });
    const chief = new Agent({
      name: 'chief',
      model: 'openai/gpt-6.1-sol',
      instructions: 'Decide.',
      topP: 0.7,
      stopSequences: ['END'],
      reasoning: { effort: 'high' },
      responseFormat: { type: 'json_schema', schema: Verdict },
      onIterationLimit: 'stop',
      timeout: 600000,
    });
    const coord = new DistributedSwarmCoordinator({
      config: { name: 'remote', strategy: 'round-robin', agents: [chief] },
      distributed: { enabled: true },
    });

    await coord.runAgent('chief', 'go');
    await coord.close();

    const [job] = redisState.jobs as SwarmAgentJobPayload[];
    expect(job.agentConfig).toMatchObject({
      topP: 0.7,
      stopSequences: ['END'],
      reasoning: { effort: 'high' },
      responseFormat: { type: 'json_schema', schema: { type: 'object' } },
      onIterationLimit: 'stop',
      timeout: 600000,
    });
  });

  it('reports the cost, duration and flags the worker measured', async () => {
    redisState.handler = (raw) => {
      const job = raw as SwarmAgentJobPayload;
      const result = {
        jobId: job.jobId,
        swarmId: job.swarmId,
        agentName: job.agentName,
        output: 'cut',
        toolCalls: [],
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          cost: 0.25,
          duration: 900,
          reasoningTokens: 30,
        },
        truncated: true,
        tokenUsage: { prompt: 100, completion: 40, total: 140 },
      };
      for (const listener of redisState.channels.get(job.stateKeys.results) ?? []) {
        listener(job.stateKeys.results, JSON.stringify(result));
      }
    };
    const coord = coordinator();

    const result = await coord.runAgent('worker', 'go');

    expect(result.usage).toMatchObject({ cost: 0.25, duration: 900, reasoningTokens: 30 });
    expect(result.truncated).toBe(true);
    expect(coord.getResourceUsage().totalCost).toBeCloseTo(0.25);
    await coord.close();
  });
});
