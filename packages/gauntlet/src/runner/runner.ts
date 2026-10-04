import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cogitator } from '@cogitator-ai/core';
import type { LLMBackend } from '@cogitator-ai/types';
import { costOf, currentStage, modelRef, type ModelPrice } from '../llm.js';
import { RequirementProbe } from './requirements.js';
import type {
  ArtifactStore,
  CheckResult,
  CogitatorOverrides,
  GauntletArtifacts,
  GauntletEvent,
  RunReport,
  ServiceUrls,
  StageContext,
  StageDefinition,
  StageResult,
  Usage,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 15_000;

export interface RunnerOptions {
  stages: StageDefinition[];
  services: ServiceUrls;
  /** OpenRouter model ids, primary first. */
  models: readonly string[];
  backend: LLMBackend;
  prices: Map<string, ModelPrice>;
  /** Published package names that must be covered by some stage. */
  publishedPackages: string[];
  /** Run only these stages and what they need. */
  only?: string[];
  concurrency?: number;
  keepTmp?: boolean;
}

class CheckFailed extends Error {}

class StageTimeout extends Error {
  constructor(ms: number) {
    super(`Stage timed out after ${Math.round(ms / 1000)} s`);
  }
}

const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });

function addUsage(target: Usage, delta: Usage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.costUsd += delta.costUsd;
  target.calls += delta.calls;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stages to run: the selected ones plus everything they transitively need. */
export function selectStages(stages: StageDefinition[], only?: string[]): StageDefinition[] {
  if (!only?.length) return stages;
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const unknown = only.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`Unknown stage(s): ${unknown.join(', ')}`);
  const wanted = new Set<string>();
  const visit = (id: string) => {
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const need of byId.get(id)?.needs ?? []) visit(need);
  };
  only.forEach(visit);
  return stages.filter((stage) => wanted.has(stage.id));
}

function validate(stages: StageDefinition[]): void {
  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`Duplicate stage id: ${stage.id}`);
    ids.add(stage.id);
  }
  for (const stage of stages) {
    for (const need of stage.needs ?? []) {
      if (!ids.has(need)) throw new Error(`Stage ${stage.id} needs unknown stage ${need}`);
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      throw new Error(`Stage dependency cycle: ${[...path, id].join(' -> ')}`);
    }
    state.set(id, 'visiting');
    for (const need of byId.get(id)?.needs ?? []) visit(need, [...path, id]);
    state.set(id, 'done');
  };
  for (const stage of stages) visit(stage.id, []);
}

/** Runs the stage graph and emits {@link GauntletEvent}s as it goes. */
export class GauntletRunner extends EventEmitter<{ event: [GauntletEvent] }> {
  private readonly stages: StageDefinition[];
  private readonly report: RunReport;
  private readonly artifacts = new Map<string, unknown>();
  private readonly cleanups: Array<{ stageId: string; run: () => Promise<void> | void }> = [];
  private readonly runtimes: Cogitator[] = [];
  private readonly probe: RequirementProbe;
  private readonly root: Promise<string>;
  private sharedRuntime?: Cogitator;

