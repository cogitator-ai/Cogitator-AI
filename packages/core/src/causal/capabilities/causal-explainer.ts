import type {
  CausalGraph,
  CausalContext,
  CausalExplanation,
  RootCause,
  CausalPath,
  ExecutionTrace,
  ExecutionStep,
  LLMBackend,
} from '@cogitator-ai/types';
import { CounterfactualReasoner } from '../inference/counterfactual';
import { buildErrorCausalAnalysisPrompt, parseRootCauseResponse } from '../discovery/prompts';

export interface CausalExplainerOptions {
  llmBackend: LLMBackend;
  model?: string;
  maxRootCauses?: number;
  maxCounterfactuals?: number;
}

export class CausalExplainer {
  private llm: LLMBackend;
  private model: string;
  private maxRootCauses: number;
  private maxCounterfactuals: number;

  constructor(options: CausalExplainerOptions) {
    this.llm = options.llmBackend;
    this.model = options.model ?? 'gpt-4';
    this.maxRootCauses = options.maxRootCauses ?? 5;
    this.maxCounterfactuals = options.maxCounterfactuals ?? 3;
  }

  async explainCause(
    effect: string,
    effectValue: number | string | boolean,
    graph: CausalGraph,
    context: CausalContext
  ): Promise<CausalExplanation> {
    const rootCauses = this.findRootCauses(effect, graph, context);

    const contributingFactors = this.findContributingFactors(effect, graph);

    const counterfactuals = await this.generateCounterfactuals(effect, effectValue, graph, context);

    const summary = this.generateSummary(effect, effectValue, rootCauses);

    const confidence = this.calculateConfidence(rootCauses, contributingFactors);

    return {
      effect,
      effectValue,
      rootCauses,
      contributingFactors,
      counterfactuals,
      summary,
      confidence,
    };
  }

  async analyzeError(
    error: { message: string; stack?: string },
    trace: ExecutionTrace,
    _graph: CausalGraph,
    context: CausalContext
  ): Promise<CausalExplanation> {
    const recentActions = trace.steps.slice(-10).map((s) => this.describeStep(s));

    const prompt = buildErrorCausalAnalysisPrompt(error, trace, {
      recentActions,
      systemState: context.observedVariables,
    });

    const response = await this.llm.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const parsed = parseRootCauseResponse(response.content);

    if (!parsed) {
      return this.createBasicErrorExplanation(error, trace);
    }

    const rootCauses: RootCause[] = parsed.rootCauses.map((rc) => ({
      variable: rc.variable,
      contribution: rc.contribution,
      mechanism: rc.description,
      path: {
        nodes: [],
        edges: [],
        totalStrength: rc.contribution,
        isBlocked: false,
        blockingNodes: [],
      },
      confidence: rc.contribution,
      actionable: rc.actionable,
      suggestedIntervention: parsed.preventiveInterventions.find((p) => p.target === rc.variable)
        ?.action,
    }));

    const contributingFactors = parsed.causalChain.map((c) => ({
      variable: c.from,
      contribution: 0.5,
      direction: 'negative' as const,
    }));

    return {
      effect: 'error',
      effectValue: error.message,
      rootCauses,
      contributingFactors,
      counterfactuals: parsed.preventiveInterventions.map((p) => ({
        change: `${p.target}: ${p.action}`,
        wouldPrevent: true,
        confidence: 0.7,
      })),
      summary: parsed.reasoning,
      confidence: 0.7,
    };
  }

  async analyzeSuccess(
    outcome: string,
    trace: ExecutionTrace,
    graph: CausalGraph
  ): Promise<CausalExplanation> {
    const successfulSteps = trace.steps.filter((s) => this.isStepSuccessful(s));

    const rootCauses: RootCause[] = [];
    const contributingFactors: Array<{
      variable: string;
      contribution: number;
      direction: 'positive' | 'negative';
    }> = [];

    for (const step of successfulSteps.slice(-5)) {
      const stepDesc = this.describeStep(step);
      const relevantNodes = this.findRelevantNodes(stepDesc, graph);

      for (const nodeId of relevantNodes) {
        const paths = graph.findPaths(nodeId, outcome);
        if (paths.length > 0) {
          const bestPath = paths.reduce((a, b) => (a.totalStrength > b.totalStrength ? a : b));

          rootCauses.push({
            variable: nodeId,
            contribution: bestPath.totalStrength,
            mechanism: `${stepDesc} enabled ${outcome}`,
            path: bestPath,
            confidence: bestPath.totalStrength,
            actionable: true,
          });
        }
      }
    }

    rootCauses.sort((a, b) => b.contribution - a.contribution);

    return {
      effect: outcome,
      effectValue: true,
      rootCauses: rootCauses.slice(0, this.maxRootCauses),
      contributingFactors,
      counterfactuals: [],
      summary: `Success achieved through ${rootCauses.length} contributing factors`,
      confidence: 0.7,
    };
  }

