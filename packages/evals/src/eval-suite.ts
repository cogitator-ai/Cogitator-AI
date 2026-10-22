import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Dataset } from './datasets';
import type { EvalCase } from './schema';
import { EvalSuiteConfigSchema, JudgeConfigSchema } from './schema';
import type { JudgeCogitator, JudgeConfigInput } from './schema';
import type {
  MetricFn,
  MetricScore,
  EvalCaseResult,
  EvalPrompt,
  EvalToolCall,
  EvalToolResult,
  EvalTurnResult,
  Passage,
  ScoredCaseResult,
  StatisticalMetricFn,
} from './metrics/types';
import { nonFiniteScoreError } from './metrics/types';
import { isPassAtKMetric } from './metrics/statistical';
import { ragSearchPassages } from './metrics/retrieval';
import type { LLMMetricFn } from './metrics/llm-judge';
import { bindJudgeContext, judgeContextFor } from './metrics/llm-judge';
import type { AssertionFn, AssertionResult, AggregatedMetric, EvalStats } from './assertions';
import { aggregate, mean } from './stats';
import { report } from './reporters';
import type { ReportedCase, ReporterType, ReporterOptions } from './reporters';
import { parseOptions } from './options';
import { ExperimentOptionsSchema, RunPromptSchema } from './runs/schema';
import type { EvalRun, EvalRunConfig, JsonMetadata } from './runs/schema';
import { buildRun, newRunId, writeRun } from './runs/run';

/** A turn of a conversation: what the user said and what the target answered */
export interface EvalTurn {
  input: string;
  output: string;
}

/** What a function target gets besides the input */
export interface EvalTargetContext {
  /**
   * Aborted when the attempt times out or the suite run is cancelled. Pass it on to the model
   * call (`cogitator.run(agent, { input, signal })`, `fetch(url, { signal })`) so an abandoned
   * attempt stops instead of running, and paying, in the background.
   */
  signal: AbortSignal;
  /** The case being run */
  case: EvalCase;
  /** 0 for the first attempt, then 1, 2 and so on for retries */
  attempt: number;
  /** 0 for the case's `input`, then 1, 2 and so on for each of its further `turns` */
  turn: number;
  /** The turns of the case before this one, with the answers the target gave */
  history: readonly EvalTurn[];
}

/** A tool result as the `retrieval` of a target reads it */
export interface RetrievalToolResult {
  name: string;
  result: unknown;
}

export interface EvalTarget {
  agent?: unknown;
  cogitator?: unknown;
  /** Called once per turn of a case: with `input`, then with each of its further `turns` */
  fn?: (input: string, context: EvalTargetContext) => Promise<string>;
  /**
   * Reads the passages a tool result of an agent target surfaced, into the case's `retrieved`,
   * undefined for a result that holds none. Default: `ragSearchPassages`, which reads the
   * results of the `rag_search` tool of `@cogitator-ai/rag`
   */
  retrieval?: (toolResult: RetrievalToolResult) => Passage[] | undefined;
}

export interface EvalProgress {
  completed: number;
  total: number;
  currentCase?: EvalCase;
}

export interface EvalSuiteOptions {
  dataset: Dataset;
  target: EvalTarget;
  /** Names the experiment the suite runs, such as `support-agent`, in reports and run files */
  name?: string;
  /**
   * Describes the experiment in run files, such as `{ branch: 'main', commit: 'a1b2c3' }`. Must be
   * JSON-serializable: keys holding `undefined` are dropped, other values JSON cannot hold throw
   */
  metadata?: Record<string, unknown>;
  metrics?: MetricFn[];
  statisticalMetrics?: StatisticalMetricFn[];
  judge?: JudgeConfigInput;
  assertions?: AssertionFn[];
  concurrency?: number;
  timeout?: number;
  retries?: number;
  /**
   * Runs of each case, a positive integer, 1 by default. Each trial is scored on its own, the
   * case result is the first trial that answered (the first when all errored) with every trial in
   * `trials`, and the aggregate of a metric
   * takes the mean of a case's scored trials as the case's score. A case counts as errored in
   * `stats.errors` when every trial errored, and `latency()`, `cost()` and `tokenUsage()` see
   * every trial. Use `passAtK()` to score how often a case passes
   */
  trials?: number;
  /**
   * Called after each case, once all its trials ran. A callback that throws is reported as a
   * process warning
   */
  onProgress?: (progress: EvalProgress) => void;
}

