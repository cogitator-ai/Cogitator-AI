import { writeFileSync } from 'node:fs';
import { Dataset } from './datasets';
import type { EvalCase } from './schema';
import { EvalSuiteConfigSchema, JudgeConfigSchema } from './schema';
import type { JudgeCogitator, JudgeConfigInput } from './schema';
import type { MetricFn, MetricScore, EvalCaseResult, StatisticalMetricFn } from './metrics/types';
import { nonFiniteScoreError } from './metrics/types';
import type { LLMMetricFn } from './metrics/llm-judge';
import { bindJudgeContext, judgeContextFor } from './metrics/llm-judge';
import type { AssertionFn, AssertionResult, AggregatedMetric, EvalStats } from './assertions';
import { aggregate } from './stats';
import { report } from './reporters';
import type { ReporterType, ReporterOptions } from './reporters';

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
}

export interface EvalTarget {
  agent?: unknown;
  cogitator?: unknown;
  fn?: (input: string, context: EvalTargetContext) => Promise<string>;
}

export interface EvalProgress {
  completed: number;
  total: number;
  currentCase?: EvalCase;
}

export interface EvalSuiteOptions {
  dataset: Dataset;
  target: EvalTarget;
  metrics?: MetricFn[];
  statisticalMetrics?: StatisticalMetricFn[];
  judge?: JudgeConfigInput;
  assertions?: AssertionFn[];
  concurrency?: number;
  timeout?: number;
  retries?: number;
  /** Called after each case. A callback that throws is reported as a process warning */
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
  results: Array<EvalCaseResult & { scores: MetricScore[] }>;
  aggregated: Record<string, AggregatedMetric>;
  assertions: AssertionResult[];
  stats: EvalSuiteStats;
  report: (type: ReporterType | ReporterType[], options?: ReporterOptions) => void;
  /** Writes the mean of each metric as JSON; throws when a mean is not a finite number */
  saveBaseline: (path: string) => void;
}

type TargetUsage = NonNullable<EvalCaseResult['usage']>;

type AttemptOutcome =
  { ok: true; result: EvalCaseResult } | { ok: false; error: unknown; usage?: TargetUsage };

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

export class EvalSuite {
  private readonly dataset: Dataset;
  private readonly target: EvalTarget;
  private readonly boundMetrics: MetricFn[];
  private readonly statisticalMetrics: StatisticalMetricFn[];
  private readonly assertionFns: AssertionFn[];
  private readonly concurrency: number;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly onProgress?: (progress: EvalProgress) => void;

  constructor(opts: EvalSuiteOptions) {
    const config = EvalSuiteConfigSchema.parse({
      concurrency: opts.concurrency,
      timeout: opts.timeout,
      retries: opts.retries,
    });

    this.dataset = opts.dataset;
    this.target = opts.target;
    this.statisticalMetrics = opts.statisticalMetrics ?? [];
    this.assertionFns = opts.assertions ?? [];
    this.concurrency = config.concurrency;
    this.timeout = config.timeout;
    this.retries = config.retries;
    this.onProgress = opts.onProgress;

    this.validateTarget();

    const rawMetrics = opts.metrics ?? [];
    this.validateMetricNames(rawMetrics);
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

  async run(options: EvalRunOptions = {}): Promise<EvalSuiteResult> {
    const { maxCases, signal } = options;
    if (maxCases !== undefined && (!Number.isInteger(maxCases) || maxCases < 1)) {
      throw new Error(`maxCases must be a positive integer, got ${maxCases}`);
    }
    signal?.throwIfAborted();

    const suiteStart = Date.now();
    const cases = this.dataset.cases.slice(0, maxCases);
    const total = cases.length;

    type ScoredResult = EvalCaseResult & { scores: MetricScore[] };
    const orderedResults = new Array<ScoredResult>(total);
    let nextIdx = 0;
    let completed = 0;

    const worker = async () => {
      while (nextIdx < total && !signal?.aborted) {
        const i = nextIdx++;
        const evalCase = cases[i];
        orderedResults[i] = await this.runCase(evalCase, signal);
        completed++;
        this.reportProgress({ completed, total, currentCase: evalCase });
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, total) }, worker));
    signal?.throwIfAborted();

    const aggregated = this.aggregateScores(orderedResults);

    for (const statMetric of this.statisticalMetrics) {
      const score = statMetric(orderedResults);
      aggregated[score.name] = {
        name: score.name,
        ...aggregate(score.values ?? [score.score]),
        ...(score.metadata && { metadata: score.metadata }),
      };
    }

