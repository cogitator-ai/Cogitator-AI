import type {
  Plan,
  PlanState,
  PlanAction,
  SafetyProperty,
  Precondition,
  InvariantCheckResult,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { ActionRegistry, evaluatePrecondition, applyAction } from './action-schema';

export interface InvariantCheckerConfig {
  checkInvariants: boolean;
  checkEventually: boolean;
  checkAlways: boolean;
  maxSteps: number;
}

const DEFAULT_CONFIG: InvariantCheckerConfig = {
  checkInvariants: true,
  checkEventually: true,
  checkAlways: true,
  maxSteps: 1000,
};

export class InvariantChecker {
  private registry: ActionRegistry;
  private properties: SafetyProperty[] = [];
  private config: InvariantCheckerConfig;

  constructor(registry: ActionRegistry, config: Partial<InvariantCheckerConfig> = {}) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  addProperty(property: SafetyProperty): void {
    this.properties.push(property);
  }

  addInvariant(name: string, condition: Precondition, description?: string): string {
    const id = nanoid(8);
    this.properties.push({
      id,
      name,
      description,
      type: 'invariant',
      condition,
    });
    return id;
  }

  addEventually(name: string, condition: Precondition, description?: string): string {
    const id = nanoid(8);
    this.properties.push({
      id,
      name,
      description,
      type: 'eventually',
      condition,
    });
    return id;
  }

  addAlways(name: string, condition: Precondition, description?: string): string {
    const id = nanoid(8);
    this.properties.push({
      id,
      name,
      description,
      type: 'always',
      condition,
    });
    return id;
  }

  addNever(name: string, condition: Precondition, description?: string): string {
    const id = nanoid(8);
    this.properties.push({
      id,
      name,
      description,
      type: 'never',
      condition,
    });
    return id;
  }

  removeProperty(id: string): boolean {
    const index = this.properties.findIndex((p) => p.id === id);
    if (index !== -1) {
      this.properties.splice(index, 1);
      return true;
    }
    return false;
  }

  getProperties(): SafetyProperty[] {
    return [...this.properties];
  }

  checkPlan(plan: Plan): InvariantCheckResult[] {
    const results: InvariantCheckResult[] = [];
    const stateTrace = this.simulatePlan(plan);

    const propertiesToCheck = this.properties.filter((p) => {
      if (p.type === 'invariant' && !this.config.checkInvariants) return false;
      if (p.type === 'eventually' && !this.config.checkEventually) return false;
      if (p.type === 'always' && !this.config.checkAlways) return false;
      return true;
    });

    for (const property of propertiesToCheck) {
      const result = this.checkProperty(property, stateTrace, plan.actions);
      results.push(result);
    }

    return results;
  }

  private simulatePlan(plan: Plan): PlanState[] {
    const stateTrace: PlanState[] = [plan.initialState];
    let currentState = plan.initialState;

    for (let i = 0; i < plan.actions.length && i < this.config.maxSteps; i++) {
      const action = plan.actions[i];
      const schema = this.registry.get(action.schemaName);

      if (!schema) {
        break;
      }

      currentState = applyAction(action, currentState, schema);
      stateTrace.push(currentState);
    }

    return stateTrace;
  }

  private checkProperty(
    property: SafetyProperty,
    stateTrace: PlanState[],
    actions: PlanAction[]
  ): InvariantCheckResult {
    switch (property.type) {
      case 'invariant':
      case 'always':
        return this.checkAlwaysProperty(property, stateTrace, actions);

      case 'eventually':
        return this.checkEventuallyProperty(property, stateTrace);

      case 'never':
        return this.checkNeverProperty(property, stateTrace, actions);

      case 'until':
        return this.checkUntilProperty(property, stateTrace, actions);

      default:
        return {
          property,
          satisfied: false,
          violatingStates: [],
        };
    }
  }

  private checkAlwaysProperty(
    property: SafetyProperty,
    stateTrace: PlanState[],
    actions: PlanAction[]
  ): InvariantCheckResult {
    const violatingStates: PlanState[] = [];
    const counterexample: PlanAction[] = [];

    for (let i = 0; i < stateTrace.length; i++) {
      const state = stateTrace[i];

      if (!evaluatePrecondition(property.condition, state)) {
        violatingStates.push(state);

        if (counterexample.length === 0 && i > 0) {
          counterexample.push(...actions.slice(0, i));
        }
      }
    }

    return {
      property,
      satisfied: violatingStates.length === 0,
      violatingStates: violatingStates.length > 0 ? violatingStates : undefined,
      counterexample: counterexample.length > 0 ? counterexample : undefined,
    };
  }

  private checkEventuallyProperty(
    property: SafetyProperty,
    stateTrace: PlanState[]
  ): InvariantCheckResult {
    for (const state of stateTrace) {
      if (evaluatePrecondition(property.condition, state)) {
        return {
          property,
          satisfied: true,
        };
      }
    }

    return {
      property,
      satisfied: false,
      violatingStates: stateTrace,
    };
  }

  private checkNeverProperty(
    property: SafetyProperty,
    stateTrace: PlanState[],
    actions: PlanAction[]
  ): InvariantCheckResult {
    for (let i = 0; i < stateTrace.length; i++) {
      const state = stateTrace[i];

      if (evaluatePrecondition(property.condition, state)) {
        return {
          property,
          satisfied: false,
          violatingStates: [state],
          counterexample: i > 0 ? actions.slice(0, i) : undefined,
        };
      }
    }

    return {
      property,
      satisfied: true,
    };
  }

  private checkUntilProperty(
    property: SafetyProperty,
    stateTrace: PlanState[],
    actions: PlanAction[]
  ): InvariantCheckResult {
    const condition = property.condition;

    if (condition.type === 'and' && condition.conditions.length >= 2) {
      const holdCondition = condition.conditions[0];
      const untilCondition = condition.conditions[1];

      for (let i = 0; i < stateTrace.length; i++) {
        if (evaluatePrecondition(untilCondition, stateTrace[i])) {
          return { property, satisfied: true };
        }
        if (!evaluatePrecondition(holdCondition, stateTrace[i])) {
          return {
            property,
            satisfied: false,
            violatingStates: [stateTrace[i]],
            counterexample: i > 0 ? actions.slice(0, i) : undefined,
          };
        }
      }

      return {
        property,
        satisfied: false,
        violatingStates: stateTrace,
      };
    }

    for (const state of stateTrace) {
      if (evaluatePrecondition(condition, state)) {
        return { property, satisfied: true };
      }
    }

    return {
      property,
      satisfied: false,
      violatingStates: stateTrace,
    };
  }

  checkState(state: PlanState): { property: SafetyProperty; violated: boolean }[] {
    const results: { property: SafetyProperty; violated: boolean }[] = [];

    for (const property of this.properties) {
      if (property.type === 'invariant' || property.type === 'always') {
        const satisfied = evaluatePrecondition(property.condition, state);
        results.push({ property, violated: !satisfied });
      }

      if (property.type === 'never') {
        const violated = evaluatePrecondition(property.condition, state);
        results.push({ property, violated });
      }
    }

    return results;
  }
}

export function createInvariantChecker(
  registry: ActionRegistry,
  config?: Partial<InvariantCheckerConfig>
): InvariantChecker {
  return new InvariantChecker(registry, config);
}

export function formatInvariantResults(results: InvariantCheckResult[]): string {
  const lines: string[] = [];

  const satisfied = results.filter((r) => r.satisfied);
  const violated = results.filter((r) => !r.satisfied);

  lines.push(`Safety Check: ${violated.length === 0 ? 'PASSED' : 'FAILED'}`);
  lines.push(`  ${satisfied.length} properties satisfied`);
  lines.push(`  ${violated.length} properties violated`);
  lines.push('');

  if (violated.length > 0) {
    lines.push('Violated Properties:');

    for (const result of violated) {
      lines.push(`  ✗ ${result.property.name} (${result.property.type})`);

      if (result.property.description) {
        lines.push(`    ${result.property.description}`);
      }

      if (result.violatingStates && result.violatingStates.length > 0) {
        lines.push(`    Violated in ${result.violatingStates.length} state(s)`);
      }

      if (result.counterexample && result.counterexample.length > 0) {
        lines.push(
          `    Counterexample: ${result.counterexample.map((a) => a.schemaName).join(' → ')}`
        );
      }
    }
    lines.push('');
  }

  if (satisfied.length > 0) {
    lines.push('Satisfied Properties:');

    for (const result of satisfied) {
      lines.push(`  ✓ ${result.property.name} (${result.property.type})`);
    }
  }

  return lines.join('\n');
}

export function commonSafetyProperties(): {
  name: string;
  description: string;
  createCondition: (variable: string, value?: unknown) => Precondition;
}[] {
  return [
    {
      name: 'Non-negative',
      description: 'Variable must never be negative',
      createCondition: (variable: string) => ({
        type: 'comparison',
        variable,
        operator: 'gte',
        value: 0,
      }),
    },
    {
      name: 'Bounded',
      description: 'Variable must stay within bounds',
      createCondition: (variable: string, value?: unknown) => {
        if (!value || typeof value !== 'object') {
          return { type: 'simple', variable, value: undefined };
        }
        const bounds = value as { min: number; max: number };
        if (typeof bounds.min !== 'number' || typeof bounds.max !== 'number') {
          return { type: 'simple', variable, value: undefined };
        }
        return {
          type: 'and',
          conditions: [
            { type: 'comparison', variable, operator: 'gte', value: bounds.min },
            { type: 'comparison', variable, operator: 'lte', value: bounds.max },
          ],
        };
      },
    },
    {
      name: 'Defined',
      description: 'Variable must be defined (not undefined)',
      createCondition: (variable: string) => ({
        type: 'comparison',
        variable,
        operator: 'neq',
        value: undefined,
      }),
    },
    {
      name: 'Boolean',
      description: 'Variable must be true or false',
      createCondition: (variable: string) => ({
        type: 'or',
        conditions: [
          { type: 'simple', variable, value: true },
          { type: 'simple', variable, value: false },
        ],
      }),
    },
    {
      name: 'Mutex',
      description: 'At most one of the variables can be true',
      createCondition: (_variable: string, value?: unknown) => {
        if (!Array.isArray(value)) {
          return { type: 'and', conditions: [] };
        }
        const vars = value as string[];
        const conditions: Precondition[] = [];

        for (let i = 0; i < vars.length; i++) {
          for (let j = i + 1; j < vars.length; j++) {
            conditions.push({
              type: 'not',
              condition: {
                type: 'and',
                conditions: [
                  { type: 'simple', variable: vars[i], value: true },
                  { type: 'simple', variable: vars[j], value: true },
                ],
              },
            });
          }
        }

        return { type: 'and', conditions };
      },
    },
  ];
}
