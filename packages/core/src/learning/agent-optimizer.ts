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
import { MetricEvaluator } from './metrics';
import { DemoSelector } from './demo-selector';
import { InstructionOptimizer } from './instruction-optimizer';

export interface AgentOptimizerOptions {
  llm: LLMBackend;
  model: string;
  traceStore?: TraceStore;
  insightStore?: InsightStore;
  config?: Partial<LearningConfig>;
}

export class AgentOptimizer {
  private llm: LLMBackend;
  private model: string;
  private traceStore: TraceStore;
  private insightStore?: InsightStore;
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

  async compile(
    agent: Agent,
    _trainset: Array<{ input: string; expected?: unknown }>,
    options?: CompileOptions
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    const maxRounds = options?.maxRounds ?? 3;
    const maxBootstrappedDemos = options?.maxBootstrappedDemos ?? 5;

    const demosAdded: Demo[] = [];
    const demosRemoved: Demo[] = [];
    const errors: string[] = [];

    const existingTraces = await this.traceStore.getAll(agent.id);
    const scoreBefore =
      existingTraces.length > 0
        ? existingTraces.reduce((sum, t) => sum + t.score, 0) / existingTraces.length
        : 0;

    const instructionsBefore = agent.instructions;
    let currentInstructions = instructionsBefore;

    for (let round = 0; round < maxRounds; round++) {
      const highScoringTraces = existingTraces
        .filter((t) => t.score >= (this.config.minScoreForDemo ?? 0.8))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxBootstrappedDemos);

      for (const trace of highScoringTraces) {
        if (!trace.isDemo) {
          try {
            const demo = await this.demoSelector.addDemo(trace);
            demosAdded.push(demo);
          } catch (e) {
            errors.push(`Failed to add demo: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      if (options?.optimizeInstructions !== false) {
        try {
          const optimizationResult = await this.instructionOptimizer.optimize(
            agent.id,
            currentInstructions
          );

          if (optimizationResult.improvement > 0) {
            currentInstructions = optimizationResult.optimizedInstructions;
          }
        } catch (e) {
          errors.push(
            `Instruction optimization failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }

    const allTraces = await this.traceStore.getAll(agent.id);
    const scoreAfter =
      allTraces.length > 0 ? allTraces.reduce((sum, t) => sum + t.score, 0) / allTraces.length : 0;

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
      tracesEvaluated: existingTraces.length,
      bootstrapRounds: maxRounds,
      duration: Date.now() - startTime,
      tokensUsed: 0,
      errors,
    };
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