export interface EvalRunOptions {
  /** Run only the first `maxCases` cases of the dataset (a positive integer) */
  maxCases?: number;
  /**
   * Cancels the run: the attempts in flight are aborted, no further case starts, and `run()`
   * rejects with the signal's reason
   */
  signal?: AbortSignal;
}

/** The run-wide figures of a finished suite run, every field filled in */
export type EvalSuiteStats = Required<EvalStats>;

export interface EvalSuiteResult {
  /**
   * One result per case, in dataset order. With several trials it is the first trial that
   * answered, or the first when every trial errored, with every trial in its `trials`
   */
  results: ScoredCaseResult[];
  aggregated: Record<string, AggregatedMetric>;
  assertions: AssertionResult[];
  stats: EvalSuiteStats;
  report: (type: ReporterType | ReporterType[], options?: ReporterOptions) => void;
  /** Writes the mean of each metric as JSON; throws when a mean is not a finite number */
  saveBaseline: (path: string) => void;
  /** Unique id of the run, which names its run file: `20261022T101530123Z-1a2b3c4d` */
  runId: string;
  /** The suite's `name` */
  name?: string;
  /** The suite's `metadata` */
  metadata?: JsonMetadata;
  /** When the run started, ISO 8601 */
  startedAt: string;
  /** When the run finished, ISO 8601 */
  finishedAt: string;
  /**
   * The run as a run file holds it: id, times, name and metadata, the dataset fingerprint, the
   * suite's configuration (never its functions, Cogitator or keys), the prompts used, every case
   * result with its `caseKey`, the aggregates, assertions and stats
   */
  toRun: () => EvalRun;
  /**
   * Writes the run file and returns its path: `<target>/<runId>.json` when `target` is a
   * directory or ends with a path separator, `target` itself otherwise. Read it back with
   * `loadRun()`, keep runs with a `RunStore` and compare them with `compareRuns()`
   */
  saveRun: (target: string) => string;
}

type TargetUsage = NonNullable<EvalCaseResult['usage']>;

type AttemptOutcome =
  | { ok: true; result: EvalCaseResult }
  | { ok: false; error: unknown; usage?: TargetUsage; turns?: EvalTurnResult[] };

interface AgentRunResult {
  output?: unknown;
  trace?: unknown;
  prompt?: unknown;
  usage?: unknown;
  toolCalls?: unknown;
  truncated?: unknown;
  iterationLimitReached?: unknown;
  status?: unknown;
}

interface AgentRunner {
  run: (
    agent: unknown,
    opts: {
      input: string;
      context?: Record<string, unknown>;
      signal?: AbortSignal;
      threadId?: string;
      onToolResult?: (result: {
        callId: string;
        name: string;
        result: unknown;
        error?: string;
      }) => void;
    }
  ) => Promise<AgentRunResult>;
}

/**
 * A turn of a multi-turn case failed: the error of the turn, with the turns run so far (the
 * failed one last) and what they spent
 */
class TurnFailure extends Error {
  constructor(
    cause: unknown,
    readonly turns: EvalTurnResult[],
    readonly usage: TargetUsage | undefined
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'TurnFailure';
  }
}

/** What the user says to the target, turn by turn: the case's `input`, then its `turns` */
function turnInputs(evalCase: EvalCase): string[] {
  return [evalCase.input, ...(evalCase.turns ?? [])];
}

type Settled = { ok: true; result: EvalCaseResult } | { ok: false; error: unknown };

export function isLLMMetric(m: MetricFn): m is LLMMetricFn {
  return 'requiresJudge' in m && (m as LLMMetricFn).requiresJudge === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function targetUsageOf(value: unknown): TargetUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost)) return undefined;
  return {
    inputTokens: finite(usage.inputTokens),
    outputTokens: finite(usage.outputTokens),
    totalTokens: finite(usage.totalTokens),
    cost: usage.cost,
    duration: finite(usage.duration),
  };
}

