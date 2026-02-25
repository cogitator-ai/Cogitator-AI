import type {
  Plan,
  PlanAction,
  PlanState,
  ActionSchema,
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
      const redundancyWarnings = this.detectRedundantActions(plan, stateTrace);
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

  private detectRedundantActions(plan: Plan, stateTrace: PlanState[]): PlanValidationWarning[] {
    const warnings: PlanValidationWarning[] = [];

    for (let i = 1; i < stateTrace.length; i++) {
      const before = stateTrace[i - 1];
      const after = stateTrace[i];

      const beforeStr = JSON.stringify(before.variables);
      const afterStr = JSON.stringify(after.variables);

      if (beforeStr === afterStr) {
        warnings.push({
          type: 'redundant_action',
          actionIndex: i - 1,
          message: `Action ${plan.actions[i - 1].schemaName} has no effect`,
        });
      }
    }

    return warnings;
  }

  private detectOrderingIssues(plan: Plan): PlanValidationWarning[] {
    const warnings: PlanValidationWarning[] = [];

    const dependencies = this.analyzeDependencies(plan);

    const actionPositions = new Map<string, number>();
    for (let i = 0; i < dependencies.actions.length; i++) {
      if (!actionPositions.has(dependencies.actions[i])) {
        actionPositions.set(dependencies.actions[i], i);
      }
    }

    for (const edge of dependencies.edges) {
      if (edge.type === 'threat') {
        const fromIdx = actionPositions.get(edge.fromAction) ?? -1;
        const toIdx = actionPositions.get(edge.toAction) ?? -1;

        if (fromIdx > toIdx) {
          warnings.push({
            type: 'suboptimal_ordering',
            actionIndex: fromIdx,
            message: `Action ordering may cause issues: ${edge.description}`,
          });
        }
      }
    }

    return warnings;
  }

  analyzeDependencies(plan: Plan): DependencyGraph {
    const actions = plan.actions.map((a) => a.id);
    const edges: DependencyEdge[] = [];

    const producedBy = new Map<string, string[]>();
    const consumedBy = new Map<string, string[]>();

    for (const action of plan.actions) {
      const schema = this.registry.get(action.schemaName);
      if (!schema) continue;

      for (const effect of schema.effects) {
        if (
          effect.type === 'assign' ||
          effect.type === 'increment' ||
          effect.type === 'decrement'
        ) {
          if (!producedBy.has(effect.variable)) {
            producedBy.set(effect.variable, []);
          }
          producedBy.get(effect.variable)!.push(action.id);
        }
      }
    }

    const actionIndex = new Map<string, number>();
    for (let i = 0; i < plan.actions.length; i++) {
      actionIndex.set(plan.actions[i].id, i);
    }

    for (const action of plan.actions) {
      const schema = this.registry.get(action.schemaName);
      if (!schema) continue;

      const consumerIdx = actionIndex.get(action.id)!;

      for (const pre of schema.preconditions) {
        const variables = this.extractVariables(pre);
        for (const variable of variables) {
          if (!consumedBy.has(variable)) {
            consumedBy.set(variable, []);
          }
          consumedBy.get(variable)!.push(action.id);

          const producers = producedBy.get(variable);
          if (producers) {
            let bestProducer: string | undefined;
            let bestIdx = -1;
            for (const p of producers) {
              if (p === action.id) continue;
              const pIdx = actionIndex.get(p)!;
              if (pIdx < consumerIdx && pIdx > bestIdx) {
                bestProducer = p;
                bestIdx = pIdx;
              }
            }

            if (bestProducer) {
              edges.push({
                fromAction: bestProducer,
                toAction: action.id,
                type: 'causal',
                variable,
                description: `${bestProducer} produces ${variable} for ${action.id}`,
              });
            }
          }
        }
      }
    }

    const criticalPath = this.findCriticalPath(actions, edges);
    const parallelizable = this.findParallelizable(actions, edges);

    return {
      actions,
      edges,
      criticalPath,
      parallelizable,
    };
  }

  private extractVariables(precondition: Precondition): string[] {
    switch (precondition.type) {
      case 'simple':
      case 'comparison':
        return [precondition.variable];
      case 'and':
      case 'or':
        return precondition.conditions.flatMap((c) => this.extractVariables(c));
      case 'not':
        return this.extractVariables(precondition.condition);
      case 'exists':
      case 'forall':
        return this.extractVariables(precondition.condition);
      default:
        return [];
    }
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
