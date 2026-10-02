import type {
  CausalGraph,
  CausalContext,
  CausalPlan,
  CausalPlanStep,
  LLMBackend,
} from '@cogitator-ai/types';
import { CausalEffectPredictor } from './effect-predictor';

export interface CausalPlannerOptions {
  llmBackend: LLMBackend;
  model?: string;
  maxPlanSteps?: number;
  maxAlternatives?: number;
  robustnessThreshold?: number;
}

export class CausalPlanner {
  private llm: LLMBackend;
  private model: string;
  private effectPredictor: CausalEffectPredictor;
  private maxPlanSteps: number;
  private maxAlternatives: number;
  private robustnessThreshold: number;

  constructor(options: CausalPlannerOptions) {
    this.llm = options.llmBackend;
    this.model = options.model ?? 'gpt-6.1-sol';
    this.effectPredictor = new CausalEffectPredictor({ llmBackend: options.llmBackend });
    this.maxPlanSteps = options.maxPlanSteps ?? 10;
    this.maxAlternatives = options.maxAlternatives ?? 2;
    this.robustnessThreshold = options.robustnessThreshold ?? 0.6;
  }

  async planForGoal(
    goal: string,
    goalValue: number | string | boolean,
    graph: CausalGraph,
    context: CausalContext,
    constraints?: { forbidden?: string[]; required?: string[]; maxCost?: number }
  ): Promise<CausalPlan> {
    const interventions = this.findInterventions(goal, goalValue, graph, context);

    const filteredInterventions = this.applyConstraints(interventions, constraints);

    const steps = await this.buildPlanSteps(filteredInterventions, graph, context);

    const robustness = await this.analyzeRobustness(steps, graph, context);

    const expectedOutcome = this.calculateExpectedOutcome(steps);

    const reasoning = await this.generatePlanReasoning(goal, goalValue, steps, context);

    return {
      goal,
      goalValue,
      steps,
      expectedOutcome,
      robustness,
      estimatedCost: this.estimateCost(steps),
      reasoning,
    };
  }

  findInterventions(
    target: string,
    targetValue: number | string | boolean,
    graph: CausalGraph,
    _context: CausalContext
  ): Array<{ variable: string; value: unknown; effectiveness: number }> {
    const interventions: Array<{
      variable: string;
      value: unknown;
      effectiveness: number;
    }> = [];

    const parents = graph.getParents(target);

    for (const parent of parents) {
      const edge = graph.getEdgeBetween(parent.id, target);
      if (!edge) continue;

      let interventionValue: unknown;
      if (edge.relationType === 'causes' || edge.relationType === 'enables') {
        interventionValue = typeof targetValue === 'boolean' ? targetValue : 1;
      } else if (edge.relationType === 'prevents') {
        interventionValue = typeof targetValue === 'boolean' ? !targetValue : 0;
      } else {
        interventionValue = 1;
      }

      interventions.push({
        variable: parent.id,
        value: interventionValue,
        effectiveness: edge.strength * edge.confidence,
      });
    }

    const ancestors = graph.getAncestors(target);
    for (const ancestor of ancestors) {
      if (parents.some((p) => p.id === ancestor.id)) continue;

      const paths = graph.findPaths(ancestor.id, target);
      if (paths.length === 0) continue;

      const bestPath = paths.reduce((a, b) => (a.totalStrength > b.totalStrength ? a : b));

      if (bestPath.totalStrength > 0.3) {
        interventions.push({
          variable: ancestor.id,
          value: 1,
          effectiveness: bestPath.totalStrength * 0.8,
        });
      }
    }

    interventions.sort((a, b) => b.effectiveness - a.effectiveness);

    return interventions;
  }

  async reverseEngineer(
    desiredOutcome: Record<string, number | string | boolean>,
    graph: CausalGraph,
    context: CausalContext
  ): Promise<CausalPlan[]> {
    const plans: CausalPlan[] = [];

    for (const [outcome, value] of Object.entries(desiredOutcome)) {
      const plan = await this.planForGoal(outcome, value, graph, context);
      plans.push(plan);
    }

    plans.sort((a, b) => b.expectedOutcome.probability - a.expectedOutcome.probability);

    return plans;
  }

