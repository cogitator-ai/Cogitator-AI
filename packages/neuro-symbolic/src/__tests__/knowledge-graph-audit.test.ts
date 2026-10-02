import { describe, it, expect, beforeEach } from 'vitest';
import type { GraphNode, EntityType, RelationType, QueryBinding } from '@cogitator-ai/types';
import { MemoryGraphAdapter } from '../knowledge-graph/adapters/memory-adapter';
import {
  executeQuery,
  parseQueryString,
  GraphQueryBuilder,
  variable,
} from '../knowledge-graph/query-language';
import {
  analyzeNLQuery,
  buildQueryFromAnalysis,
  executeNLQuery,
  parseNLQueryResponse,
} from '../knowledge-graph/natural-language-query';
import { createReasoningEngine } from '../knowledge-graph/reasoning-engine';
import { parseEntityExtractionResponse } from '../knowledge-graph/prompts';
import { extractJSON } from '../knowledge-graph/utils';

const AGENT = 'kg-agent';

interface Fixture {
  adapter: MemoryGraphAdapter;
  nodes: Record<string, GraphNode>;
}

async function buildFixture(): Promise<Fixture> {
  const adapter = new MemoryGraphAdapter();
  const nodes: Record<string, GraphNode> = {};

  const addNode = async (name: string, type: EntityType, properties = {}) => {
    const result = await adapter.addNode({
      agentId: AGENT,
      name,
      type,
      aliases: [],
      properties,
      confidence: 1,
      source: 'user',
    });
    if (!result.success) throw new Error(result.error);
    nodes[name] = result.data;
  };

  const addEdge = async (from: string, to: string, type: RelationType, bidirectional = false) => {
    const result = await adapter.addEdge({
      agentId: AGENT,
      sourceNodeId: nodes[from].id,
      targetNodeId: nodes[to].id,
      type,
      weight: 1,
      bidirectional,
      properties: {},
      confidence: 0.9,
      source: 'user',
    });
    if (!result.success) throw new Error(result.error);
  };

  await addNode('Alice', 'person', { profile: { level: 3 } });
  await addNode('Bob', 'person', { profile: { level: 1 } });
  await addNode('Acme', 'organization');
  await addNode('Paris', 'location');
  await addNode('France', 'location');

  await addEdge('Alice', 'Acme', 'works_at');
  await addEdge('Acme', 'Paris', 'located_in');
  await addEdge('Paris', 'France', 'located_in');
  await addEdge('Alice', 'Bob', 'knows', true);

  return { adapter, nodes };
}

function names(bindings: QueryBinding[]): Record<string, unknown>[] {
  return bindings.map((binding) =>
    Object.fromEntries(
      Object.entries(binding).map(([key, value]) => [
        key,
        typeof value === 'object' && value !== null
          ? ((value as { name?: string; type?: string }).name ?? (value as { type: string }).type)
          : value,
      ])
    )
  );
}

