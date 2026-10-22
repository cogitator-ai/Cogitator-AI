/**
 * Worker node for distributed swarms.
 *
 * Consumes agent turns dispatched by `DistributedSwarmCoordinator` (from
 * `@cogitator-ai/swarms`), runs them with the worker's Cogitator and tools, and hands each
 * result back to the coordinator. A turn moves from the queue to this worker's own list while
 * it runs, so a turn of a worker that died goes back to the queue for another one.
 */

import { nanoid } from 'nanoid';
import {
  closeSwarmRedis,
  createSwarmRedis,
  deliverSwarmJobResult,
  swarmQueueKeys,
  type SwarmQueueKeys,
  type SwarmRedis,
} from '@cogitator-ai/swarms';
import type { RedisConnectionConfig } from '@cogitator-ai/types';
import type { SwarmAgentJobPayload, SwarmAgentJobResult, WorkerRuntime } from './types';
import { executeSwarmAgentJob } from './processors/swarm-agent.js';
import { toErrorMessage } from './processors/shared.js';
import { Cogitator } from '@cogitator-ai/core';

export interface DistributedSwarmWorkerConfig extends WorkerRuntime {
  /**
   * Redis holding the swarm job queue (must match the swarm's `distributed.redis`): a url, host
   * and port, TLS, or a cluster. Default: localhost:6379
   */
  redis?: RedisConnectionConfig;
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
  /**
   * How often, in ms, the worker tells the queue it is alive and returns the turns of workers
   * that stopped doing so to the queue (default: 5000). A worker silent for three intervals
   * counts as gone, so a turn that runs past that on a stalled worker can run twice
   */
  heartbeatInterval?: number;
}

export interface DistributedSwarmWorkerEvents {
  onJobStarted?: (job: SwarmAgentJobPayload) => void;
  onJobCompleted?: (job: SwarmAgentJobPayload, result: SwarmAgentJobResult) => void;
  onJobFailed?: (job: SwarmAgentJobPayload, error: Error) => void;
  /**
   * The coordinator gave up on the turn or already has its result: it was skipped, or aborted
   * while it ran
   */
  onJobCancelled?: (job: SwarmAgentJobPayload) => void;
  /**
   * Turns went back to the queue: those of a worker that stopped beating, or ones on this
   * worker's own list it never got (`workerId` is then its own)
   */
  onJobsRecovered?: (workerId: string, count: number) => void;
  onError?: (error: Error) => void;
}

/** Take one copy of a turn off a worker's list and put it at the head of the queue, at once */
const HAND_BACK = `if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  redis.call('LPUSH', KEYS[2], ARGV[1])
  return 1
end
return 0`;

/**
 * Drop a worker from the queue's workers only while its heartbeat is still gone, at once: a
 * worker that came back and beat meanwhile keeps its place, so its list stays found
 */