function addUsage(total: TargetUsage | undefined, more: TargetUsage | undefined) {
  if (!more) return total;
  if (!total) return more;
  return {
    inputTokens: total.inputTokens + more.inputTokens,
    outputTokens: total.outputTokens + more.outputTokens,
    totalTokens: total.totalTokens + more.totalTokens,
    cost: total.cost + more.cost,
    duration: total.duration + more.duration,
  };
}

/** Resolves when `signal` aborts; `cancel` drops the listener */
function whenAborted(signal: AbortSignal): { aborted: Promise<'aborted'>; cancel: () => void } {
  let cancel = () => {};
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    cancel = () => signal.removeEventListener('abort', onAbort);
  });
  return { aborted, cancel };
}

/** Waits for `promise` at most `ms` milliseconds; undefined when it did not settle in time */
async function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The aggregate of a metric no case was scored on, every case having errored: its figures are
 * NaN, so a threshold, a regression check or a baseline over it fails instead of passing on
 * nothing
 */
function unscored(name: string): AggregatedMetric {
  return {
    name,
    mean: Number.NaN,
    median: Number.NaN,
    min: Number.NaN,
    max: Number.NaN,
    stdDev: Number.NaN,
    p50: Number.NaN,
    p95: Number.NaN,
    p99: Number.NaN,
    count: 0,
  };
}

export class EvalSuite {
  private readonly dataset: Dataset;
  private readonly target: EvalTarget;
  private readonly boundMetrics: MetricFn[];
  private readonly statisticalMetrics: StatisticalMetricFn[];
  private readonly assertionFns: AssertionFn[];
  private readonly concurrency: number;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly trials: number;
  private readonly onProgress?: (progress: EvalProgress) => void;
  private readonly name?: string;
  private readonly metadata?: JsonMetadata;
  private readonly runConfig: EvalRunConfig;

  constructor(opts: EvalSuiteOptions) {
    const config = EvalSuiteConfigSchema.parse({
      concurrency: opts.concurrency,
      timeout: opts.timeout,
      retries: opts.retries,
      trials: opts.trials,
    });

    this.dataset = opts.dataset;
    this.target = opts.target;
    this.statisticalMetrics = opts.statisticalMetrics ?? [];
    this.assertionFns = opts.assertions ?? [];
    this.concurrency = config.concurrency;
    this.timeout = config.timeout;
    this.retries = config.retries;
    this.trials = config.trials;
    this.onProgress = opts.onProgress;

    const experiment = parseOptions(
      ExperimentOptionsSchema,
      { name: opts.name, metadata: opts.metadata },
      'EvalSuite'
    );
    this.name = experiment.name;
    this.metadata = experiment.metadata;

    this.validateTarget();

    const rawMetrics = opts.metrics ?? [];
    this.validateMetricNames(rawMetrics);
    this.validatePassAtK(rawMetrics);
    const hasLLMMetrics = rawMetrics.some(isLLMMetric);

    if (hasLLMMetrics && !opts.judge) {
      throw new Error('LLM metrics require a judge config');
    }

    const judgeConfig = opts.judge ? JudgeConfigSchema.parse(opts.judge) : undefined;
    const judgeCogitator =
      judgeConfig?.cogitator ?? (this.target.cogitator as JudgeCogitator | undefined);
    if (hasLLMMetrics && !judgeCogitator) {
      throw new Error(
        'LLM metrics need a Cogitator to run the judge: pass judge.cogitator, or use an agent target'
      );
    }
    const judge =
      judgeConfig && judgeCogitator ? judgeContextFor(judgeCogitator, judgeConfig) : null;

    this.boundMetrics = rawMetrics.map((m) =>
      isLLMMetric(m) && judge ? bindJudgeContext(m, judge) : m
    );

    this.runConfig = {
      metrics: rawMetrics.map((m) => m.metricName),
      statisticalMetrics: this.statisticalMetrics.map((m) => m.metricName),
      ...(judgeConfig && {
        judge: {
          model: judgeConfig.model,
          temperature: judgeConfig.temperature,
          ...(judgeConfig.samples !== undefined && { samples: judgeConfig.samples }),
        },
      }),
      trials: this.trials,
      concurrency: this.concurrency,
      target: targetDescription(this.target),
    };
  }

