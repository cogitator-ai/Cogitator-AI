/**
 * Types for steering a run while it goes on: queued messages, run handles, interrupts and what
 * happens to a new run on a thread that is busy
 */

import type { ZodType } from 'zod';
import type { MessageContent } from './message';
import type { RunOptions, RunResult } from './runtime';

/**
 * What a run does when its thread already has a run going on, the "double-texting" policy, named
 * as LangGraph's `multitask_strategy`:
 * - `enqueue`: waits until the runs before it on the thread are done, then runs
 * - `reject`: fails at once with `THREAD_BUSY`
 * - `interrupt`: stops the runs going on (they fail with `RUN_INTERRUPTED`), then runs after them
 * - `rollback`: as `interrupt`, and runs on a branch from where the interrupted run started, so
 *   the thread goes on as if that run never happened (its entries stay on a branch of their own)
 */
export type MultitaskStrategy = 'enqueue' | 'reject' | 'interrupt' | 'rollback';

/**
 * How a queued message reaches a run going on:
 * - `steer`: after the tool calls of the current step (they always finish), before the next
 *   model call, and it wakes an agent that was about to stop
 * - `followUp`: only once the agent would stop, it goes on with the message instead
 * - `inject`: context for the next model call that never wakes the agent: one left when the run
 *   ends is saved to the thread, so the next run there reads it
 */
export type RunQueueKind = 'steer' | 'followUp' | 'inject';

/** How many queued messages a run takes at once: every one waiting, or one per step */
export type QueueDrainMode = 'all' | 'one-at-a-time';

/** A message given to a run going on, see {@link RunHandle} */
export interface QueuedRunMessage {
  readonly kind: RunQueueKind;
  readonly content: MessageContent;
}

/** How a run started with `cogitator.start()` takes its queued messages */
export interface RunQueueOptions {
  /** Steering messages taken at a step boundary, `one-at-a-time` by default */
  steering?: QueueDrainMode;
  /** Follow-up messages taken when the agent would stop, `one-at-a-time` by default */
  followUp?: QueueDrainMode;
}

/** Options of `cogitator.start()`: a run's options and how it takes its queued messages */
export type StartOptions<TDeps = unknown> = RunOptions<TDeps> & { queue?: RunQueueOptions };

/**
 * A run going on, as `cogitator.start()` returns it. Each message it delivers becomes a user
 * message of the run, saved to the thread with `metadata.queued` set to its kind, so a later run
 * reads it in the history like any other.
 */
export interface RunHandle {
  /** The run's result, as `cogitator.run()` returns it. It rejects when the run is aborted */
  readonly result: Promise<RunResult>;
  /** Queues a steering message, false once the run no longer takes messages */
  steer(message: MessageContent): boolean;
  /** Queues a follow-up message, false once the run no longer takes messages */
  followUp(message: MessageContent): boolean;
  /** Queues context for the next model call, false once the run no longer takes messages */
  inject(message: MessageContent): boolean;
  /** The messages queued and not delivered yet, in the order they came */
  readonly queued: readonly QueuedRunMessage[];
  /**
   * Stops the run, as an abort of its `signal` does, and returns the messages it had not
   * delivered: they never reach the run or the thread
   */
  abort(reason?: unknown): readonly QueuedRunMessage[];
}

/**
 * What waits on a paused run before it goes on: a tool call to approve (`approval`), or an answer
 * a tool asked for with `context.interrupt()` (`input`)
 */
export type InterruptKind = 'approval' | 'input';

/**
 * A question a paused run waits on. It carries the fields AG-UI interrupts, ACP elicitation and
 * MCP input requests have, so a protocol adapter maps it as it is
 */
export interface RunInterrupt {
  /** Key of its answer in `ResumeOptions.responses`: the tool call id for an approval */
  id: string;
  kind: InterruptKind;
  /** Why the run asks, a short machine-readable reason (`tool_approval` for an approval) */
  reason: string;
  /** What to tell the person who answers */
  message: string;
  /** JSON Schema the answer must match */
  responseSchema?: Record<string, unknown>;
  /** ISO time after which an answer is refused with `INTERRUPT_EXPIRED` */
  expiresAt?: string;
  /** The tool call that asked, or that waits for approval */
  toolCallId?: string;
  toolName?: string;
  /** The answer, once given: a tool asking again in a resumed run gets it back */
  response?: unknown;
}

/** What a tool asks with `context.interrupt()` */
export interface InterruptRequest<T = unknown> {
  /** Why it asks, a short machine-readable reason such as `confirm_plan` */
  reason: string;
  /** What to tell the person who answers */
  message: string;
  /**
   * What the answer must look like: a Zod schema (the answer is then parsed by it) or JSON
   * Schema. Without one any JSON value is accepted
   */
  responseSchema?: ZodType<T> | Record<string, unknown>;
  /** When the question lapses: an answer after it is refused with `INTERRUPT_EXPIRED` */
  expiresAt?: Date | string | number;
}
