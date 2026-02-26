import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ActionSchema,
  Plan,
  PlanState,
  Precondition,
  SafetyProperty,
} from '@cogitator-ai/types';
import {
  ActionRegistry,
  createAction,
  evaluatePrecondition,
  createInvariantChecker,
  PlanValidator,
} from '../planning';

describe('exists precondition', () => {
  it('returns true when condition holds for some value in domain', () => {
    const state: PlanState = {
      variables: {
        items: [1, 2, 3, 4, 5],
        x: 0,
      },
    };

    const precond: Precondition = {
      type: 'exists',
      variable: 'x',
      domain: 'items',
      condition: { type: 'comparison', variable: 'x', operator: 'gt', value: 3 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(true);
  });

  it('returns false when condition holds for no value in domain', () => {
    const state: PlanState = {
      variables: {
        items: [1, 2, 3],
        x: 0,
      },
    };

    const precond: Precondition = {
      type: 'exists',
      variable: 'x',
      domain: 'items',
      condition: { type: 'comparison', variable: 'x', operator: 'gt', value: 10 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(false);
  });

  it('returns false on empty domain', () => {
    const state: PlanState = {
      variables: {
        items: [],
        x: 0,
      },
    };

    const precond: Precondition = {
      type: 'exists',
      variable: 'x',
      domain: 'items',
      condition: { type: 'simple', variable: 'x', value: 1 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(false);
  });

  it('works with range domain', () => {
    const state: PlanState = {
      variables: {
        range: { min: 1, max: 5 },
        n: 0,
      },
    };

    const precond: Precondition = {
      type: 'exists',
      variable: 'n',
      domain: 'range',
      condition: { type: 'simple', variable: 'n', value: 3 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(true);
  });
});

describe('forall precondition', () => {
  it('returns true when condition holds for all values in domain', () => {
    const state: PlanState = {
      variables: {
        items: [2, 4, 6, 8],
        x: 0,
      },
    };

    const precond: Precondition = {
      type: 'forall',
      variable: 'x',
      domain: 'items',
      condition: { type: 'comparison', variable: 'x', operator: 'gt', value: 0 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(true);
  });

  it('returns false when condition fails for at least one value', () => {
    const state: PlanState = {
      variables: {
        items: [2, 4, -1, 8],
        x: 0,
      },
    };

    const precond: Precondition = {
      type: 'forall',
      variable: 'x',
      domain: 'items',
      condition: { type: 'comparison', variable: 'x', operator: 'gt', value: 0 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(false);
  });

  it('returns true on empty domain (vacuous truth)', () => {
    const state: PlanState = {
      variables: {
        items: [],
        x: 0,
      },
    };

    const precond: Precondition = {
      type: 'forall',
      variable: 'x',
      domain: 'items',
      condition: { type: 'simple', variable: 'x', value: 999 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(true);
  });

  it('does not leak bound variable into outer state', () => {
    const state: PlanState = {
      variables: {
        items: [10, 20, 30],
        x: 42,
      },
    };

    const precond: Precondition = {
      type: 'forall',
      variable: 'x',
      domain: 'items',
      condition: { type: 'comparison', variable: 'x', operator: 'gte', value: 10 },
    };

    expect(evaluatePrecondition(precond, state)).toBe(true);
    expect(state.variables.x).toBe(42);
  });
});

describe('until safety property', () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
    registry.register({
      name: 'step',
      description: 'Increment counter by 1',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'increment', variable: 'counter', amount: 1 }],
    });
    registry.register({
      name: 'break_safe',
      description: 'Sets safe to false',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'assign', variable: 'safe', value: false }],
    });
  });

  it('satisfied when until-condition becomes true while hold-condition holds', () => {
    const checker = createInvariantChecker(registry);

    const untilProp: SafetyProperty = {
      id: 'until-1',
      name: 'safe_until_done',
      type: 'until',
      condition: {
        type: 'and',
        conditions: [
          { type: 'simple', variable: 'safe', value: true },
          { type: 'simple', variable: 'counter', value: 3 },
        ],
      },
    };
    checker.addProperty(untilProp);

    const plan: Plan = {
      id: 'until-plan-ok',
      initialState: { variables: { counter: 0, safe: true } },
      actions: [createAction('step', {}), createAction('step', {}), createAction('step', {})],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results).toHaveLength(1);
    expect(results[0].satisfied).toBe(true);
  });

  it('violated when hold-condition fails before until-condition becomes true', () => {
    const checker = createInvariantChecker(registry);

    const untilProp: SafetyProperty = {
      id: 'until-2',
      name: 'safe_until_done',
      type: 'until',
      condition: {
        type: 'and',
        conditions: [
          { type: 'simple', variable: 'safe', value: true },
          { type: 'simple', variable: 'counter', value: 5 },
        ],
      },
    };
    checker.addProperty(untilProp);

    const plan: Plan = {
      id: 'until-plan-fail',
      initialState: { variables: { counter: 0, safe: true } },
      actions: [
        createAction('step', {}),
        createAction('break_safe', {}),
        createAction('step', {}),
        createAction('step', {}),
        createAction('step', {}),
      ],
      goalConditions: [],
    };

    const results = checker.checkPlan(plan);
    expect(results).toHaveLength(1);
    expect(results[0].satisfied).toBe(false);
    expect(results[0].violatingStates).toBeDefined();
    expect(results[0].violatingStates!.length).toBeGreaterThan(0);
  });
});

describe('InvariantChecker config flags', () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
    registry.register({
      name: 'noop',
      description: 'Does nothing',
      parameters: [],
      preconditions: [],
      effects: [],
    });
  });

  const makePlan = (): Plan => ({
    id: 'cfg-plan',
    initialState: { variables: { x: 1 } },
    actions: [createAction('noop', {})],
    goalConditions: [],
  });

  it('skips invariant checks when checkInvariants is false', () => {
    const checker = createInvariantChecker(registry, { checkInvariants: false });
    checker.addInvariant('should_skip', { type: 'simple', variable: 'x', value: 999 });

    const results = checker.checkPlan(makePlan());
    expect(results).toHaveLength(0);
  });

  it('skips eventually checks when checkEventually is false', () => {
    const checker = createInvariantChecker(registry, { checkEventually: false });
    checker.addEventually('should_skip', { type: 'simple', variable: 'x', value: 999 });

    const results = checker.checkPlan(makePlan());
    expect(results).toHaveLength(0);
  });

  it('skips always checks when checkAlways is false', () => {
    const checker = createInvariantChecker(registry, { checkAlways: false });
    checker.addAlways('should_skip', { type: 'simple', variable: 'x', value: 999 });

    const results = checker.checkPlan(makePlan());
    expect(results).toHaveLength(0);
  });

  it('checks all property types when all flags are true', () => {
    const checker = createInvariantChecker(registry, {
      checkInvariants: true,
      checkEventually: true,
      checkAlways: true,
    });
    checker.addInvariant('inv', { type: 'simple', variable: 'x', value: 1 });
    checker.addEventually('evt', { type: 'simple', variable: 'x', value: 1 });
    checker.addAlways('alw', { type: 'simple', variable: 'x', value: 1 });

    const results = checker.checkPlan(makePlan());
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.satisfied)).toBe(true);
  });

  it('never properties are always checked regardless of config flags', () => {
    const checker = createInvariantChecker(registry, {
      checkInvariants: false,
      checkEventually: false,
      checkAlways: false,
    });
    checker.addNever('never_prop', { type: 'simple', variable: 'x', value: 999 });

    const results = checker.checkPlan(makePlan());
    expect(results).toHaveLength(1);
    expect(results[0].satisfied).toBe(true);
  });
});

describe('findParallelizable', () => {
  let registry: ActionRegistry;

  const makeSchema = (name: string, reads: string[], writes: string[]): ActionSchema => ({
    name,
    description: name,
    parameters: [],
    preconditions: reads.map((v) => ({ type: 'simple' as const, variable: v, value: true })),
    effects: writes.map((v) => ({ type: 'assign' as const, variable: v, value: true })),
  });

  beforeEach(() => {
    registry = new ActionRegistry();
  });

  it('groups independent actions together', () => {
    registry.register(makeSchema('a', [], ['x']));
    registry.register(makeSchema('b', [], ['y']));

    const plan: Plan = {
      id: 'par-1',
      initialState: { variables: {} },
      actions: [createAction('a', {}, 'a1'), createAction('b', {}, 'b1')],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const deps = validator.analyzeDependencies(plan);

    const inSameGroup = deps.parallelizable.some((g) => g.includes('a1') && g.includes('b1'));
    expect(inSameGroup).toBe(true);
  });

  it('does not group actions with causal dependency', () => {
    registry.register(makeSchema('a', [], ['x']));
    registry.register(makeSchema('b', ['x'], ['y']));

    const plan: Plan = {
      id: 'par-2',
      initialState: { variables: { x: true } },
      actions: [createAction('a', {}, 'a1'), createAction('b', {}, 'b1')],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const deps = validator.analyzeDependencies(plan);

    const inSameGroup = deps.parallelizable.some((g) => g.includes('a1') && g.includes('b1'));
    expect(inSameGroup).toBe(false);
  });

  it('does not group transitive dependents into the same group as their dependency', () => {
    registry.register(makeSchema('a', [], ['x']));
    registry.register(makeSchema('b', ['x'], ['y']));
    registry.register(makeSchema('c', ['y'], ['z']));

    const plan: Plan = {
      id: 'par-3',
      initialState: { variables: { x: true, y: true } },
      actions: [
        createAction('a', {}, 'a1'),
        createAction('b', {}, 'b1'),
        createAction('c', {}, 'c1'),
      ],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const deps = validator.analyzeDependencies(plan);

    const groupWithA = deps.parallelizable.find((g) => g.includes('a1'));
    if (groupWithA) {
      expect(groupWithA).not.toContain('b1');
    }

    const groupWithB = deps.parallelizable.find((g) => g.includes('b1'));
    if (groupWithB) {
      expect(groupWithB).not.toContain('c1');
    }
  });
});

describe('producedBy tracking', () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
    registry.register({
      name: 'set_x_to_1',
      description: 'Sets x to 1',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'assign', variable: 'x', value: 1 }],
    });
    registry.register({
      name: 'set_x_to_2',
      description: 'Sets x to 2',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'assign', variable: 'x', value: 2 }],
    });
    registry.register({
      name: 'read_x',
      description: 'Reads x',
      parameters: [],
      preconditions: [{ type: 'comparison', variable: 'x', operator: 'gte', value: 0 }],
      effects: [{ type: 'assign', variable: 'result', value: true }],
    });
  });

  it('picks the closest preceding producer for a dependency edge', () => {
    const plan: Plan = {
      id: 'prod-1',
      initialState: { variables: { x: 0 } },
      actions: [
        createAction('set_x_to_1', {}, 'writer1'),
        createAction('set_x_to_2', {}, 'writer2'),
        createAction('read_x', {}, 'reader'),
      ],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const deps = validator.analyzeDependencies(plan);

    const edgeToReader = deps.edges.find((e) => e.toAction === 'reader' && e.variable === 'x');
    expect(edgeToReader).toBeDefined();
    expect(edgeToReader!.fromAction).toBe('writer2');
  });

  it('creates no edge when only producer is the consumer itself', () => {
    registry.register({
      name: 'self_modify',
      description: 'Reads and writes x',
      parameters: [],
      preconditions: [{ type: 'simple', variable: 'x', value: 0 }],
      effects: [{ type: 'assign', variable: 'x', value: 1 }],
    });

    const plan: Plan = {
      id: 'prod-2',
      initialState: { variables: { x: 0 } },
      actions: [createAction('self_modify', {}, 'self1')],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const deps = validator.analyzeDependencies(plan);

    const edgesToSelf = deps.edges.filter((e) => e.toAction === 'self1' && e.variable === 'x');
    expect(edgesToSelf).toHaveLength(0);
  });

  it('tracks multiple variables independently', () => {
    registry.register({
      name: 'set_y',
      description: 'Sets y',
      parameters: [],
      preconditions: [],
      effects: [{ type: 'assign', variable: 'y', value: 10 }],
    });
    registry.register({
      name: 'read_both',
      description: 'Reads x and y',
      parameters: [],
      preconditions: [
        { type: 'comparison', variable: 'x', operator: 'gte', value: 0 },
        { type: 'comparison', variable: 'y', operator: 'gte', value: 0 },
      ],
      effects: [],
    });

    const plan: Plan = {
      id: 'prod-3',
      initialState: { variables: { x: 0, y: 0 } },
      actions: [
        createAction('set_x_to_1', {}, 'wx'),
        createAction('set_y', {}, 'wy'),
        createAction('read_both', {}, 'reader'),
      ],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const deps = validator.analyzeDependencies(plan);

    const xEdge = deps.edges.find((e) => e.toAction === 'reader' && e.variable === 'x');
    const yEdge = deps.edges.find((e) => e.toAction === 'reader' && e.variable === 'y');

    expect(xEdge).toBeDefined();
    expect(xEdge!.fromAction).toBe('wx');
    expect(yEdge).toBeDefined();
    expect(yEdge!.fromAction).toBe('wy');
  });
});