  private findRootCauses(effect: string, graph: CausalGraph, context: CausalContext): RootCause[] {
    const rootCauses: RootCause[] = [];

    const effectNode = graph.getNode(effect);
    if (!effectNode) {
      return rootCauses;
    }

    const ancestors = graph.getAncestors(effect);

    const rootNodes = ancestors.filter((ancestor) => {
      const parents = graph.getParents(ancestor.id);
      return parents.length === 0;
    });

    for (const root of rootNodes) {
      const paths = graph.findPaths(root.id, effect);
      if (paths.length === 0) continue;

      const bestPath = paths.reduce((a, b) => (a.totalStrength > b.totalStrength ? a : b));

      const isObserved = context.observedVariables[root.id] !== undefined;

      rootCauses.push({
        variable: root.id,
        contribution: bestPath.totalStrength,
        mechanism: this.describeMechanism(bestPath),
        path: bestPath,
        confidence: isObserved ? 0.9 : 0.6,
        actionable: root.variableType === 'treatment' || root.variableType === 'observed',
        suggestedIntervention: this.suggestIntervention(root.id, bestPath, graph),
      });
    }

    rootCauses.sort((a, b) => b.contribution - a.contribution);

    return rootCauses.slice(0, this.maxRootCauses);
  }

  private findContributingFactors(
    effect: string,
    graph: CausalGraph
  ): Array<{ variable: string; contribution: number; direction: 'positive' | 'negative' }> {
    const factors: Array<{
      variable: string;
      contribution: number;
      direction: 'positive' | 'negative';
    }> = [];

    const parents = graph.getParents(effect);

    for (const parent of parents) {
      const edge = graph.getEdgeBetween(parent.id, effect);
      if (!edge) continue;

      let direction: 'positive' | 'negative';
      if (edge.relationType === 'causes' || edge.relationType === 'enables') {
        direction = 'positive';
      } else if (edge.relationType === 'prevents') {
        direction = 'negative';
      } else {
        direction = edge.strength > 0 ? 'positive' : 'negative';
      }

      factors.push({
        variable: parent.id,
        contribution: Math.abs(edge.strength),
        direction,
      });
    }

    factors.sort((a, b) => b.contribution - a.contribution);

    return factors;
  }

  private async generateCounterfactuals(
    effect: string,
    effectValue: number | string | boolean,
    graph: CausalGraph,
    context: CausalContext
  ): Promise<Array<{ change: string; wouldPrevent: boolean; confidence: number }>> {
    const counterfactuals: Array<{
      change: string;
      wouldPrevent: boolean;
      confidence: number;
    }> = [];

    const parents = graph.getParents(effect);
    const reasoner = new CounterfactualReasoner();

    for (const parent of parents.slice(0, this.maxCounterfactuals)) {
      const edge = graph.getEdgeBetween(parent.id, effect);
      if (!edge) continue;

      const currentValue = context.observedVariables[parent.id];
      const alternativeValue = this.getAlternativeValue(currentValue);

      const result = reasoner.evaluate(graph, {
        target: effect,
        intervention: { [parent.id]: alternativeValue },
        factual: context.observedVariables,
        question: `What if ${parent.id} was ${alternativeValue}?`,
      });

      const wouldPrevent = result.counterfactualValue !== effectValue;

      counterfactuals.push({
        change: `If ${parent.id} was ${alternativeValue} instead of ${currentValue}`,
        wouldPrevent,
        confidence: edge.confidence,
      });
    }

    return counterfactuals;
  }

