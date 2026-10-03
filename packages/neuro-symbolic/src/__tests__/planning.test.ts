import { describe, it, expect, beforeEach } from 'vitest';
import type { ActionSchema, Plan, PlanState, Precondition } from '@cogitator-ai/types';
import {
  ActionRegistry,
  createAction,
  applyAction,
  evaluatePrecondition,
  schemaToString,
  actionToString,
} from '../planning/action-schema';
import { PlanValidator, validatePlan } from '../planning/plan-validator';
import { InvariantChecker, createInvariantChecker } from '../planning/invariant-checker';
import { PlanRepairer, repairPlan } from '../planning/plan-repair';

const createMoveSchema = (): ActionSchema => ({
  name: 'move',
  description: 'Move robot from one location to another',
  parameters: [
    { name: 'from', type: 'string', required: true },
    { name: 'to', type: 'string', required: true },
  ],
  preconditions: [{ type: 'simple', variable: 'robot_at', value: '?from' }],
  effects: [{ type: 'assign', variable: 'robot_at', value: '?to' }],
});

const createPickupSchema = (): ActionSchema => ({
  name: 'pickup',
  description: 'Pick up an object',
  parameters: [
    { name: 'obj', type: 'string', required: true },
    { name: 'loc', type: 'string', required: true },
  ],
  preconditions: [
    { type: 'simple', variable: 'robot_at', value: '?loc' },
    { type: 'simple', variable: 'holding', value: null },
  ],
  effects: [{ type: 'assign', variable: 'holding', value: '?obj' }],
});

const createDropSchema = (): ActionSchema => ({
  name: 'drop',
  description: 'Drop an object',
  parameters: [{ name: 'loc', type: 'string', required: true }],
  preconditions: [
    { type: 'simple', variable: 'robot_at', value: '?loc' },
    { type: 'comparison', variable: 'holding', operator: 'neq', value: null },
  ],
  effects: [{ type: 'assign', variable: 'holding', value: null }],
});

describe('ActionRegistry', () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
  });

  it('registers action schema', () => {
    const schema = createMoveSchema();
    registry.register(schema);
    expect(registry.has('move')).toBe(true);
  });

  it('retrieves registered schema', () => {
    const schema = createMoveSchema();
    registry.register(schema);
    const retrieved = registry.get('move');
    expect(retrieved).toEqual(schema);
  });

  it('returns undefined for unregistered action', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered actions', () => {
    registry.register(createMoveSchema());
    registry.register(createPickupSchema());

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.name)).toContain('move');
    expect(all.map((a) => a.name)).toContain('pickup');
  });

  it('clears all actions', () => {
    registry.register(createMoveSchema());
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });
});

describe('createAction', () => {
  it('creates action with parameters', () => {
    const action = createAction('move', { from: 'A', to: 'B' });
    expect(action.schemaName).toBe('move');
    expect(action.parameters.from).toBe('A');
    expect(action.parameters.to).toBe('B');
  });

  it('creates action with unique id', () => {
    const action1 = createAction('move', { from: 'A', to: 'B' });
    const action2 = createAction('move', { from: 'A', to: 'B' });
    expect(action1.id).not.toBe(action2.id);
  });
});

