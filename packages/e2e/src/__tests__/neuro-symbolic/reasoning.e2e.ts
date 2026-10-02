import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Cogitator, Agent } from '@cogitator-ai/core';
import type { RunResult } from '@cogitator-ai/core';
import {
  createNeuroSymbolic,
  createNeuroSymbolicTools,
  createAction,
  isZ3Available,
  MemoryGraphAdapter,
  parseQueryString,
  createNLToFactsPrompt,
  parseLLMFactsResponse,
} from '@cogitator-ai/neuro-symbolic';
import type { ActionSchema, Plan, GraphNode, RelationType } from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const z3Available = await isZ3Available();

describe('Neuro-Symbolic: Prolog engine end to end', () => {
  it('evaluates arithmetic with correct operator precedence', () => {
    const ns = createNeuroSymbolic();
    ns.loadLogicProgram(`
      price(widget, 10).
      price(gadget, 25).
      total(Item, Qty, Total) :- price(Item, P), Total is P * Qty + 5.
    `);
    expect(ns.getLogicSolutions('total(gadget, 3, T)')).toBe('T = 80.');
  });

  it('keeps cut local and commits if-then-else', () => {
    const ns = createNeuroSymbolic();
    ns.loadLogicProgram(`
      grade(S, a) :- S >= 90, !.
      grade(S, b) :- S >= 75, !.
      grade(_, c).
      label(S, L) :- ( grade(S, a) -> L = excellent ; L = ok ).
      first_pass(Name) :- score(Name, S), S >= 75, !.
      score(ann, 60). score(bob, 80). score(cid, 95).
    `);
    expect(ns.getLogicSolutions('grade(80, G)')).toBe('G = b.');
    expect(ns.getLogicSolutions('label(95, L)')).toBe('L = excellent.');
    expect(ns.getLogicSolutions('label(70, L)')).toBe('L = ok.');
    expect(ns.getLogicSolutions('first_pass(N)')).toBe('N = bob.');
  });

  it('collects answers with findall and aggregates them', () => {
    const ns = createNeuroSymbolic();
    ns.loadLogicProgram('order(o1, 30). order(o2, 45). order(o3, 25).');
    expect(
      ns.getLogicSolutions('findall(A, order(_, A), Amounts), sum_list(Amounts, Total)?')
    ).toBe('Amounts = [30, 45, 25], Total = 100.');
  });
});

describe.skipIf(!z3Available)('Neuro-Symbolic: Z3 constraint solving', () => {
  it('solves a scheduling problem through the default Z3 backend', async () => {
    const ns = createNeuroSymbolic();
    const builder = ns.createConstraintProblem('shifts');
    const alice = builder.int('alice', 0, 8);
    const bob = builder.int('bob', 0, 8);
    const budget = builder.real('budget', 0, 1000);
    builder.assert(alice.add(bob).eq(12));
    builder.assert(alice.gte(bob));
    builder.assert(budget.eq(alice.mul(25).add(bob.mul(30))));
    builder.minimize(budget);

    const result = await ns.solve(builder.build());
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('sat');
    if (result.data!.status === 'sat') {
      const { alice: a, bob: b, budget: cost } = result.data!.model.assignments;
      expect(a).toBe(8);
      expect(b).toBe(4);
      expect(cost).toBe(320);
    }
  });
});

describe('Neuro-Symbolic: knowledge graph queries', () => {
  let ns: ReturnType<typeof createNeuroSymbolic>;

  beforeAll(async () => {
    const adapter = new MemoryGraphAdapter();
    const nodes: Record<string, GraphNode> = {};
    for (const [name, type] of [
      ['Alice', 'person'],
      ['Bob', 'person'],
      ['Acme', 'organization'],
      ['Berlin', 'location'],
    ] as const) {
      const result = await adapter.addNode({
        agentId: 'kg',
        name,
        type,
        aliases: [],
        properties: {},
        confidence: 1,
        source: 'user',
      });
      if (!result.success) throw new Error(result.error);
      nodes[name] = result.data;
    }
    const link = async (from: string, to: string, type: RelationType, bidirectional = false) => {
      const result = await adapter.addEdge({
        agentId: 'kg',
        sourceNodeId: nodes[from].id,
        targetNodeId: nodes[to].id,
        type,
        weight: 1,
        bidirectional,
        properties: {},
        confidence: 1,
        source: 'user',
      });
      if (!result.success) throw new Error(result.error);
    };
    await link('Alice', 'Acme', 'works_at');
    await link('Bob', 'Acme', 'works_at');
    await link('Acme', 'Berlin', 'located_in');
    await link('Alice', 'Bob', 'knows', true);

    ns = createNeuroSymbolic({ graphAdapter: adapter, agentId: 'kg' });
  });

  it('runs a joined SPARQL-like query string', async () => {
    const result = await ns.queryGraph(
      parseQueryString(
        'SELECT ?p WHERE { ?p works_at ?c . ?c located_in Berlin } ORDER BY ?p.name DESC'
      )
    );
    expect(result.success).toBe(true);
    const people = result.data!.bindings.map((b) => (b.p as GraphNode).name);
    expect(people).toEqual(['Bob', 'Alice']);
  });

  it('answers natural language questions', async () => {
    const result = await ns.askGraph('Who works at "Acme"?');
    expect(result.success).toBe(true);
    expect(result.data!.naturalLanguageResponse).toContain('Alice');
    expect(result.data!.naturalLanguageResponse).toContain('Bob');

    const describeResult = await ns.askGraph('Tell me about Acme');
    expect(describeResult.data!.results.count).toBe(3);
  });

  it('finds paths across bidirectional edges', async () => {
    const result = await ns.findPath(
      (await ns.getGraphAdapter()!.getNodeByName('kg', 'Bob')).data!.id,
      (await ns.getGraphAdapter()!.getNodeByName('kg', 'Berlin')).data!.id
    );
    expect(result.success).toBe(true);
  });
});