  async analyzeRobustness(
    steps: CausalPlanStep[],
    graph: CausalGraph,
    _context: CausalContext
  ): Promise<{
    score: number;
    vulnerabilities: string[];
    backupPlans: CausalPlan[];
  }> {
    const vulnerabilities: string[] = [];
    let robustnessScore = 1.0;

    for (const step of steps) {
      if (step.expectedEffect.confidence < this.robustnessThreshold) {
        vulnerabilities.push(
          `Step ${step.order}: Low confidence (${Math.round(step.expectedEffect.confidence * 100)}%)`
        );
        robustnessScore *= step.expectedEffect.confidence;
      }

      for (const sideEffect of step.expectedEffect.sideEffects) {
        if (sideEffect.unintended && sideEffect.probability > 0.3) {
          vulnerabilities.push(`Step ${step.order}: Risk of unintended ${sideEffect.variable}`);
          robustnessScore *= 1 - sideEffect.probability * 0.3;
        }
      }
    }

    for (const step of steps) {
      const node = graph.getNode(step.target);
      if (node) {
        const confounders = graph
          .getParents(step.target)
          .filter((p) => p.variableType === 'confounder');
        for (const confounder of confounders) {
          if (!steps.some((s) => s.target === confounder.id)) {
            vulnerabilities.push(
              `Uncontrolled confounder: ${confounder.id} affects ${step.target}`
            );
            robustnessScore *= 0.9;
          }
        }
      }
    }

    const backupPlans: CausalPlan[] = [];

    for (const step of steps) {
      if (step.alternatives && step.alternatives.length > 0) {
        const alternativeSteps = steps.map((s) =>
          s.order === step.order ? step.alternatives![0] : s
        );

        backupPlans.push({
          goal: 'backup',
          goalValue: true,
          steps: alternativeSteps,
          expectedOutcome: { probability: 0.6, confidence: 0.5 },
          robustness: { score: 0.5, vulnerabilities: [], backupPlans: [] },
          estimatedCost: this.estimateCost(alternativeSteps),
          reasoning: `Backup plan using alternative for step ${step.order}`,
        });
      }
    }

    return {
      score: Math.max(0, robustnessScore),
      vulnerabilities,
      backupPlans: backupPlans.slice(0, 2),
    };
  }

  private applyConstraints(
    interventions: Array<{ variable: string; value: unknown; effectiveness: number }>,
    constraints?: { forbidden?: string[]; required?: string[]; maxCost?: number }
  ): Array<{ variable: string; value: unknown; effectiveness: number }> {
    if (!constraints) return interventions;

    let filtered = interventions;

    if (constraints.forbidden) {
      filtered = filtered.filter((i) => !constraints.forbidden!.includes(i.variable));
    }

    if (constraints.required) {
      for (const required of constraints.required) {
        if (!filtered.some((i) => i.variable === required)) {
          filtered.push({
            variable: required,
            value: 1,
            effectiveness: 0.5,
          });
        }
      }
    }

    return filtered;
  }

  private async buildPlanSteps(
    interventions: Array<{ variable: string; value: unknown; effectiveness: number }>,
    graph: CausalGraph,
    context: CausalContext
  ): Promise<CausalPlanStep[]> {
    const steps: CausalPlanStep[] = [];

    const sortedInterventions = this.topologicalSortInterventions(interventions, graph);

    for (let i = 0; i < Math.min(sortedInterventions.length, this.maxPlanSteps); i++) {
      const intervention = sortedInterventions[i];

      const action = `Set ${intervention.variable} to ${intervention.value}`;
      const expectedEffect = await this.effectPredictor.predictEffect(action, graph, context);

      const preconditions = this.findPreconditions(intervention.variable, graph);

      const alternatives = await this.findAlternativeSteps(intervention, graph, context);

      steps.push({
        order: i + 1,
        action,
        target: intervention.variable,
        value: intervention.value as number | string | boolean,
        expectedEffect,
        preconditions,
        alternatives,
      });
    }

    return steps;
  }