describe('evaluatePrecondition', () => {
  const state: PlanState = {
    id: 'state-0',
    variables: {
      robot_at: 'A',
      holding: null,
      count: 5,
      flag: true,
    },
  };

  it('evaluates simple equality', () => {
    const precond: Precondition = { type: 'simple', variable: 'robot_at', value: 'A' };
    expect(evaluatePrecondition(precond, state)).toBe(true);
  });

  it('evaluates simple inequality', () => {
    const precond: Precondition = { type: 'simple', variable: 'robot_at', value: 'B' };
    expect(evaluatePrecondition(precond, state)).toBe(false);
  });

  it('evaluates comparison operators', () => {
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'count', operator: 'gt', value: 3 },
        state
      )
    ).toBe(true);
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'count', operator: 'lt', value: 10 },
        state
      )
    ).toBe(true);
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'count', operator: 'gte', value: 5 },
        state
      )
    ).toBe(true);
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'count', operator: 'lte', value: 5 },
        state
      )
    ).toBe(true);
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'count', operator: 'eq', value: 5 },
        state
      )
    ).toBe(true);
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'count', operator: 'neq', value: 3 },
        state
      )
    ).toBe(true);
  });

  it('evaluates AND precondition', () => {
    const precond: Precondition = {
      type: 'and',
      conditions: [
        { type: 'simple', variable: 'robot_at', value: 'A' },
        { type: 'simple', variable: 'holding', value: null },
      ],
    };
    expect(evaluatePrecondition(precond, state)).toBe(true);
  });

  it('evaluates OR precondition', () => {
    const precond: Precondition = {
      type: 'or',
      conditions: [
        { type: 'simple', variable: 'robot_at', value: 'B' },
        { type: 'simple', variable: 'holding', value: null },
      ],
    };
    expect(evaluatePrecondition(precond, state)).toBe(true);
  });

  it('evaluates NOT precondition', () => {
    const precond: Precondition = {
      type: 'not',
      condition: { type: 'simple', variable: 'robot_at', value: 'B' },
    };
    expect(evaluatePrecondition(precond, state)).toBe(true);
  });
});

describe('applyAction', () => {
  const schema = createMoveSchema();

  it('applies effects to state', () => {
    const state: PlanState = { id: 'state-0', variables: { robot_at: 'A' } };
    const action = createAction('move', { from: 'A', to: 'B' });

    const newState = applyAction(action, state, schema);
    expect(newState.variables.robot_at).toBe('B');
  });

  it('preserves unchanged variables', () => {
    const state: PlanState = { id: 'state-0', variables: { robot_at: 'A', other: 'value' } };
    const action = createAction('move', { from: 'A', to: 'B' });

    const newState = applyAction(action, state, schema);
    expect(newState.variables.other).toBe('value');
  });

  it('does not mutate original state', () => {
    const state: PlanState = { id: 'state-0', variables: { robot_at: 'A' } };
    const action = createAction('move', { from: 'A', to: 'B' });

    applyAction(action, state, schema);
    expect(state.variables.robot_at).toBe('A');
  });
});

describe('PlanValidator', () => {
  let registry: ActionRegistry;
  let validator: PlanValidator;

  beforeEach(() => {
    registry = new ActionRegistry();
    registry.register(createMoveSchema());
    registry.register(createPickupSchema());
    registry.register(createDropSchema());
    validator = new PlanValidator(registry);
  });

  it('validates correct plan', () => {
    const plan: Plan = {
      id: 'plan1',
      name: 'delivery',
      initialState: { id: 'state-0', variables: { robot_at: 'A', holding: null } },
      actions: [
        createAction('move', { from: 'A', to: 'B' }),
        createAction('pickup', { obj: 'box', loc: 'B' }),
        createAction('move', { from: 'B', to: 'C' }),
        createAction('drop', { loc: 'C' }),
      ],
      goalConditions: [
        { type: 'simple', variable: 'robot_at', value: 'C' },
        { type: 'simple', variable: 'holding', value: null },
      ],
    };

    const result = validator.validate(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects precondition violation', () => {
    const plan: Plan = {
      id: 'plan2',
      initialState: { id: 'state-0', variables: { robot_at: 'A', holding: null } },
      actions: [createAction('pickup', { obj: 'box', loc: 'B' })],
      goalConditions: [],
    };

    const result = validator.validate(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'precondition_violated')).toBe(true);
  });

  it('detects undefined action', () => {
    const plan: Plan = {
      id: 'plan3',
      initialState: { id: 'state-0', variables: {} },
      actions: [createAction('unknown_action', {})],
      goalConditions: [],
    };

    const result = validator.validate(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'undefined_action')).toBe(true);
  });

  it('detects unreachable goal', () => {
    const plan: Plan = {
      id: 'plan4',
      initialState: { id: 'state-0', variables: { robot_at: 'A', holding: null } },
      actions: [createAction('move', { from: 'A', to: 'B' })],
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'C' }],
    };

    const result = validator.validate(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'goal_unreachable')).toBe(true);
  });

  it('returns state trace', () => {
    const plan: Plan = {
      id: 'plan5',
      initialState: { id: 'state-0', variables: { robot_at: 'A', holding: null } },
      actions: [
        createAction('move', { from: 'A', to: 'B' }),
        createAction('move', { from: 'B', to: 'C' }),
      ],
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'C' }],
    };

    const result = validator.validate(plan);
    expect(result.stateTrace).toHaveLength(3);
    expect(result.stateTrace[0].variables.robot_at).toBe('A');
    expect(result.stateTrace[1].variables.robot_at).toBe('B');
    expect(result.stateTrace[2].variables.robot_at).toBe('C');
  });
});