    const targetCost = orderedResults.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
    const judgeCost = orderedResults.reduce(
      (sum, r) => sum + r.scores.reduce((s, score) => s + (score.usage?.cost ?? 0), 0),
      0
    );
    const stats: EvalSuiteStats = {
      total,
      errors: orderedResults.filter((r) => r.error !== undefined).length,
      metricErrors: orderedResults.reduce(
        (n, r) => n + r.scores.filter((s) => s.error !== undefined).length,
        0
      ),
      duration: Date.now() - suiteStart,
      cost: targetCost + judgeCost,
      targetCost,
      judgeCost,
    };

    const assertionResults = this.assertionFns.map((fn) => fn(aggregated, stats));

    const suiteResult: EvalSuiteResult = {
      results: orderedResults,
      aggregated,
      assertions: assertionResults,
      stats,
      report: (type, options) => {
        report(
          {
            results: orderedResults.map((r) => ({
              case: { input: r.case.input, expected: r.case.expected },
              output: r.output,
              duration: r.duration,
              ...(r.error !== undefined && { error: r.error }),
              scores: r.scores,
            })),
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
  ): Promise<EvalCaseResult & { scores: MetricScore[] }> {
    const caseResult = await this.executeCase(evalCase, signal);
    if (signal?.aborted) return { ...caseResult, scores: [] };
    return { ...caseResult, scores: await this.evaluateCaseMetrics(caseResult) };
  }

  private async executeCase(
    evalCase: EvalCase,
    signal: AbortSignal | undefined
  ): Promise<EvalCaseResult> {
    const start = Date.now();
    let lastError: unknown;
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
    }

    return {
      case: evalCase,
      output: '',
      duration: Date.now() - start,
      error: errorMessage(signal?.aborted ? signal.reason : lastError),
      attempts,
      ...(usage && { usage }),
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
      if (first !== 'aborted' && (first.ok || !signal.aborted)) return first;

      const late = await waitAtMost(settled, this.timeout);
      const usage = late?.ok ? late.result.usage : undefined;
      return { ok: false, error: signal.reason, ...(usage && { usage }) };
    } finally {
      clearTimeout(timer);
      abort.cancel();
    }
  }

  private async executeFnTarget(
    evalCase: EvalCase,
    context: EvalTargetContext
  ): Promise<EvalCaseResult> {
    const start = Date.now();
    const output = await this.target.fn!(evalCase.input, context);
    return { case: evalCase, output, duration: Date.now() - start };
  }

  private async executeAgentTarget(
    evalCase: EvalCase,
    signal: AbortSignal
  ): Promise<EvalCaseResult> {
    const start = Date.now();
    const cogitator = this.target.cogitator as {
      run: (
        agent: unknown,
        opts: { input: string; context?: Record<string, unknown>; signal?: AbortSignal }
      ) => Promise<Record<string, unknown>>;
    };
    const runResult = await cogitator.run(this.target.agent, {
      input: evalCase.input,
      context: evalCase.context,
      signal,
    });
    const duration = Date.now() - start;

    const result: EvalCaseResult = {
      case: evalCase,
      output: (runResult.output as string) ?? '',
      duration,
    };

    const usage = targetUsageOf(runResult.usage);
    if (usage) {
      result.usage = usage;
    }

    if (runResult.toolCalls) {
      result.toolCalls = runResult.toolCalls as EvalCaseResult['toolCalls'];
    }

    return result;
  }

  private async evaluateCaseMetrics(result: EvalCaseResult): Promise<MetricScore[]> {
    if (this.boundMetrics.length === 0) return [];
    return Promise.all(this.boundMetrics.map((m) => this.scoreMetric(m, result)));
  }

  /**
   * A metric's score for one case. A metric that throws, or whose score is not a finite number,
   * scores 0 with the reason in `error`, so one bad metric neither drops the case nor poisons
   * the aggregate with NaN.
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

  private aggregateScores(
    results: Array<EvalCaseResult & { scores: MetricScore[] }>
  ): Record<string, AggregatedMetric> {
    const scoresByMetric = new Map<string, number[]>();

    for (const r of results) {
      for (const s of r.scores) {
        let arr = scoresByMetric.get(s.name);
        if (!arr) {
          arr = [];
          scoresByMetric.set(s.name, arr);
        }
        arr.push(s.score);
      }
    }

    const aggregated: Record<string, AggregatedMetric> = {};
    for (const [name, values] of scoresByMetric) {
      aggregated[name] = { name, ...aggregate(values) };
    }

    return aggregated;
  }
}
