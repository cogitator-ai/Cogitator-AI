import type {
  Plan,
  PlanAction,
  PlanState,
  ActionSchema,
  Effect,
  Precondition,
  PlanValidationResult,
  PlanValidationError,
  PlanValidationWarning,
  DependencyGraph,
  DependencyEdge,
} from '@cogitator-ai/types';
import {
  ActionRegistry,
  evaluatePrecondition,
  applyAction,
  preconditionToString,
} from './action-schema';

export interface ValidationConfig {
  checkPreconditions: boolean;
  checkGoals: boolean;
  detectRedundancy: boolean;
  detectOrdering: boolean;
  maxSteps: number;
}

const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  checkPreconditions: true,
  checkGoals: true,
  detectRedundancy: true,
  detectOrdering: true,
  maxSteps: 1000,
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function resolveEffectVariable(variable: string, parameters: Record<string, unknown>): string {
  if (!variable.startsWith('?')) return variable;
  const value = parameters[variable.substring(1)];
  return typeof value === 'string' ? value : variable;
}

function collectEffectVariables(
  effects: Effect[],
  parameters: Record<string, unknown>
): { written: string[]; deleted: string[] } {
  const written: string[] = [];
  const deleted: string[] = [];

  for (const effect of effects) {
    switch (effect.type) {
      case 'assign':
      case 'increment':
      case 'decrement':
        written.push(resolveEffectVariable(effect.variable, parameters));
        break;
      case 'delete':
        deleted.push(resolveEffectVariable(effect.variable, parameters));
        break;
      case 'conditional': {
        const branches = [effect.thenEffects, effect.elseEffects ?? []];
        for (const branch of branches) {
          const nested = collectEffectVariables(branch, parameters);
          written.push(...nested.written);
          deleted.push(...nested.deleted);
        }
        break;
      }
    }
  }

  return { written: unique(written), deleted: unique(deleted) };
}

function collectPreconditionVariables(precondition: Precondition, bound: Set<string>): string[] {
  switch (precondition.type) {
    case 'simple':
    case 'comparison':
      return precondition.variable.startsWith('?') || bound.has(precondition.variable)
        ? []
        : [precondition.variable];
    case 'and':
    case 'or':
      return precondition.conditions.flatMap((c) => collectPreconditionVariables(c, bound));
    case 'not':
      return collectPreconditionVariables(precondition.condition, bound);
    case 'exists':
    case 'forall': {
      const inner = new Set(bound);
      inner.add(precondition.variable);
      return [precondition.domain, ...collectPreconditionVariables(precondition.condition, inner)];
    }
    default:
      return [];
  }
}

export class PlanValidator {
  private registry: ActionRegistry;
  private config: ValidationConfig;

  constructor(registry: ActionRegistry, config: Partial<ValidationConfig> = {}) {
    this.registry = registry;
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
  }

