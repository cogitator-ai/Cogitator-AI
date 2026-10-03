import type {
  ExecutionTrace,
  TraceStore,
  Demo,
  OptimizationResult,
  CompileOptions,
  LearningStats,
  LearningConfig,
  InsightStore,
  RunResult,
  Agent,
  LLMBackend,
} from '@cogitator-ai/types';
import { InMemoryTraceStore } from './trace-store';
import { buildExecutionTrace } from './trace-builder';
import { Agent as CoreAgent } from '../agent';
import { MetricEvaluator } from './metrics';
import { DemoSelector } from './demo-selector';
import { InstructionOptimizer } from './instruction-optimizer';

/** What `compile()` needs to run a trainset: `Cogitator.run`. */
export interface TrainsetRunner {
  run(agent: CoreAgent, options: { input: string }): Promise<RunResult>;
}

export interface AgentOptimizerOptions {
  llm: LLMBackend;
  model: string;
  /** Runs the trainset given to `compile()`; without it, `compile()` works on stored traces. */
  cogitator?: TrainsetRunner;
  traceStore?: TraceStore;
  insightStore?: InsightStore;
  config?: Partial<LearningConfig>;
}

export class AgentOptimizer {
  private llm: LLMBackend;
  private model: string;
  private traceStore: TraceStore;
  private insightStore?: InsightStore;
  private cogitator?: TrainsetRunner;
  private metricEvaluator: MetricEvaluator;
  private demoSelector: DemoSelector;
  private instructionOptimizer: InstructionOptimizer;
  private config: LearningConfig;

  private optimizationRuns = new Map<
    string,
    { lastRun: Date; count: number; totalImprovement: number }
  >();

  constructor(options: AgentOptimizerOptions) {
    this.llm = options.llm;
    this.model = options.model;
    this.traceStore = options.traceStore ?? new InMemoryTraceStore();
    this.insightStore = options.insightStore;
    this.cogitator = options.cogitator;

    const defaultConfig: LearningConfig = {
      enabled: true,
      captureTraces: true,
      autoOptimize: false,
      maxDemosPerAgent: 5,
      minScoreForDemo: 0.8,
      defaultMetrics: ['success', 'tool_accuracy', 'efficiency'],
    };
    this.config = { ...defaultConfig, ...options.config };

    this.metricEvaluator = new MetricEvaluator({
      llm: this.llm,
      model: this.model,
    });

    this.demoSelector = new DemoSelector({
      traceStore: this.traceStore,
      maxDemos: this.config.maxDemosPerAgent,
      minScore: this.config.minScoreForDemo,
    });

    this.instructionOptimizer = new InstructionOptimizer({
      llm: this.llm,
      model: this.model,
      traceStore: this.traceStore,
      insightStore: this.insightStore,
    });
  }

  async captureTrace(
    runResult: RunResult,
    input: string,
    options?: { expected?: unknown; labels?: string[] }
  ): Promise<ExecutionTrace> {
    const trace = buildExecutionTrace(runResult, input, {
      model: this.model,
      expected: options?.expected,
      labels: options?.labels,
    });

    const evaluation = await this.metricEvaluator.evaluate(trace, options?.expected);
    trace.score = evaluation.score;
    trace.metrics.completeness =
      evaluation.results.find((r) => r.name === 'completeness')?.value ??
      trace.metrics.completeness;

    await this.traceStore.store(trace);

    return trace;
  }

