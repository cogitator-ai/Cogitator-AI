import type {
  ActionSchema,
  ActionParameter,
  Precondition,
  Effect,
  PlanState,
  PlanAction,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export class ActionSchemaBuilder {
  private name: string;
  private description?: string;
  private parameters: ActionParameter[] = [];
  private preconditions: Precondition[] = [];
  private effects: Effect[] = [];
  private cost?: number;
  private duration?: number;

  constructor(name: string) {
    this.name = name;
  }

  static create(name: string): ActionSchemaBuilder {
    return new ActionSchemaBuilder(name);
  }

  describe(description: string): this {
    this.description = description;
    return this;
  }

  param(name: string, type: string, options: Partial<ActionParameter> = {}): this {
    this.parameters.push({
      name,
      type,
      description: options.description,
      required: options.required ?? true,
      default: options.default,
    });
    return this;
  }

  pre(condition: Precondition): this {
    this.preconditions.push(condition);
    return this;
  }

  preSimple(variable: string, value: unknown): this {
    this.preconditions.push({ type: 'simple', variable, value });
    return this;
  }

  preCompare(
    variable: string,
    operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in',
    value: unknown
  ): this {
    this.preconditions.push({ type: 'comparison', variable, operator, value });
    return this;
  }

  preAnd(...conditions: Precondition[]): this {
    this.preconditions.push({ type: 'and', conditions });
    return this;
  }

  preOr(...conditions: Precondition[]): this {
    this.preconditions.push({ type: 'or', conditions });
    return this;
  }

  preNot(condition: Precondition): this {
    this.preconditions.push({ type: 'not', condition });
    return this;
  }

  effect(effect: Effect): this {
    this.effects.push(effect);
    return this;
  }

  assign(variable: string, value: unknown): this {
    this.effects.push({ type: 'assign', variable, value });
    return this;
  }

  increment(variable: string, amount: number = 1): this {
    this.effects.push({ type: 'increment', variable, amount });
    return this;
  }

  decrement(variable: string, amount: number = 1): this {
    this.effects.push({ type: 'decrement', variable, amount });
    return this;
  }

  delete(variable: string): this {
    this.effects.push({ type: 'delete', variable });
    return this;
  }

  conditional(condition: Precondition, thenEffects: Effect[], elseEffects?: Effect[]): this {
    this.effects.push({
      type: 'conditional',
      condition,
      thenEffects,
      elseEffects,
    });
    return this;
  }

  setCost(cost: number): this {
    this.cost = cost;
    return this;
  }

  setDuration(duration: number): this {
    this.duration = duration;
    return this;
  }

  build(): ActionSchema {
    return {
      name: this.name,
      description: this.description,
      parameters: [...this.parameters],
      preconditions: [...this.preconditions],
      effects: [...this.effects],
      cost: this.cost,
      duration: this.duration,
    };
  }
}

export class ActionRegistry {
  private schemas = new Map<string, ActionSchema>();

  register(schema: ActionSchema): void {
    this.schemas.set(schema.name, schema);
  }

  get(name: string): ActionSchema | undefined {
    return this.schemas.get(name);
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }

  getAll(): ActionSchema[] {
    return Array.from(this.schemas.values());
  }

  getNames(): string[] {
    return Array.from(this.schemas.keys());
  }

  unregister(name: string): boolean {
    return this.schemas.delete(name);
  }

  clear(): void {
    this.schemas.clear();
  }
}

export function createAction(
  schemaName: string,
  parameters: Record<string, unknown>,
  id?: string
): PlanAction {
  return {
    id: id || nanoid(8),
    schemaName,
    parameters,
  };
}

const MAX_DOMAIN_SIZE = 1000;

function resolveDomain(domainRef: string, state: PlanState): unknown[] {
  const value = state.variables[domainRef];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && 'min' in value && 'max' in value) {
    const { min, max } = value as { min: number; max: number };
    const size = Math.min(max - min + 1, MAX_DOMAIN_SIZE);
    return Array.from({ length: size }, (_, i) => min + i);
  }
  return [];
}

