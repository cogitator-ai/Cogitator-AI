import type { CallUsage } from '../llm.js';
import type { Cogitator } from '@cogitator-ai/core';

/**
 * Values stages hand to each other. Stage modules add their own keys through declaration
 * merging, so every read and write is typed:
 *
 * ```ts
 * declare module '../runner/types.js' {
 *   interface GauntletArtifacts {
 *     topic: string;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GauntletArtifacts {}

/** Something a stage needs from the machine; a missing one turns the stage into a skip. */
export type Requirement =
  | { kind: 'env'; name: string; why?: string }
  | { kind: 'docker' }
  | { kind: 'bun' }
  | { kind: 'deno' }
  | { kind: 'service'; name: ServiceName }
  | { kind: 'playwright' }
  /** An Ollama server (OLLAMA_BASE_URL, localhost by default) that has `model` pulled. */
  | { kind: 'ollama'; model: string };

export type ServiceName = 'postgres' | 'redis' | 'qdrant' | 'mongodb';

export interface ServiceUrls {
  postgres: string;
  redis: string;
  qdrant: string;
  mongodb: string;
}

export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked';

/** One assertion inside a stage, with what it observed. */
export interface CheckResult {
  name: string;
  ok: boolean;
  durationMs: number;
  /** What the check saw: ids, counts, excerpts. Shown in the dashboard. */
  evidence: Record<string, unknown>;
  error?: string;
}

export interface LogLine {
  at: number;
  message: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

export interface StageResult {
  id: string;
  status: StageStatus;
  startedAt?: number;
  durationMs?: number;
  checks: CheckResult[];
  logs: LogLine[];
  usage: Usage;
  /** Why the stage was skipped or blocked, or the error that failed it. */
  reason?: string;
}

/** Shared handles every stage gets. */
export interface StageContext {
  readonly stageId: string;
  readonly signal: AbortSignal;
  readonly services: ServiceUrls;
  /** The primary model, as agents name it (`openrouter/<vendor>/<model>`). */
  readonly model: string;
  /** Every gauntlet model, primary first, from different vendors: give multi-agent stages variety. */
  readonly models: readonly string[];
  /** A runtime on the gauntlet model, shared across stages. */
  readonly cogitator: Cogitator;
  /** A fresh runtime on the gauntlet model with extra config, closed when the run ends. */
  createCogitator(config?: CogitatorOverrides): Cogitator;
  /** A directory that exists for this stage only and is removed when the run ends. */
  readonly tmpDir: string;
  /**
   * Runs one named assertion and records it with its evidence. A failing check fails the stage
   * and stops it, since later checks build on earlier ones.
   */
  check<T>(name: string, run: (evidence: Evidence) => Promise<T> | T): Promise<T>;
  log(message: string): void;
  /**
   * Counts tokens and cost of model calls the metered backend cannot see, such as a server in a
   * child process. `model` is the model string used (`openrouter/<id>` or a bare OpenRouter id).
   */
  recordUsage(model: string, usage: CallUsage): void;
  /** A free TCP port on localhost. */
  freePort(): Promise<number>;
  /** Runs when the gauntlet finishes, newest first, also after failures. */
  onCleanup(cleanup: () => Promise<void> | void): void;
  artifacts: ArtifactStore;
}

export type CogitatorOverrides = Omit<
  NonNullable<ConstructorParameters<typeof Cogitator>[0]>,
  'llm'
> & {
  llm?: Omit<
    NonNullable<NonNullable<ConstructorParameters<typeof Cogitator>[0]>['llm']>,
    'backends'
  >;
};

/** Records what a check observed. */
export type Evidence = (key: string, value: unknown) => void;

export interface ArtifactStore {
  set<K extends keyof GauntletArtifacts>(key: K, value: GauntletArtifacts[K]): void;
  /** Throws when the producing stage did not provide the value. */
  get<K extends keyof GauntletArtifacts>(key: K): GauntletArtifacts[K];
  has(key: keyof GauntletArtifacts): boolean;
}

export interface StageDefinition {
  /** Unique, kebab-case. */
  id: string;
  title: string;
  /** One sentence for the dashboard: what this stage proves. */
  description: string;
  /** Published packages this stage exercises (npm names). Feeds the coverage check. */
  packages: string[];
  /** Stages whose artifacts this one reads; a failed dependency blocks it. */
  needs?: string[];
  requires?: Requirement[];
  /** Default 120 s. */
  timeoutMs?: number;
  run(context: StageContext): Promise<void>;
}

export interface StageInfo {
  id: string;
  title: string;
  description: string;
  packages: string[];
  needs: string[];
}

export interface RunReport {
  startedAt: number;
  finishedAt?: number;
  /** Primary model id. */
  model: string;
  /** Every model id the run uses, primary first. */
  models: string[];
  stages: StageInfo[];
  results: Record<string, StageResult>;
  usage: Usage;
  /** Published packages and the stages that exercise them. */
  coverage: Record<string, string[]>;
  passed?: boolean;
}

export type GauntletEvent =
  | { type: 'run:start'; report: RunReport }
  | { type: 'stage:start'; stageId: string; at: number }
  | { type: 'stage:check'; stageId: string; check: CheckResult }
  | { type: 'stage:log'; stageId: string; line: LogLine }
  | { type: 'stage:usage'; stageId: string; usage: Usage; total: Usage }
  | { type: 'stage:end'; result: StageResult }
  | { type: 'run:end'; report: RunReport };
