import { nanoid } from 'nanoid';
import type {
  ExecutionTrace,
  ExecutionStep,
  TraceStore,
  TraceMetrics,
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

  private optimizationRuns = new Map<string, { lastRun: Date; count: number; totalImprovement: number }>();

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
    const steps = this.extractSteps(runResult);

    const metrics = this.computeQuickMetrics(runResult, steps);

    const trace: ExecutionTrace = {
      id: `trace_${nanoid(12)}`,
      runId: runResult.runId,
      agentId: runResult.agentId,
      threadId: runResult.threadId,
      input,
      output: runResult.output,
      steps,
      toolCalls: [...runResult.toolCalls],
      reflections: runResult.reflections ? [...runResult.reflections] : [],
      metrics,
      score: 0,
      model: '',
      createdAt: new Date(),
      duration: runResult.usage.duration,
      usage: {
        inputTokens: runResult.usage.inputTokens,
        outputTokens: runResult.usage.outputTokens,
        cost: runResult.usage.cost,
      },
      labels: options?.labels,
      isDemo: false,
      expected: options?.expected,
    };

    const evaluation = await this.metricEvaluator.evaluate(trace, options?.expected);
    trace.score = evaluation.score;
    trace.metrics.completeness = evaluation.results.find(r => r.name === 'completeness')?.value ?? metrics.completeness;

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
    let tokensUsed = 0;

    const existingTraces = await this.traceStore.getAll(agent.id);
    const scoreBefore = existingTraces.length > 0
      ? existingTraces.reduce((sum, t) => sum + t.score, 0) / existingTraces.length
      : 0;

    const instructionsBefore = agent.instructions;
    let currentInstructions = instructionsBefore;

    for (let round = 0; round < maxRounds; round++) {
      const highScoringTraces = existingTraces
        .filter(t => t.score >= (this.config.minScoreForDemo ?? 0.8))
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
          errors.push(`Instruction optimization failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const allTraces = await this.traceStore.getAll(agent.id);
    const scoreAfter = allTraces.length > 0
      ? allTraces.reduce((sum, t) => sum + t.score, 0) / allTraces.length
      : 0;

    const stats = this.optimizationRuns.get(agent.id) ?? { lastRun: new Date(), count: 0, totalImprovement: 0 };
    stats.lastRun = new Date();
    stats.count++;
    stats.totalImprovement += (scoreAfter - scoreBefore);
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
      tokensUsed,
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
      .filter(t => !t.isDemo && t.score >= (this.config.minScoreForDemo ?? 0.8))
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

  async getDemosForPrompt(
    agentId: string,
    input: string,
    count?: number
  ): Promise<Demo[]> {
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

  private extractSteps(runResult: RunResult): ExecutionStep[] {
    const steps: ExecutionStep[] = [];
    let index = 0;

    for (const span of runResult.trace.spans) {
      if (span.name.includes('tool_call') || span.attributes?.toolName) {
        const toolCall = runResult.toolCalls.find(
          tc => tc.name === span.attributes?.toolName
        );

        steps.push({
          index: index++,
          type: 'tool_call',
          timestamp: span.startTime,
          duration: span.duration,
          toolCall,
          toolResult: toolCall ? {
            callId: toolCall.id,
            name: toolCall.name,
            result: span.attributes?.result,
            error: span.status === 'error' ? String(span.attributes?.error ?? 'Unknown error') : undefined,
          } : undefined,
        });
      } else if (span.name.includes('llm') || span.name.includes('chat')) {
        steps.push({
          index: index++,
          type: 'llm_call',
          timestamp: span.startTime,
          duration: span.duration,
          tokensUsed: {
            input: Number(span.attributes?.inputTokens ?? 0),
            output: Number(span.attributes?.outputTokens ?? 0),
          },
        });
      }
    }

    if (runResult.reflections) {
      for (const reflection of runResult.reflections) {
        steps.push({
          index: index++,
          type: 'reflection',
          timestamp: reflection.timestamp.getTime(),
          duration: 0,
          reflection,
        });
      }
    }

    steps.sort((a, b) => a.timestamp - b.timestamp);
    return steps;
  }

  private computeQuickMetrics(runResult: RunResult, steps: ExecutionStep[]): TraceMetrics {
    const toolSteps = steps.filter(s => s.type === 'tool_call');
    const successfulTools = toolSteps.filter(s => !s.toolResult?.error);

    const hasErrors = steps.some(s => s.toolResult?.error);
    const toolAccuracy = toolSteps.length > 0
      ? successfulTools.length / toolSteps.length
      : 1;

    const totalTokens = runResult.usage.inputTokens + runResult.usage.outputTokens;
    const efficiency = Math.min(1, 10000 / Math.max(totalTokens, 1));

    const completeness = runResult.output.length > 50 ? 0.8 : 0.5;

    return {
      success: !hasErrors,
      toolAccuracy,
      efficiency,
      completeness,
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