  private validateTarget(): void {
    const { fn, agent, cogitator } = this.target;
    const hasFn = fn !== undefined;
    const hasAgent = agent !== undefined;
    const hasCogitator = cogitator !== undefined;

    if (hasFn && (hasAgent || hasCogitator)) {
      throw new Error('Target must have either fn or agent+cogitator, not both');
    }

    if (!hasFn && !hasAgent && !hasCogitator) {
      throw new Error('Target must have either fn or agent+cogitator');
    }

    if (hasAgent && !hasCogitator) {
      throw new Error('Agent target requires cogitator instance');
    }

    if (hasCogitator && !hasAgent) {
      throw new Error('Cogitator target requires agent instance');
    }

    if (hasFn && this.target.retrieval !== undefined) {
      throw new Error('Target retrieval reads tool results, so it needs an agent target, not fn');
    }
  }

  /** A `passAtK()` metric needs the metric it reads and at least `k` trials */
  private validatePassAtK(metrics: MetricFn[]): void {
    const names = new Set(metrics.map((m) => m.metricName));
    for (const statMetric of this.statisticalMetrics) {
      if (!isPassAtKMetric(statMetric)) continue;
      const { metric, k } = statMetric.passAtK;
      if (!names.has(metric)) {
        throw new Error(
          `${statMetric.metricName} reads the metric '${metric}', which the suite does not have: add it to metrics`
        );
      }
      if (k > this.trials) {
        throw new Error(
          `${statMetric.metricName} needs at least ${k} trials per case, the suite runs ${this.trials}: set trials to ${k} or more`
        );
      }
    }
  }

  /** Two metrics with one name would be aggregated, compared and reported as one */
  private validateMetricNames(metrics: MetricFn[]): void {
    const seen = new Set<string>();
    for (const m of [...metrics, ...this.statisticalMetrics]) {
      const name = m.metricName;
      if (name === undefined) continue;
      if (seen.has(name)) {
        throw new Error(
          `Two metrics are named '${name}': give each its own name, such as regex(pattern, { name: 'hasDate' })`
        );
      }
      seen.add(name);
    }
  }

  /** The cases a run with `maxCases` goes through, in order */
  cases(maxCases?: number): readonly EvalCase[] {
    return this.dataset.cases.slice(0, maxCases);
  }

