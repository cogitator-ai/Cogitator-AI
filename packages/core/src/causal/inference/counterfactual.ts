import type {
  CausalGraph,
  CausalNode,
  CounterfactualQuery,
  CounterfactualResult,
  StructuralEquation,
} from '@cogitator-ai/types';

export interface CounterfactualReasonerOptions {
  defaultNoiseMean?: number;
  defaultNoiseStd?: number;
  maxIterations?: number;
  convergenceThreshold?: number;
}

export class CounterfactualReasoner {
  private options: Required<CounterfactualReasonerOptions>;

  constructor(options: CounterfactualReasonerOptions = {}) {
    this.options = {
      defaultNoiseMean: options.defaultNoiseMean ?? 0,
      defaultNoiseStd: options.defaultNoiseStd ?? 1,
      maxIterations: options.maxIterations ?? 100,
      convergenceThreshold: options.convergenceThreshold ?? 0.001,
    };
  }

  evaluate(graph: CausalGraph, query: CounterfactualQuery): CounterfactualResult {
    const abductionResult = this.abduction(graph, query.factual);

    const actionResult = this.action(graph, query.intervention, abductionResult);

    const predictionResult = this.prediction(graph, query.target, actionResult);

    const factualValue =
      query.factual[query.target] ??
      this.computeValue(graph, query.target, query.factual, abductionResult);

    return {
      query,
      factualValue,
      counterfactualValue: predictionResult.value,
      probability: predictionResult.probability,
      explanation: this.generateExplanation(query, factualValue, predictionResult.value),
      reasoning: {
        abduction: abductionResult,
        action: actionResult,
        prediction: predictionResult.values,
      },
    };
  }

  private abduction(
    graph: CausalGraph,
    factual: Record<string, number | string | boolean>
  ): Record<string, number> {
    const noiseTerms: Record<string, number> = {};
    const sortedNodes = graph.topologicalSort();

    for (const nodeId of sortedNodes) {
      const node = graph.getNode(nodeId);
      if (!node) continue;

      if (factual[nodeId] !== undefined && node.equation) {
        const observedValue = this.toNumber(factual[nodeId]);
        const predictedValue = this.evaluateEquation(node.equation, graph, nodeId, factual, {});
        noiseTerms[nodeId] = observedValue - predictedValue;
      } else {
        noiseTerms[nodeId] = this.sampleNoise(node);
      }
    }

    return noiseTerms;
  }

  private action(
    _graph: CausalGraph,
    intervention: Record<string, number | string | boolean>,
    noiseTerms: Record<string, number>
  ): Record<string, number | string | boolean> {
    const result: Record<string, number | string | boolean> = {};

    for (const [key, value] of Object.entries(noiseTerms)) {
      result[key] = value;
    }

    for (const [variable, value] of Object.entries(intervention)) {
      result[variable] = value;
    }

    return result;
  }

  private prediction(
    graph: CausalGraph,
    target: string,
    state: Record<string, number | string | boolean>
  ): {
    value: number | string | boolean;
    probability: number;
    values: Record<string, number | string | boolean>;
  } {
    const sortedNodes = graph.topologicalSort();
    const computedValues: Record<string, number | string | boolean> = { ...state };

    for (const nodeId of sortedNodes) {
      if (computedValues[nodeId] !== undefined && typeof computedValues[nodeId] !== 'number') {
        continue;
      }

      const node = graph.getNode(nodeId);
      if (!node) continue;

      if (node.equation) {
        const noiseValue =
          typeof computedValues[nodeId] === 'number' ? (computedValues[nodeId] as number) : 0;

        const parentValues: Record<string, number | string | boolean> = {};
        for (const parent of graph.getParents(nodeId)) {
          if (computedValues[parent.id] !== undefined) {
            parentValues[parent.id] = computedValues[parent.id];
          }
        }

        computedValues[nodeId] = this.evaluateEquationWithNoise(
          node.equation,
          parentValues,
          noiseValue
        );
      }
    }

    return {
      value: computedValues[target] ?? 0,
      probability: 1.0,
      values: computedValues,
    };
  }

