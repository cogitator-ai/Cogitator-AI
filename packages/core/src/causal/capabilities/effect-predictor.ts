import type {
  CausalGraph,
  CausalContext,
  PredictedEffect,
  CausalActionEvaluation,
  LLMBackend,
  ThoughtBranch,
} from '@cogitator-ai/types';
export interface EffectPredictorOptions {
  llmBackend: LLMBackend;
  model?: string;
  safetyThresholds?: {
    maxRisk: number;
    minConfidence: number;
  };
}

export class CausalEffectPredictor {
  private llm: LLMBackend;
  private model: string;
  private safetyThresholds: { maxRisk: number; minConfidence: number };

  constructor(options: EffectPredictorOptions) {
    this.llm = options.llmBackend;
    this.model = options.model ?? 'gpt-4';
    this.safetyThresholds = options.safetyThresholds ?? {
      maxRisk: 0.7,
      minConfidence: 0.3,
    };
  }

  async predictEffect(
    action: string,
    graph: CausalGraph,
    context: CausalContext
  ): Promise<PredictedEffect> {
    const relevantNodes = this.findRelevantNodes(action, graph);

    const directEffects = this.predictDirectEffects(action, relevantNodes, graph);

    const sideEffects = this.predictSideEffects(action, relevantNodes, graph, context);

    const llmEnhanced = await this.enhanceWithLLM(action, directEffects, sideEffects, context);

    return {
      action,
      effects: llmEnhanced.effects,
      sideEffects: llmEnhanced.sideEffects,
      confidence: llmEnhanced.confidence,
      reasoning: llmEnhanced.reasoning,
    };
  }

  async predictEffectsBatch(
    branches: ThoughtBranch[],
    graph: CausalGraph,
    context: CausalContext
  ): Promise<Map<string, PredictedEffect>> {
    const results = new Map<string, PredictedEffect>();

    const predictions = await Promise.all(
      branches.map(async (branch) => {
        const prediction = await this.predictEffect(branch.thought, graph, context);
        return { branchId: branch.id, prediction };
      })
    );

    for (const { branchId, prediction } of predictions) {
      results.set(branchId, prediction);
    }

    return results;
  }

  async evaluateSafety(
    action: string,
    graph: CausalGraph,
    context: CausalContext
  ): Promise<CausalActionEvaluation> {
    const prediction = await this.predictEffect(action, graph, context);

    const warnings: string[] = [];
    const recommendations: string[] = [];
    const blockedReasons: string[] = [];

    let riskScore = 0;

    for (const sideEffect of prediction.sideEffects) {
      if (sideEffect.unintended && sideEffect.probability > 0.5) {
        riskScore += sideEffect.probability * 0.3;
        warnings.push(
          `Potential unintended effect on ${sideEffect.variable} (${Math.round(sideEffect.probability * 100)}% probability)`
        );
      }
    }

    for (const effect of prediction.effects) {
      if (this.isNegativeOutcome(effect.variable, effect.expectedValue)) {
        riskScore += effect.probability * 0.5;
        warnings.push(`May cause negative outcome: ${effect.variable} = ${effect.expectedValue}`);
      }
    }

    let riskLevel: 'low' | 'medium' | 'high' | 'critical';
    if (riskScore < 0.2) {
      riskLevel = 'low';
    } else if (riskScore < 0.4) {
      riskLevel = 'medium';
    } else if (riskScore < 0.7) {
      riskLevel = 'high';
      recommendations.push('Consider alternative approaches');
    } else {
      riskLevel = 'critical';
      blockedReasons.push('Risk score exceeds safety threshold');
    }

    const isSafe =
      riskScore < this.safetyThresholds.maxRisk &&
      prediction.confidence >= this.safetyThresholds.minConfidence;

    if (!isSafe && blockedReasons.length === 0) {
      if (prediction.confidence < this.safetyThresholds.minConfidence) {
        warnings.push('Low confidence in effect prediction');
        recommendations.push('Gather more information before proceeding');
      }
    }

    return {
      action,
      isSafe,
      riskLevel,
      predictedEffects: prediction,
      warnings,
      recommendations,
      blockedReasons: blockedReasons.length > 0 ? blockedReasons : undefined,
    };
  }

  async whatIf(
    scenario: { action: string; conditions: Record<string, unknown> },
    graph: CausalGraph,
    context: CausalContext
  ): Promise<PredictedEffect[]> {
    const predictions: PredictedEffect[] = [];

    const baseContext: CausalContext = {
      ...context,
      observedVariables: {
        ...context.observedVariables,
        ...this.normalizeConditions(scenario.conditions),
      },
    };

    const mainPrediction = await this.predictEffect(scenario.action, graph, baseContext);
    predictions.push(mainPrediction);

    const relatedActions = this.findRelatedActions(scenario.action, graph);
    for (const relatedAction of relatedActions.slice(0, 3)) {
      const prediction = await this.predictEffect(relatedAction, graph, baseContext);
      predictions.push(prediction);
    }

    return predictions;
  }

  private findRelevantNodes(action: string, graph: CausalGraph): string[] {
    const nodes = graph.getNodes();
    const relevant: string[] = [];

    const actionWords = action.toLowerCase().split(/\s+/);

    for (const node of nodes) {
      const nodeWords = [node.id.toLowerCase(), node.name.toLowerCase()];

      for (const actionWord of actionWords) {
        for (const nodeWord of nodeWords) {
          if (nodeWord.includes(actionWord) || actionWord.includes(nodeWord)) {
            relevant.push(node.id);
            break;
          }
        }
      }
    }

    return [...new Set(relevant)];
  }