  async run(options: EvalRunOptions = {}): Promise<EvalSuiteResult> {
    const { maxCases, signal } = options;
    if (maxCases !== undefined && (!Number.isInteger(maxCases) || maxCases < 1)) {
      throw new Error(`maxCases must be a positive integer, got ${maxCases}`);
    }
    signal?.throwIfAborted();

    const startedAt = new Date();
    const runId = newRunId(startedAt);
    const suiteStart = startedAt.getTime();
    const cases = this.cases(maxCases);
    const total = cases.length;
    const trials = this.trials;

    const trialResults = cases.map(() => new Array<ScoredCaseResult>(trials));
    const trialsLeft = cases.map(() => trials);
    const runs = total * trials;
    let nextRun = 0;
    let completed = 0;

    const worker = async () => {
      while (nextRun < runs && !signal?.aborted) {
        const run = nextRun++;
        const i = Math.floor(run / trials);
        const evalCase = cases[i];
        trialResults[i][run % trials] = await this.runCase(evalCase, signal);
        if (--trialsLeft[i] > 0) continue;
        completed++;
        this.reportProgress({ completed, total, currentCase: evalCase });
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, runs) }, worker));
    signal?.throwIfAborted();

    const orderedResults: ScoredCaseResult[] = trialResults.map((caseTrials) =>
      trials === 1 ? caseTrials[0] : { ...leadTrial(caseTrials), trials: caseTrials }
    );
    const allTrials = orderedResults.flatMap(trialsOf);

    const aggregated = this.aggregateScores(orderedResults);

    for (const statMetric of this.statisticalMetrics) {
      const score = statMetric(isPassAtKMetric(statMetric) ? orderedResults : allTrials);
      aggregated[score.name] = {
        name: score.name,
        ...aggregate(score.values ?? [score.score]),
        ...(score.metadata && { metadata: score.metadata }),
      };
    }

    const targetCost = allTrials.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
    const judgeCost = allTrials.reduce(
      (sum, r) => sum + r.scores.reduce((s, score) => s + (score.usage?.cost ?? 0), 0),
      0
    );
    const stats: EvalSuiteStats = {
      total,
      errors: orderedResults.filter((r) => r.error !== undefined).length,
      metricErrors: allTrials.reduce(
        (n, r) => n + r.scores.filter((s) => s.error !== undefined).length,
        0
      ),
      duration: Date.now() - suiteStart,
      cost: targetCost + judgeCost,
      targetCost,
      judgeCost,
    };

    const assertionResults = this.assertionFns.map((fn) => fn(aggregated, stats));
    const finishedAt = new Date(suiteStart + stats.duration);

    let run: EvalRun | undefined;
    const toRun = () =>
      (run ??= buildRun({
        runId,
        startedAt,
        finishedAt,
        ...(this.name !== undefined && { name: this.name }),
        ...(this.metadata !== undefined && { metadata: this.metadata }),
        cases,
        config: this.runConfig,
        results: orderedResults,
        aggregated,
        assertions: assertionResults,
        stats,
      }));

    const suiteResult: EvalSuiteResult = {
      results: orderedResults,
      aggregated,
      assertions: assertionResults,
      stats,
      runId,
      ...(this.name !== undefined && { name: this.name }),
      ...(this.metadata !== undefined && { metadata: this.metadata }),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      toRun,
      saveRun: (target) => writeRun(toRun(), target),
      report: (type, options) => {
        report(
          {
            ...(this.name !== undefined && { name: this.name }),
            runId,
            results: orderedResults.map(reportedCase),
            aggregated,
            assertions: assertionResults,
            stats,
          },
          type,
          options
        );
      },
      saveBaseline: (path) => {
        const baseline: Record<string, number> = {};
        const invalid: string[] = [];
        for (const [name, agg] of Object.entries(aggregated)) {
          if (Number.isFinite(agg.mean)) baseline[name] = agg.mean;
          else invalid.push(`${name} = ${agg.mean}`);
        }
        if (invalid.length > 0) {
          throw new Error(
            `Cannot save a baseline with values that are not finite numbers: ${invalid.join(', ')}`
          );
        }
        writeFileSync(path, JSON.stringify(baseline, null, 2));
      },
    };

    return suiteResult;
  }

  private reportProgress(progress: EvalProgress): void {
    if (!this.onProgress) return;
    const warn = (error: unknown) =>
      process.emitWarning(`EvalSuite onProgress threw: ${errorMessage(error)}`, {
        code: 'COGITATOR_EVALS_ON_PROGRESS',
      });
    try {
      const returned: unknown = this.onProgress(progress);
      if (returned instanceof Promise) returned.catch(warn);
    } catch (error) {
      warn(error);
    }
  }

  private async runCase(
    evalCase: EvalCase,
    signal: AbortSignal | undefined
  ): Promise<ScoredCaseResult> {
    const caseResult = await this.executeCase(evalCase, signal);
    if (signal?.aborted || caseResult.error !== undefined) return { ...caseResult, scores: [] };
    return { ...caseResult, scores: await this.evaluateCaseMetrics(caseResult) };
  }

  private async executeCase(
    evalCase: EvalCase,
    signal: AbortSignal | undefined
  ): Promise<EvalCaseResult> {
    const start = Date.now();
    let lastError: unknown;
    let lastTurns: EvalTurnResult[] | undefined;
    let usage: TargetUsage | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= this.retries && !signal?.aborted; attempt++) {
      attempts++;
      const outcome = await this.executeCaseAttempt(evalCase, attempt, signal);
      if (outcome.ok) {
        const total = addUsage(usage, outcome.result.usage);
        return { ...outcome.result, attempts, ...(total && { usage: total }) };
      }
      usage = addUsage(usage, outcome.usage);
      lastError = outcome.error;
      lastTurns = outcome.turns;
    }

    return {
      case: evalCase,
      output: '',
      duration: Date.now() - start,
      error: errorMessage(signal?.aborted ? signal.reason : lastError),
      attempts,
      ...(usage && { usage }),
      ...(lastTurns && { turns: lastTurns }),
    };
  }

  /**
   * One attempt, aborted through its signal after `timeout`. An aborted attempt gets as long
   * again to stop before the case moves on, so a target that honors the signal never overlaps
   * its retry and the concurrency limit holds. Usage of an attempt that still finished counts.
   */
  private async executeCaseAttempt(
    evalCase: EvalCase,
    attempt: number,
    suiteSignal: AbortSignal | undefined
  ): Promise<AttemptOutcome> {
    const controller = new AbortController();
    const signal = suiteSignal
      ? AbortSignal.any([suiteSignal, controller.signal])
      : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new Error(`Timed out after ${this.timeout}ms`)),
      this.timeout
    );

    const settled: Promise<Settled> = (async () =>
      this.target.fn
        ? this.executeFnTarget(evalCase, { signal, case: evalCase, attempt })
        : this.executeAgentTarget(evalCase, signal))().then(
      (result): Settled => ({ ok: true, result }),
      (error: unknown): Settled => ({ ok: false, error })
    );
    const abort = whenAborted(signal);

    try {
      const first = await Promise.race([settled, abort.aborted]);
      if (first !== 'aborted' && (first.ok || !signal.aborted)) return failureDetails(first);

      const late = await waitAtMost(settled, this.timeout);
      const lateOutcome = late && failureDetails(late);
      const usage = lateOutcome?.ok ? lateOutcome.result.usage : lateOutcome?.usage;
      const turns = lateOutcome && !lateOutcome.ok ? lateOutcome.turns : undefined;
      return { ok: false, error: signal.reason, ...(usage && { usage }), ...(turns && { turns }) };
    } finally {
      clearTimeout(timer);
      abort.cancel();
    }
  }

  private async executeFnTarget(
    evalCase: EvalCase,
    context: Omit<EvalTargetContext, 'turn' | 'history'>
  ): Promise<EvalCaseResult> {
    const start = Date.now();
    const inputs = turnInputs(evalCase);
    const multiTurn = inputs.length > 1;
    const turns: EvalTurnResult[] = [];

    for (const [turn, input] of inputs.entries()) {
      if (turn > 0 && context.signal.aborted) {
        throw new TurnFailure(context.signal.reason, [...turns], undefined);
      }
      const history = turns.map(({ input, output }) => ({ input, output }));
      try {
        const output = await this.target.fn!(input, { ...context, turn, history });
        turns.push({ input, output });
      } catch (error) {
        if (!multiTurn) throw error;
        throw new TurnFailure(
          error,
          [...turns, { input, output: '', error: errorMessage(error) }],
          undefined
        );
      }
    }

    return {
      case: evalCase,
      output: turns[turns.length - 1].output,
      duration: Date.now() - start,
      ...(multiTurn && { turns }),
    };
  }

  /**
   * Runs the agent on each turn of the case. A case with further `turns` runs them all on one
   * thread of its own, so the Cogitator's memory carries the conversation from turn to turn
   */
  private async executeAgentTarget(
    evalCase: EvalCase,
    signal: AbortSignal
  ): Promise<EvalCaseResult> {
    const start = Date.now();
    const cogitator = this.target.cogitator as AgentRunner;
    const retrieval = this.target.retrieval ?? ragSearchPassages;
    const inputs = turnInputs(evalCase);
    const threadId = inputs.length > 1 ? `eval-${randomUUID()}` : undefined;

    const turns: EvalTurnResult[] = [];
    const toolCalls: EvalToolCall[] = [];
    const toolResults: EvalToolResult[] = [];
    const retrieved: Passage[] = [];
    let reportsToolCalls = false;
    let usage: TargetUsage | undefined;
    let lastRun: RunIdentity = {};
    const flags: Pick<EvalCaseResult, 'truncated' | 'iterationLimitReached' | 'paused'> = {};

    for (const input of inputs) {
      if (turns.length > 0 && signal.aborted) {
        throw new TurnFailure(signal.reason, [...turns], usage);
      }
      const turnResults: EvalToolResult[] = [];
      let runResult: AgentRunResult;
      try {
        runResult = await cogitator.run(this.target.agent, {
          input,
          context: evalCase.context,
          signal,
          ...(threadId !== undefined && { threadId }),
          onToolResult: (toolResult) => turnResults.push(toolResultOf(toolResult)),
        });
      } catch (error) {
        if (threadId === undefined) throw error;
        throw new TurnFailure(
          error,
          [...turns, { input, output: '', error: errorMessage(error) }],
          usage
        );
      }

      const output = typeof runResult.output === 'string' ? runResult.output : '';
      const turnCalls = Array.isArray(runResult.toolCalls)
        ? (runResult.toolCalls as EvalToolCall[])
        : undefined;
      if (turnCalls) reportsToolCalls = true;
      toolCalls.push(...(turnCalls ?? []));
      toolResults.push(...turnResults);
      for (const toolResult of turnResults) {
        if (toolResult.error !== undefined) continue;
        retrieved.push(...(retrieval({ name: toolResult.name, result: toolResult.result }) ?? []));
      }
      usage = addUsage(usage, targetUsageOf(runResult.usage));
      if (runResult.truncated === true) flags.truncated = true;
      if (runResult.iterationLimitReached === true) flags.iterationLimitReached = true;
      if (runResult.status === 'paused') flags.paused = true;
      lastRun = runIdentityOf(runResult);
      turns.push({
        input,
        output,
        ...(turnCalls && turnCalls.length > 0 && { toolCalls: turnCalls }),
        ...lastRun,
      });
    }

    return {
      case: evalCase,
      output: turns[turns.length - 1].output,
      duration: Date.now() - start,
      ...(usage && { usage }),
      ...(reportsToolCalls && { toolCalls }),
      ...(toolResults.length > 0 && { toolResults }),
      ...(retrieved.length > 0 && { retrieved }),
      ...(threadId !== undefined && { turns }),
      ...lastRun,
      ...flags,
    };
  }

  private async evaluateCaseMetrics(result: EvalCaseResult): Promise<MetricScore[]> {
    if (this.boundMetrics.length === 0) return [];
    return Promise.all(this.boundMetrics.map((m) => this.scoreMetric(m, result)));
  }

  /**
   * A metric's score for one case. Only cases with an output are scored: a case whose every
   * attempt failed is left unscored, so its empty output neither costs a judge call nor counts as
   * a score of 0 (`stats.errors` and the `maxErrorRate` assertion catch those). A metric that
   * throws, or whose score is not a finite number, scores 0 with the reason in `error`, so one
   * bad metric neither drops the case nor poisons the aggregate with NaN.
   */
  private async scoreMetric(metric: MetricFn, result: EvalCaseResult): Promise<MetricScore> {
    try {
      const score: unknown = await metric(result);
      if (typeof score !== 'object' || score === null) {
        const error = `metric returned ${String(score)} instead of a score`;
        return { name: metric.metricName, score: 0, details: `metric error: ${error}`, error };
      }
      const scored = score as MetricScore;
      const invalid = nonFiniteScoreError(scored.score);
      if (!invalid) return scored;
      return {
        ...scored,
        name: scored.name ?? metric.metricName,
        score: 0,
        details: `metric error: ${invalid}`,
        error: invalid,
      };
    } catch (err) {
      const error = errorMessage(err);
      return { name: metric.metricName, score: 0, details: `metric error: ${error}`, error };
    }
  }

  /** One score per case and metric: the mean over the case's trials the metric scored */
  private aggregateScores(results: ScoredCaseResult[]): Record<string, AggregatedMetric> {
    const scoresByMetric = new Map<string, number[]>();
    const push = (map: Map<string, number[]>, name: string, value: number) => {
      const values = map.get(name);
      if (values) values.push(value);
      else map.set(name, [value]);
    };

    for (const r of results) {
      const caseScores = new Map<string, number[]>();
      for (const trial of trialsOf(r)) {
        for (const s of trial.scores) push(caseScores, s.name, s.score);
      }
      for (const [name, values] of caseScores) push(scoresByMetric, name, mean(values));
    }

    const aggregated: Record<string, AggregatedMetric> = {};
    for (const [name, values] of scoresByMetric) {
      aggregated[name] = { name, ...aggregate(values), count: values.length };
    }
    if (results.length > 0 && results.flatMap(trialsOf).every((r) => r.error !== undefined)) {
      for (const metric of this.boundMetrics) {
        aggregated[metric.metricName] ??= unscored(metric.metricName);
      }
    }

    return aggregated;
  }
}