describe('executeQuery', () => {
  let fixture: Fixture;
  const ctx = () => ({ adapter: fixture.adapter, agentId: AGENT, variables: new Map() });

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  it('joins patterns on shared variables', async () => {
    const query = GraphQueryBuilder.select()
      .where(variable('p'), 'works_at', variable('c'))
      .where(variable('c'), 'located_in', 'Paris')
      .build();
    expect(names((await executeQuery(query, ctx())).bindings)).toEqual([{ p: 'Alice', c: 'Acme' }]);
  });

  it('returns no results when an earlier pattern has no matches', async () => {
    const query = GraphQueryBuilder.select()
      .where(variable('x'), 'works_at', 'Nowhere')
      .where(variable('x'), 'knows', variable('y'))
      .build();
    expect((await executeQuery(query, ctx())).count).toBe(0);
  });

  it('matches bidirectional edges in both directions', async () => {
    const query = GraphQueryBuilder.select().where(variable('x'), 'knows', 'Alice').build();
    expect(names((await executeQuery(query, ctx())).bindings)).toEqual([{ x: 'Bob' }]);
  });

  it('matches node types with a/type predicates', async () => {
    const query = GraphQueryBuilder.select().where(variable('x'), 'a', 'Person').build();
    const result = await executeQuery(query, ctx());
    expect(names(result.bindings).map((b) => b.x)).toEqual(['Alice', 'Bob']);
  });

  it('treats describe queries as undirected', async () => {
    const query = GraphQueryBuilder.describe().where('Acme', variable('r'), variable('o')).build();
    const result = await executeQuery(query, ctx());
    expect(names(result.bindings).map((b) => b.o)).toEqual(['Alice', 'Paris']);
  });

  it('filters on nested property paths', async () => {
    const query = GraphQueryBuilder.select()
      .where(variable('x'), 'a', 'person')
      .filter('x.properties.profile.level', 'gt', 2)
      .build();
    expect(names((await executeQuery(query, ctx())).bindings)).toEqual([{ x: 'Alice' }]);
  });

  it('counts all bindings with count(*)', async () => {
    const query = GraphQueryBuilder.select()
      .where(variable('a'), 'located_in', variable('b'))
      .count('*', 'total')
      .build();
    expect((await executeQuery(query, ctx())).bindings).toEqual([{ total: 2 }]);
  });

  it('is not truncated at 1000 nodes', async () => {
    for (let i = 0; i < 1005; i++) {
      await fixture.adapter.addNode({
        agentId: AGENT,
        name: `filler-${i}`,
        type: 'concept',
        aliases: [],
        properties: {},
        confidence: 1,
        source: 'user',
      });
    }
    const last = await fixture.adapter.getNodeByName(AGENT, 'filler-1004');
    await fixture.adapter.addEdge({
      agentId: AGENT,
      sourceNodeId: last.success && last.data ? last.data.id : '',
      targetNodeId: fixture.nodes.Paris.id,
      type: 'related_to',
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 1,
      source: 'user',
    });
    const query = GraphQueryBuilder.select().where(variable('x'), 'related_to', 'Paris').build();
    expect(names((await executeQuery(query, ctx())).bindings)).toEqual([{ x: 'filler-1004' }]);
  });

  it('executes single-line query strings end to end', async () => {
    const query = parseQueryString('SELECT ?p WHERE ?p works_at Acme');
    expect(names((await executeQuery(query, ctx())).bindings)).toEqual([{ p: 'Alice' }]);
  });
});

describe('parseQueryString', () => {
  it('parses braces, separators, filters, ordering and paging', () => {
    const query = parseQueryString(
      'SELECT ?p ?c WHERE { ?p works_at ?c . ?c located_in "San Francisco" } ' +
        'FILTER(?p.name contains "Al") ORDER BY DESC(?p.name) LIMIT 5 OFFSET 1'
    );
    expect(query.patterns).toEqual([
      { subject: { name: 'p' }, predicate: 'works_at', object: { name: 'c' } },
      { subject: { name: 'c' }, predicate: 'located_in', object: 'San Francisco' },
    ]);
    expect(query.filters).toEqual([{ field: 'p.name', operator: 'contains', value: 'Al' }]);
    expect(query.orderBy).toEqual([{ field: 'p.name', direction: 'desc' }]);
    expect(query.limit).toBe(5);
    expect(query.offset).toBe(1);
  });

  it('parses multi-line queries with list filters', () => {
    const query = parseQueryString(`
      SELECT ?x
      WHERE
        ?x knows Bob
      FILTER ?x.name in ["Alice", "Carol"]
      ORDER BY ?x.confidence desc
    `);
    expect(query.patterns).toHaveLength(1);
    expect(query.filters).toEqual([{ field: 'x.name', operator: 'in', value: ['Alice', 'Carol'] }]);
    expect(query.orderBy).toEqual([{ field: 'x.confidence', direction: 'desc' }]);
  });
});

describe('natural language queries', () => {
  it('uses word boundaries for intents and variables', () => {
    const analysis = analyzeNLQuery('Which country is the whole team based in?');
    expect(analysis.intent).not.toBe('count');
    expect(analysis.variables).not.toContain('person');
  });

  it('maps relation phrases to real relation types', () => {
    expect(analyzeNLQuery('Who lives in "Paris"?').relations).toEqual(['located_in']);
    expect(analyzeNLQuery('Who is employed by "Acme"?').relations).toEqual(['works_at']);
  });

  it('builds a describe query for entity-only questions', () => {
    const query = buildQueryFromAnalysis(analyzeNLQuery('Tell me about Acme'));
    expect(query.type).toBe('describe');
    expect(query.patterns).toHaveLength(1);
  });

  it('answers entity questions from both edge directions', async () => {
    const { adapter } = await buildFixture();
    const result = await executeNLQuery('Tell me about Acme', { adapter, agentId: AGENT });
    expect(result.results.count).toBe(2);
    expect(result.naturalLanguageResponse).toContain('Alice');
    expect(result.naturalLanguageResponse).toContain('Paris');
  });

  it('counts matches for how-many questions', async () => {
    const { adapter } = await buildFixture();
    const result = await executeNLQuery('How many things are located in "France"?', {
      adapter,
      agentId: AGENT,
    });
    expect(result.naturalLanguageResponse).toBe('The count is 1.');
  });

  it('validates LLM query JSON', () => {
    const query = parseNLQueryResponse(
      '{"type": "count", "patterns": [{"subject": "?x", "predicate": "knows", "object": 5}], "filters": [{"field": "?x.name", "operator": "drop table", "value": 1}, {"field": "x.name", "operator": "eq", "value": "Bob"}], "limit": -3}'
    );
    expect(query).toEqual({
      type: 'select',
      patterns: [{ subject: { name: 'x' }, predicate: 'knows', object: undefined }],
      filters: [{ field: 'x.name', operator: 'eq', value: 'Bob' }],
      aggregates: [{ function: 'count', field: '*', alias: 'count' }],
    });
  });
});

