/**
 * Types for durable agent runs: a run that keeps a checkpoint after every step, so a process that
 * crashed or was stopped leaves it for another to recover and continue (`cogitator.recoverRuns()`)
 */

import type { Message } from './message';
import type { ToolResult } from './message';
import type { QueuedRunMessage, RunHandle, StartOptions } from './run-control';
import type { RunCheckpoint } from './runtime';

/** A message queued on a durable run's handle, with the id the queue gave it */
export type DurableQueuedMessage = QueuedRunMessage & { id?: string };

/** Where a durable run is kept: its id and the thread it runs in */
export interface DurableRunRef {
  readonly runId: string;
  readonly threadId: string;
}

/**
 * Who takes a durable run: the runtime's `durable.owner` and the instance of the runtime, new for
 * every `Cogitator`, so another live runtime with the same owner never takes a run this one holds
 */
export interface DurableRunHolder {
  owner: string;
  instance: string;
}

/** Who holds a durable run: the process that runs it, until `expiresAt` unless it renews */
export interface DurableRunLease extends DurableRunHolder {
  /** Epoch milliseconds the lease ends at, when the store knows it */
  expiresAt?: number;
}

/**
 * What happened in a durable run since its last checkpoint, in order: a tool call that started,
 * one that returned, the messages queued on its handle that it has not delivered yet, and one it
 * delivered
 */
export type DurableRunMark = (
  | { kind: 'started'; toolCallId: string }
  | {
      kind: 'finished';
      toolCallId: string;
      /** What the call returned, as JSON: `details` and `presentation` kept, values JSON cannot hold dropped */
      result: ToolResult;
    }
  | { kind: 'queue'; pending: DurableQueuedMessage[] }
  | {
      kind: 'delivered';
      /** The queued message the run took */
      queued: DurableQueuedMessage;
      /** What it added to the conversation: the message, and the context the input checks added */
      messages: Message[];
      /** The iteration the run now stops at, when the message woke it at its stop */
      iterationLimit?: number;
    }
) & {
  /**
   * Names the mark, so a mark a store kept twice (a write retried after its reply was lost) is
   * read once
   */
  id?: string;
};

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
   * The messages the run's conversation starts with (system prompt, history, input, and without
   * a memory log every message the run added), kept once. `save()` without it keeps the base the
   * store holds
   */
  base?: Message[];
  /**
   * When set, `save()` gets in `base` only the messages from this index on: the store keeps its
   * first `baseFrom` messages and adds these after them, so a step writes what is new
   */
  baseFrom?: number;
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
   * Takes the run for `holder`, or renews the lease its instance holds, for `ttlMs`. False while
   * another instance holds a lease that has not run out, unless `replacing` names that instance:
   * the runtime passes it to take back a run of its own `owner` whose instance is gone (a process
   * that restarted)
   */
  acquire(
    ref: DurableRunRef,
    holder: DurableRunHolder,
    ttlMs: number,
    options?: { replacing?: string }
  ): Promise<boolean>;
  /**
   * Extends the lease `holder` holds by `ttlMs`. False when it holds none: it ran out, another
   * instance took it, or the run was deleted. A run that loses its lease stops, so it never goes
   * on past a process that recovered it
   */
  renew(ref: DurableRunRef, holder: DurableRunHolder, ttlMs: number): Promise<boolean>;
  /** Lets the run go, when `holder` holds it, so another process may take it at once */
  release(ref: DurableRunRef, holder: DurableRunHolder): Promise<void>;
  /**
   * Keeps the run's checkpoint, its journal (`record.journal`, usually empty) and `base` when
   * given, all at once, and only while `holder` holds the lease: false when it does not, so a
   * process that lost a run never overwrites the checkpoint of the one that took it over
   */
  save(record: DurableRunRecord, holder: DurableRunHolder): Promise<boolean>;
  /** Adds marks to the run's journal while `holder` holds the lease, false when it does not */
  append(
    ref: DurableRunRef,
    marks: readonly DurableRunMark[],
    holder: DurableRunHolder
  ): Promise<boolean>;
  /** The run with its base and journal, null when the store has none */
  load(ref: DurableRunRef): Promise<DurableRunRecord | null>;
  list(filter?: DurableRunFilter): Promise<DurableRunSummary[]>;
  /**
   * Forgets the run and its lease. With `holder`, only while it holds the lease: false when it
   * does not
   */
  delete(ref: DurableRunRef, holder?: DurableRunHolder): Promise<boolean>;
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
   * Who this runtime's runs are held by, in leases and listings. Default: the host name, the
   * process id and a random part, new for every `Cogitator`. A run is only taken from another
   * holder once its lease ran out, whatever the owner, unless `takeoverOnRestart` is set
   */
  owner?: string;
  /**
   * Take back at once, without waiting for its lease, a run whose lease names this `owner` and an
   * instance no runtime of this process has: a process that restarted. Only safe when `owner` is
   * unique to one live process at a time, such as a pod name, never a host name several processes
   * share: two live processes with one owner would then take each other's runs. Default: false
   */
  takeoverOnRestart?: boolean;
  /**
   * What a run does when its store keeps failing (after `storeRetries`): `suspend` (default)
   * stops it with `RUN_SUSPENDED`, its last checkpoint kept for a recovery, `continue` lets it
   * go on without checkpoints (a recovery may then repeat what it did since the last one)
   */
  onStoreError?: 'suspend' | 'continue';
  /** How often a failed write to the store is tried again, with a growing pause. Default: 3 */
  storeRetries?: number;
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