/** The trace and versioned instructions of an agent run */
interface RunIdentity {
  traceId?: string;
  prompt?: EvalPrompt;
}

function runIdentityOf(runResult: AgentRunResult): RunIdentity {
  const trace = runResult.trace;
  const traceId =
    typeof trace === 'object' && trace !== null
      ? (trace as { traceId?: unknown }).traceId
      : undefined;
  const prompt = RunPromptSchema.safeParse(runResult.prompt);
  return {
    ...(typeof traceId === 'string' && traceId !== '' && { traceId }),
    ...(prompt.success && { prompt: prompt.data }),
  };
}

/** What a run file records of the target: its kind, and an agent's name and model */
function targetDescription(target: EvalTarget): EvalRunConfig['target'] {
  if (target.fn !== undefined) return { kind: 'fn' };
  const agent =
    typeof target.agent === 'object' && target.agent !== null
      ? (target.agent as { name?: unknown; model?: unknown })
      : {};
  return {
    kind: 'agent',
    ...(typeof agent.name === 'string' && { name: agent.name }),
    ...(typeof agent.model === 'string' && { model: agent.model }),
  };
}

function trialsOf(result: ScoredCaseResult): readonly ScoredCaseResult[] {
  return result.trials ?? [result];
}

function toolResultOf(toolResult: {
  callId: string;
  name: string;
  result: unknown;
  error?: string;
}): EvalToolResult {
  return {
    callId: toolResult.callId,
    name: toolResult.name,
    ...(toolResult.result !== undefined && { result: toolResult.result }),
    ...(toolResult.error !== undefined && { error: toolResult.error }),
  };
}