describe('Neuro-Symbolic: plan repair with invariants', () => {
  it('repairs a plan and verifies invariants on the repaired plan', async () => {
    const ns = createNeuroSymbolic();
    const schemas: ActionSchema[] = [
      {
        name: 'charge',
        parameters: [],
        preconditions: [],
        effects: [{ type: 'assign', variable: 'battery', value: 100 }],
      },
      {
        name: 'fly',
        parameters: [{ name: 'to', type: 'string', required: true }],
        preconditions: [{ type: 'comparison', variable: 'battery', operator: 'gte', value: 50 }],
        effects: [
          { type: 'assign', variable: 'location', value: '?to' },
          { type: 'decrement', variable: 'battery', amount: 50 },
        ],
      },
    ];
    ns.registerActions(schemas);
    ns.addSafetyProperty({
      id: 'battery-floor',
      name: 'battery never negative',
      type: 'invariant',
      condition: { type: 'comparison', variable: 'battery', operator: 'gte', value: 0 },
    });

    const plan: Plan = {
      id: 'delivery',
      initialState: { id: 's0', variables: { battery: 10, location: 'base' } },
      actions: [createAction('fly', { to: 'depot' })],
      goalConditions: [{ type: 'simple', variable: 'location', value: 'depot' }],
    };

    const result = await ns.validateAndRepair(plan);
    expect(result.data!.validation.valid).toBe(false);
    expect(result.data!.finalPlan.actions.map((a) => a.schemaName)).toEqual(['charge', 'fly']);
    expect(result.data!.invariants!.every((r) => r.satisfied)).toBe(true);
    expect(result.success).toBe(true);
  });
});

describeGoogle('Neuro-Symbolic: LLM integration (Gemini)', () => {
  let cogitator: Cogitator;
  const model = 'google/gemini-3.5-flash-lite';

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: model,
        providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
      },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('agent answers with the query_logic tool', { timeout: 180_000 }, async () => {
    const tools = createNeuroSymbolicTools();
    tools.instance.loadLogicProgram(`
      parent(tom, bob). parent(bob, ann). parent(bob, pat). parent(pat, jim).
      grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
    `);

    const agent = new Agent({
      name: 'logic-agent',
      model,
      instructions:
        'You answer family questions ONLY by calling the query_logic tool with a Prolog query ' +
        'against the loaded knowledge base. Report the names returned by the tool.',
      tools: tools.all,
    });

    let result: RunResult | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await cogitator.run(agent, {
        input: 'Who are the grandchildren of tom? Use the query_logic tool.',
      });
      if (result.toolCalls.some((tc) => tc.name === 'query_logic')) break;
    }

    expect(result!.toolCalls.some((tc) => tc.name === 'query_logic')).toBe(true);
    const output = result!.output.toLowerCase();
    expect(output).toContain('ann');
    expect(output).toContain('pat');
  });

  it('turns natural language into loadable Prolog facts', { timeout: 180_000 }, async () => {
    const agent = new Agent({
      name: 'fact-extractor',
      model,
      instructions: 'Output only Prolog facts, one per line, no markdown fences, no commentary.',
    });

    const prompt = createNLToFactsPrompt({
      naturalLanguageText: 'Alice manages Bob. Bob manages Carol. Carol manages Dave.',
      existingPredicates: ['manages/2'],
    });
    const result = await cogitator.run(agent, { input: prompt });
    const parsed = parseLLMFactsResponse(result.output);
    expect(parsed.success).toBe(true);

    const ns = createNeuroSymbolic();
    const loaded = ns.loadLogicProgram(parsed.facts!.join('\n'));
    expect(loaded.errors).toEqual([]);
    ns.loadLogicProgram('chain(X, Y) :- manages(X, Y). chain(X, Z) :- manages(X, Y), chain(Y, Z).');
    expect(ns.proveLogic('chain(alice, dave)').data).toBe(true);
  });
});