describe('validatePlan helper', () => {
  it('works without explicit validator', () => {
    const registry = new ActionRegistry();
    registry.register(createMoveSchema());

    const plan: Plan = {
      id: 'plan1',
      initialState: { id: 'state-0', variables: { robot_at: 'A' } },
      actions: [createAction('move', { from: 'A', to: 'B' })],
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'B' }],
    };

    const result = validatePlan(plan, registry);
    expect(result.valid).toBe(true);
  });
});

describe('InvariantChecker', () => {
  let registry: ActionRegistry;
  let checker: InvariantChecker;

  beforeEach(() => {
    registry = new ActionRegistry();
    registry.register({
      name: 'increment',
      description: 'Increment counter',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'increment', variable: 'counter', amount: 1 }],
    });
    registry.register({
      name: 'decrement',
      description: 'Decrement counter',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'increment', variable: 'counter', amount: -1 }],
    });
    checker = createInvariantChecker(registry);
  });

  it('adds invariant property', () => {
    checker.addInvariant('positive', {
      type: 'comparison',
      variable: 'counter',
      operator: 'gte',
      value: 0,
    });
    const properties = checker.getProperties();
    expect(properties).toHaveLength(1);
    expect(properties[0].type).toBe('invariant');
  });

  it('adds eventually property', () => {
    checker.addEventually('complete', { type: 'simple', variable: 'done', value: true });
    const properties = checker.getProperties();
    expect(properties[0].type).toBe('eventually');
  });

  it('adds always property', () => {
    checker.addAlways('safe', { type: 'simple', variable: 'safe', value: true });
    const properties = checker.getProperties();
    expect(properties[0].type).toBe('always');
  });

  it('adds never property', () => {
    checker.addNever('danger', { type: 'simple', variable: 'danger', value: true });
    const properties = checker.getProperties();
    expect(properties[0].type).toBe('never');
  });

  it('removes property by id', () => {
    const id = checker.addInvariant('test', { type: 'simple', variable: 'x', value: 1 });
    expect(checker.getProperties()).toHaveLength(1);
    checker.removeProperty(id);
    expect(checker.getProperties()).toHaveLength(0);
  });

  it('checks invariant satisfied', () => {
    checker.addInvariant('non_negative', {
      type: 'comparison',
      variable: 'counter',
      operator: 'gte',
      value: 0,
    });

    const plan: Plan = {
      id: 'plan1',
      initialState: { id: 'state-0', variables: { counter: 5 } },
      actions: [createAction('increment', {}), createAction('increment', {})],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results).toHaveLength(1);
    expect(results[0].satisfied).toBe(true);
  });

  it('checks invariant violated', () => {
    checker.addInvariant('non_negative', {
      type: 'comparison',
      variable: 'counter',
      operator: 'gte',
      value: 0,
    });

    const plan: Plan = {
      id: 'plan2',
      initialState: { id: 'state-0', variables: { counter: 0 } },
      actions: [createAction('decrement', {}), createAction('decrement', {})],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results[0].satisfied).toBe(false);
    expect(results[0].violatingStates).toBeDefined();
  });

  it('checks eventually property satisfied', () => {
    checker.addEventually('reaches_target', { type: 'simple', variable: 'counter', value: 3 });

    const plan: Plan = {
      id: 'plan3',
      initialState: { id: 'state-0', variables: { counter: 0 } },
      actions: [
        createAction('increment', {}),
        createAction('increment', {}),
        createAction('increment', {}),
      ],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results[0].satisfied).toBe(true);
  });

  it('checks never property', () => {
    checker.addNever('overflow', {
      type: 'comparison',
      variable: 'counter',
      operator: 'gt',
      value: 10,
    });

    const plan: Plan = {
      id: 'plan4',
      initialState: { id: 'state-0', variables: { counter: 5 } },
      actions: [createAction('increment', {}), createAction('increment', {})],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results[0].satisfied).toBe(true);
  });

  it('provides counterexample for violated property', () => {
    checker.addNever('negative', {
      type: 'comparison',
      variable: 'counter',
      operator: 'lt',
      value: 0,
    });

    const plan: Plan = {
      id: 'plan5',
      initialState: { id: 'state-0', variables: { counter: 1 } },
      actions: [createAction('decrement', {}), createAction('decrement', {})],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results[0].satisfied).toBe(false);
    expect(results[0].counterexample).toBeDefined();
  });
});

