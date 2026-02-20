import type {
  CausalGraph,
  CausalContext,
  CausalReasoningConfig,
  CausalReasonerStats,
  PredictedEffect,
  CausalExplanation,
  CausalPlan,
  CausalActionEvaluation,
  CausalHypothesis,
  CausalPattern,
  InterventionRecord,
  ExecutionTrace,
  ExecutionStep,
  ToolCall,
  ThoughtBranch,
  LLMBackend,
} from '@cogitator-ai/types';
import { DEFAULT_CAUSAL_CONFIG } from '@cogitator-ai/types';
import { CausalGraphImpl } from './graph/causal-graph';
import { CausalGraphBuilder } from './graph/graph-builder';
import { CausalExtractor } from './discovery/causal-extractor';
import { CausalHypothesisGenerator } from './discovery/hypothesis-generator';
import { CausalValidator, ValidationContext } from './discovery/causal-validator';
import { CausalEffectPredictor } from './capabilities/effect-predictor';
import { CausalExplainer } from './capabilities/causal-explainer';
import { CausalPlanner } from './capabilities/causal-planner';
import { InMemoryCausalGraphStore } from './stores/causal-graph-store';
import { InMemoryCausalPatternStore } from './stores/causal-pattern-store';
import { InMemoryInterventionLog } from './stores/intervention-log';

export interface CausalReasonerOptions {
  llmBackend: LLMBackend;
  model?: string;
  config?: Partial<CausalReasoningConfig>;
  graphStore?: InMemoryCausalGraphStore;
  patternStore?: InMemoryCausalPatternStore;
  interventionLog?: InMemoryInterventionLog;
}

let patternIdCounter = 0;
let interventionIdCounter = 0;

export class CausalReasoner {
  private config: CausalReasoningConfig;
  private llm: LLMBackend;

  private graphs = new Map<string, CausalGraph>();
  private graphStore: InMemoryCausalGraphStore;
  private patternStore: InMemoryCausalPatternStore;
  private interventionLog: InMemoryInterventionLog;

  private extractor: CausalExtractor;
  private hypothesisGenerator: CausalHypothesisGenerator;
  private validator: CausalValidator;
  private effectPredictor: CausalEffectPredictor;
  private explainer: CausalExplainer;
  private planner: CausalPlanner;

  private stats: CausalReasonerStats = {
    graphNodes: 0,
    graphEdges: 0,
    hypothesesPending: 0,
    hypothesesValidated: 0,
    hypothesesRejected: 0,
    patternsStored: 0,
    interventionsLogged: 0,
    predictionsAccuracy: 0,
    explanationsGenerated: 0,
    plansGenerated: 0,
  };

  constructor(options: CausalReasonerOptions) {
    this.llm = options.llmBackend;
    this.config = { ...DEFAULT_CAUSAL_CONFIG, ...options.config };

    this.graphStore = options.graphStore ?? new InMemoryCausalGraphStore();
    this.patternStore = options.patternStore ?? new InMemoryCausalPatternStore();
    this.interventionLog = options.interventionLog ?? new InMemoryInterventionLog();

    const model = options.model;

    this.extractor = new CausalExtractor({
      llmBackend: this.llm,
      model,
      minConfidence: this.config.minEdgeConfidence,
      minStrength: this.config.minEdgeStrength,
      batchSize: this.config.discoveryBatchSize,
    });

    this.hypothesisGenerator = new CausalHypothesisGenerator({
      llmBackend: this.llm,
      model,
    });

    this.validator = new CausalValidator({
      llmBackend: this.llm,
      model,
      validationThreshold: this.config.hypothesisValidationThreshold,
    });

    this.effectPredictor = new CausalEffectPredictor({
      llmBackend: this.llm,
      model,
    });

    this.explainer = new CausalExplainer({
      llmBackend: this.llm,
      model,
    });

    this.planner = new CausalPlanner({
      llmBackend: this.llm,
      model,
    });
  }

  async predictEffect(
    action: string,
    agentId: string,
    context?: Partial<CausalContext>
  ): Promise<PredictedEffect> {
    const graph = await this.getOrCreateGraph(agentId);
    const fullContext = this.buildContext(agentId, context);

    return this.effectPredictor.predictEffect(action, graph, fullContext);
  }

  async explainCause(
    effect: string,
    effectValue: number | string | boolean,
    agentId: string,
    context?: Partial<CausalContext>
  ): Promise<CausalExplanation> {
    const graph = await this.getOrCreateGraph(agentId);
    const fullContext = this.buildContext(agentId, context);

    const explanation = await this.explainer.explainCause(effect, effectValue, graph, fullContext);

    this.stats.explanationsGenerated++;
    return explanation;
  }