  private evaluateEquation(
    equation: StructuralEquation,
    graph: CausalGraph,
    nodeId: string,
    values: Record<string, number | string | boolean>,
    _noiseTerms: Record<string, number>
  ): number {
    const parents = graph.getParents(nodeId);
    const parentValues: Record<string, number | string | boolean> = {};

    for (const parent of parents) {
      if (values[parent.id] !== undefined) {
        parentValues[parent.id] = values[parent.id];
      }
    }

    return this.evaluateEquationWithNoise(equation, parentValues, 0);
  }

  private evaluateEquationWithNoise(
    equation: StructuralEquation,
    parentValues: Record<string, number | string | boolean>,
    noise: number
  ): number {
    switch (equation.type) {
      case 'linear': {
        let result = equation.intercept ?? 0;
        if (equation.coefficients) {
          for (const [variable, coefficient] of Object.entries(equation.coefficients)) {
            const value = this.toNumber(parentValues[variable] ?? 0);
            result += coefficient * value;
          }
        }
        return result + noise;
      }

      case 'logistic': {
        let linearPart = equation.intercept ?? 0;
        if (equation.coefficients) {
          for (const [variable, coefficient] of Object.entries(equation.coefficients)) {
            const value = this.toNumber(parentValues[variable] ?? 0);
            linearPart += coefficient * value;
          }
        }
        linearPart += noise;
        return 1 / (1 + Math.exp(-linearPart));
      }

      case 'polynomial': {
        let result = equation.intercept ?? 0;
        if (equation.coefficients) {
          for (const [variable, coefficient] of Object.entries(equation.coefficients)) {
            const [varName, powerStr] = variable.split('^');
            const power = powerStr ? parseInt(powerStr, 10) : 1;
            const value = this.toNumber(parentValues[varName] ?? 0);
            result += coefficient * Math.pow(value, power);
          }
        }
        return result + noise;
      }

      case 'custom': {
        return noise;
      }

      default:
        return noise;
    }
  }

  private computeValue(
    graph: CausalGraph,
    target: string,
    observed: Record<string, number | string | boolean>,
    noiseTerms: Record<string, number>
  ): number | string | boolean {
    const node = graph.getNode(target);
    if (!node?.equation) {
      return observed[target] ?? 0;
    }

    const parentValues: Record<string, number | string | boolean> = {};
    for (const parent of graph.getParents(target)) {
      parentValues[parent.id] = observed[parent.id] ?? 0;
    }

    return this.evaluateEquationWithNoise(node.equation, parentValues, noiseTerms[target] ?? 0);
  }

  private sampleNoise(node: CausalNode): number {
    const params = node.equation?.noiseParams ?? {};
    const distribution = node.equation?.noiseDistribution ?? 'gaussian';

    switch (distribution) {
      case 'gaussian': {
        const mean = params.mean ?? this.options.defaultNoiseMean;
        const std = params.std ?? this.options.defaultNoiseStd;
        return this.sampleGaussian(mean, std);
      }
      case 'uniform': {
        const min = params.min ?? -1;
        const max = params.max ?? 1;
        return min + Math.random() * (max - min);
      }
      case 'bernoulli': {
        const p = params.p ?? 0.5;
        return Math.random() < p ? 1 : 0;
      }
      default:
        return 0;
    }
  }

  private sampleGaussian(mean: number, std: number): number {
    const u1 = Math.random() || Number.MIN_VALUE;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + std * z;
  }

  private toNumber(value: number | string | boolean): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }

  private generateExplanation(
    query: CounterfactualQuery,
    factualValue: number | string | boolean,
    counterfactualValue: number | string | boolean
  ): string {
    const interventionDesc = Object.entries(query.intervention)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    return (
      `Given the factual observation where ${query.target}=${factualValue}, ` +
      `if we had intervened to set ${interventionDesc}, ` +
      `then ${query.target} would have been ${counterfactualValue}.`
    );
  }
}

export function evaluateCounterfactual(
  graph: CausalGraph,
  query: CounterfactualQuery,
  options?: CounterfactualReasonerOptions
): CounterfactualResult {
  const reasoner = new CounterfactualReasoner(options);
  return reasoner.evaluate(graph, query);
}