  private generateSummary(
    effect: string,
    effectValue: number | string | boolean,
    rootCauses: RootCause[]
  ): string {
    if (rootCauses.length === 0) {
      return `Unable to determine root causes for ${effect} = ${effectValue}`;
    }

    const topCause = rootCauses[0];
    const otherCauses = rootCauses.slice(1, 3);

    let summary = `The primary cause of ${effect} = ${effectValue} is ${topCause.variable} (${Math.round(topCause.contribution * 100)}% contribution)`;

    if (topCause.mechanism) {
      summary += ` through ${topCause.mechanism}`;
    }

    if (otherCauses.length > 0) {
      summary += `. Contributing factors include ${otherCauses.map((c) => c.variable).join(', ')}`;
    }

    if (topCause.suggestedIntervention) {
      summary += `. To change this outcome, consider: ${topCause.suggestedIntervention}`;
    }

    return summary;
  }

  private calculateConfidence(
    rootCauses: RootCause[],
    contributingFactors: Array<{ variable: string; contribution: number; direction: string }>
  ): number {
    if (rootCauses.length === 0) return 0.1;

    const avgRootCauseConfidence =
      rootCauses.reduce((sum, rc) => sum + rc.confidence, 0) / rootCauses.length;

    const totalContribution = contributingFactors.reduce((sum, f) => sum + f.contribution, 0);
    const contributionFactor = Math.min(1, totalContribution);

    return avgRootCauseConfidence * 0.7 + contributionFactor * 0.3;
  }

  private describeMechanism(path: CausalPath): string {
    if (path.nodes.length <= 2) {
      const edge = path.edges[0];
      return edge?.mechanism || 'Direct causal relationship';
    }

    const steps = path.edges.map((edge) => {
      return `${edge.source} ${edge.relationType} ${edge.target}`;
    });

    return `Causal chain: ${steps.join(' → ')}`;
  }

  private suggestIntervention(
    variable: string,
    path: CausalPath,
    graph: CausalGraph
  ): string | undefined {
    const node = graph.getNode(variable);
    if (!node) return undefined;

    if (node.variableType === 'treatment') {
      return `Modify ${variable} to change the outcome`;
    }

    if (node.variableType === 'confounder') {
      return `Control for ${variable} to eliminate confounding`;
    }

    if (path.edges.length > 0) {
      const firstEdge = path.edges[0];
      if (firstEdge.relationType === 'prevents') {
        return `Enable ${variable} to prevent the effect`;
      }
      return `Adjust ${variable} to modify the causal pathway`;
    }

    return undefined;
  }

  private getAlternativeValue(currentValue: unknown): number | string | boolean {
    if (typeof currentValue === 'boolean') {
      return !currentValue;
    }
    if (typeof currentValue === 'number') {
      return currentValue === 0 ? 1 : 0;
    }
    return 'alternative';
  }

  private findRelevantNodes(description: string, graph: CausalGraph): string[] {
    const nodes = graph.getNodes();
    const relevant: string[] = [];
    const descLower = description.toLowerCase();

    for (const node of nodes) {
      if (
        descLower.includes(node.id.toLowerCase()) ||
        descLower.includes(node.name.toLowerCase())
      ) {
        relevant.push(node.id);
      }
    }

    return relevant;
  }

  private describeStep(step: ExecutionStep): string {
    if (step.toolCall) {
      return `${step.toolCall.name}(${JSON.stringify(step.toolCall.arguments)})`;
    }
    if (step.response) {
      return step.response.substring(0, 100);
    }
    return `step-${step.type}-${step.index}`;
  }

  private isStepSuccessful(step: ExecutionStep): boolean {
    if (step.toolResult) {
      return !step.toolResult.error;
    }
    return step.response !== undefined;
  }

  private createBasicErrorExplanation(
    error: { message: string; stack?: string },
    trace: ExecutionTrace
  ): CausalExplanation {
    const failedStep = trace.steps.find((s) => !this.isStepSuccessful(s));

    return {
      effect: 'error',
      effectValue: error.message,
      rootCauses: failedStep
        ? [
            {
              variable: 'failed_step',
              contribution: 1,
              mechanism: `Step "${this.describeStep(failedStep)}" failed`,
              path: { nodes: [], edges: [], totalStrength: 1, isBlocked: false, blockingNodes: [] },
              confidence: 0.5,
              actionable: true,
              suggestedIntervention: 'Review and fix the failed step',
            },
          ]
        : [],
      contributingFactors: [],
      counterfactuals: [],
      summary: `Error occurred: ${error.message}`,
      confidence: 0.3,
    };
  }
}