const FORGET_WORKER = `if redis.call('EXISTS', KEYS[1]) == 0 then
  return redis.call('SREM', KEYS[2], ARGV[1])
end
return 0`;

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
  private readonly runtime: WorkerRuntime & Required<Pick<WorkerRuntime, 'cogitator' | 'tools'>>;
  private readonly keys: SwarmQueueKeys;
  /** This worker's id in the queue's worker set, new for every start */
  private workerId = '';
  private consumer?: SwarmRedis;
  private publisher?: SwarmRedis;
  private loop?: Promise<void>;
  /** The next beat, scheduled once the one before it finished */
  private beat?: ReturnType<typeof setTimeout>;
  /** The beat running now, which `stop()` waits for */
  private beating?: Promise<void>;
  /** Whether the worker beats: from `start()` until `stop()` saw its last turn finish */
  private alive = false;
  private running = false;
  private readonly active = new Set<Promise<void>>();
  /** The turns this worker took and runs, as moved: one entry per copy */
  private readonly holding: string[] = [];
  /** Turns on this worker's list it did not run at the last beat, with how many copies */
  private strays = new Map<string, number>();

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
    this.keys = swarmQueueKeys(config.keyPrefix, config.queue);
  }

  /**
   * Start consuming jobs. Resolves once the worker is connected, has joined the queue's workers
   * and has returned the turns of workers that are gone to the queue.
   */
  async start(): Promise<void> {
    if (this.running) return;

    const consumer = createSwarmRedis(this.config.redis, { blocking: true });
    const publisher = createSwarmRedis(this.config.redis);

    try {
      await Promise.all([consumer.connect(), publisher.connect()]);
      this.workerId = `worker_${nanoid(12)}`;
      this.publisher = publisher;
      await this.heartbeat();
      await this.recover();
    } catch (error) {
      this.publisher = undefined;
      consumer.disconnect();
      publisher.disconnect();
      throw error;
    }

    this.consumer = consumer;
    this.running = true;
    this.alive = true;
    this.scheduleBeat();
    this.loop = this.consume();
  }

  /**
   * Stop taking new jobs, wait for in-flight jobs to finish, hand back to the queue whatever is
   * still on this worker's list, leave the queue's workers and close connections.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.consumer?.disconnect();
    await this.loop;
    await Promise.allSettled([...this.active]);
    this.alive = false;
    clearTimeout(this.beat);
    await this.beating;

    if (this.publisher) {
      try {
        await this.requeue(this.workerId);
        await this.publisher.del(this.keys.heartbeat(this.workerId));
        await this.publisher.srem(this.keys.workers, this.workerId);
      } catch (error) {
        this.reportError(error);
      }
      await closeSwarmRedis(this.publisher);
    }
    this.consumer = undefined;
    this.publisher = undefined;
    this.loop = undefined;
    this.beat = undefined;
  }

  /** This worker's id in the queue's worker set while it runs */
  getWorkerId(): string {
    return this.workerId;
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

      let raw: string | null;
      try {
        raw = await this.consumer!.blmove(
          this.keys.queue,
          this.keys.processing(this.workerId),
          'LEFT',
          'RIGHT',
          pollTimeout
        );
      } catch (error) {
        if (!this.running) return;
        this.reportError(error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (raw === null) continue;

      const taken = raw;
      this.holding.push(taken);
      const task = this.handle(taken)
        .catch((error: unknown) => this.reportError(error))
        .finally(() => {
          this.active.delete(task);
          this.holding.splice(this.holding.indexOf(taken), 1);
          void this.publisher
            ?.lrem(this.keys.processing(this.workerId), 1, taken)
            .catch((error: unknown) => this.reportError(error));
        });
      this.active.add(task);
    }
  }

  /**
   * Beat once `heartbeatInterval` ms from now, and again that long after it finished: one beat at
   * a time, so a slow Redis never runs two `reclaim()` at once or shortens the grace between two
   */
  private scheduleBeat(): void {
    this.beat = setTimeout(() => {
      this.beating = this.heartbeat()
        .then(() => this.reclaim())
        .then(() => this.recover())
        .catch((error: unknown) => this.reportError(error))
        .finally(() => {
          this.beating = undefined;
          if (this.alive) this.scheduleBeat();
        });
    }, this.heartbeatInterval());
  }

  private heartbeatInterval(): number {
    return Math.max(100, this.config.heartbeatInterval ?? 5000);
  }

  /** Tell the queue this worker is alive: its heartbeat first, so no one takes it for gone */
  private async heartbeat(): Promise<void> {
    const publisher = this.publisher!;
    await publisher.set(
      this.keys.heartbeat(this.workerId),
      String(Date.now()),
      'PX',
      this.heartbeatInterval() * 3
    );
    await publisher.sadd(this.keys.workers, this.workerId);
  }

  /**
   * Hand back to the queue the turns on this worker's own list it does not run, at the second
   * beat in a row that finds them there: a BLMOVE whose reply a dropped connection lost (and
   * ioredis sent again) moved a turn this worker never got. One beat of grace lets a reply that
   * is still on its way arrive first
   */
  private async reclaim(): Promise<void> {
    const publisher = this.publisher!;
    const listed = await publisher.lrange(this.keys.processing(this.workerId), 0, -1);
    const strays = new Map<string, number>();
    for (const raw of listed) strays.set(raw, (strays.get(raw) ?? 0) + 1);
    for (const raw of this.holding) {
      const left = (strays.get(raw) ?? 0) - 1;
      if (left > 0) strays.set(raw, left);
      else strays.delete(raw);
    }

    let count = 0;
    for (const [raw, copies] of strays) {
      const confirmed = Math.min(copies, this.strays.get(raw) ?? 0);
      for (let at = 0; at < confirmed; at++) {
        const moved = await publisher.eval(
          HAND_BACK,
          2,
          this.keys.processing(this.workerId),
          this.keys.queue,
          raw
        );
        if (moved === 1) count++;
      }
    }
    this.strays = strays;
    if (count > 0) this.events.onJobsRecovered?.(this.workerId, count);
  }

  /** Return the turns of every worker whose heartbeat is gone to the queue */
  private async recover(): Promise<void> {
    const publisher = this.publisher!;
    for (const workerId of await publisher.smembers(this.keys.workers)) {
      if (workerId === this.workerId) continue;
      if ((await publisher.exists(this.keys.heartbeat(workerId))) === 1) continue;
      const count = await this.requeue(workerId);
      await publisher.eval(
        FORGET_WORKER,
        2,
        this.keys.heartbeat(workerId),
        this.keys.workers,
        workerId
      );
      if (count > 0) this.events.onJobsRecovered?.(workerId, count);
    }
  }

  /**
   * Move the turns on a worker's list back to the head of the queue, one at a time so two
   * workers recovering it at once never move a turn twice
   *
   * @returns how many turns this call moved
   */
  private async requeue(workerId: string): Promise<number> {
    const publisher = this.publisher!;
    let count = 0;
    while (
      (await publisher.lmove(this.keys.processing(workerId), this.keys.queue, 'RIGHT', 'LEFT')) !==
      null
    ) {
      count++;
    }
    return count;
  }

  private reportError(error: unknown): void {
    this.events.onError?.(error instanceof Error ? error : new Error(toErrorMessage(error)));
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
      await deliverSwarmJobResult(this.publisher!, job, result, (error) => this.reportError(error));
    } catch (error) {
      this.reportError(error);
      return;
    }

    if (result.error !== undefined) {
      this.events.onJobFailed?.(job, new Error(result.error));
    } else {
      this.events.onJobCompleted?.(job, result);
    }
  }

  /**
   * Whether the coordinator gave up on the job (only coordinators that name a cancel set), or a
   * worker answered it already, such as one that died after answering and before taking the job
   * off its list
   */
  private async isCancelled(job: SwarmAgentJobPayload): Promise<boolean> {
    const { cancelled, result } = job.stateKeys;
    if (!this.publisher) return false;
    try {
      if (cancelled && (await this.publisher.sismember(cancelled, job.jobId)) === 1) return true;
      return result !== undefined && (await this.publisher.exists(result)) === 1;
    } catch (error) {
      this.reportError(error);
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