  async planForGoal(
    goal: string,
    goalValue: number | string | boolean,
    agentId: string,
    context?: Partial<CausalContext>,
    constraints?: { forbidden?: string[]; required?: string[] }
  ): Promise<CausalPlan> {
    const graph = await this.getOrCreateGraph(agentId);
    const fullContext = this.buildContext(agentId, context);

    const plan = await this.planner.planForGoal(goal, goalValue, graph, fullContext, constraints);

    this.stats.plansGenerated++;
    return plan;
  }

  async evaluateToolCall(
    toolCall: ToolCall,
    agentId: string,
    context?: Partial<CausalContext>
  ): Promise<CausalActionEvaluation> {
    if (!this.config.enableSafetyChecks) {
      return {
        action: toolCall.name,
        isSafe: true,
        riskLevel: 'low',
        predictedEffects: {
          action: toolCall.name,
          effects: [],
          sideEffects: [],
          confidence: 0,
          reasoning: 'Safety checks disabled',
        },
        warnings: [],
        recommendations: [],
      };
    }

    const graph = await this.getOrCreateGraph(agentId);
    const fullContext = this.buildContext(agentId, context);

    const action = `${toolCall.name}(${JSON.stringify(toolCall.arguments)})`;
    return this.effectPredictor.evaluateSafety(action, graph, fullContext);
  }

