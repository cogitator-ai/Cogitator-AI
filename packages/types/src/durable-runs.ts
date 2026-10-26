/**
 * Types for durable agent runs: a run that keeps a checkpoint after every step, so a process that
 * crashed or was stopped leaves it for another to recover and continue (`cogitator.recoverRuns()`)
 */

import type { Message } from './message';
import type { ToolResult } from './message';
import type { QueuedRunMessage, RunHandle, StartOptions } from './run-control';
import type { RunCheckpoint } from './runtime';

/** Where a durable run is kept: its id and the thread it runs in */
export interface DurableRunRef {
  readonly runId: string;
  readonly threadId: string;
}

/** Who holds a durable run: the process that runs it, until `expiresAt` unless it renews */
export interface DurableRunLease {
  /** The `durable.owner` of the runtime that holds it */
  owner: string;
  /** Epoch milliseconds the lease ends at, when the store knows it */
  expiresAt?: number;
}

/**
 * What happened in a durable run since its last checkpoint, in order: a tool call that started,
 * one that returned, and the messages queued on its handle that it has not delivered yet
 */
export type DurableRunMark =
  | { kind: 'started'; toolCallId: string }
  | {
      kind: 'finished';
      toolCallId: string;
      /** What the call returned, as JSON: `details` and `presentation` kept, values JSON cannot hold dropped */
      result: ToolResult;
    }
  | { kind: 'queue'; pending: QueuedRunMessage[] };

/**
 * A durable run as its store keeps it. `checkpoint` is the run after its last step, with
 * `status: 'running'`: its messages hold only what neither `base` nor the thread's log holds
 * (`checkpoint.compact`), so a step writes what is new rather than the whole conversation.
 */
export interface DurableRunRecord extends DurableRunRef {
  /** The id of the agent the run was started with: recovery needs this agent to go on */
  agentId: string;
  /** The name of that agent */
  agentName: string;
  userId?: string;
  checkpoint: RunCheckpoint;
  /**
   * The messages the run's conversation starts with (system prompt, history, input), kept once.
   * `save()` without it keeps the base the store holds
   */
  base?: Message[];
  /** What happened since `checkpoint`, see {@link DurableRunMark}. `save()` replaces it */
  journal: DurableRunMark[];
  /** Epoch milliseconds of the last `save()` */
  savedAt: number;
  /** Who holds the run, as `load()` and `list()` report it */
  lease?: DurableRunLease;
}

/** A durable run as `list()` reports it, without its conversation */
export interface DurableRunSummary extends DurableRunRef {
  agentId: string;
  agentName: string;
  userId?: string;
  /** Model turns the run made so far */
  iterations: number;
  /** Epoch milliseconds the run started at */
  startedAt: number;
  /** Epoch milliseconds of its last checkpoint */
  savedAt: number;
  /** Who holds it, absent when nobody does (its process stopped and the lease ran out) */
  lease?: DurableRunLease;
}

/** Which durable runs `list()` returns */
export interface DurableRunFilter {
  runId?: string;
  threadId?: string;
  agentId?: string;
  userId?: string;
}

/**
 * Where durable runs keep their checkpoints, and who holds each. `acquire` must be atomic for
 * several processes to share a store safely (the Redis store is): a store that cannot lock,
 * such as one on a memory adapter's threads, is safe for one process at a time.
 */
export interface DurableRunStore {
  /**
   * Takes the run for `owner`, or renews the lease `owner` holds, for `ttlMs`. False while
   * another owner holds a lease that has not run out
   */
  acquire(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean>;
  /**
   * Extends the lease `owner` holds by `ttlMs`. False when it holds none: it ran out, another
   * owner took it, or the run was deleted. A run that loses its lease stops, so it never goes on
   * past a process that recovered it
   */
  renew(ref: DurableRunRef, owner: string, ttlMs: number): Promise<boolean>;
  /** Lets the run go, when `owner` holds it, so another process may take it at once */
  release(ref: DurableRunRef, owner: string): Promise<void>;
  /** Keeps the run's checkpoint, its journal emptied (or `record.journal`), and `base` when given */
  save(record: DurableRunRecord): Promise<void>;
  /** Adds marks to the run's journal */
  append(ref: DurableRunRef, marks: readonly DurableRunMark[]): Promise<void>;
  /** The run with its base and journal, null when the store has none */
  load(ref: DurableRunRef): Promise<DurableRunRecord | null>;
  list(filter?: DurableRunFilter): Promise<DurableRunSummary[]>;
  /** Forgets the run and its lease */
  delete(ref: DurableRunRef): Promise<void>;
}

/** `CogitatorConfig.durable`: how durable runs are kept */
export interface DurableRunsConfig {
  /**
   * Whether runs are durable unless their agent or their options say otherwise. Default: true
   * once `durable` is set
   */
  enabled?: boolean;
  /**
   * Where the checkpoints go. Default: the memory adapter's threads (one process at a time), else
   * process memory (lost with the process, for tests and for several runtimes in one process)
   */
  store?: DurableRunStore;
  /**
   * How long a run stays held after its process last renewed its lease, in milliseconds. A run
   * renews it at every step and a third of the way through it. Default: 60 000
   */
  leaseMs?: number;
  /**
   * Who this runtime's runs are held by. Default: an id new for every `Cogitator`. Give a process
   * a stable one (its host name, a pod name) to recover its own runs at once after a restart,
   * without waiting for their leases to run out
   */
  owner?: string;
}

/** Options of a recovered run: those of `cogitator.start()` the checkpoint does not fix */
export type RecoverRunOptions<TDeps = unknown> = Omit<
  StartOptions<TDeps>,
  'input' | 'images' | 'audio' | 'context' | 'threadId' | 'history' | 'runId' | 'durable'
>;

/** A durable run left running that `recoverRuns()` found */
export interface DurableRunInfo extends DurableRunSummary {
  /** Whether a live process holds it: true for runs going on elsewhere, which are left alone */
  held: boolean;
}

/** Options of `cogitator.recoverRuns()` */
export interface RecoverRunsOptions<TAgent = unknown, TDeps = unknown> {
  /**
   * The agents the runs were started with, matched by id, then by name, or a function that gives
   * the agent of a run. A run whose agent is missing is skipped
   */
  agents: readonly TAgent[] | ((run: DurableRunInfo) => TAgent | undefined);
  /**
   * Whether to continue the runs (default), or only report them in `found` for the host to
   * decide: `recoverRun()` one, `discardRun()` another
   */
  resume?: boolean;
  /** Which runs to look at, all left running by default */
  filter?: (run: DurableRunInfo) => boolean;
  /** Options for each continued run: its deps, callbacks, signal */
  options?: (run: DurableRunInfo) => RecoverRunOptions<TDeps>;
}

/** What `cogitator.recoverRuns()` did */
export interface RecoveredAgentRuns {
  /** The runs it continued, with their handles */
  resumed: { run: DurableRunInfo; handle: RunHandle }[];
  /** Runs left running by a stopped process it did not continue, with why */
  skipped: { run: DurableRunInfo; reason: string }[];
  /** With `resume: false`, the runs left running by a stopped process, for the host to decide */
  found: DurableRunInfo[];
}