export function evaluatePrecondition(
  precondition: Precondition,
  state: PlanState,
  parameters: Record<string, unknown> = {}
): boolean {
  const resolveVariable = (variable: string): unknown => {
    if (variable.startsWith('?')) {
      const paramName = variable.substring(1);
      return parameters[paramName];
    }
    return state.variables[variable];
  };

  const resolveValue = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('?')) {
      const paramName = value.substring(1);
      return parameters[paramName];
    }
    return value;
  };

  switch (precondition.type) {
    case 'simple': {
      const actual = resolveVariable(precondition.variable);
      const expected = resolveValue(precondition.value);
      return actual === expected;
    }

    case 'comparison': {
      const actual = resolveVariable(precondition.variable);
      const expected = resolveValue(precondition.value);

      switch (precondition.operator) {
        case 'eq':
          return actual === expected;
        case 'neq':
          return actual !== expected;
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          if (typeof actual !== 'number' || typeof expected !== 'number') return false;
          switch (precondition.operator) {
            case 'gt':
              return actual > expected;
            case 'gte':
              return actual >= expected;
            case 'lt':
              return actual < expected;
            case 'lte':
              return actual <= expected;
            default:
              return false;
          }
        }
        case 'in':
          return Array.isArray(expected) && expected.includes(actual);
        default:
          return false;
      }
    }

    case 'and':
      return precondition.conditions.every((c) => evaluatePrecondition(c, state, parameters));

    case 'or':
      return precondition.conditions.some((c) => evaluatePrecondition(c, state, parameters));

    case 'not':
      return !evaluatePrecondition(precondition.condition, state, parameters);

    case 'exists': {
      const domain = resolveDomain(precondition.domain, state);
      return domain.some((val) => {
        const extendedState: PlanState = {
          ...state,
          variables: { ...state.variables, [precondition.variable]: val },
        };
        return evaluatePrecondition(precondition.condition, extendedState, parameters);
      });
    }

    case 'forall': {
      const domain = resolveDomain(precondition.domain, state);
      return domain.every((val) => {
        const extendedState: PlanState = {
          ...state,
          variables: { ...state.variables, [precondition.variable]: val },
        };
        return evaluatePrecondition(precondition.condition, extendedState, parameters);
      });
    }

    default:
      return false;
  }
}

export function applyEffect(
  effect: Effect,
  state: PlanState,
  parameters: Record<string, unknown> = {}
): PlanState {
  const newVariables = { ...state.variables };

  const resolveValue = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('?')) {
      const paramName = value.substring(1);
      return parameters[paramName];
    }
    return value;
  };

  const resolveVariable = (variable: string): string => {
    if (variable.startsWith('?')) {
      const paramName = variable.substring(1);
      const resolved = parameters[paramName];
      return typeof resolved === 'string' ? resolved : variable;
    }
    return variable;
  };

  switch (effect.type) {
    case 'assign': {
      const varName = resolveVariable(effect.variable);
      newVariables[varName] = resolveValue(effect.value);
      break;
    }

    case 'increment': {
      const varName = resolveVariable(effect.variable);
      const current = newVariables[varName];
      const num = typeof current === 'number' ? current : 0;
      newVariables[varName] = num + effect.amount;
      break;
    }

    case 'decrement': {
      const varName = resolveVariable(effect.variable);
      const current = newVariables[varName];
      const num = typeof current === 'number' ? current : 0;
      newVariables[varName] = num - effect.amount;
      break;
    }

    case 'delete': {
      const varName = resolveVariable(effect.variable);
      delete newVariables[varName];
      break;
    }

    case 'conditional': {
      if (evaluatePrecondition(effect.condition, state, parameters)) {
        let currentState: PlanState = { ...state, variables: newVariables };
        for (const thenEffect of effect.thenEffects) {
          currentState = applyEffect(thenEffect, currentState, parameters);
        }
        return currentState;
      } else if (effect.elseEffects) {
        let currentState: PlanState = { ...state, variables: newVariables };
        for (const elseEffect of effect.elseEffects) {
          currentState = applyEffect(elseEffect, currentState, parameters);
        }
        return currentState;
      }
      break;
    }
  }

  return {
    ...state,
    id: nanoid(8),
    variables: newVariables,
    timestamp: new Date(),
  };
}