  private predictDirectEffects(
    _action: string,
    relevantNodes: string[],
    graph: CausalGraph
  ): Array<{
    variable: string;
    expectedValue: number | string | boolean;
    probability: number;
    mechanism: string;
  }> {
    const effects: Array<{
      variable: string;
      expectedValue: number | string | boolean;
      probability: number;
      mechanism: string;
    }> = [];

    for (const nodeId of relevantNodes) {
      const children = graph.getChildren(nodeId);

      for (const child of children) {
        const edge = graph.getEdgeBetween(nodeId, child.id);
        if (!edge) continue;

        let expectedValue: number | string | boolean;
        if (edge.relationType === 'causes' || edge.relationType === 'enables') {
          expectedValue = true;
        } else if (edge.relationType === 'prevents') {
          expectedValue = false;
        } else {
          expectedValue = edge.strength;
        }

        effects.push({
          variable: child.id,
          expectedValue,
          probability: edge.strength * edge.confidence,
          mechanism: edge.mechanism || `${nodeId} ${edge.relationType} ${child.id}`,
        });
      }
    }

    return effects;
  }

  private predictSideEffects(
    _action: string,
    relevantNodes: string[],
    graph: CausalGraph,
    _context: CausalContext
  ): Array<{
    variable: string;
    expectedValue: number | string | boolean;
    probability: number;
    unintended: boolean;
  }> {
    const sideEffects: Array<{
      variable: string;
      expectedValue: number | string | boolean;
      probability: number;
      unintended: boolean;
    }> = [];

    const directEffectNodes = new Set<string>();
    for (const nodeId of relevantNodes) {
      for (const child of graph.getChildren(nodeId)) {
        directEffectNodes.add(child.id);
      }
    }

    for (const nodeId of relevantNodes) {
      const descendants = graph.getDescendants(nodeId);

      for (const descendant of descendants) {
        if (directEffectNodes.has(descendant.id)) continue;

        const paths = graph.findPaths(nodeId, descendant.id);
        if (paths.length === 0) continue;

        const bestPath = paths.reduce((a, b) => (a.totalStrength > b.totalStrength ? a : b));

        sideEffects.push({
          variable: descendant.id,
          expectedValue: bestPath.totalStrength > 0.5,
          probability: bestPath.totalStrength * 0.8,
          unintended: true,
        });
      }
    }

    return sideEffects;
  }

  private async enhanceWithLLM(
    action: string,
    directEffects: Array<{
      variable: string;
      expectedValue: number | string | boolean;
      probability: number;
      mechanism: string;
    }>,
    sideEffects: Array<{
      variable: string;
      expectedValue: number | string | boolean;
      probability: number;
      unintended: boolean;
    }>,
    context: CausalContext
  ): Promise<PredictedEffect> {
    const prompt = `Analyze the predicted effects of this action and provide reasoning.

Action: ${action}

Direct effects predicted:
${directEffects.map((e) => `- ${e.variable}: ${e.expectedValue} (${Math.round(e.probability * 100)}% probability) via ${e.mechanism}`).join('\n')}

Side effects predicted:
${sideEffects.map((e) => `- ${e.variable}: ${e.expectedValue} (${Math.round(e.probability * 100)}% probability, ${e.unintended ? 'unintended' : 'intended'})`).join('\n')}

Current context:
- Agent: ${context.agentId}
- Observed: ${JSON.stringify(context.observedVariables)}

Provide:
1. Confidence in these predictions (0-1)
2. Reasoning for the predictions
3. Any additional effects not captured

Respond in JSON:
{
  "confidence": 0.75,
  "reasoning": "Explanation of the causal chain",
  "additionalEffects": []
}`;

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      });

      const match = /\{[\s\S]*\}/.exec(response.content);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          action,
          effects: directEffects,
          sideEffects,
          confidence: parsed.confidence ?? 0.5,
          reasoning: parsed.reasoning ?? 'No reasoning provided',
        };
      }
    } catch {}

    return {
      action,
      effects: directEffects,
      sideEffects,
      confidence: 0.5,
      reasoning: 'Based on causal graph analysis',
    };
  }

  private isNegativeOutcome(variable: string, value: unknown): boolean {
    const negativePatterns = ['error', 'fail', 'crash', 'loss', 'damage', 'risk'];
    const varLower = variable.toLowerCase();

    for (const pattern of negativePatterns) {
      if (varLower.includes(pattern)) {
        return value === true || (typeof value === 'number' && value > 0.5);
      }
    }

    return false;
  }

  private findRelatedActions(action: string, graph: CausalGraph): string[] {
    const nodes = graph.getNodes();
    const related: string[] = [];

    for (const node of nodes) {
      if (node.variableType === 'treatment' && !action.includes(node.id)) {
        related.push(`Apply ${node.name}`);
      }
    }

    return related;
  }

  private normalizeConditions(
    conditions: Record<string, unknown>
  ): Record<string, number | string | boolean> {
    const normalized: Record<string, number | string | boolean> = {};

    for (const [key, value] of Object.entries(conditions)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        normalized[key] = value;
      } else {
        normalized[key] = String(value);
      }
    }

    return normalized;
  }
}
