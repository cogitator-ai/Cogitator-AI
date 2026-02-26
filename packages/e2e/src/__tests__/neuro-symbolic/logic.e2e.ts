import { describe, it, expect, beforeEach } from 'vitest';
import { createNeuroSymbolic } from '@cogitator-ai/neuro-symbolic';
import type { NeuroSymbolic } from '@cogitator-ai/neuro-symbolic';
import { createAction } from '@cogitator-ai/neuro-symbolic';
import { constant, not } from '@cogitator-ai/neuro-symbolic';
import type { Plan, ActionSchema } from '@cogitator-ai/types';

describe('Neuro-Symbolic: Logic Programming', () => {
  let ns: NeuroSymbolic;

  beforeEach(() => {
    ns = createNeuroSymbolic({
      config: { constraints: { solver: 'simple-sat' } },
    });
  });

  it('loads and queries logic program', () => {
    const result = ns.loadLogicProgram('parent(tom, bob). parent(bob, alice).');
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);

    const query = ns.queryLogic('parent(tom, X)');
    expect(query.success).toBe(true);
    expect(query.data).toBeDefined();
    expect(query.data!.solutions.length).toBeGreaterThan(0);

    const solution = query.data!.solutions[0];
    const xBinding = solution.get('X');
    expect(xBinding).toBeDefined();
    expect(xBinding!.type).toBe('atom');
    if (xBinding!.type === 'atom') {
      expect(xBinding!.value).toBe('bob');
    }
  });

  it('assertFact and queryLogic', () => {
    ns.assertFact('likes', 'alice', 'pizza');
    ns.assertFact('likes', 'bob', 'sushi');
    ns.assertFact('likes', 'alice', 'sushi');

    const query = ns.queryLogic('likes(alice, X)');
    expect(query.success).toBe(true);
    expect(query.data!.solutions.length).toBeGreaterThanOrEqual(2);

    const values = query.data!.solutions.map((s) => {
      const x = s.get('X');
      return x?.type === 'atom' ? x.value : undefined;
    });
    expect(values).toContain('pizza');
    expect(values).toContain('sushi');
  });

  it('proveLogic returns true for provable query', () => {
    ns.loadLogicProgram('mortal(X) :- human(X). human(socrates).');

    const result = ns.proveLogic('mortal(socrates)');
    expect(result.success).toBe(true);
    expect(result.data).toBe(true);
  });

  it('proveLogic returns false for unprovable query', () => {
    ns.loadLogicProgram('mortal(X) :- human(X). human(socrates).');

    const result = ns.proveLogic('mortal(plato)');
    expect(result.success).toBe(true);
    expect(result.data).toBe(false);
  });
});

describe('Neuro-Symbolic: Constraint Solving', () => {
  let ns: NeuroSymbolic;

  beforeEach(() => {
    ns = createNeuroSymbolic({
      config: { constraints: { solver: 'simple-sat' } },
    });
  });

  it('solves simple constraint problem', async () => {
    const builder = ns.createConstraintProblem('sum-problem');
    const x = builder.int('x', 0, 10);
    const y = builder.int('y', 0, 10);
    builder.assert(x.add(y).eq(constant(10)));
    builder.assert(x.gt(constant(3)));
    builder.assert(y.gt(constant(3)));

    const problem = builder.build();
    const result = await ns.solve(problem);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.status).toBe('sat');
    if (result.data!.status === 'sat') {
      const xVal = result.data!.model.assignments.x as number;
      const yVal = result.data!.model.assignments.y as number;
      expect(xVal + yVal).toBe(10);
      expect(xVal).toBeGreaterThan(3);
      expect(yVal).toBeGreaterThan(3);
    }
  });

  it('returns failure for unsatisfiable constraints', async () => {
    const builder = ns.createConstraintProblem('unsat');
    const a = builder.bool('a');
    builder.assert(a);
    builder.assert(not(a));

    const problem = builder.build();
    const result = await ns.solve(problem);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.status).toBe('unsat');
  });
});

describe('Neuro-Symbolic: Planning', () => {
  let ns: NeuroSymbolic;

  const moveSchema: ActionSchema = {
    name: 'move',
    description: 'Move robot between locations',
    parameters: [
      { name: 'from', type: 'string', required: true },
      { name: 'to', type: 'string', required: true },
    ],
    preconditions: [{ type: 'simple', variable: 'robot_at', value: '?from' }],
    effects: [{ type: 'assign', variable: 'robot_at', value: '?to' }],
  };

  const pickupSchema: ActionSchema = {
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
  };

  const dropSchema: ActionSchema = {
    name: 'drop',
    description: 'Drop held object',
    parameters: [{ name: 'loc', type: 'string', required: true }],
    preconditions: [
      { type: 'simple', variable: 'robot_at', value: '?loc' },
      { type: 'comparison', variable: 'holding', operator: 'neq', value: null },
    ],
    effects: [{ type: 'assign', variable: 'holding', value: null }],
  };

  beforeEach(() => {
    ns = createNeuroSymbolic({
      config: { constraints: { solver: 'simple-sat' } },
    });
    ns.registerAction(moveSchema);
    ns.registerAction(pickupSchema);
    ns.registerAction(dropSchema);
  });

  it('validates a correct plan', () => {
    const plan: Plan = {
      id: 'delivery-plan',
      name: 'deliver box',
      initialState: { id: 's0', variables: { robot_at: 'A', holding: null } },
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

    const result = ns.validatePlan(plan);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.valid).toBe(true);
    expect(result.data!.errors).toHaveLength(0);
  });

  it('detects invalid plan with precondition violation', () => {
    const plan: Plan = {
      id: 'bad-plan',
      initialState: { id: 's0', variables: { robot_at: 'A', holding: null } },
      actions: [createAction('pickup', { obj: 'box', loc: 'B' })],
      goalConditions: [],
    };

    const result = ns.validatePlan(plan);
    expect(result.success).toBe(false);
    expect(result.data!.valid).toBe(false);
    expect(result.data!.errors.length).toBeGreaterThan(0);
    expect(result.data!.errors.some((e) => e.type === 'precondition_violated')).toBe(true);
  });

  it('checks safety invariants', () => {
    ns.addSafetyProperty({
      id: 'no-negative-fuel',
      name: 'fuel stays non-negative',
      type: 'never',
      condition: {
        type: 'comparison',
        variable: 'holding',
        operator: 'eq',
        value: 'dangerous_item',
      },
    });

    const plan: Plan = {
      id: 'unsafe-plan',
      initialState: { id: 's0', variables: { robot_at: 'A', holding: null } },
      actions: [createAction('pickup', { obj: 'dangerous_item', loc: 'A' })],
      goalConditions: [],
    };

    const result = ns.checkInvariants(plan);
    expect(result.success).toBe(false);
    expect(result.data).toBeDefined();
    expect(result.data!.length).toBeGreaterThan(0);

    const violation = result.data!.find((r) => !r.satisfied);
    expect(violation).toBeDefined();
    expect(violation!.property.name).toBe('fuel stays non-negative');
  });
});