/** The turns and usage a failed attempt leaves, when a turn of a multi-turn case failed */
function failureDetails(settled: Settled): AttemptOutcome {
  if (settled.ok || !(settled.error instanceof TurnFailure)) return settled;
  const { turns, usage } = settled.error;
  return { ok: false, error: settled.error, turns, ...(usage && { usage }) };
}

/** The trial a case is reported by: the first that answered, the first when every trial errored */
function leadTrial(trials: ScoredCaseResult[]): ScoredCaseResult {
  return trials.find((trial) => trial.error === undefined) ?? trials[0];
}

/** A case result as the reporters get it, the agent's data and the trials kept */
function reportedCase(r: ScoredCaseResult): ReportedCase {
  return {
    case: { input: r.case.input, expected: r.case.expected },
    output: r.output,
    duration: r.duration,
    ...(r.error !== undefined && { error: r.error }),
    ...(r.truncated && { truncated: true }),
    ...(r.iterationLimitReached && { iterationLimitReached: true }),
    ...(r.paused && { paused: true }),
    ...(r.toolCalls && { toolCalls: r.toolCalls }),
    ...(r.toolResults && { toolResults: r.toolResults }),
    ...(r.retrieved && { retrieved: r.retrieved }),
    ...(r.turns && { turns: r.turns }),
    ...(r.traceId !== undefined && { traceId: r.traceId }),
    ...(r.prompt && { prompt: r.prompt }),
    scores: r.scores,
    ...(r.trials && { trials: r.trials.map(reportedCase) }),
  };
}
