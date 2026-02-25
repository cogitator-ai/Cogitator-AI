import { describe, it, expect, beforeEach } from 'vitest';
import type { ActionSchema, Plan } from '@cogitator-ai/types';
import { NeuroSymbolic, createNeuroSymbolic } from '../orchestrator';
import { ConstraintBuilder } from '../constraints';

describe('NeuroSymbolic', () => {
  let ns: NeuroSymbolic;

  beforeEach(() => {
    ns = new NeuroSymbolic();
  });

  describe('constructor', () => {
    it('creates with default config', () => {
      const config = ns.getConfig();
      expect(config.logic.maxDepth).toBe(50);
      expect(config.logic.maxSolutions).toBe(10);
      expect(config.logic.timeout).toBe(5000);
      expect(config.logic.enableCut).toBe(true);
      expect(config.logic.enableNegation).toBe(true);
      expect(config.logic.traceExecution).toBe(false);
      expect(config.constraints.timeout).toBe(10000);
      expect(config.constraints.solver).toBe('z3');
      expect(config.constraints.enableOptimization).toBe(true);
      expect(config.constraints.randomSeed).toBe(42);
      expect(config.planning.maxPlanLength).toBe(100);
      expect(config.planning.enableRepair).toBe(true);
      expect(config.planning.verifyInvariants).toBe(true);
      expect(config.knowledgeGraph.enableNaturalLanguage).toBe(true);
      expect(config.knowledgeGraph.defaultQueryLimit).toBe(100);
    });

    it('creates with partial config', () => {
      const custom = new NeuroSymbolic({
        config: {
          logic: { maxDepth: 100 },
        },
      });
      const config = custom.getConfig();
      expect(config.logic.maxDepth).toBe(100);
      expect(config.logic.maxSolutions).toBe(10);
    });

    it('merges nested config sections independently', () => {
      const custom = new NeuroSymbolic({
        config: {
          constraints: { timeout: 5000 },
          planning: { enableRepair: false },
        },
      });
      const config = custom.getConfig();
      expect(config.constraints.timeout).toBe(5000);
      expect(config.constraints.solver).toBe('z3');
      expect(config.planning.enableRepair).toBe(false);
      expect(config.planning.maxPlanLength).toBe(100);
    });

    it('accepts agentId', () => {
      const custom = new NeuroSymbolic({ agentId: 'agent-42' });
      expect(custom).toBeInstanceOf(NeuroSymbolic);
    });
  });

  describe('createNeuroSymbolic', () => {
    it('creates instance via factory function', () => {
      const instance = createNeuroSymbolic();
      expect(instance).toBeInstanceOf(NeuroSymbolic);
    });

    it('passes options to constructor', () => {
      const instance = createNeuroSymbolic({
        config: { logic: { maxDepth: 200 } },
      });
      expect(instance.getConfig().logic.maxDepth).toBe(200);
    });
  });

  describe('loadLogicProgram', () => {
    it('loads a valid program', () => {
      const result = ns.loadLogicProgram('parent(tom, bob).');
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('loads program with rules', () => {
      const result = ns.loadLogicProgram(`
        parent(tom, bob).
        parent(bob, ann).
        grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
      `);
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns errors for invalid program', () => {
      const result = ns.loadLogicProgram('this is not valid prolog ###');
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('assertFact / queryLogic / proveLogic / getLogicSolutions', () => {
    beforeEach(() => {
      ns.assertFact('color', 'sky', 'blue');
      ns.assertFact('color', 'grass', 'green');
      ns.assertFact('color', 'sun', 'yellow');
    });

    it('queries asserted facts successfully', () => {
      const result = ns.queryLogic('color(sky, blue)');
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.success).toBe(true);
    });

    it('returns failure for non-existent facts', () => {
      const result = ns.queryLogic('color(sky, red)');
      expect(result.data!.success).toBe(false);
    });

    it('proves a known fact', () => {
      const result = ns.proveLogic('color(grass, green)');
      expect(result.success).toBe(true);
      expect(result.data).toBe(true);
    });

    it('disproves an unknown fact', () => {
      const result = ns.proveLogic('color(grass, purple)');
      expect(result.success).toBe(true);
      expect(result.data).toBe(false);
    });

    it('returns formatted solutions', () => {
      const output = ns.getLogicSolutions('color(sky, X)');
      expect(typeof output).toBe('string');
      expect(output).not.toContain('Error');
    });

    it('returns error string for invalid query', () => {
      const output = ns.getLogicSolutions('###invalid');
      expect(output).toContain('Error');
    });

    it('has duration in query results', () => {
      const result = ns.queryLogic('color(sky, blue)');
      expect(result.duration).toBeTypeOf('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('logic programs with rules', () => {
    it('resolves transitive rules', () => {
      ns.loadLogicProgram(`
        parent(tom, bob).
        parent(bob, ann).
        ancestor(X, Y) :- parent(X, Y).
        ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
      `);

      const direct = ns.proveLogic('ancestor(tom, bob)');
      expect(direct.data).toBe(true);

      const transitive = ns.proveLogic('ancestor(tom, ann)');
      expect(transitive.data).toBe(true);

      const wrong = ns.proveLogic('ancestor(ann, tom)');
      expect(wrong.data).toBe(false);
    });
  });

  describe('solve()', () => {
    let solver: NeuroSymbolic;

    beforeEach(() => {
      solver = new NeuroSymbolic({
        config: { constraints: { solver: 'simple-sat' } },
      });
    });

    it('returns success: true for satisfiable problem', async () => {
      const builder = ConstraintBuilder.create('sat-test');
      const x = builder.bool('x');
      builder.assert(x.eq(true));
      const problem = builder.build();

      const result = await solver.solve(problem);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.status).toBe('sat');
      expect(result.data!.model).toBeDefined();
      expect(result.data!.model!.assignments['x']).toBe(true);
    });

    it('returns success: true for unsatisfiable problem (regression)', async () => {
      const builder = ConstraintBuilder.create('unsat-test');
      const x = builder.bool('x');
      builder.assert(x.eq(true));
      builder.assert(x.eq(false));
      const problem = builder.build();

      const result = await solver.solve(problem);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.status).toBe('unsat');
    });

    it('returns duration', async () => {
      const builder = ConstraintBuilder.create('timing');
      builder.bool('a');
      const problem = builder.build();

      const result = await solver.solve(problem);
      expect(result.duration).toBeTypeOf('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('solves multi-variable boolean problem', async () => {
      const builder = ConstraintBuilder.create('multi');
      const a = builder.bool('a');
      const b = builder.bool('b');
      builder.assert(a.or(b));
      builder.assert(a.and(b).not());
      const problem = builder.build();

      const result = await solver.solve(problem);
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('sat');

      const assignments = result.data!.model!.assignments;
      expect(assignments['a'] !== assignments['b']).toBe(true);
    });
  });

  describe('createConstraintProblem', () => {
    it('returns a ConstraintBuilder', () => {
      const builder = ns.createConstraintProblem('test');
      expect(builder).toBeInstanceOf(ConstraintBuilder);
    });
  });

  describe('getConfig()', () => {
    it('returns a deep copy — mutations do not affect internal state (regression)', () => {
      const config1 = ns.getConfig();
      config1.logic.maxDepth = 9999;
      config1.constraints.timeout = 1;

      const config2 = ns.getConfig();
      expect(config2.logic.maxDepth).toBe(50);
      expect(config2.constraints.timeout).toBe(10000);
    });
  });

  describe('updateConfig()', () => {
    it('updates a single section', () => {
      ns.updateConfig({ logic: { maxDepth: 200 } });
      expect(ns.getConfig().logic.maxDepth).toBe(200);
      expect(ns.getConfig().logic.maxSolutions).toBe(10);
    });

    it('updates multiple sections at once', () => {
      ns.updateConfig({
        constraints: { timeout: 3000 },
        planning: { enableRepair: false },
      });
      expect(ns.getConfig().constraints.timeout).toBe(3000);
      expect(ns.getConfig().planning.enableRepair).toBe(false);
    });

    it('does not affect untouched sections', () => {
      ns.updateConfig({ logic: { maxDepth: 300 } });
      expect(ns.getConfig().constraints.timeout).toBe(10000);
      expect(ns.getConfig().planning.maxPlanLength).toBe(100);
      expect(ns.getConfig().knowledgeGraph.defaultQueryLimit).toBe(100);
    });

    it('recreates resolver when logic config changes', () => {
      ns.loadLogicProgram('fact(a).');
      ns.updateConfig({ logic: { maxDepth: 5 } });
      const result = ns.queryLogic('fact(a)');
      expect(result.success).toBe(true);
    });
  });

  describe('validatePlan / repairPlan', () => {
    const moveSchema: ActionSchema = {
      name: 'move',
      parameters: [
        { name: 'from', type: 'string', required: true },
        { name: 'to', type: 'string', required: true },
      ],
      preconditions: [{ type: 'simple', variable: 'robot_at', value: '?from' }],
      effects: [{ type: 'assign', variable: 'robot_at', value: '?to' }],
    };

    const validPlan: Plan = {
      id: 'plan-1',
      actions: [{ id: 'a1', schemaName: 'move', parameters: { from: 'A', to: 'B' } }],
      initialState: { id: 'state-0', variables: { robot_at: 'A' } },
      goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'B' }],
    };

    beforeEach(() => {
      ns.registerAction(moveSchema);
    });

    it('validates a correct plan', () => {
      const result = ns.validatePlan(validPlan);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.valid).toBe(true);
    });

    it('invalidates a plan with unknown action', () => {
      const badPlan: Plan = {
        id: 'plan-bad',
        actions: [{ id: 'a1', schemaName: 'fly', parameters: { dest: 'moon' } }],
        initialState: { id: 'state-0', variables: {} },
        goalConditions: [],
      };
      const result = ns.validatePlan(badPlan);
      expect(result.success).toBe(false);
    });

    it('repairs an invalid plan', () => {
      const brokenPlan: Plan = {
        id: 'plan-broken',
        actions: [{ id: 'a1', schemaName: 'move', parameters: { from: 'X', to: 'Y' } }],
        initialState: { id: 'state-0', variables: { robot_at: 'Z' } },
        goalConditions: [{ type: 'simple', variable: 'robot_at', value: 'Y' }],
      };
      const result = ns.repairPlan(brokenPlan);
      expect(result.success).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.duration).toBeTypeOf('number');
    });

    it('rejects repair when disabled', () => {
      ns.updateConfig({ planning: { enableRepair: false } });
      const result = ns.repairPlan(validPlan);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Plan repair is disabled');
    });
  });

  describe('registerActions / getRegisteredActions', () => {
    it('registers multiple actions at once', () => {
      ns.registerActions([
        {
          name: 'push',
          parameters: [],
          preconditions: [],
          effects: [],
        },
        {
          name: 'pull',
          parameters: [],
          preconditions: [],
          effects: [],
        },
      ]);
      const all = ns.getRegisteredActions();
      expect(all).toHaveLength(2);
      expect(all.map((a) => a.name)).toContain('push');
      expect(all.map((a) => a.name)).toContain('pull');
    });
  });

  describe('reset()', () => {
    it('clears loaded logic program', () => {
      ns.loadLogicProgram('fact(hello).');
      const before = ns.proveLogic('fact(hello)');
      expect(before.data).toBe(true);

      ns.reset();

      const after = ns.proveLogic('fact(hello)');
      expect(after.data).toBe(false);
    });

    it('clears asserted facts', () => {
      ns.assertFact('color', 'sky', 'blue');
      ns.reset();
      const result = ns.proveLogic('color(sky, blue)');
      expect(result.data).toBe(false);
    });

    it('clears registered actions', () => {
      ns.registerAction({
        name: 'test',
        parameters: [],
        preconditions: [],
        effects: [],
      });
      expect(ns.getRegisteredActions()).toHaveLength(1);

      ns.reset();
      expect(ns.getRegisteredActions()).toHaveLength(0);
    });

    it('preserves config after reset', () => {
      ns.updateConfig({ logic: { maxDepth: 999 } });
      ns.reset();
      expect(ns.getConfig().logic.maxDepth).toBe(999);
    });
  });

  describe('graph operations without adapter', () => {
    it('queryGraph returns error without adapter', async () => {
      const result = await ns.queryGraph({
        type: 'pattern',
        patterns: [],
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Graph adapter not configured');
    });

    it('askGraph returns error without adapter', async () => {
      const result = await ns.askGraph('what is the meaning of life?');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Graph adapter not configured');
    });

    it('findPath returns error without reasoning engine', async () => {
      const result = await ns.findPath('node-1', 'node-2');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Reasoning engine not configured');
    });
  });

  describe('createGraphQuery', () => {
    it('returns a GraphQueryBuilder', () => {
      const builder = ns.createGraphQuery();
      expect(builder).toBeDefined();
    });
  });

  describe('getKnowledgeBase / getActionRegistry', () => {
    it('exposes knowledge base', () => {
      const kb = ns.getKnowledgeBase();
      expect(kb).toBeDefined();
      expect(typeof kb.consult).toBe('function');
    });

    it('exposes action registry', () => {
      const registry = ns.getActionRegistry();
      expect(registry).toBeDefined();
      expect(typeof registry.register).toBe('function');
    });
  });
});
