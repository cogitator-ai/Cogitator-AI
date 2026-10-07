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
  /**
   * How often, in ms, a running turn checks whether the coordinator cancelled it (its run
   * aborted or timed out, the swarm closed, or another attempt answered), default 1000. A
   * cancelled turn is aborted and its result is not published
   */
  cancelCheckInterval?: number;
}

export interface DistributedSwarmWorkerEvents {
  onJobStarted?: (job: SwarmAgentJobPayload) => void;
  onJobCompleted?: (job: SwarmAgentJobPayload, result: SwarmAgentJobResult) => void;
  onJobFailed?: (job: SwarmAgentJobPayload, error: Error) => void;
  /** The coordinator gave up on the turn: it was skipped, or aborted while it ran */
  onJobCancelled?: (job: SwarmAgentJobPayload) => void;
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
    if (await this.isCancelled(job)) {
      this.events.onJobCancelled?.(job);
      return;
    }
    this.events.onJobStarted?.(job);

    const controller = new AbortController();
    const watch = this.watchCancellation(job, controller);
    let result: SwarmAgentJobResult;
    try {
      result = await executeSwarmAgentJob(job, this.runtime, { signal: controller.signal });
    } finally {
      clearInterval(watch);
    }

    if (controller.signal.aborted) {
      this.events.onJobCancelled?.(job);
      return;
    }

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

  /** Whether the coordinator gave up on the job (only coordinators that name a cancel set). */
  private async isCancelled(job: SwarmAgentJobPayload): Promise<boolean> {
    const key = job.stateKeys.cancelled;
    if (!key || !this.publisher) return false;
    try {
      return (await this.publisher.sismember(key, job.jobId)) === 1;
    } catch (error) {
      this.events.onError?.(error instanceof Error ? error : new Error(toErrorMessage(error)));
      return false;
    }
  }

  /** Abort `controller` once the coordinator cancels the job while it runs. */
  private watchCancellation(
    job: SwarmAgentJobPayload,
    controller: AbortController
  ): ReturnType<typeof setInterval> | undefined {
    if (!job.stateKeys.cancelled) return undefined;
    const interval = Math.max(10, this.config.cancelCheckInterval ?? 1000);
    let checking = false;
    return setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void this.isCancelled(job)
        .then((cancelled) => {
          if (cancelled) {
            controller.abort(new Error(`Swarm turn ${job.jobId} was cancelled by its coordinator`));
          }
        })
        .finally(() => {
          checking = false;
        });
    }, interval);
  }
}