describe('reasoning engine inference', () => {
  it('does not emit duplicate inferred edges', async () => {
    const { adapter } = await buildFixture();
    const engine = createReasoningEngine(adapter, AGENT, { minConfidence: 0 });
    const inferred = await engine.infer();
    const keys = inferred.map((e) => `${e.sourceNodeId}->${e.targetNodeId}:${e.type}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(inferred.some((e) => e.ruleId === 'transitive' && e.type === 'located_in')).toBe(true);
  });
});

describe('MemoryGraphAdapter hardening', () => {
  it('rejects edges with unknown endpoints', async () => {
    const adapter = new MemoryGraphAdapter();
    const result = await adapter.addEdge({
      agentId: AGENT,
      sourceNodeId: 'missing',
      targetNodeId: 'missing-too',
      type: 'knows',
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 1,
      source: 'user',
    });
    expect(result.success).toBe(false);
  });

  it('scopes shortest paths and traversal to the agent', async () => {
    const { adapter, nodes } = await buildFixture();
    const foreign = await adapter.findShortestPath('other-agent', nodes.Alice.id, nodes.Paris.id);
    expect(foreign.success).toBe(false);

    const own = await adapter.findShortestPath(AGENT, nodes.Alice.id, nodes.Paris.id);
    expect(own.success && own.data?.length).toBe(2);
  });

  it('honours traversal limits', async () => {
    const { adapter, nodes } = await buildFixture();
    const result = await adapter.traverse({
      agentId: AGENT,
      startNodeId: nodes.Alice.id,
      maxDepth: 5,
      direction: 'both',
      limit: 1,
    });
    expect(result.success && result.data.paths.length).toBe(1);
  });

  it('includes bidirectional edges in directional neighbor lookups', async () => {
    const { adapter, nodes } = await buildFixture();
    const outgoingFromBob = await adapter.getNeighbors(nodes.Bob.id, 'outgoing');
    expect(outgoingFromBob.success && outgoingFromBob.data.map((n) => n.node.name)).toEqual([
      'Alice',
    ]);
    const incomingToAlice = await adapter.getNeighbors(nodes.Alice.id, 'incoming');
    expect(incomingToAlice.success && incomingToAlice.data.map((n) => n.node.name)).toEqual([
      'Bob',
    ]);
  });

  it('does not delete the target when it appears among merge sources', async () => {
    const { adapter, nodes } = await buildFixture();
    const merged = await adapter.mergeNodes(nodes.Paris.id, [nodes.Paris.id, nodes.France.id]);
    expect(merged.success).toBe(true);
    expect((await adapter.getNode(nodes.Paris.id)).data).not.toBeNull();
    expect((await adapter.getNode(nodes.France.id)).data).toBeNull();
  });
});

describe('LLM response parsing helpers', () => {
  it('normalizes extracted entity and relation types', () => {
    const parsed = parseEntityExtractionResponse(
      '{"entities": [{"name": "Alice", "type": "Person", "confidence": 7}, {"name": "", "type": "event"}], "relations": [{"source": "Alice", "target": "Acme", "type": "works at"}, {"source": "x"}]}'
    );
    expect(parsed).toEqual({
      entities: [{ name: 'Alice', type: 'person', description: undefined, confidence: 1 }],
      relations: [{ source: 'Alice', target: 'Acme', type: 'works_at', confidence: 0.5 }],
    });
  });

  it('extractJSON skips braces that are not JSON', () => {
    expect(extractJSON('Use {x} then {"a": 1}')).toBe('{"a": 1}');
    expect(extractJSON('no json here')).toBeNull();
  });
});