  validate(plan: Plan): PlanValidationResult {
    const errors: PlanValidationError[] = [];
    const warnings: PlanValidationWarning[] = [];
    const stateTrace: PlanState[] = [plan.initialState];
    const appliedActionIndices: number[] = [];

    let currentState = plan.initialState;

    for (let i = 0; i < plan.actions.length; i++) {
      if (i >= this.config.maxSteps) {
        errors.push({
          type: 'goal_unreachable',
          message: `Plan exceeds maximum steps (${this.config.maxSteps})`,
        });
        break;
      }

      const action = plan.actions[i];
      const schema = this.registry.get(action.schemaName);

      if (!schema) {
        errors.push({
          type: 'undefined_action',
          actionIndex: i,
          actionName: action.schemaName,
          message: `Unknown action schema: ${action.schemaName}`,
        });
        continue;
      }

      const paramErrors = this.validateParameters(action, schema, i);
      errors.push(...paramErrors);

      if (paramErrors.length > 0) {
        continue;
      }

      if (this.config.checkPreconditions) {
        const preErrors = this.validatePreconditions(action, schema, currentState, i);
        errors.push(...preErrors);

        if (preErrors.length > 0) {
          continue;
        }
      }

      currentState = applyAction(action, currentState, schema);
      stateTrace.push(currentState);
      appliedActionIndices.push(i);
    }

    const satisfiedGoals: string[] = [];
    const unsatisfiedGoals: string[] = [];

    if (this.config.checkGoals) {
      for (const goal of plan.goalConditions) {
        const goalStr = preconditionToString(goal);
        if (evaluatePrecondition(goal, currentState)) {
          satisfiedGoals.push(goalStr);
        } else {
          unsatisfiedGoals.push(goalStr);
          errors.push({
            type: 'goal_unreachable',
            message: `Goal not satisfied: ${goalStr}`,
            details: { goal },
          });
        }
      }
    }

    if (this.config.detectRedundancy) {
      const redundancyWarnings = this.detectRedundantActions(
        plan,
        stateTrace,
        appliedActionIndices
      );
      warnings.push(...redundancyWarnings);
    }

    if (this.config.detectOrdering) {
      const orderingWarnings = this.detectOrderingIssues(plan);
      warnings.push(...orderingWarnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      stateTrace,
      satisfiedGoals,
      unsatisfiedGoals,
    };
  }

  private validateParameters(
    action: PlanAction,
    schema: ActionSchema,
    actionIndex: number
  ): PlanValidationError[] {
    const errors: PlanValidationError[] = [];

    for (const param of schema.parameters) {
      if (param.required && !(param.name in action.parameters)) {
        errors.push({
          type: 'missing_parameter',
          actionIndex,
          actionName: action.schemaName,
          message: `Missing required parameter: ${param.name}`,
          details: { parameter: param.name },
        });
      }
    }

    for (const paramName of Object.keys(action.parameters)) {
      const param = schema.parameters.find((p) => p.name === paramName);
      if (!param) {
        errors.push({
          type: 'invalid_parameter',
          actionIndex,
          actionName: action.schemaName,
          message: `Unknown parameter: ${paramName}`,
          details: { parameter: paramName },
        });
      }
    }

    return errors;
  }

  private validatePreconditions(
    action: PlanAction,
    schema: ActionSchema,
    state: PlanState,
    actionIndex: number
  ): PlanValidationError[] {
    const errors: PlanValidationError[] = [];

    for (const precondition of schema.preconditions) {
      if (!evaluatePrecondition(precondition, state, action.parameters)) {
        errors.push({
          type: 'precondition_violated',
          actionIndex,
          actionName: action.schemaName,
          message: `Precondition not satisfied: ${preconditionToString(precondition)}`,
          details: {
            precondition,
            state: state.variables,
          },
        });
      }
    }

    return errors;
  }

  private detectRedundantActions(
    plan: Plan,
    stateTrace: PlanState[],
    appliedActionIndices: number[]
  ): PlanValidationWarning[] {
    const warnings: PlanValidationWarning[] = [];

    for (let i = 1; i < stateTrace.length; i++) {
      const before = stateTrace[i - 1];
      const after = stateTrace[i];

      const beforeStr = JSON.stringify(before.variables);
      const afterStr = JSON.stringify(after.variables);

      if (beforeStr === afterStr) {
        const actionIdx = appliedActionIndices[i - 1];
        warnings.push({
          type: 'redundant_action',
          actionIndex: actionIdx,
          message: `Action ${plan.actions[actionIdx].schemaName} has no effect`,
        });
      }
    }

    return warnings;
  }

  private detectOrderingIssues(plan: Plan): PlanValidationWarning[] {
    const dependencies = this.analyzeDependencies(plan);
    const indexById = new Map(plan.actions.map((action, index) => [action.id, index]));

    return dependencies.edges
      .filter((edge) => edge.type === 'threat')
      .map((edge) => ({
        type: 'suboptimal_ordering' as const,
        actionIndex: indexById.get(edge.fromAction),
        message: `Action ordering may cause issues: ${edge.description}`,
      }));
  }

  analyzeDependencies(plan: Plan): DependencyGraph {
    const actions = plan.actions.map((a) => a.id);
    const edges: DependencyEdge[] = [];

    const footprints = plan.actions.map((action) => {
      const schema = this.registry.get(action.schemaName);
      if (!schema) return null;
      return {
        ...collectEffectVariables(schema.effects, action.parameters),
        reads: unique(
          schema.preconditions.flatMap((pre) => collectPreconditionVariables(pre, new Set()))
        ),
      };
    });

    plan.actions.forEach((consumer, consumerIdx) => {
      const footprint = footprints[consumerIdx];
      if (!footprint) return;

      for (const variable of footprint.reads) {
        for (let i = consumerIdx - 1; i >= 0; i--) {
          const candidate = footprints[i];
          if (!candidate) continue;

          if (candidate.written.includes(variable)) {
            edges.push({
              fromAction: plan.actions[i].id,
              toAction: consumer.id,
              type: 'causal',
              variable,
              description: `${plan.actions[i].id} produces ${variable} for ${consumer.id}`,
            });
            break;
          }

          if (candidate.deleted.includes(variable)) {
            edges.push({
              fromAction: plan.actions[i].id,
              toAction: consumer.id,
              type: 'threat',
              variable,
              description:
                `${plan.actions[i].schemaName} (action ${i}) deletes '${variable}' ` +
                `required by ${consumer.schemaName} (action ${consumerIdx})`,
            });
            break;
          }
        }
      }
    });

    const criticalPath = this.findCriticalPath(actions, edges);
    const parallelizable = this.findParallelizable(actions, edges);

    return {
      actions,
      edges,
      criticalPath,
      parallelizable,
    };
  }

  private findCriticalPath(actions: string[], edges: DependencyEdge[]): string[] {
    const inDegree = new Map<string, number>();
    const outEdges = new Map<string, string[]>();

    for (const action of actions) {
      inDegree.set(action, 0);
      outEdges.set(action, []);
    }

    for (const edge of edges) {
      if (edge.type === 'causal' || edge.type === 'ordering') {
        inDegree.set(edge.toAction, (inDegree.get(edge.toAction) || 0) + 1);
        outEdges.get(edge.fromAction)?.push(edge.toAction);
      }
    }

    const distance = new Map<string, number>();
    const predecessor = new Map<string, string>();

    for (const action of actions) {
      distance.set(action, 0);
    }

    const queue = actions.filter((a) => inDegree.get(a) === 0);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDist = distance.get(current) || 0;

      for (const next of outEdges.get(current) || []) {
        const newDist = currentDist + 1;
        if (newDist > (distance.get(next) || 0)) {
          distance.set(next, newDist);
          predecessor.set(next, current);
        }

        const newInDegree = (inDegree.get(next) || 0) - 1;
        inDegree.set(next, newInDegree);

        if (newInDegree === 0) {
          queue.push(next);
        }
      }
    }

    let maxDist = 0;
    let endAction = actions[0];

    for (const [action, dist] of distance) {
      if (dist > maxDist) {
        maxDist = dist;
        endAction = action;
      }
    }

    const path: string[] = [];
    let current: string | undefined = endAction;

    while (current) {
      path.unshift(current);
      current = predecessor.get(current);
    }

    return path;
  }

