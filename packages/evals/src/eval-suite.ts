import { writeFileSync } from 'node:fs';
import { Dataset } from './datasets';
import type { EvalCase } from './schema';
import { EvalSuiteConfigSchema } from './schema';
import type { JudgeConfig } from './schema';
import type { MetricFn, MetricScore, EvalCaseResult, StatisticalMetricFn } from './metrics/types';
import type { LLMMetricFn } from './metrics/llm-judge';
import { bindJudgeContext } from './metrics/llm-judge';
import type { AssertionFn, AssertionResult, AggregatedMetric } from './assertions';
import { aggregate } from './stats';
import { report } from './reporters';
import type { ReporterType, ReporterOptions } from './reporters';

export interface EvalTarget {
  agent?: unknown;
  cogitator?: unknown;
  fn?: (input: string) => Promise<string>;
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
  judge?: JudgeConfig;
  assertions?: AssertionFn[];
  concurrency?: number;
  timeout?: number;
  retries?: number;
  onProgress?: (progress: EvalProgress) => void;
}

export interface EvalSuiteResult {
  results: Array<EvalCaseResult & { scores: MetricScore[] }>;
  aggregated: Record<string, AggregatedMetric>;
  assertions: AssertionResult[];
  stats: { total: number; duration: number; cost: number };
  report: (type: ReporterType | ReporterType[], options?: ReporterOptions) => void;
  saveBaseline: (path: string) => void;
}

function isLLMMetric(m: MetricFn): m is LLMMetricFn {
  return 'requiresJudge' in m && (m as LLMMetricFn).requiresJudge === true;
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
    const hasLLMMetrics = rawMetrics.some(isLLMMetric);

    if (hasLLMMetrics && !opts.judge) {
      throw new Error('LLM metrics require a judge config');
    }

    this.boundMetrics = rawMetrics.map((m) => {
      if (isLLMMetric(m) && opts.judge) {
        return bindJudgeContext(m, {
          cogitator: { run: async ({ input }: { input: string }) => ({ output: input }) },
          judgeConfig: opts.judge,
        });
      }
      return m;
    });
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

  async run(): Promise<EvalSuiteResult> {
    const suiteStart = Date.now();
    const cases = [...this.dataset.cases];
    const total = cases.length;
    let completed = 0;

    type ScoredResult = EvalCaseResult & { scores: MetricScore[] };
    const indexed: Array<{ idx: number; result: ScoredResult }> = [];

    let active = 0;
    let nextIdx = 0;

    if (total > 0) {
      await new Promise<void>((resolve) => {
        const drain = () => {
          while (active < this.concurrency && nextIdx < total) {
            const i = nextIdx++;
            const evalCase = cases[i];
            active++;

            this.executeCase(evalCase)
              .then((caseResult) =>
                this.evaluateCaseMetrics(caseResult).then((scores) => ({ ...caseResult, scores }))
              )
              .then((scored) => {
                indexed.push({ idx: i, result: scored });
                completed++;
                this.onProgress?.({ completed, total, currentCase: evalCase });
              })
              .finally(() => {
                active--;
                if (nextIdx >= total && active === 0) {
                  resolve();
                } else {
                  drain();
                }
              });
          }
        };
        drain();
      });
    }

    indexed.sort((a, b) => a.idx - b.idx);
    const orderedResults = indexed.map((e) => e.result);

    const aggregated = this.aggregateScores(orderedResults);

    for (const statMetric of this.statisticalMetrics) {
      const score = statMetric(orderedResults);
      aggregated[score.name] = { name: score.name, ...aggregate([score.score]) };
    }

    const totalCost = orderedResults.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
    const suiteDuration = Date.now() - suiteStart;
    const stats = { total, duration: suiteDuration, cost: totalCost };

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
        for (const [name, agg] of Object.entries(aggregated)) {
          baseline[name] = agg.mean;
        }
        writeFileSync(path, JSON.stringify(baseline, null, 2));
      },
    };

    return suiteResult;
  }

  private async executeCase(evalCase: EvalCase): Promise<EvalCaseResult> {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.executeCaseAttempt(evalCase);
      } catch {
        if (attempt < this.retries) continue;
      }
    }

    return {
      case: evalCase,
      output: '',
      duration: 0,
    };
  }

  private async executeCaseAttempt(evalCase: EvalCase): Promise<EvalCaseResult> {
    const start = Date.now();

    const work = this.target.fn
      ? this.executeFnTarget(evalCase)
      : this.executeAgentTarget(evalCase);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('__timeout__')), this.timeout);
    });

    try {
      return await Promise.race([work, timeoutPromise]);
    } catch (err) {
      if ((err as Error).message === '__timeout__') {
        return {
          case: evalCase,
          output: '',
          duration: Date.now() - start,
        };
      }
      throw err;
    }
  }

  private async executeFnTarget(evalCase: EvalCase): Promise<EvalCaseResult> {
    const start = Date.now();
    const output = await this.target.fn!(evalCase.input);
    return { case: evalCase, output, duration: Date.now() - start };
  }

  private async executeAgentTarget(evalCase: EvalCase): Promise<EvalCaseResult> {
    const start = Date.now();
    const cogitator = this.target.cogitator as {
      run: (
        agent: unknown,
        opts: { input: string; context?: Record<string, unknown> }
      ) => Promise<Record<string, unknown>>;
    };
    const runResult = await cogitator.run(this.target.agent, {
      input: evalCase.input,
      context: evalCase.context,
    });
    const duration = Date.now() - start;

    const result: EvalCaseResult = {
      case: evalCase,
      output: (runResult.output as string) ?? '',
      duration,
    };

    if (runResult.usage) {
      result.usage = runResult.usage as EvalCaseResult['usage'];
    }

    if (runResult.toolCalls) {
      result.toolCalls = runResult.toolCalls as EvalCaseResult['toolCalls'];
    }

    return result;
  }

  private async evaluateCaseMetrics(result: EvalCaseResult): Promise<MetricScore[]> {
    if (this.boundMetrics.length === 0) return [];
    return Promise.all(this.boundMetrics.map((m) => m(result)));
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
