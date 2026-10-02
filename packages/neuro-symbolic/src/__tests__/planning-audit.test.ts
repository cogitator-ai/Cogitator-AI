import { describe, it, expect } from 'vitest';
import type { ActionSchema, Plan, PlanState } from '@cogitator-ai/types';
import {
  ActionRegistry,
  createAction,
  applyAction,
  evaluatePrecondition,
} from '../planning/action-schema';
import { PlanValidator, validatePlan } from '../planning/plan-validator';
import { createInvariantChecker, commonSafetyProperties } from '../planning/invariant-checker';
import { repairPlan } from '../planning/plan-repair';
import { parseActionSuggestionResponse, parsePlanResponse } from '../planning/prompts';

const state = (variables: Record<string, unknown>): PlanState => ({ id: 's', variables });

const doorSchemas: ActionSchema[] = [
  {
    name: 'close_door',
    parameters: [],
    preconditions: [],
    effects: [{ type: 'assign', variable: 'door_open', value: false }],
  },
  {
    name: 'open_door',
    parameters: [],
    preconditions: [{ type: 'simple', variable: 'door_unlocked', value: true }],
    effects: [{ type: 'assign', variable: 'door_open', value: true }],
  },
  {
    name: 'unlock',
    parameters: [],
    preconditions: [],
    effects: [{ type: 'assign', variable: 'door_unlocked', value: true }],
  },
  {
    name: 'walk_through',
    parameters: [],
    preconditions: [{ type: 'simple', variable: 'door_open', value: true }],
    effects: [{ type: 'assign', variable: 'inside', value: true }],
  },
];

function registryWith(schemas: ActionSchema[]): ActionRegistry {
  const registry = new ActionRegistry();
  for (const schema of schemas) registry.register(schema);
  return registry;
}

describe('preconditions: value equality', () => {
  it('compares arrays and objects structurally', () => {
    const s = state({ items: ['a', 'b'], pos: { x: 1, y: 2 } });
    expect(evaluatePrecondition({ type: 'simple', variable: 'items', value: ['a', 'b'] }, s)).toBe(
      true
    );
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'pos', operator: 'eq', value: { y: 2, x: 1 } },
        s
      )
    ).toBe(true);
    expect(
      evaluatePrecondition(
        { type: 'comparison', variable: 'pos', operator: 'in', value: [{ x: 1, y: 2 }] },
        s
      )
    ).toBe(true);
  });

  it('does not throw for inverted numeric quantifier domains', () => {
    const s = state({ range: { min: 5, max: 1 } });
    expect(
      evaluatePrecondition(
        {
          type: 'exists',
          variable: 'i',
          domain: 'range',
          condition: { type: 'comparison', variable: 'i', operator: 'gt', value: 0 },
        },
        s
      )
    ).toBe(false);
  });
});

describe('conditional effects', () => {
  it('evaluate conditions against the pre-action state', () => {
    const schema: ActionSchema = {
      name: 'toggle',
      parameters: [],
      preconditions: [],
      effects: [
        { type: 'assign', variable: 'light', value: true },
        {
          type: 'conditional',
          condition: { type: 'simple', variable: 'light', value: false },
          thenEffects: [{ type: 'increment', variable: 'switches', amount: 1 }],
        },
      ],
    };
    const next = applyAction(
      createAction('toggle', {}),
      state({ light: false, switches: 0 }),
      schema
    );
    expect(next.variables).toEqual({ light: true, switches: 1 });
  });
});

describe('ordering threats', () => {
  it('warns when an action deletes a variable a later action needs', () => {
    const registry = registryWith([
      {
        name: 'make_key',
        parameters: [],
        preconditions: [],
        effects: [{ type: 'assign', variable: 'key', value: true }],
      },
      {
        name: 'lose_key',
        parameters: [],
        preconditions: [],
        effects: [{ type: 'delete', variable: 'key' }],
      },
      {
        name: 'use_key',
        parameters: [],
        preconditions: [{ type: 'simple', variable: 'key', value: true }],
        effects: [],
      },
    ]);

    const plan: Plan = {
      id: 'p',
      initialState: state({}),
      actions: [
        createAction('make_key', {}),
        createAction('lose_key', {}),
        createAction('use_key', {}),
      ],
      goalConditions: [],
    };

    const validator = new PlanValidator(registry);
    const graph = validator.analyzeDependencies(plan);
    expect(graph.edges.some((e) => e.type === 'threat' && e.variable === 'key')).toBe(true);

    const result = validator.validate(plan);
    const warning = result.warnings.find((w) => w.type === 'suboptimal_ordering');
    expect(warning?.actionIndex).toBe(1);
    expect(warning?.message).toMatch(/deletes 'key'/);
  });

  it('resolves parameterized effect variables in causal links', () => {
    const registry = registryWith([
      {
        name: 'mark',
        parameters: [{ name: 'flag', type: 'string', required: true }],
        preconditions: [],
        effects: [{ type: 'assign', variable: '?flag', value: true }],
      },
      {
        name: 'check',
        parameters: [],
        preconditions: [{ type: 'simple', variable: 'ready', value: true }],
        effects: [],
      },
    ]);
    const plan: Plan = {
      id: 'p',
      initialState: state({}),
      actions: [createAction('mark', { flag: 'ready' }, 'a1'), createAction('check', {}, 'a2')],
      goalConditions: [],
    };
    const graph = new PlanValidator(registry).analyzeDependencies(plan);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ fromAction: 'a1', toAction: 'a2', type: 'causal' })
    );
  });
});

