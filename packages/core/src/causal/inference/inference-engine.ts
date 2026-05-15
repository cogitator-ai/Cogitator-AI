import type {
  CausalGraph,
  CausalEffectEstimate,
  CounterfactualQuery,
  CounterfactualResult,
  InterventionQuery,
  AdjustmentSet,
  CausalReasoningConfig,
} from '@cogitator-ai/types';
import { DEFAULT_CAUSAL_CONFIG } from '@cogitator-ai/types';
import { dSeparation } from './d-separation';
import {
  findBackdoorAdjustment,
  findFrontdoorAdjustment,
  findAllAdjustmentSets,
} from './adjustment';
import { CounterfactualReasoner, CounterfactualReasonerOptions } from './counterfactual';

export interface CausalInferenceEngineOptions {
  config?: Partial<CausalReasoningConfig>;
  counterfactualOptions?: CounterfactualReasonerOptions;
}

export class CausalInferenceEngine {
  private graph: CausalGraph;
  private config: CausalReasoningConfig;
  private counterfactualReasoner: CounterfactualReasoner;

  constructor(graph: CausalGraph, options: CausalInferenceEngineOptions = {}) {
    this.graph = graph;
    this.config = { ...DEFAULT_CAUSAL_CONFIG, ...options.config };
    this.counterfactualReasoner = new CounterfactualReasoner(options.counterfactualOptions);
  }

  isIdentifiable(
    treatment: string,
    outcome: string
  ): { identifiable: boolean; reason: string; adjustmentSet?: AdjustmentSet } {
    const backdoor = findBackdoorAdjustment(this.graph, treatment, outcome);
    if (backdoor) {
      return {
        identifiable: true,
        reason: 'Identifiable via backdoor criterion',
        adjustmentSet: backdoor,
      };
    }

    const frontdoor = findFrontdoorAdjustment(this.graph, treatment, outcome);
    if (frontdoor) {
      return {
        identifiable: true,
        reason: 'Identifiable via frontdoor criterion',
        adjustmentSet: frontdoor,
      };
    }

    return {
      identifiable: false,
      reason:
        'No valid adjustment set found. Effect may not be identifiable from observational data.',
    };
  }

  computeInterventionalEffect(
    query: InterventionQuery,
    observedData?: Record<string, number[]>
  ): CausalEffectEstimate {
    const treatment = Object.keys(query.interventions)[0];
    const outcome = query.target;

    const identifiability = this.isIdentifiable(treatment, outcome);

    if (!identifiability.identifiable || !identifiability.adjustmentSet) {
      return {
        effect: NaN,
        isIdentifiable: false,
        adjustmentSet: {
          variables: [],
          type: 'backdoor',
          formula: 'Not identifiable',
          isMinimal: false,
          isValid: false,
        },
        formula: identifiability.reason,
      };
    }

    const adjustmentSet = identifiability.adjustmentSet;

    if (observedData) {
      const effect = this.estimateEffectFromData(
        treatment,
        outcome,
        adjustmentSet.variables,
        observedData,
        query.interventions[treatment]
      );

      return {
        effect: effect.estimate,
        standardError: effect.standardError,
        confidenceInterval: effect.confidenceInterval,
        adjustmentSet,
        isIdentifiable: true,
        formula: adjustmentSet.formula,
      };
    }

    return {
      effect: NaN,
      adjustmentSet,
      isIdentifiable: true,
      formula: adjustmentSet.formula,
    };
  }

