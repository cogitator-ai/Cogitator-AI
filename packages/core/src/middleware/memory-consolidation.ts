import {
  MemoryConsolidator,
  MemoryFiles,
  MemoryItems,
  MemoryObservations,
  isMemoryFileAdapter,
  isMemoryItemAdapter,
  type SummarizeFn,
} from '@cogitator-ai/memory';
import type {
  MemoryAdapter,
  MemoryConsolidationConfig,
  MemoryConsolidationReport,
  MemoryItemScope,
  MemoryObservationsConfig,
  RunEndEvent,
  RunMiddleware,
  RunMiddlewareContext,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import type { CompactionRun } from './memory-compaction';

/** The thread metadata key that counts the runs since the last consolidation */
export const CONSOLIDATION_STATE = 'memoryConsolidation';

/** What memory upkeep takes from the runtime */
export interface MemoryUpkeepDeps {
  memory: () => MemoryAdapter | undefined;
  /**
   * A summarizer that asks `model`, its calls counted against `run` in the cost router only, as
   * the run returned before they were made
   */
  summarizer: (model: string, run: CompactionRun) => SummarizeFn;
}

export interface MemoryUpkeepConfig {
  observations?: MemoryObservationsConfig;
  consolidation?: MemoryConsolidationConfig;
  /** Who memory items belong to, as `memory.extraction.scope` says (default `user`) */
  scope?: 'user' | 'agent' | 'thread';
}

/** What one pass does, for a scope */
interface UpkeepJob {
  scope: MemoryItemScope;
  model: string;
  run: Omit<CompactionRun, 'signal'>;
  observe: boolean;
  consolidate: boolean;
  /** Look only at subjects with items recorded after this, every subject when absent */
  since?: Date;
  /** Threads whose consolidation cursor moves to the start of the pass once it went through */
  cursors: string[];
}

/** The memory upkeep middleware, with the passes it runs in the background */
export interface MemoryUpkeep extends RunMiddleware {
  /** Notes that `threadId` was compacted, so its next run ends with a pass */
  noteCompaction(threadId: string): void;
  /** Runs a pass over the memory of `scope` now, see `Cogitator.consolidateMemory` */
  consolidate(job: {
    scope: MemoryItemScope;
    model: string;
    run: Omit<CompactionRun, 'signal'>;
  }): Promise<MemoryConsolidationReport>;
  /** Stops the passes under way and waits for them */
  close(): Promise<void>;
}

/** Where consolidation stands on a thread, as its metadata keeps it */
interface ConsolidationState {
  runs: number;
  /** When the last pass that went through started */
  at?: string;
}

function stateOf(metadata: Record<string, unknown> | undefined): ConsolidationState {
  const state = metadata?.[CONSOLIDATION_STATE];
  if (typeof state !== 'object' || state === null) return { runs: 0 };
  const { runs, at } = state as { runs?: unknown; at?: unknown };
  return {
    runs: typeof runs === 'number' && Number.isInteger(runs) && runs >= 0 ? runs : 0,
    ...(typeof at === 'string' && { at }),
  };
}

/** The scope memory items of a run belong to, as extraction keeps them */
export function upkeepScope(
  memoryAgentId: string,
  scope: 'user' | 'agent' | 'thread' | undefined,
  run: { userId?: string; threadId: string }
): MemoryItemScope {
  const anonymous = scope !== 'agent' && run.userId === undefined;
  return {
    agentId: memoryAgentId,
    ...(scope !== 'agent' && run.userId !== undefined && { userId: run.userId }),
    ...((scope === 'thread' || anonymous) && { threadId: run.threadId }),
  };
}

/**
 * Memory upkeep between runs, see `MemoryObservationsConfig` and `MemoryConsolidationConfig`.
 * After a run it writes again the observations whose facts changed and, every `everyRuns` runs
 * of a thread or after the thread was compacted, consolidates the memory of the run's scope:
 * repeats and contradictions marked as stale, then lessons folded into the playbook, then the
 * observations. Passes run in the background, so no run waits for them, one at a time per scope,
 * a pass asked for while one runs going after it. A failure is logged and leaves memory as the
 * last step that held left it. `close` stops the passes under way.
 */
export function memoryUpkeepMiddleware(
  config: MemoryUpkeepConfig,
  deps: MemoryUpkeepDeps
): MemoryUpkeep {
  const consolidation = config.consolidation;
  const everyRuns = consolidation?.everyRuns ?? 20;
  if (consolidation && !(Number.isInteger(everyRuns) && everyRuns > 0)) {
    throw new Error(
      `memory.consolidation.everyRuns must be a whole number above 0, got ${everyRuns}`
    );
  }
  const maxChanges = consolidation?.maxChanges;
  if (maxChanges !== undefined && !(Number.isInteger(maxChanges) && maxChanges >= 0)) {
    throw new Error(
      `memory.consolidation.maxChanges must be a whole number from 0, got ${maxChanges}`
    );
  }
  for (const [name, value] of [
    ['maxEntities', config.observations?.maxEntities],
    ['minItems', config.observations?.minItems],
  ] as const) {
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      throw new Error(`memory.observations.${name} must be a whole number above 0, got ${value}`);
    }
  }

  const stop = new AbortController();
  const compacted = new Set<string>();
  const running = new Map<string, { done: Promise<void>; next?: UpkeepJob }>();
  const passes = new Set<Promise<unknown>>();

  const keyOf = (scope: MemoryItemScope) =>
    JSON.stringify([
      scope.agentId,
      scope.userId ?? null,
      scope.projectId ?? null,
      scope.threadId ?? null,
    ]);

  /** One job doing what `a` and `b` do: consolidating from the earlier cursor of the two */
  function merged(a: UpkeepJob, b: UpkeepJob): UpkeepJob {
    const since = !a.consolidate
      ? b.since
      : !b.consolidate
        ? a.since
        : a.since && b.since
          ? a.since < b.since
            ? a.since
            : b.since
          : undefined;
    const { since: _, ...rest } = b;
    return {
      ...rest,
      observe: a.observe || b.observe,
      consolidate: a.consolidate || b.consolidate,
      cursors: [...new Set([...a.cursors, ...b.cursors])],
      ...(since && { since }),
    };
  }

  /** Runs `job` after the pass of its scope under way, merged with any other waiting for it */
  function schedule(job: UpkeepJob): void {
    const key = keyOf(job.scope);
    const current = running.get(key);
    if (current) {
      const waiting = current.next;
      current.next = waiting ? merged(waiting, job) : job;
      return;
    }
    const entry: { done: Promise<void>; next?: UpkeepJob } = { done: Promise.resolve() };
    running.set(key, entry);
    const work = (async () => {
      let next: UpkeepJob | undefined = job;
      while (next && !stop.signal.aborted) {
        entry.next = undefined;
        try {
          await pass(next);
        } catch (error) {
          if (!stop.signal.aborted) {
            getLogger().warn('A pass over memory failed', {
              agentId: next.scope.agentId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        next = entry.next;
      }
    })().finally(() => {
      running.delete(key);
      passes.delete(work);
    });
    entry.done = work;
    passes.add(work);
  }

  /** One pass: consolidation first, so observations are written from what it kept */
  async function pass(job: UpkeepJob): Promise<MemoryConsolidationReport> {
    const report: MemoryConsolidationReport = {
      scope: job.scope,
      observations: [],
      observationsDeleted: [],
      stale: [],
    };
    const memory = deps.memory();
    if (!memory || !isMemoryItemAdapter(memory)) return report;
    const startedAt = new Date();
    let through = true;
    const items = new MemoryItems({ adapter: memory });
    const files = isMemoryFileAdapter(memory) ? new MemoryFiles({ adapter: memory }) : undefined;
    const summarize = (model: string | undefined) =>
      deps.summarizer(model ?? job.model, { ...job.run, signal: stop.signal });

    if (job.consolidate && consolidation) {
      const consolidator = new MemoryConsolidator({
        items,
        itemAdapter: memory,
        ...(files && { files }),
      });
      const dedupe = await consolidator.dedupe(job.scope, {
        summarize: summarize(consolidation.model),
        ...(job.since && { since: job.since }),
        ...(maxChanges !== undefined && { maxChanges }),
        ...(consolidation.prompt && { prompt: consolidation.prompt }),
      });
      report.stale = dedupe.stale;
      through = dedupe.complete;
      const mode = consolidation.playbook ?? 'apply';
      if (mode !== false) {
        const change = await consolidator.foldLessons(job.scope, {
          summarize: summarize(consolidation.model),
          mode,
          ...(consolidation.prompt && { prompt: consolidation.prompt }),
        });
        if (change && change.edits.length > 0) {
          report.playbook = {
            path: change.path,
            edits: change.edits.length,
            lessonIds: change.lessonIds,
          };
        }
      }
    }
    const observing = config.observations;
    if ((job.observe || job.consolidate) && observing && files) {
      const refresh = await new MemoryObservations({ files, items, itemAdapter: memory }).refresh(
        job.scope,
        {
          summarize: summarize(observing.model),
          ...(observing.maxEntities !== undefined && { maxEntities: observing.maxEntities }),
          ...(observing.minItems !== undefined && { minItems: observing.minItems }),
          ...(observing.prompt && { prompt: observing.prompt }),
        }
      );
      report.observations = refresh.written.map((observation) => observation.path);
      report.observationsDeleted = refresh.deleted;
    }
    if (job.consolidate && through) {
      for (const threadId of job.cursors) await moveCursor(memory, threadId, startedAt);
    }
    if (job.consolidate && consolidation?.afterConsolidate) {
      try {
        await consolidation.afterConsolidate(report);
      } catch (error) {
        getLogger().warn('memory.consolidation.afterConsolidate failed', {
          agentId: job.scope.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }

  /**
   * Moves the consolidation cursor of `threadId` to `at`, the start of a pass that went through,
   * keeping the runs counted since and never moving it back
   */
  async function moveCursor(memory: MemoryAdapter, threadId: string, at: Date): Promise<void> {
    const thread = await memory.getThread(threadId);
    if (!thread.success || !thread.data) return;
    const state = stateOf(thread.data.metadata);
    if (state.at && new Date(state.at).getTime() >= at.getTime()) return;
    const updated = await memory.updateThread(threadId, {
      [CONSOLIDATION_STATE]: { runs: state.runs, at: at.toISOString() },
    });
    if (!updated.success) throw new Error(updated.error);
  }

  /** Counts the run on its thread, true when the thread is due a consolidation */
  async function due(
    memory: MemoryAdapter,
    threadId: string
  ): Promise<{ due: boolean; since?: Date }> {
    const thread = await memory.getThread(threadId);
    if (!thread.success || !thread.data) return { due: false };
    const state = stateOf(thread.data.metadata);
    const runs = state.runs + 1;
    const afterCompaction = compacted.delete(threadId) && consolidation?.afterCompaction !== false;
    const isDue = runs >= everyRuns || afterCompaction;
    const since = state.at ? new Date(state.at) : undefined;
    const updated = await memory.updateThread(threadId, {
      [CONSOLIDATION_STATE]: { runs: isDue ? 0 : runs, ...(state.at && { at: state.at }) },
    });
    if (!updated.success) throw new Error(updated.error);
    return {
      due: isDue,
      ...(since && !Number.isNaN(since.getTime()) && { since }),
    };
  }

  return {
    name: 'cogitator:memory-upkeep',
    async afterRun({ result, model, memoryAgentId }: RunEndEvent, context: RunMiddlewareContext) {
      const place = result.memory;
      if (!place || context.signal.aborted || stop.signal.aborted) return;
      const memory = deps.memory();
      if (!memory || !isMemoryItemAdapter(memory)) return;
      const consolidate = consolidation ? await due(memory, place.threadId) : { due: false };
      const observe = config.observations !== undefined;
      if (!observe && !consolidate.due) return;
      schedule({
        scope: upkeepScope(memoryAgentId, config.scope, {
          ...(context.userId !== undefined && { userId: context.userId }),
          threadId: place.threadId,
        }),
        model,
        run: { runId: result.runId, agentId: result.agentId, threadId: place.threadId },
        observe,
        consolidate: consolidate.due,
        ...(consolidate.since && { since: consolidate.since }),
        cursors: consolidate.due ? [place.threadId] : [],
      });
    },
    noteCompaction(threadId) {
      if (consolidation) compacted.add(threadId);
    },
    async consolidate({ scope, model, run }) {
      const key = keyOf(scope);
      for (let current = running.get(key); current; current = running.get(key)) {
        await current.done;
      }
      const work = pass({ scope, model, run, observe: true, consolidate: true, cursors: [] });
      const entry: { done: Promise<void>; next?: UpkeepJob } = {
        done: work.then(
          () => undefined,
          () => undefined
        ),
      };
      running.set(key, entry);
      passes.add(entry.done);
      try {
        return await work;
      } finally {
        running.delete(key);
        passes.delete(entry.done);
        if (entry.next) schedule(entry.next);
      }
    },
    async close() {
      stop.abort();
      await Promise.allSettled([...passes]);
    },
  };
}
