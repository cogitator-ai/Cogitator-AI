import { describe, it, expect } from 'vitest';
import type { ActionSchema, Plan, ToolContext } from '@cogitator-ai/types';
import { createNeuroSymbolic } from '../orchestrator';
import { createNeuroSymbolicTools } from '../tools';
import { MemoryGraphAdapter } from '../knowledge-graph/adapters/memory-adapter';
import { GraphQueryBuilder, variable } from '../knowledge-graph/query-language';
import { createAction } from '../planning/action-schema';

const toolContext = (agentId = 'caller'): ToolContext => ({
  agentId,
  runId: 'run-1',
  signal: new AbortController().signal,
});

async function seededAdapter(agentId: string): Promise<MemoryGraphAdapter> {
  const adapter = new MemoryGraphAdapter();
  const ids: string[] = [];
  for (const name of ['Alice', 'Bob', 'Carol']) {
    const node = await adapter.addNode({
      agentId,
      name,
      type: 'person',
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user',
    });
    if (!node.success) throw new Error(node.error);
    ids.push(node.data.id);
  }
  await adapter.addEdge({
    agentId,
    sourceNodeId: ids[0],
    targetNodeId: ids[1],
    type: 'knows',
    weight: 1,
    bidirectional: false,
    properties: {},
    confidence: 1,
    source: 'user',
  });
  return adapter;
}

const lightSchema: ActionSchema = {
  name: 'switch_on',
  parameters: [],
  preconditions: [],
  effects: [
    { type: 'assign', variable: 'light', value: true },
    { type: 'increment', variable: 'power', amount: 10 },
  ],
};

describe('NeuroSymbolic configuration', () => {
  it('uses the adapter from config.knowledgeGraph', async () => {
    const adapter = await seededAdapter('default');
    const ns = createNeuroSymbolic({ config: { knowledgeGraph: { adapter } } });
    expect(ns.getGraphAdapter()).toBe(adapter);
    const result = await ns.queryGraph(
      GraphQueryBuilder.select().where(variable('x'), 'knows', variable('y')).build()
    );
    expect(result.success).toBe(true);
    expect(result.data!.count).toBe(1);
  });

  it('applies defaultQueryLimit when the query has no limit', async () => {
    const adapter = await seededAdapter('default');
    const ns = createNeuroSymbolic({
      graphAdapter: adapter,
      config: { knowledgeGraph: { defaultQueryLimit: 1 } },
    });
    const result = await ns.queryGraph(
      GraphQueryBuilder.select().where(variable('x'), 'a', 'person').build()
    );
    expect(result.data!.count).toBe(1);
  });

  it('honours enableNaturalLanguage = false', async () => {
    const ns = createNeuroSymbolic({
      graphAdapter: new MemoryGraphAdapter(),
      config: { knowledgeGraph: { enableNaturalLanguage: false } },
    });
    const result = await ns.askGraph('Who knows Bob?');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled/);
  });

  it('returns errors instead of throwing when the adapter fails', async () => {
    const adapter = new MemoryGraphAdapter();
    adapter.queryNodes = async () => {
      throw new Error('connection reset');
    };
    const ns = createNeuroSymbolic({ graphAdapter: adapter });
    const result = await ns.queryGraph(
      GraphQueryBuilder.select().where(variable('x'), 'knows', variable('y')).build()
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('connection reset');
  });

  it('enforces planning.maxPlanLength', () => {
    const ns = createNeuroSymbolic({ config: { planning: { maxPlanLength: 1 } } });
    ns.registerAction(lightSchema);
    const plan: Plan = {
      id: 'p',
      initialState: { id: 's', variables: {} },
      actions: [createAction('switch_on', {}), createAction('switch_on', {})],
      goalConditions: [],
    };
    expect(ns.validatePlan(plan).data!.valid).toBe(false);
  });
});

describe('NeuroSymbolic logic API', () => {
  it('accepts README-style queries with a trailing question mark', () => {
    const ns = createNeuroSymbolic();
    ns.loadLogicProgram('parent(tom, bob). parent(bob, ann).');
    ns.loadLogicProgram('grandparent(X, Z) :- parent(X, Y), parent(Y, Z).');
    const result = ns.queryLogic('grandparent(tom, X)?');
    expect(result.success).toBe(true);
    expect(ns.getLogicSolutions('grandparent(tom, X)?')).toBe('X = ann.');
  });

  it('asserts structured fact arguments as terms', () => {
    const ns = createNeuroSymbolic();
    ns.assertFact('config', 'retries', [1, 2], true);
    expect(ns.getLogicSolutions('config(retries, L, F)')).toBe('L = [1, 2], F = true.');
    expect(() => ns.assertFact('bad', Infinity)).toThrow(/non-finite/);
  });

  it('surfaces resolution explanations as errors', () => {
    const ns = createNeuroSymbolic({ config: { logic: { maxDepth: 10 } } });
    ns.loadLogicProgram('loop :- loop.');
    const result = ns.queryLogic('loop');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/depth limit/i);
  });
});