  private estimateEffectFromData(
    treatment: string,
    outcome: string,
    adjustmentVars: string[],
    data: Record<string, number[]>,
    interventionValue: number | string | boolean
  ): { estimate: number; standardError: number; confidenceInterval: [number, number] } {
    const treatmentValues = data[treatment];
    const outcomeValues = data[outcome];

    if (!treatmentValues || !outcomeValues) {
      return { estimate: NaN, standardError: NaN, confidenceInterval: [NaN, NaN] };
    }

    const n = Math.min(treatmentValues.length, outcomeValues.length);
    if (n === 0) {
      return { estimate: NaN, standardError: NaN, confidenceInterval: [NaN, NaN] };
    }

    const targetTreatment =
      typeof interventionValue === 'number' ? interventionValue : interventionValue ? 1 : 0;

    if (adjustmentVars.length === 0) {
      const treatedIndices: number[] = [];
      const controlIndices: number[] = [];

      for (let i = 0; i < n; i++) {
        if (Math.abs(treatmentValues[i] - targetTreatment) < 0.5) {
          treatedIndices.push(i);
        } else {
          controlIndices.push(i);
        }
      }

      const treatedOutcome =
        treatedIndices.length > 0
          ? treatedIndices.reduce((sum, i) => sum + outcomeValues[i], 0) / treatedIndices.length
          : NaN;

      const controlOutcome =
        controlIndices.length > 0
          ? controlIndices.reduce((sum, i) => sum + outcomeValues[i], 0) / controlIndices.length
          : NaN;

      const effect = treatedOutcome - controlOutcome;

      const treatedVar =
        treatedIndices.length > 1
          ? treatedIndices.reduce(
              (sum, i) => sum + Math.pow(outcomeValues[i] - treatedOutcome, 2),
              0
            ) /
            (treatedIndices.length - 1)
          : 0;

      const controlVar =
        controlIndices.length > 1
          ? controlIndices.reduce(
              (sum, i) => sum + Math.pow(outcomeValues[i] - controlOutcome, 2),
              0
            ) /
            (controlIndices.length - 1)
          : 0;

      const se = Math.sqrt(treatedVar / treatedIndices.length + controlVar / controlIndices.length);

      return {
        estimate: effect,
        standardError: se,
        confidenceInterval: [effect - 1.96 * se, effect + 1.96 * se],
      };
    }

    let weightedEffect = 0;
    let totalWeight = 0;

    const strata = this.stratifyData(data, adjustmentVars, n);

    for (const stratum of strata) {
      const stratumTreated: number[] = [];
      const stratumControl: number[] = [];

      for (const i of stratum.indices) {
        if (Math.abs(treatmentValues[i] - targetTreatment) < 0.5) {
          stratumTreated.push(outcomeValues[i]);
        } else {
          stratumControl.push(outcomeValues[i]);
        }
      }

      if (stratumTreated.length > 0 && stratumControl.length > 0) {
        const treatedMean = stratumTreated.reduce((a, b) => a + b, 0) / stratumTreated.length;
        const controlMean = stratumControl.reduce((a, b) => a + b, 0) / stratumControl.length;
        const stratumEffect = treatedMean - controlMean;
        const weight = stratum.indices.length / n;
        weightedEffect += stratumEffect * weight;
        totalWeight += weight;
      }
    }

    const effect = totalWeight > 0 ? weightedEffect / totalWeight : NaN;

    return {
      estimate: effect,
      standardError: NaN,
      confidenceInterval: [NaN, NaN],
    };
  }

  private stratifyData(
    data: Record<string, number[]>,
    adjustmentVars: string[],
    n: number
  ): Array<{ key: string; indices: number[] }> {
    const strataMap = new Map<string, number[]>();

    for (let i = 0; i < n; i++) {
      const key = adjustmentVars
        .map((v) => {
          const val = data[v]?.[i];
          return val !== undefined ? Math.round(val).toString() : 'NA';
        })
        .join('|');

      if (!strataMap.has(key)) {
        strataMap.set(key, []);
      }
      strataMap.get(key)!.push(i);
    }

    return Array.from(strataMap.entries()).map(([key, indices]) => ({ key, indices }));
  }

  private estimateATTFromData(
    treatment: string,
    outcome: string,
    adjustmentVars: string[],
    data: Record<string, number[]>
  ): { estimate: number; standardError: number; confidenceInterval: [number, number] } {
    const treatmentValues = data[treatment];
    const outcomeValues = data[outcome];

    if (!treatmentValues || !outcomeValues) {
      return { estimate: NaN, standardError: NaN, confidenceInterval: [NaN, NaN] };
    }

    const n = Math.min(treatmentValues.length, outcomeValues.length);
    if (n === 0) {
      return { estimate: NaN, standardError: NaN, confidenceInterval: [NaN, NaN] };
    }

    if (adjustmentVars.length === 0) {
      return this.estimateEffectFromData(treatment, outcome, [], data, 1);
    }

    const strata = this.stratifyData(data, adjustmentVars, n);
    const treatedTotal = treatmentValues.slice(0, n).filter((value) => value >= 0.5).length;
    if (treatedTotal === 0) {
      return { estimate: NaN, standardError: NaN, confidenceInterval: [NaN, NaN] };
    }

    let weightedEffect = 0;
    let totalWeight = 0;

    for (const stratum of strata) {
      const stratumTreated: number[] = [];
      const stratumControl: number[] = [];

      for (const i of stratum.indices) {
        if (treatmentValues[i] >= 0.5) {
          stratumTreated.push(outcomeValues[i]);
        } else {
          stratumControl.push(outcomeValues[i]);
        }
      }

      if (stratumTreated.length > 0 && stratumControl.length > 0) {
        const treatedMean = stratumTreated.reduce((a, b) => a + b, 0) / stratumTreated.length;
        const controlMean = stratumControl.reduce((a, b) => a + b, 0) / stratumControl.length;
        const weight = stratumTreated.length / treatedTotal;
        weightedEffect += (treatedMean - controlMean) * weight;
        totalWeight += weight;
      }
    }

    return {
      estimate: totalWeight > 0 ? weightedEffect / totalWeight : NaN,
      standardError: NaN,
      confidenceInterval: [NaN, NaN],
    };
  }