  private topologicalSortInterventions(
    interventions: Array<{ variable: string; value: unknown; effectiveness: number }>,
    graph: CausalGraph
  ): Array<{ variable: string; value: unknown; effectiveness: number }> {
    const variableSet = new Set(interventions.map((i) => i.variable));
    const sorted: Array<{ variable: string; value: unknown; effectiveness: number }> = [];
    const visited = new Set<string>();

    const visit = (variable: string) => {
      if (visited.has(variable)) return;
      visited.add(variable);

      const parents = graph.getParents(variable);
      for (const parent of parents) {
        if (variableSet.has(parent.id)) {
          visit(parent.id);
        }
      }

      const intervention = interventions.find((i) => i.variable === variable);
      if (intervention) {
        sorted.push(intervention);
      }
    };

    for (const intervention of interventions) {
      visit(intervention.variable);
    }

    return sorted;
  }

  private findPreconditions(variable: string, graph: CausalGraph): string[] {
    const preconditions: string[] = [];

    const parents = graph.getParents(variable);
    for (const parent of parents) {
      const edge = graph.getEdgeBetween(parent.id, variable);
      if (edge?.relationType === 'enables') {
        preconditions.push(`${parent.id} must be active`);
      }
    }

    return preconditions;
  }

  private async findAlternativeSteps(
    intervention: { variable: string; value: unknown; effectiveness: number },
    graph: CausalGraph,
    context: CausalContext
  ): Promise<CausalPlanStep[]> {
    const alternatives: CausalPlanStep[] = [];

    const siblings = graph.getParents(intervention.variable);
    for (const sibling of siblings.slice(0, this.maxAlternatives)) {
      if (sibling.variableType === 'treatment') {
        const action = `Use ${sibling.id} instead of ${intervention.variable}`;
        const expectedEffect = await this.effectPredictor.predictEffect(action, graph, context);

        alternatives.push({
          order: 0,
          action,
          target: sibling.id,
          value: intervention.value as number | string | boolean,
          expectedEffect,
          preconditions: [],
        });
      }
    }

    return alternatives;
  }

  private calculateExpectedOutcome(steps: CausalPlanStep[]): {
    probability: number;
    confidence: number;
  } {
    if (steps.length === 0) {
      return { probability: 0, confidence: 0 };
    }

    let probability = 1.0;
    let totalConfidence = 0;

    for (const step of steps) {
      const mainEffects = step.expectedEffect.effects;
      if (mainEffects.length > 0) {
        const avgProbability =
          mainEffects.reduce((sum, e) => sum + e.probability, 0) / mainEffects.length;
        probability *= avgProbability;
      }
      totalConfidence += step.expectedEffect.confidence;
    }

    return {
      probability: Math.max(0, Math.min(1, probability)),
      confidence: totalConfidence / steps.length,
    };
  }

  private estimateCost(steps: CausalPlanStep[]): number {
    let cost = 0;

    for (const step of steps) {
      cost += 1;

      cost += step.preconditions.length * 0.5;

      for (const sideEffect of step.expectedEffect.sideEffects) {
        if (sideEffect.unintended) {
          cost += sideEffect.probability * 2;
        }
      }
    }

    return cost;
  }

  private async generatePlanReasoning(
    goal: string,
    goalValue: unknown,
    steps: CausalPlanStep[],
    context: CausalContext
  ): Promise<string> {
    const prompt = `Explain the reasoning behind this causal plan.

Goal: ${goal} = ${goalValue}

Planned steps:
${steps.map((s) => `${s.order}. ${s.action} (targeting ${s.target})`).join('\n')}

Context:
- Agent: ${context.agentId}
- Current state: ${JSON.stringify(context.observedVariables)}

Provide a brief explanation (2-3 sentences) of:
1. Why these steps were chosen
2. The causal chain from interventions to goal
3. Key assumptions made`;

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      });

      return response.content.trim();
    } catch {
      return `Plan to achieve ${goal}=${goalValue} through ${steps.length} interventions targeting the causal pathway.`;
    }
  }
}