  async scoreBranch(
    branch: ThoughtBranch,
    agentId: string,
    context?: Partial<CausalContext>
  ): Promise<number> {
    const graph = await this.getOrCreateGraph(agentId);
    const fullContext = this.buildContext(agentId, context);

    const prediction = await this.effectPredictor.predictEffect(branch.thought, graph, fullContext);

    let score = prediction.confidence;

    for (const effect of prediction.effects) {
      score += effect.probability * 0.2;
    }

    for (const sideEffect of prediction.sideEffects) {
      if (sideEffect.unintended) {
        score -= sideEffect.probability * 0.3;
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  async analyzeErrorCausally(
    error: { message: string; stack?: string },
    trace: ExecutionTrace,
    agentId: string,
    context?: Partial<CausalContext>
  ): Promise<CausalExplanation> {
    const graph = await this.getOrCreateGraph(agentId);
    const fullContext = this.buildContext(agentId, context);

    return this.explainer.analyzeError(error, trace, graph, fullContext);
  }

  async learnFromTrace(
    trace: ExecutionTrace,
    agentId: string
  ): Promise<{ nodesAdded: number; edgesAdded: number; patternsFound: number }> {
    if (!this.config.enableLLMDiscovery) {
      return { nodesAdded: 0, edgesAdded: 0, patternsFound: 0 };
    }

    const graph = await this.getOrCreateGraph(agentId);

    const extracted = await this.extractor.extractFromTrace(trace, graph);

    for (const node of extracted.nodes) {
      if (!graph.hasNode(node.id)) {
        graph.addNode(node);
      }
    }

    for (const edge of extracted.edges) {
      if (!graph.getEdgeBetween(edge.source, edge.target)) {
        graph.addEdge(edge);
      }
    }

    const patterns = this.extractPatterns(trace, agentId);
    for (const pattern of patterns) {
      await this.patternStore.save(pattern);
    }

    this.stats.graphNodes = graph.getNodes().length;
    this.stats.graphEdges = graph.getEdges().length;
    this.stats.patternsStored += patterns.length;

    await this.saveGraph(agentId);

    return {
      nodesAdded: extracted.nodes.length,
      edgesAdded: extracted.edges.length,
      patternsFound: patterns.length,
    };
  }

  async learnFromIntervention(
    intervention: Record<string, number | string | boolean>,
    observedBefore: Record<string, number | string | boolean>,
    observedAfter: Record<string, number | string | boolean>,
    expectedEffect: PredictedEffect,
    success: boolean,
    agentId: string,
    traceId?: string
  ): Promise<void> {
    const record: InterventionRecord = {
      id: `intervention-${++interventionIdCounter}-${Date.now()}`,
      agentId,
      intervention,
      observedBefore,
      observedAfter,
      expectedEffect,
      actualEffect: observedAfter,
      success,
      timestamp: Date.now(),
      traceId,
    };

    await this.interventionLog.log(record);
    this.stats.interventionsLogged++;

    const graph = await this.getOrCreateGraph(agentId);

    for (const [variable, _] of Object.entries(intervention)) {
      for (const [outcome, afterValue] of Object.entries(observedAfter)) {
        const beforeValue = observedBefore[outcome];
        if (beforeValue !== afterValue) {
          const existingEdge = graph.getEdgeBetween(variable, outcome);
          if (existingEdge) {
            const newConfidence = success
              ? Math.min(1, existingEdge.confidence + 0.1)
              : Math.max(0.1, existingEdge.confidence - 0.1);

            graph.removeEdge(existingEdge.id);
            graph.addEdge({
              ...existingEdge,
              confidence: newConfidence,
            });
          }
        }
      }
    }

    await this.saveGraph(agentId);
  }

  async generateHypotheses(agentId: string, goal?: string): Promise<CausalHypothesis[]> {
    const patterns = await this.patternStore.findRelevant(agentId, {}, 20);

    const traces: ExecutionTrace[] = [];

    const hypotheses = await this.hypothesisGenerator.generateHypotheses(patterns, traces, {
      agentId,
      goal,
    });

    this.stats.hypothesesPending += hypotheses.length;

    return hypotheses;
  }

  async validateHypothesis(
    hypothesis: CausalHypothesis,
    context: ValidationContext
  ): Promise<{
    validated: boolean;
    adjustedStrength: number;
    adjustedConfidence: number;
  }> {
    const result = await this.validator.validateHypothesis(hypothesis, context);

    if (result.validated) {
      this.stats.hypothesesValidated++;
      this.stats.hypothesesPending--;

      const graph = await this.getOrCreateGraph(hypothesis.id.split('-')[0]);
      if (!graph.hasNode(hypothesis.cause)) {
        graph.addNode({
          id: hypothesis.cause,
          name: hypothesis.cause,
          variableType: 'observed',
        });
      }
      if (!graph.hasNode(hypothesis.effect)) {
        graph.addNode({
          id: hypothesis.effect,
          name: hypothesis.effect,
          variableType: 'observed',
        });
      }
      if (!graph.getEdgeBetween(hypothesis.cause, hypothesis.effect)) {
        graph.addEdge({
          id: `edge-validated-${Date.now()}`,
          source: hypothesis.cause,
          target: hypothesis.effect,
          relationType: hypothesis.relationType,
          strength: result.adjustedStrength,
          confidence: result.adjustedConfidence,
        });
      }
    } else {
      this.stats.hypothesesRejected++;
      this.stats.hypothesesPending--;
    }

    return {
      validated: result.validated,
      adjustedStrength: result.adjustedStrength,
      adjustedConfidence: result.adjustedConfidence,
    };
  }

  async getGraph(agentId: string): Promise<CausalGraph> {
    return this.getOrCreateGraph(agentId);
  }

  async saveGraph(agentId: string): Promise<void> {
    const graph = this.graphs.get(agentId);
    if (graph) {
      const data = graph.toData();
      data.metadata = { ...data.metadata, agentId };
      await this.graphStore.save(data);
    }
  }

  async loadGraph(agentId: string): Promise<CausalGraph | null> {
    const data = await this.graphStore.loadForAgent(agentId);
    if (data) {
      const graph = CausalGraphImpl.fromData(data);
      this.graphs.set(agentId, graph);
      return graph;
    }
    return null;
  }

  getStats(): CausalReasonerStats {
    return { ...this.stats };
  }

  getConfig(): CausalReasoningConfig {
    return { ...this.config };
  }

  private async getOrCreateGraph(agentId: string): Promise<CausalGraph> {
    let graph = this.graphs.get(agentId);

    if (!graph) {
      graph = (await this.loadGraph(agentId)) ?? undefined;
    }

    if (!graph) {
      graph = CausalGraphBuilder.create(`${agentId}-causal-graph`).build();
      this.graphs.set(agentId, graph);
    }

    return graph;
  }

  private buildContext(agentId: string, partial?: Partial<CausalContext>): CausalContext {
    return {
      agentId,
      taskId: partial?.taskId,
      observedVariables: partial?.observedVariables ?? {},
      activeInterventions: partial?.activeInterventions ?? {},
      recentPatterns: partial?.recentPatterns ?? [],
      timestamp: Date.now(),
    };
  }

  private extractPatterns(trace: ExecutionTrace, agentId: string): CausalPattern[] {
    const patterns: CausalPattern[] = [];

    for (let i = 0; i < trace.steps.length - 1; i++) {
      const current = trace.steps[i];
      const next = trace.steps[i + 1];

      if (this.isStepSuccessful(current) && this.isStepSuccessful(next)) {
        patterns.push({
          id: `pattern-${++patternIdCounter}-${Date.now()}`,
          agentId,
          pattern: {
            trigger: this.describeStep(current),
            effect: this.describeStep(next),
            conditions: [],
          },
          occurrences: 1,
          successRate: 1,
          avgStrength: 0.5,
          lastSeen: Date.now(),
          createdAt: Date.now(),
        });
      }
    }

    return patterns;
  }

  private describeStep(step: ExecutionStep): string {
    if (step.toolCall) {
      return `${step.toolCall.name}(${JSON.stringify(step.toolCall.arguments)})`;
    }
    return step.type;
  }

  private isStepSuccessful(step: ExecutionStep): boolean {
    return !step.toolResult?.error;
  }
}