  computeCounterfactual(query: CounterfactualQuery): CounterfactualResult {
    if (!this.config.enableCounterfactual) {
      throw new Error('Counterfactual reasoning is disabled in config');
    }
    return this.counterfactualReasoner.evaluate(this.graph, query);
  }

  estimateATE(
    treatment: string,
    outcome: string,
    data: Record<string, number[]>
  ): CausalEffectEstimate {
    return this.computeInterventionalEffect(
      { target: outcome, interventions: { [treatment]: 1 } },
      data
    );
  }

  estimateATT(
    treatment: string,
    outcome: string,
    data: Record<string, number[]>
  ): CausalEffectEstimate {
    const treatmentValues = data[treatment];
    const outcomeValues = data[outcome];

    if (!treatmentValues || !outcomeValues) {
      return {
        effect: NaN,
        isIdentifiable: false,
        adjustmentSet: {
          variables: [],
          type: 'backdoor',
          formula: 'No data available',
          isMinimal: false,
          isValid: false,
        },
        formula: 'No data available',
      };
    }

    const identifiability = this.isIdentifiable(treatment, outcome);

    if (!identifiability.identifiable) {
      return {
        effect: NaN,
        isIdentifiable: false,
        adjustmentSet: identifiability.adjustmentSet || {
          variables: [],
          type: 'backdoor',
          formula: 'Not identifiable',
          isMinimal: false,
          isValid: false,
        },
        formula: identifiability.reason,
      };
    }

    const adjustmentSet = identifiability.adjustmentSet!;
    const attResult = this.estimateATTFromData(treatment, outcome, adjustmentSet.variables, data);

    return {
      effect: attResult.estimate,
      standardError: attResult.standardError,
      confidenceInterval: attResult.confidenceInterval,
      adjustmentSet,
      isIdentifiable: true,
      formula: `ATT = E[Y(1) - Y(0) | T=1] estimated via ${adjustmentSet.type} adjustment`,
    };
  }

  checkConditionalIndependence(
    x: string,
    y: string,
    z: string[]
  ): { independent: boolean; paths: number; openPaths: number } {
    const result = dSeparation(this.graph, x, y, z);
    return {
      independent: result.separated,
      paths: result.paths.length,
      openPaths: result.openPaths.length,
    };
  }

  findInstrumentalVariables(treatment: string, outcome: string): string[] {
    const instruments: string[] = [];
    const allNodes = this.graph.getNodes();

    for (const node of allNodes) {
      if (node.id === treatment || node.id === outcome) continue;

      const hasPathToTreatment = this.graph.findPaths(node.id, treatment).length > 0;
      if (!hasPathToTreatment) continue;

      const directPathToOutcome = this.graph.getEdgeBetween(node.id, outcome);
      if (directPathToOutcome) continue;

      const independenceResult = dSeparation(this.graph, node.id, outcome, [treatment]);
      if (independenceResult.separated) {
        instruments.push(node.id);
      }
    }

    return instruments;
  }

  getAllAdjustmentSets(treatment: string, outcome: string): AdjustmentSet[] {
    return findAllAdjustmentSets(this.graph, treatment, outcome);
  }

  updateGraph(graph: CausalGraph): void {
    this.graph = graph;
  }

  getGraph(): CausalGraph {
    return this.graph;
  }
}
