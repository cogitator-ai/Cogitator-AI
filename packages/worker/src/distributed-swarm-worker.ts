/**
 * Worker node for distributed swarms.
 *
 * Consumes agent turns dispatched by `DistributedSwarmCoordinator` (from
 * `@cogitator-ai/swarms`), runs them with the worker's Cogitator and tools, and publishes
 * each result back to the coordinator's results channel.
 */

import { Redis } from 'ioredis';
import { swarmJobQueueKey } from '@cogitator-ai/swarms';
import type { SwarmAgentJobPayload, SwarmAgentJobResult, WorkerRuntime } from './types';
import { executeSwarmAgentJob } from './processors/swarm-agent.js';
import { toErrorMessage } from './processors/shared.js';
import { Cogitator } from '@cogitator-ai/core';

export interface DistributedSwarmWorkerConfig extends WorkerRuntime {
  /** Redis holding the swarm job queue (must match the swarm's `distributed.redis`) */
  redis?: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
  };
  /** Swarm key prefix (must match `distributed.redis.keyPrefix`, default: 'swarm') */
  keyPrefix?: string;
  /** Job queue name (must match `distributed.queue`, default: 'swarm-agent-jobs') */
  queue?: string;
  /** Agent turns processed concurrently by this worker (default: 4) */
  concurrency?: number;
  /** Seconds a blocking poll waits for new jobs before re-checking state (default: 1) */
  pollTimeout?: number;
}

export interface DistributedSwarmWorkerEvents {
  onJobStarted?: (job: SwarmAgentJobPayload) => void;
  onJobCompleted?: (job: SwarmAgentJobPayload, result: SwarmAgentJobResult) => void;
  onJobFailed?: (job: SwarmAgentJobPayload, error: Error) => void;
  onError?: (error: Error) => void;
}

function isSwarmAgentJob(value: unknown): value is SwarmAgentJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<SwarmAgentJobPayload>;
  return (
    job.type === 'swarm-agent' &&
    typeof job.jobId === 'string' &&
    typeof job.agentName === 'string' &&
    typeof job.input === 'string' &&
    typeof job.agentConfig === 'object' &&
    job.agentConfig !== null &&
    typeof job.stateKeys?.results === 'string'
  );
}

export class DistributedSwarmWorker {
  private readonly config: DistributedSwarmWorkerConfig;
  private readonly events: DistributedSwarmWorkerEvents;
  private readonly runtime: Required<WorkerRuntime>;
  private readonly queueKey: string;
  private consumer?: Redis;
  private publisher?: Redis;
  private loop?: Promise<void>;
  private running = false;
  private readonly active = new Set<Promise<void>>();

  constructor(
    config: DistributedSwarmWorkerConfig = {},
    events: DistributedSwarmWorkerEvents = {}
  ) {
    this.config = config;
    this.events = events;
    this.runtime = {
      cogitator: config.cogitator ?? new Cogitator(),
      tools: config.tools ?? [],
    };
    this.queueKey = swarmJobQueueKey(config.keyPrefix, config.queue);
  }

  /**
   * Start consuming jobs. Resolves once the worker is connected.
   */
  async start(): Promise<void> {
    if (this.running) return;

    const options = {
      host: this.config.redis?.host ?? 'localhost',
      port: this.config.redis?.port ?? 6379,
      password: this.config.redis?.password,
      db: this.config.redis?.db ?? 0,
      lazyConnect: true,
    };
    const consumer = new Redis({ ...options, maxRetriesPerRequest: null });
    const publisher = new Redis(options);

    try {
      await Promise.all([consumer.connect(), publisher.connect()]);
    } catch (error) {
      consumer.disconnect();
      publisher.disconnect();
      throw error;
    }

    this.consumer = consumer;
    this.publisher = publisher;
    this.running = true;
    this.loop = this.consume();
  }

  /**
   * Stop taking new jobs, wait for in-flight jobs to finish and close connections.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.consumer?.disconnect();
    await this.loop;
    await Promise.allSettled([...this.active]);

    await this.publisher?.quit();
    this.consumer = undefined;
    this.publisher = undefined;
    this.loop = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  getActiveJobCount(): number {
    return this.active.size;
  }

  private async consume(): Promise<void> {
    const concurrency = Math.max(1, this.config.concurrency ?? 4);
    const pollTimeout = Math.max(0.1, this.config.pollTimeout ?? 1);

    while (this.running) {
      if (this.active.size >= concurrency) {
        await Promise.race(this.active);
        continue;
      }

      let entry: [string, string] | null;
      try {
        entry = await this.consumer!.blpop(this.queueKey, pollTimeout);
      } catch (error) {
        if (!this.running) return;
        this.events.onError?.(error instanceof Error ? error : new Error(toErrorMessage(error)));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (!entry) continue;

      const task = this.handle(entry[1]).finally(() => {
        this.active.delete(task);
      });
      this.active.add(task);
    }
  }

  private async handle(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.events.onError?.(new Error('Discarded swarm job with invalid JSON'));
      return;
    }

    if (!isSwarmAgentJob(parsed)) {
      this.events.onError?.(new Error('Discarded malformed swarm job payload'));
      return;
    }

    const job = parsed;
    this.events.onJobStarted?.(job);

    const result = await executeSwarmAgentJob(job, this.runtime);

    try {
      await this.publisher!.publish(job.stateKeys.results, JSON.stringify(result));
    } catch (error) {
      this.events.onError?.(error instanceof Error ? error : new Error(toErrorMessage(error)));
      return;
    }

    if (result.error !== undefined) {
      this.events.onJobFailed?.(job, new Error(result.error));
    } else {
      this.events.onJobCompleted?.(job, result);
    }
  }
}