  constructor(private readonly options: RunnerOptions) {
    super();
    this.stages = selectStages(options.stages, options.only);
    validate(this.stages);
    this.probe = new RequirementProbe(options.services);
    this.root = mkdtemp(join(tmpdir(), 'cogitator-gauntlet-'));

    const coverage: Record<string, string[]> = {};
    for (const name of options.publishedPackages) coverage[name] = [];
    for (const stage of options.stages) {
      for (const name of stage.packages) (coverage[name] ??= []).push(stage.id);
    }

    this.report = {
      startedAt: Date.now(),
      model: options.models[0] ?? '',
      models: [...options.models],
      stages: this.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        description: stage.description,
        packages: stage.packages,
        needs: stage.needs ?? [],
      })),
      results: Object.fromEntries(
        this.stages.map((stage) => [
          stage.id,
          { id: stage.id, status: 'pending', checks: [], logs: [], usage: emptyUsage() },
        ])
      ),
      usage: emptyUsage(),
      coverage,
    };
  }

  /** The current state; also served to dashboards that connect mid-run. */
  snapshot(): RunReport {
    return structuredClone(this.report);
  }

  /** Called by the metered backend for every model call. */
  recordModelCall(
    stageId: string | undefined,
    model: string,
    usage: { inputTokens: number; outputTokens: number }
  ): void {
    const delta: Usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: costOf(this.options.prices, model, usage),
      calls: 1,
    };
    addUsage(this.report.usage, delta);
    const result = stageId ? this.report.results[stageId] : undefined;
    if (!result) return;
    addUsage(result.usage, delta);
    this.emit('event', {
      type: 'stage:usage',
      stageId: result.id,
      usage: { ...result.usage },
      total: { ...this.report.usage },
    });
  }

  async run(): Promise<RunReport> {
    this.emit('event', { type: 'run:start', report: this.snapshot() });
    try {
      await this.schedule();
    } finally {
      await this.cleanup();
    }
    this.report.finishedAt = Date.now();
    this.report.passed = Object.values(this.report.results).every(
      (result) => result.status === 'passed' || result.status === 'skipped'
    );
    this.emit('event', { type: 'run:end', report: this.snapshot() });
    return this.snapshot();
  }

  private async schedule(): Promise<void> {
    const limit = this.options.concurrency ?? 4;
    const remaining = new Map(this.stages.map((stage) => [stage.id, stage]));
    const running = new Map<string, Promise<void>>();

    while (remaining.size > 0 || running.size > 0) {
      for (const [id, stage] of remaining) {
        if (running.size >= limit) break;
        const needs = stage.needs ?? [];
        const statuses = needs.map((need) => this.report.results[need]?.status);
        if (statuses.some((status) => status === 'pending' || status === 'running')) continue;

        remaining.delete(id);
        const unmet = needs.filter((need) => this.report.results[need]?.status !== 'passed');
        if (unmet.length > 0) {
          this.finish(id, 'blocked', `Needs ${unmet.join(', ')}, which did not pass`);
          continue;
        }
        running.set(
          id,
          this.runStage(stage).finally(() => running.delete(id))
        );
      }
      if (running.size === 0) {
        if (remaining.size > 0) throw new Error('Stage graph is stuck');
        break;
      }
      await Promise.race(running.values());
    }
  }

  private finish(id: string, status: StageResult['status'], reason?: string): void {
    const result = this.report.results[id];
    if (!result) return;
    result.status = status;
    if (reason) result.reason = reason;
    if (result.startedAt) result.durationMs = Date.now() - result.startedAt;
    this.emit('event', { type: 'stage:end', result: structuredClone(result) });
  }

  private async runStage(stage: StageDefinition): Promise<void> {
    const result = this.report.results[stage.id];
    if (!result) return;

    for (const requirement of stage.requires ?? []) {
      const missing = await this.probe.missing(requirement);
      if (missing) {
        this.finish(stage.id, 'skipped', missing);
        return;
      }
    }

    result.status = 'running';
    result.startedAt = Date.now();
    this.emit('event', { type: 'stage:start', stageId: stage.id, at: result.startedAt });

    const timeoutMs = stage.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new StageTimeout(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      const context = await this.createContext(stage, controller.signal);
      await currentStage.run(stage.id, () => Promise.race([stage.run(context), timeout]));
      this.finish(stage.id, 'passed');
    } catch (error) {
      const failedCheck = result.checks.find((check) => !check.ok);
      this.finish(
        stage.id,
        'failed',
        error instanceof CheckFailed && failedCheck
          ? `${failedCheck.name}: ${failedCheck.error ?? 'failed'}`
          : errorText(error)
      );
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  private runtime(overrides: CogitatorOverrides = {}): Cogitator {
    const runtime = new Cogitator({
      ...overrides,
      llm: {
        ...overrides.llm,
        defaultModel: overrides.llm?.defaultModel ?? modelRef(this.options.models[0] ?? ''),
        backends: { openrouter: this.options.backend },
      },
    });
    this.runtimes.push(runtime);
    return runtime;
  }

  private async createContext(stage: StageDefinition, signal: AbortSignal): Promise<StageContext> {
    const result = this.report.results[stage.id];
    if (!result) throw new Error(`No result slot for ${stage.id}`);
    const tmpDir = await mkdtemp(join(await this.root, `${stage.id}-`));
    const artifacts = this.artifactStore();
    let boundShared: Cogitator | undefined;
    const shared = () => {
      this.sharedRuntime ??= this.runtime();
      boundShared ??= bindToStage(this.sharedRuntime, stage.id);
      return boundShared;
    };

    return {
      stageId: stage.id,
      signal,
      services: this.options.services,
      model: modelRef(this.options.models[0] ?? ''),
      models: this.options.models.map(modelRef),
      get cogitator() {
        return shared();
      },
      createCogitator: (overrides) => bindToStage(this.runtime(overrides), stage.id),
      tmpDir,
      artifacts,
      check: async <T>(
        name: string,
        run: (evidence: (key: string, value: unknown) => void) => Promise<T> | T
      ) => {
        const evidence: Record<string, unknown> = {};
        const started = Date.now();
        const record = (check: CheckResult) => {
          result.checks.push(check);
          this.emit('event', { type: 'stage:check', stageId: stage.id, check });
        };
        try {
          const value = await run((key, value) => {
            evidence[key] = value;
          });
          record({ name, ok: true, durationMs: Date.now() - started, evidence });
          return value;
        } catch (error) {
          if (signal.aborted && signal.reason instanceof StageTimeout) throw signal.reason;
          record({
            name,
            ok: false,
            durationMs: Date.now() - started,
            evidence,
            error: errorText(error),
          });
          throw new CheckFailed(name);
        }
      },
      log: (message) => {
        const line = { at: Date.now(), message };
        result.logs.push(line);
        this.emit('event', { type: 'stage:log', stageId: stage.id, line });
      },
      recordUsage: (model, usage) => this.recordModelCall(stage.id, model, usage),
      freePort,
      onCleanup: (cleanup) => {
        this.cleanups.push({ stageId: stage.id, run: cleanup });
      },
    };
  }

  private artifactStore(): ArtifactStore {
    const store = this.artifacts;
    return {
      set(key, value) {
        store.set(key, value);
      },
      get<K extends keyof GauntletArtifacts>(key: K): GauntletArtifacts[K] {
        if (!store.has(key)) throw new Error(`Artifact "${String(key)}" was not produced`);
        return store.get(key) as GauntletArtifacts[K];
      },
      has(key) {
        return store.has(key);
      },
    };
  }

  private async cleanup(): Promise<void> {
    const withTimeout = async (label: string, work: () => Promise<void> | void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(work),
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), CLEANUP_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        process.stderr.write(`gauntlet: cleanup of ${label} failed: ${errorText(error)}\n`);
      } finally {
        clearTimeout(timer);
      }
    };

    for (const cleanup of this.cleanups.reverse()) {
      await withTimeout(cleanup.stageId, cleanup.run);
    }
    for (const runtime of this.runtimes) await withTimeout('runtime', () => runtime.close());
    if (!this.options.keepTmp) {
      await withTimeout('temporary files', async () =>
        rm(await this.root, { recursive: true, force: true })
      );
    }
  }
}

/**
 * The runtime as seen from one stage: every method runs inside that stage's usage context, so
 * model calls count towards the stage even when they start from a socket or timer callback
 * where the async context of the stage is lost.
 */
function bindToStage<T extends object>(runtime: T, stageId: string): T {
  return new Proxy(runtime, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        currentStage.run(stageId, () => Reflect.apply(value, target, args));
    },
  });
}

/** A free TCP port on localhost. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate a port'));
      });
    });
  });
}
