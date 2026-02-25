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
import { ActionRegistry, applyAction, createAction } from './action-schema';
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

export class PlanRepairer {
  private registry: ActionRegistry;
  private validator: PlanValidator;
  private config: RepairConfig;

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
          error.details?.precondition as Precondition
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
        suggestions.push({
          type: 'modify',
          position: error.actionIndex,
          reason: error.message,
          confidence: 0.5,
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
    precondition: Precondition
  ): PlanRepairSuggestion[] {
    const suggestions: PlanRepairSuggestion[] = [];

    const stateBeforeAction = this.getStateAtPosition(plan, position);

    for (const schema of this.registry.getAll()) {
      const wouldHelp = this.schemaCouldEstablish(schema, precondition);

      if (wouldHelp) {
        const action = this.createActionFromSchema(schema, stateBeforeAction);

        if (action) {
          suggestions.push({
            type: 'insert',
            position,
            action,
            reason: `Insert ${schema.name} to establish precondition`,
            confidence: 0.7,
          });
        }
      }
    }

    return suggestions;
  }

  private suggestReorders(plan: Plan, problemPosition: number): PlanRepairSuggestion[] {
    const suggestions: PlanRepairSuggestion[] = [];
    const originalErrorCount = this.countErrors(plan);

    for (let i = 0; i < plan.actions.length; i++) {
      if (i === problemPosition) continue;

      const swappedPlan = this.swapActions(plan, i, problemPosition);
      const validation = this.validator.validate(swappedPlan);

      if (validation.errors.length < originalErrorCount) {
        suggestions.push({
          type: 'reorder',
          position: problemPosition,
          reason: `Swap action ${problemPosition} with action ${i}`,
          confidence: 0.5,
        });
      }
    }

    return suggestions;
  }

  private suggestActionsForGoal(plan: Plan, goal?: Precondition): PlanRepairSuggestion[] {
    const suggestions: PlanRepairSuggestion[] = [];

    if (!goal) return suggestions;

    const finalState = this.getFinalState(plan);

    for (const schema of this.registry.getAll()) {
      if (this.schemaCouldEstablish(schema, goal)) {
        const action = this.createActionFromSchema(schema, finalState);

        if (action) {
          suggestions.push({
            type: 'insert',
            position: plan.actions.length,
            action,
            reason: `Append ${schema.name} to achieve goal`,
            confidence: 0.6,
          });
        }
      }
    }

    return suggestions;
  }

  private schemaCouldEstablish(schema: ActionSchema, precondition: Precondition): boolean {
    const varName =
      precondition.type === 'simple' || precondition.type === 'comparison'
        ? precondition.variable
        : undefined;

    if (!varName) return false;

    return this.effectsTouchVariable(schema.effects, varName);
  }

  private effectsTouchVariable(effects: Effect[], varName: string): boolean {
    for (const effect of effects) {
      if (effect.type === 'conditional') {
        if (this.effectsTouchVariable(effect.thenEffects, varName)) return true;
        if (effect.elseEffects && this.effectsTouchVariable(effect.elseEffects, varName))
          return true;
      } else if (effect.variable === varName) {
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
    let currentErrorCount = validation.errors.length;
    let insertions = 0;
    let removals = 0;
    let iterations = 0;

    for (const suggestion of suggestions) {
      if (iterations >= this.config.maxIterations) break;
      iterations++;

      let newPlan: Plan | null = null;

      switch (suggestion.type) {
        case 'insert':
          if (insertions < this.config.maxInsertions && suggestion.action) {
            newPlan = this.insertAction(currentPlan, suggestion.position!, suggestion.action);
            insertions++;
          }
          break;

        case 'remove':
          if (removals < this.config.maxRemovals) {
            newPlan = this.removeAction(currentPlan, suggestion.position!);
            removals++;
          }
          break;

        case 'reorder':
          newPlan = this.reorderActions(currentPlan, suggestion);
          break;
      }

      if (newPlan) {
        const newValidation = this.validator.validate(newPlan);

        if (newValidation.valid) {
          return newPlan;
        }

        if (newValidation.errors.length < currentErrorCount) {
          currentPlan = newPlan;
          currentErrorCount = newValidation.errors.length;
        }
      }
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
    if (targetIndex === undefined || targetIndex <= 0) return null;
    const reordered = [...plan.actions];
    [reordered[targetIndex - 1], reordered[targetIndex]] = [
      reordered[targetIndex],
      reordered[targetIndex - 1],
    ];
    return { ...plan, id: nanoid(8), actions: reordered };
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