  private findParallelizable(actions: string[], edges: DependencyEdge[]): string[][] {
    const dependencies = new Set<string>();

    for (const edge of edges) {
      if (edge.type === 'causal' || edge.type === 'ordering') {
        dependencies.add(`${edge.fromAction}->${edge.toAction}`);
      }
    }

    const groups: string[][] = [];
    const assigned = new Set<string>();

    for (const action of actions) {
      if (assigned.has(action)) continue;

      const group = [action];
      assigned.add(action);

      for (const other of actions) {
        if (assigned.has(other)) continue;

        let canAdd = true;
        for (const groupMember of group) {
          if (
            dependencies.has(`${groupMember}->${other}`) ||
            dependencies.has(`${other}->${groupMember}`)
          ) {
            canAdd = false;
            break;
          }
        }

        if (canAdd) {
          group.push(other);
          assigned.add(other);
        }
      }

      if (group.length > 1) {
        groups.push(group);
      }
    }

    return groups;
  }
}

export function validatePlan(
  plan: Plan,
  registry: ActionRegistry,
  config?: Partial<ValidationConfig>
): PlanValidationResult {
  const validator = new PlanValidator(registry, config);
  return validator.validate(plan);
}

export function simulatePlan(
  plan: Plan,
  registry: ActionRegistry
): { success: boolean; finalState: PlanState; stateTrace: PlanState[] } {
  const stateTrace: PlanState[] = [plan.initialState];
  let currentState = plan.initialState;

  for (const action of plan.actions) {
    const schema = registry.get(action.schemaName);
    if (!schema) {
      return { success: false, finalState: currentState, stateTrace };
    }

    const preOk = schema.preconditions.every((pre) =>
      evaluatePrecondition(pre, currentState, action.parameters)
    );

    if (!preOk) {
      return { success: false, finalState: currentState, stateTrace };
    }

    currentState = applyAction(action, currentState, schema);
    stateTrace.push(currentState);
  }

  const goalsOk = plan.goalConditions.every((goal) => evaluatePrecondition(goal, currentState));

  return {
    success: goalsOk,
    finalState: currentState,
    stateTrace,
  };
}

export function formatValidationResult(result: PlanValidationResult): string {
  const lines: string[] = [];

  lines.push(`Validation ${result.valid ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`);
    for (const error of result.errors) {
      const location = error.actionIndex !== undefined ? ` [action ${error.actionIndex}]` : '';
      lines.push(`  ✗ ${error.type}${location}: ${error.message}`);
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const warning of result.warnings) {
      const location = warning.actionIndex !== undefined ? ` [action ${warning.actionIndex}]` : '';
      lines.push(`  ⚠ ${warning.type}${location}: ${warning.message}`);
    }
    lines.push('');
  }

  if (result.satisfiedGoals.length > 0) {
    lines.push('Satisfied goals:');
    for (const goal of result.satisfiedGoals) {
      lines.push(`  ✓ ${goal}`);
    }
  }

  if (result.unsatisfiedGoals.length > 0) {
    lines.push('Unsatisfied goals:');
    for (const goal of result.unsatisfiedGoals) {
      lines.push(`  ✗ ${goal}`);
    }
  }

  return lines.join('\n');
}