describe('NeuroSymbolic planning API', () => {
  it('reports failed repairs as unsuccessful but keeps suggestions', () => {
    const ns = createNeuroSymbolic();
    const plan: Plan = {
      id: 'p',
      initialState: { id: 's', variables: {} },
      actions: [],
      goalConditions: [{ type: 'simple', variable: 'impossible', value: true }],
    };
    const result = ns.repairPlan(plan);
    expect(result.success).toBe(false);
    expect(result.data).toBeDefined();
    expect(result.error).toMatch(/Could not fully repair/);
  });

  it('checks invariants on the repaired plan and includes them in success', async () => {
    const ns = createNeuroSymbolic();
    ns.registerAction(lightSchema);
    ns.addSafetyProperty({
      id: 'power-cap',
      name: 'power stays below 5',
      type: 'invariant',
      condition: { type: 'comparison', variable: 'power', operator: 'lt', value: 5 },
    });

    const plan: Plan = {
      id: 'p',
      initialState: { id: 's', variables: { power: 0 } },
      actions: [],
      goalConditions: [{ type: 'simple', variable: 'light', value: true }],
    };

    const result = await ns.validateAndRepair(plan);
    expect(result.data!.finalPlan.actions.map((a) => a.schemaName)).toEqual(['switch_on']);
    expect(result.data!.invariants![0].satisfied).toBe(false);
    expect(result.success).toBe(false);
  });
});

describe('createNeuroSymbolicTools', () => {
  it('exposes graph tools for an instance configured with an adapter', async () => {
    const adapter = await seededAdapter('kb');
    const instance = createNeuroSymbolic({ graphAdapter: adapter, agentId: 'kb' });
    const tools = createNeuroSymbolicTools({ instance, agentId: 'kb' });

    expect(tools.all.map((t) => t.name)).toContain('query_graph');
    const result = (await tools.findPath!.execute(
      { startNode: 'Alice', endNode: 'Bob' },
      toolContext('some-other-agent')
    )) as { found: boolean; pathLength?: number };
    expect(result.found).toBe(true);
    expect(result.pathLength).toBe(1);
  });

  it('keeps using the calling agent when no agentId is configured', async () => {
    const adapter = await seededAdapter('caller');
    const tools = createNeuroSymbolicTools({ graphAdapter: adapter });
    const result = (await tools.queryGraph!.execute({}, toolContext('caller'))) as {
      count: number;
    };
    expect(result.count).toBe(3);
  });

  it('returns structured errors from the constraint tool', async () => {
    const tools = createNeuroSymbolicTools({ config: { constraints: { solver: 'simple-sat' } } });
    const duplicate = (await tools.solveConstraints.execute(
      {
        variables: [
          { name: 'x', type: 'int' },
          { name: 'x', type: 'bool' },
        ],
        constraints: [],
      },
      toolContext()
    )) as { status: string; error?: string };
    expect(duplicate).toMatchObject({ status: 'error' });
    expect(duplicate.error).toMatch(/already declared/);

    const missingObjective = (await tools.solveConstraints.execute(
      {
        variables: [{ name: 'x', type: 'int', min: 0, max: 3 }],
        constraints: [],
        objective: { type: 'maximize', variable: 'y' },
      },
      toolContext()
    )) as { status: string; error?: string };
    expect(missingObjective.status).toBe('error');
    expect(missingObjective.error).toMatch(/Objective variable 'y'/);
  });

  it('query_logic hides anonymous variables', async () => {
    const tools = createNeuroSymbolicTools();
    await tools.loadProgram.execute({ program: 'pair(1, a). pair(2, b).' }, toolContext());
    const result = (await tools.queryLogic.execute({ query: 'pair(_, X)' }, toolContext())) as {
      solutions: Record<string, string>[];
    };
    expect(result.solutions).toEqual([{ X: 'a' }, { X: 'b' }]);
  });
});