describe('PlanRepairer', () => {
  let registry: ActionRegistry;
  let repairer: PlanRepairer;

  beforeEach(() => {
    registry = new ActionRegistry();
    registry.register(createMoveSchema());
    registry.register(createPickupSchema());
    registry.register(createDropSchema());
    repairer = new PlanRepairer(registry);
  });

  it('returns success for valid plan', () => {
    const plan: Plan = {
      id: 'valid',
      initialState: { id: 'state-0', variables: { robot_at: 'A', holding: null } },
      actions: [createAction('move', { from: 'A', to: 'B' })],
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'B' }],
    };

    const result = repairer.repair(plan);
    expect(result.success).toBe(true);
    expect(result.explanation).toContain('already valid');
  });

  it('suggests removing undefined action', () => {
    const plan: Plan = {
      id: 'undefined',
      initialState: { id: 'state-0', variables: { robot_at: 'A' } },
      actions: [createAction('nonexistent', {})],
      goalConditions: [],
    };

    const result = repairer.repair(plan);
    expect(result.suggestions.some((s) => s.type === 'remove')).toBe(true);
  });

  it('suggests insertion for precondition violation', () => {
    const plan: Plan = {
      id: 'missing_precond',
      initialState: { id: 'state-0', variables: { robot_at: 'A', holding: null } },
      actions: [createAction('pickup', { obj: 'box', loc: 'B' })],
      goalConditions: [],
    };

    const result = repairer.repair(plan);
    expect(result.suggestions.some((s) => s.type === 'insert' || s.type === 'remove')).toBe(true);
  });

  it('repairs plan by removing invalid action', () => {
    const plan: Plan = {
      id: 'repairable',
      initialState: { id: 'state-0', variables: { robot_at: 'A' } },
      actions: [createAction('move', { from: 'A', to: 'B' }), createAction('undefined_action', {})],
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'B' }],
    };

    const result = repairer.repair(plan);

    if (result.success && result.repairedPlan) {
      expect(result.repairedPlan.actions.length).toBeLessThan(plan.actions.length);
    }
  });

  it('provides explanation for failed repair', () => {
    const plan: Plan = {
      id: 'unfixable',
      initialState: { id: 'state-0', variables: {} },
      actions: [createAction('move', { from: 'X', to: 'Y' })],
      goalConditions: [{ type: 'simple', variable: 'impossible', value: true }],
    };

    const result = repairer.repair(plan);
    expect(result.explanation).toBeDefined();
    expect(result.explanation.length).toBeGreaterThan(0);
  });
});

describe('repairPlan helper', () => {
  it('works without explicit repairer', () => {
    const registry = new ActionRegistry();
    registry.register(createMoveSchema());

    const plan: Plan = {
      id: 'plan1',
      initialState: { id: 'state-0', variables: { robot_at: 'A' } },
      actions: [createAction('move', { from: 'A', to: 'B' })],
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'B' }],
    };

    const result = repairPlan(plan, registry);
    expect(result.success).toBe(true);
  });
});

describe('Formatting functions', () => {
  it('schemaToString formats action schema', () => {
    const schema = createMoveSchema();
    const str = schemaToString(schema);
    expect(str).toContain('move');
    expect(str).toContain('from');
    expect(str).toContain('to');
  });

  it('actionToString formats action', () => {
    const action = createAction('move', { from: 'A', to: 'B' });
    const str = actionToString(action);
    expect(str).toContain('move');
  });
});