  /**
   * Multi-round optimization of an agent's instructions and demos.
   *
   * With a `cogitator`, the trainset is run before and after optimizing: the
   * first runs score the original agent and become demo candidates, the last
   * runs score the optimized instructions. Without one, the score after is the
   * instruction optimizer's estimate on the stored traces.
   */
  async compile(
    agent: Agent,
    trainset: Array<{ input: string; expected?: unknown }>,
    options?: CompileOptions
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    const maxRounds = options?.maxRounds ?? 3;
    const maxBootstrappedDemos = options?.maxBootstrappedDemos ?? 5;

    const demosAdded: Demo[] = [];
    const demosRemoved: Demo[] = [];
    const errors: string[] = [];
    let tokensUsed = 0;
    let tracesEvaluated = 0;

    const runnable = this.runnableAgent(agent, trainset, errors);

    let scoreBefore: number;
    if (runnable) {
      const baseline = await this.runTrainset(runnable, trainset, errors);
      scoreBefore = baseline.score;
      tokensUsed += baseline.tokens;
      tracesEvaluated += baseline.traces;
    } else {
      const existing = await this.traceStore.getAll(agent.id);
      scoreBefore = averageScore(existing);
      tracesEvaluated += existing.length;
    }

    const instructionsBefore = agent.instructions;
    let currentInstructions = instructionsBefore;
    let estimatedImprovement = 0;

    for (let round = 0; round < maxRounds; round++) {
      const traces = await this.traceStore.getAll(agent.id);
      const highScoringTraces = traces
        .filter((t) => !t.isDemo && t.score >= (this.config.minScoreForDemo ?? 0.8))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxBootstrappedDemos);

      for (const trace of highScoringTraces) {
        try {
          demosAdded.push(await this.demoSelector.addDemo(trace));
        } catch (e) {
          errors.push(`Failed to add demo: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (options?.optimizeInstructions !== false) {
        try {
          const optimizationResult = await this.instructionOptimizer.optimize(
            agent.id,
            currentInstructions,
            { traces }
          );

          if (optimizationResult.improvement > 0) {
            currentInstructions = optimizationResult.optimizedInstructions;
            estimatedImprovement += optimizationResult.improvement;
          }
        } catch (e) {
          errors.push(
            `Instruction optimization failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }

    let scoreAfter: number;
    if (runnable && currentInstructions !== instructionsBefore) {
      const tuned = runnable.clone({ instructions: currentInstructions });
      const after =
        tuned instanceof CoreAgent ? await this.runTrainset(tuned, trainset, errors) : null;
      scoreAfter = after?.score ?? scoreBefore;
      tokensUsed += after?.tokens ?? 0;
      tracesEvaluated += after?.traces ?? 0;
    } else if (runnable) {
      scoreAfter = scoreBefore;
    } else {
      scoreAfter = Math.min(1, scoreBefore + estimatedImprovement);
    }

    const stats = this.optimizationRuns.get(agent.id) ?? {
      lastRun: new Date(),
      count: 0,
      totalImprovement: 0,
    };
    stats.lastRun = new Date();
    stats.count++;
    stats.totalImprovement += scoreAfter - scoreBefore;
    this.optimizationRuns.set(agent.id, stats);

    return {
      success: errors.length === 0,
      instructionsBefore,
      instructionsAfter: currentInstructions,
      demosAdded,
      demosRemoved,
      scoreBefore,
      scoreAfter,
      improvement: scoreAfter - scoreBefore,
      tracesEvaluated,
      bootstrapRounds: maxRounds,
      duration: Date.now() - startTime,
      tokensUsed,
      errors,
    };
  }

  private runnableAgent(
    agent: Agent,
    trainset: Array<{ input: string; expected?: unknown }>,
    errors: string[]
  ): CoreAgent | null {
    if (trainset.length === 0) return null;
    if (!this.cogitator) {
      errors.push(
        'compile() got a trainset but the optimizer has no cogitator to run it: pass `cogitator` to AgentOptimizer'
      );
      return null;
    }
    if (!(agent instanceof CoreAgent)) {
      errors.push('compile() can run a trainset only for agents created with `new Agent()`');
      return null;
    }
    return agent;
  }

  private async runTrainset(
    agent: CoreAgent,
    trainset: Array<{ input: string; expected?: unknown }>,
    errors: string[]
  ): Promise<{ score: number; tokens: number; traces: number }> {
    const scores: number[] = [];
    let tokens = 0;
    for (const example of trainset) {
      try {
        const result = await this.cogitator!.run(agent, { input: example.input });
        const trace = await this.captureTrace(result, example.input, {
          expected: example.expected,
          labels: ['compile'],
        });
        scores.push(trace.score);
        tokens += result.usage.totalTokens;
      } catch (e) {
        errors.push(
          `Trainset run failed for "${example.input.slice(0, 60)}": ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    const score = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    return { score, tokens, traces: scores.length };
  }

  async bootstrapDemos(agentId: string): Promise<Demo[]> {
    const traces = await this.traceStore.getDemos(agentId);
    const existingDemoCount = traces.length;

    if (existingDemoCount >= (this.config.maxDemosPerAgent ?? 5)) {
      return this.demoSelector.getAllDemos(agentId);
    }

    const allTraces = await this.traceStore.getAll(agentId);
    const candidates = allTraces
      .filter((t) => !t.isDemo && t.score >= (this.config.minScoreForDemo ?? 0.8))
      .sort((a, b) => b.score - a.score);

    const newDemos: Demo[] = [];
    const slotsAvailable = (this.config.maxDemosPerAgent ?? 5) - existingDemoCount;

    for (const trace of candidates.slice(0, slotsAvailable)) {
      try {
        const demo = await this.demoSelector.addDemo(trace);
        newDemos.push(demo);
      } catch {
        continue;
      }
    }

    return [...this.demoSelector.getAllDemos(agentId)];
  }

  async getDemosForPrompt(agentId: string, input: string, count?: number): Promise<Demo[]> {
    return this.demoSelector.selectDemos(agentId, input, count ?? 3);
  }

  formatDemosForPrompt(demos: Demo[]): string {
    return this.demoSelector.formatDemosForPrompt(demos);
  }

  async getStats(agentId: string): Promise<LearningStats> {
    const traceStats = await this.traceStore.getStats(agentId);
    const demoStats = await this.demoSelector.getDemoStats(agentId);
    const optimizationStats = this.optimizationRuns.get(agentId);

    return {
      traces: traceStats,
      demos: demoStats,
      optimization: {
        lastRun: optimizationStats?.lastRun,
        runsOptimized: optimizationStats?.count ?? 0,
        averageImprovement: optimizationStats
          ? optimizationStats.totalImprovement / optimizationStats.count
          : 0,
      },
    };
  }

  getTraceStore(): TraceStore {
    return this.traceStore;
  }

  getMetricEvaluator(): MetricEvaluator {
    return this.metricEvaluator;
  }

  getDemoSelector(): DemoSelector {
    return this.demoSelector;
  }

  getInstructionOptimizer(): InstructionOptimizer {
    return this.instructionOptimizer;
  }
}

function averageScore(traces: ReadonlyArray<{ score: number }>): number {
  return traces.length > 0 ? traces.reduce((sum, t) => sum + t.score, 0) / traces.length : 0;
}
