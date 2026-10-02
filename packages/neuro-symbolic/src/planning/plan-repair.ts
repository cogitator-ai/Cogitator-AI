import type {
  Plan,
  PlanAction,
  PlanState,
  ActionSchema,
  Effect,
  Precondition,
  PlanValidationResult,
  PlanValidationError,
  PlanRepairSuggestion,
  PlanRepairResult,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { ActionRegistry, applyAction, createAction, evaluatePrecondition } from './action-schema';
import { PlanValidator } from './plan-validator';

export interface RepairConfig {
  maxInsertions: number;
  maxRemovals: number;
  maxReorders: number;
  maxIterations: number;
  useHeuristics: boolean;
}

const DEFAULT_REPAIR_CONFIG: RepairConfig = {
  maxInsertions: 5,
  maxRemovals: 3,
  maxReorders: 10,
  maxIterations: 100,
  useHeuristics: true,
};

function conditionVariables(precondition: Precondition): string[] {
  switch (precondition.type) {
    case 'simple':
    case 'comparison':
      return [precondition.variable];
    case 'and':
    case 'or':
      return precondition.conditions.flatMap(conditionVariables);
    case 'not':
    case 'exists':
    case 'forall':
      return conditionVariables(precondition.condition);
    default:
      return [];
  }
}

export class PlanRepairer {
  private registry: ActionRegistry;
  private validator: PlanValidator;
  private config: RepairConfig;
  private swapTargets = new WeakMap<PlanRepairSuggestion, number>();

  constructor(registry: ActionRegistry, config: Partial<RepairConfig> = {}) {
    this.registry = registry;
    this.validator = new PlanValidator(registry);
    this.config = { ...DEFAULT_REPAIR_CONFIG, ...config };
  }

  repair(plan: Plan): PlanRepairResult {
    const validationResult = this.validator.validate(plan);

    if (validationResult.valid) {
      return {
        originalPlan: plan,
        repairedPlan: plan,
        suggestions: [],
        success: true,
        explanation: 'Plan is already valid, no repairs needed.',
      };
    }

    const suggestions = this.generateSuggestions(plan, validationResult);

    const repairedPlan = this.attemptRepair(plan, validationResult, suggestions);

    if (repairedPlan) {
      const verificationResult = this.validator.validate(repairedPlan);

      if (verificationResult.valid) {
        return {
          originalPlan: plan,
          repairedPlan,
          suggestions,
          success: true,
          explanation: this.generateExplanation(plan, repairedPlan, suggestions),
        };
      }
    }

    return {
      originalPlan: plan,
      suggestions,
      success: false,
      explanation: this.generateFailureExplanation(validationResult, suggestions),
    };
  }

  private generateSuggestions(
    plan: Plan,
    validation: PlanValidationResult
  ): PlanRepairSuggestion[] {
    const suggestions: PlanRepairSuggestion[] = [];

    for (const error of validation.errors) {
      const errorSuggestions = this.suggestionsForError(plan, error);
      suggestions.push(...errorSuggestions);
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);

    return suggestions;
  }

  private suggestionsForError(plan: Plan, error: PlanValidationError): PlanRepairSuggestion[] {
    const suggestions: PlanRepairSuggestion[] = [];

    switch (error.type) {
      case 'precondition_violated': {
        const insertSuggestions = this.suggestInsertions(
          plan,
          error.actionIndex!,
          error.details?.precondition as Precondition,
          plan.actions[error.actionIndex!]?.parameters ?? {}
        );
        suggestions.push(...insertSuggestions);

        suggestions.push({
          type: 'remove',
          position: error.actionIndex,
          reason: `Remove action that violates precondition: ${error.message}`,
          confidence: 0.3,
        });

        const reorderSuggestions = this.suggestReorders(plan, error.actionIndex!);
        suggestions.push(...reorderSuggestions);
        break;
      }

      case 'undefined_action': {
        suggestions.push({
          type: 'remove',
          position: error.actionIndex,
          reason: `Remove undefined action: ${error.actionName}`,
          confidence: 0.9,
        });
        break;
      }

      case 'missing_parameter':
      case 'invalid_parameter': {
        const fixed = this.fixParameters(plan, error.actionIndex!);
        suggestions.push({
          type: 'modify',
          position: error.actionIndex,
          action: fixed ?? undefined,
          reason: error.message,
          confidence: fixed ? 0.6 : 0.3,
        });
        break;
      }

      case 'goal_unreachable': {
        const goalInsertions = this.suggestActionsForGoal(
          plan,
          error.details?.goal as Precondition | undefined
        );
        suggestions.push(...goalInsertions);
        break;
      }
    }

    return suggestions;
  }

  private suggestInsertions(
    plan: Plan,
    position: number,
    precondition: Precondition,
    parameters: Record<string, unknown>
  ): PlanRepairSuggestion[] {
    const stateBeforeAction = this.getStateAtPosition(plan, position);

    return this.establishingActions(stateBeforeAction, precondition, parameters).map(
      ({ action, applicable }) => ({
        type: 'insert' as const,
        position,
        action,
        reason: `Insert ${action.schemaName} to establish precondition`,
        confidence: applicable ? 0.8 : 0.5,
      })
    );
  }

  private establishingActions(
    state: PlanState,
    condition: Precondition,
    parameters: Record<string, unknown>
  ): { action: PlanAction; applicable: boolean }[] {
    const results: { action: PlanAction; applicable: boolean }[] = [];

    for (const schema of this.registry.getAll()) {
      if (!this.schemaCouldEstablish(schema, condition)) continue;

      const action = this.createActionFromSchema(schema, state);
      if (!action) continue;

      const nextState = applyAction(action, state, schema);
      if (!evaluatePrecondition(condition, nextState, parameters)) continue;

      const applicable = schema.preconditions.every((pre) =>
        evaluatePrecondition(pre, state, action.parameters)
      );
      results.push({ action, applicable });
    }

    return results;
  }

  private fixParameters(plan: Plan, position: number): PlanAction | null {
    const action = plan.actions[position];
    const schema = action ? this.registry.get(action.schemaName) : undefined;
    if (!action || !schema) return null;

    const state = this.getStateAtPosition(plan, position);
    const parameters: Record<string, unknown> = {};

    for (const param of schema.parameters) {
      if (param.name in action.parameters) {
        parameters[param.name] = action.parameters[param.name];
      } else if (param.default !== undefined) {
        parameters[param.name] = param.default;
      } else if (param.required) {
        const value = this.inferParameterValue(param, state);
        if (value === undefined) return null;
        parameters[param.name] = value;
      }
    }

    return { ...action, parameters };
  }

  private suggestReorders(plan: Plan, problemPosition: number): PlanRepairSuggestion[] {
    const suggestions: PlanRepairSuggestion[] = [];
    const originalErrorCount = this.countErrors(plan);

    for (let i = 0; i < plan.actions.length; i++) {
      if (i === problemPosition) continue;

      const swappedPlan = this.swapActions(plan, i, problemPosition);
      const validation = this.validator.validate(swappedPlan);

      if (validation.errors.length < originalErrorCount) {
        const suggestion: PlanRepairSuggestion = {
          type: 'reorder',
          position: problemPosition,
          reason: `Swap action ${problemPosition} with action ${i}`,
          confidence: 0.5,
        };
        this.swapTargets.set(suggestion, i);
        suggestions.push(suggestion);
      }
    }

    return suggestions;
  }

  private suggestActionsForGoal(plan: Plan, goal?: Precondition): PlanRepairSuggestion[] {
    if (!goal) return [];

    const finalState = this.getFinalState(plan);

    return this.establishingActions(finalState, goal, {}).map(({ action, applicable }) => ({
      type: 'insert' as const,
      position: plan.actions.length,
      action,
      reason: `Append ${action.schemaName} to achieve goal`,
      confidence: applicable ? 0.75 : 0.45,
    }));
  }

  private schemaCouldEstablish(schema: ActionSchema, precondition: Precondition): boolean {
    const variables = conditionVariables(precondition);
    if (variables.length === 0) return false;
    return variables.some((variable) => this.effectsTouchVariable(schema.effects, variable));
  }

  private effectsTouchVariable(effects: Effect[], varName: string): boolean {
    for (const effect of effects) {
      if (effect.type === 'conditional') {
        if (this.effectsTouchVariable(effect.thenEffects, varName)) return true;
        if (effect.elseEffects && this.effectsTouchVariable(effect.elseEffects, varName))
          return true;
      } else if (effect.variable === varName || effect.variable.startsWith('?')) {
        return true;
      }
    }
    return false;
  }

  private createActionFromSchema(schema: ActionSchema, state: PlanState): PlanAction | null {
    const parameters: Record<string, unknown> = {};

    for (const param of schema.parameters) {
      if (param.default !== undefined) {
        parameters[param.name] = param.default;
      } else if (param.required) {
        const value = this.inferParameterValue(param, state);
        if (value === undefined) return null;
        parameters[param.name] = value;
      }
    }

    return createAction(schema.name, parameters);
  }

  private inferParameterValue(param: { name: string; type: string }, state: PlanState): unknown {
    if (param.name in state.variables) {
      return state.variables[param.name];
    }

    for (const [key, value] of Object.entries(state.variables)) {
      if (
        key.toLowerCase().includes(param.name.toLowerCase()) ||
        param.name.toLowerCase().includes(key.toLowerCase())
      ) {
        return value;
      }
    }

    for (const [, value] of Object.entries(state.variables)) {
      if (typeof value === 'string' && param.type.includes('string')) return value;
      if (typeof value === 'number' && param.type.includes('number')) return value;
      if (typeof value === 'boolean' && param.type.includes('boolean')) return value;
    }

    switch (param.type) {
      case 'string':
        return '';
      case 'number':
        return 0;
      case 'boolean':
        return false;
      default:
        return undefined;
    }
  }

  private attemptRepair(
    plan: Plan,
    validation: PlanValidationResult,
    suggestions: PlanRepairSuggestion[]
  ): Plan | null {
    let currentPlan = plan;
    let currentValidation = validation;
    let currentSuggestions = suggestions;
    let insertions = 0;
    let removals = 0;
    let reorders = 0;
    let iterations = 0;

    while (iterations < this.config.maxIterations) {
      iterations++;
      let mutated = false;

      for (const suggestion of currentSuggestions) {
        if (iterations >= this.config.maxIterations) break;
        iterations++;

        let newPlan: Plan | null = null;

        switch (suggestion.type) {
          case 'insert':
            if (insertions < this.config.maxInsertions && suggestion.action) {
              const pos = Math.min(suggestion.position!, currentPlan.actions.length);
              newPlan = this.insertAction(currentPlan, pos, suggestion.action);
            }
            break;

          case 'remove':
            if (
              removals < this.config.maxRemovals &&
              suggestion.position! < currentPlan.actions.length
            ) {
              newPlan = this.removeAction(currentPlan, suggestion.position!);
            }
            break;

          case 'reorder':
            if (reorders < this.config.maxReorders) {
              newPlan = this.reorderActions(currentPlan, suggestion);
            }
            break;

          case 'modify':
            if (suggestion.action && suggestion.position! < currentPlan.actions.length) {
              newPlan = this.replaceAction(currentPlan, suggestion.position!, suggestion.action);
            }
            break;
        }

        if (newPlan) {
          const newValidation = this.validator.validate(newPlan);
          const improved = newValidation.errors.length < currentValidation.errors.length;

          if (newValidation.valid || improved) {
            if (suggestion.type === 'insert') insertions++;
            if (suggestion.type === 'remove') removals++;
            if (suggestion.type === 'reorder') reorders++;
          }

          if (newValidation.valid) {
            return newPlan;
          }

          if (improved) {
            currentPlan = newPlan;
            currentValidation = newValidation;
            currentSuggestions = this.generateSuggestions(currentPlan, currentValidation);
            mutated = true;
            break;
          }
        }
      }

      if (!mutated) break;
    }

    const finalValidation = this.validator.validate(currentPlan);
    return finalValidation.valid ? currentPlan : null;
  }

  private insertAction(plan: Plan, position: number, action: PlanAction): Plan {
    const newActions = [...plan.actions];
    newActions.splice(position, 0, action);

    return {
      ...plan,
      id: nanoid(8),
      actions: newActions,
    };
  }

  private replaceAction(plan: Plan, position: number, action: PlanAction): Plan {
    const newActions = [...plan.actions];
    newActions[position] = action;

    return {
      ...plan,
      id: nanoid(8),
      actions: newActions,
    };
  }

  private removeAction(plan: Plan, position: number): Plan {
    const newActions = [...plan.actions];
    newActions.splice(position, 1);

    return {
      ...plan,
      id: nanoid(8),
      actions: newActions,
    };
  }

  private swapActions(plan: Plan, pos1: number, pos2: number): Plan {
    const newActions = [...plan.actions];
    [newActions[pos1], newActions[pos2]] = [newActions[pos2], newActions[pos1]];

    return {
      ...plan,
      id: nanoid(8),
      actions: newActions,
    };
  }

  private reorderActions(plan: Plan, suggestion: PlanRepairSuggestion): Plan | null {
    const targetIndex = suggestion.position;
    if (targetIndex === undefined) return null;

    const swapWith = this.swapTargets.get(suggestion) ?? (targetIndex > 0 ? targetIndex - 1 : null);

    if (swapWith === null || swapWith === targetIndex) return null;
    if (swapWith < 0 || swapWith >= plan.actions.length) return null;
    if (targetIndex < 0 || targetIndex >= plan.actions.length) return null;

    return this.swapActions(plan, targetIndex, swapWith);
  }

  private getStateAtPosition(plan: Plan, position: number): PlanState {
    let state = plan.initialState;

    for (let i = 0; i < position && i < plan.actions.length; i++) {
      const action = plan.actions[i];
      const schema = this.registry.get(action.schemaName);

      if (schema) {
        state = applyAction(action, state, schema);
      }
    }

    return state;
  }

  private getFinalState(plan: Plan): PlanState {
    return this.getStateAtPosition(plan, plan.actions.length);
  }

  private countErrors(plan: Plan): number {
    const validation = this.validator.validate(plan);
    return validation.errors.length;
  }

  private generateExplanation(
    original: Plan,
    repaired: Plan,
    suggestions: PlanRepairSuggestion[]
  ): string {
    const lines: string[] = [];
    lines.push('Plan successfully repaired.');
    lines.push('');

    const originalLen = original.actions.length;
    const repairedLen = repaired.actions.length;

    if (repairedLen > originalLen) {
      lines.push(`Added ${repairedLen - originalLen} action(s).`);
    } else if (repairedLen < originalLen) {
      lines.push(`Removed ${originalLen - repairedLen} action(s).`);
    }

    const appliedSuggestions = suggestions.filter((s) => s.confidence >= 0.5);
    if (appliedSuggestions.length > 0) {
      lines.push('');
      lines.push('Applied repairs:');
      for (const s of appliedSuggestions.slice(0, 5)) {
        lines.push(`  - ${s.reason}`);
      }
    }

    return lines.join('\n');
  }

  private generateFailureExplanation(
    validation: PlanValidationResult,
    suggestions: PlanRepairSuggestion[]
  ): string {
    const lines: string[] = [];
    lines.push('Could not fully repair the plan.');
    lines.push('');

    lines.push('Remaining issues:');
    for (const error of validation.errors.slice(0, 5)) {
      lines.push(`  - ${error.message}`);
    }

    if (suggestions.length > 0) {
      lines.push('');
      lines.push('Suggestions for manual repair:');
      for (const s of suggestions.slice(0, 5)) {
        lines.push(`  - ${s.reason} (confidence: ${(s.confidence * 100).toFixed(0)}%)`);
      }
    }

    return lines.join('\n');
  }
}

export function createPlanRepairer(
  registry: ActionRegistry,
  config?: Partial<RepairConfig>
): PlanRepairer {
  return new PlanRepairer(registry, config);
}

export function repairPlan(
  plan: Plan,
  registry: ActionRegistry,
  config?: Partial<RepairConfig>
): PlanRepairResult {
  const repairer = new PlanRepairer(registry, config);
  return repairer.repair(plan);
}

export function formatRepairResult(result: PlanRepairResult): string {
  const lines: string[] = [];

  lines.push(`Plan Repair: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  lines.push('');

  lines.push(result.explanation);
  lines.push('');

  if (result.suggestions.length > 0) {
    lines.push('All suggestions:');
    for (const s of result.suggestions) {
      const conf = (s.confidence * 100).toFixed(0);
      lines.push(`  [${conf}%] ${s.type}: ${s.reason}`);
    }
  }

  return lines.join('\n');
}