export function applyAction(action: PlanAction, state: PlanState, schema: ActionSchema): PlanState {
  let currentState = state;

  for (const effect of schema.effects) {
    currentState = applyEffect(effect, currentState, action.parameters);
  }

  return currentState;
}

export function schemaToString(schema: ActionSchema): string {
  const lines: string[] = [];

  lines.push(`Action: ${schema.name}`);

  if (schema.description) {
    lines.push(`  Description: ${schema.description}`);
  }

  if (schema.parameters.length > 0) {
    lines.push('  Parameters:');
    for (const param of schema.parameters) {
      const required = param.required ? '' : ' (optional)';
      const defaultVal = param.default !== undefined ? ` = ${param.default}` : '';
      lines.push(`    - ${param.name}: ${param.type}${required}${defaultVal}`);
    }
  }

  if (schema.preconditions.length > 0) {
    lines.push('  Preconditions:');
    for (const pre of schema.preconditions) {
      lines.push(`    - ${preconditionToString(pre)}`);
    }
  }

  if (schema.effects.length > 0) {
    lines.push('  Effects:');
    for (const eff of schema.effects) {
      lines.push(`    - ${effectToString(eff)}`);
    }
  }

  if (schema.cost !== undefined) {
    lines.push(`  Cost: ${schema.cost}`);
  }

  if (schema.duration !== undefined) {
    lines.push(`  Duration: ${schema.duration}`);
  }

  return lines.join('\n');
}

export function preconditionToString(pre: Precondition): string {
  switch (pre.type) {
    case 'simple':
      return `${pre.variable} = ${JSON.stringify(pre.value)}`;

    case 'comparison': {
      const op = {
        eq: '=',
        neq: '≠',
        gt: '>',
        gte: '≥',
        lt: '<',
        lte: '≤',
        in: '∈',
      }[pre.operator];
      return `${pre.variable} ${op} ${JSON.stringify(pre.value)}`;
    }

    case 'and':
      return `(${pre.conditions.map(preconditionToString).join(' ∧ ')})`;

    case 'or':
      return `(${pre.conditions.map(preconditionToString).join(' ∨ ')})`;

    case 'not':
      return `¬(${preconditionToString(pre.condition)})`;

    case 'exists':
      return `∃${pre.variable} ∈ ${pre.domain}: ${preconditionToString(pre.condition)}`;

    case 'forall':
      return `∀${pre.variable} ∈ ${pre.domain}: ${preconditionToString(pre.condition)}`;

    default:
      return 'unknown';
  }
}

export function effectToString(eff: Effect): string {
  switch (eff.type) {
    case 'assign':
      return `${eff.variable} := ${JSON.stringify(eff.value)}`;

    case 'increment':
      return `${eff.variable} += ${eff.amount}`;

    case 'decrement':
      return `${eff.variable} -= ${eff.amount}`;

    case 'delete':
      return `delete ${eff.variable}`;

    case 'conditional': {
      const thenStr = eff.thenEffects.map(effectToString).join('; ');
      const elseStr = eff.elseEffects
        ? ` else { ${eff.elseEffects.map(effectToString).join('; ')} }`
        : '';
      return `if (${preconditionToString(eff.condition)}) { ${thenStr} }${elseStr}`;
    }

    default:
      return 'unknown';
  }
}

export function actionToString(action: PlanAction, _schema?: ActionSchema): string {
  const params = Object.entries(action.parameters)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');

  return `${action.schemaName}(${params})`;
}