describe('plan repair', () => {
  it('only suggests actions that actually establish the precondition', () => {
    const registry = registryWith(doorSchemas);
    const plan: Plan = {
      id: 'p',
      initialState: state({ door_open: false, door_unlocked: true }),
      actions: [createAction('walk_through', {})],
      goalConditions: [{ type: 'simple', variable: 'inside', value: true }],
    };

    const result = repairPlan(plan, registry);
    const inserted = result.suggestions.filter((s) => s.type === 'insert');
    expect(inserted.map((s) => s.action?.schemaName)).toContain('open_door');
    expect(inserted.map((s) => s.action?.schemaName)).not.toContain('close_door');
    expect(result.success).toBe(true);
    expect(result.repairedPlan!.actions.map((a) => a.schemaName)).toEqual([
      'open_door',
      'walk_through',
    ]);
  });

  it('fills missing parameters from defaults via modify suggestions', () => {
    const registry = registryWith([
      {
        name: 'greet',
        parameters: [{ name: 'name', type: 'string', required: true, default: 'world' }],
        preconditions: [],
        effects: [{ type: 'assign', variable: 'greeted', value: '?name' }],
      },
    ]);
    const plan: Plan = {
      id: 'p',
      initialState: state({}),
      actions: [createAction('greet', {})],
      goalConditions: [{ type: 'simple', variable: 'greeted', value: 'world' }],
    };

    const result = repairPlan(plan, registry);
    expect(result.success).toBe(true);
    expect(result.repairedPlan!.actions[0].parameters).toEqual({ name: 'world' });
  });
});

describe('invariant checking', () => {
  it('stops the trajectory at an inapplicable action', () => {
    const registry = registryWith(doorSchemas);
    const checker = createInvariantChecker(registry);
    checker.addNever('never inside', { type: 'simple', variable: 'inside', value: true });

    const plan: Plan = {
      id: 'p',
      initialState: state({ door_open: false }),
      actions: [createAction('walk_through', {})],
      goalConditions: [],
    };

    expect(checker.checkPlan(plan)[0].satisfied).toBe(true);
  });

  it('rejects invalid arguments to common safety properties', () => {
    const props = commonSafetyProperties();
    const bounded = props.find((p) => p.name === 'Bounded')!;
    const mutex = props.find((p) => p.name === 'Mutex')!;
    expect(() => bounded.createCondition('x')).toThrow(/min: number/);
    expect(() => mutex.createCondition('x', 'not-an-array')).toThrow(/array/);
    expect(bounded.createCondition('x', { min: 0, max: 5 })).toMatchObject({ type: 'and' });
  });
});

describe('maxSteps', () => {
  it('flags plans longer than the configured limit', () => {
    const registry = registryWith(doorSchemas);
    const plan: Plan = {
      id: 'p',
      initialState: state({}),
      actions: [createAction('unlock', {}), createAction('unlock', {}), createAction('unlock', {})],
      goalConditions: [],
    };
    const result = validatePlan(plan, registry, { maxSteps: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/maximum steps/);
  });
});

describe('planning prompt parsers', () => {
  it('ignores non-object parameters in LLM output', () => {
    expect(
      parseActionSuggestionResponse('{"action": "move", "parameters": ["a"], "reasoning": "x"}')
    ).toEqual({ action: 'move', parameters: {}, reasoning: 'x' });
  });

  it('skips prose braces before the JSON payload', () => {
    const parsed = parsePlanResponse(
      'Use {curly} notation. {"plan": [{"action": "unlock", "parameters": {}}], "explanation": 3}'
    );
    expect(parsed).toEqual({
      plan: [{ action: 'unlock', parameters: {} }],
      explanation: undefined,
    });
  });
});
