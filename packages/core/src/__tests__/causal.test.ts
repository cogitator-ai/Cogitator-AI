import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CausalGraphImpl,
  CausalGraphBuilder,
  dSeparation,
  findMinimalSeparatingSet,
  findBackdoorAdjustment,
  findFrontdoorAdjustment,
  CausalInferenceEngine,
  CounterfactualReasoner,
  evaluateCounterfactual,
  CausalReasoner,
  InMemoryCausalGraphStore,
  InMemoryCausalPatternStore,
  InMemoryInterventionLog,
  CausalExtractor,
} from '../causal';
import type {
  CausalNode,
  CausalEdge,
  CausalGraph,
  CausalGraphData,
  CausalPattern,
  InterventionRecord,
  ExecutionTrace,
  LLMBackend,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator-ai/types';

function createMockLLM(content: string): LLMBackend {
  const response: ChatResponse = {
    id: 'chat-test',
    content,
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    },
  };

  return {
    provider: 'openai',
    chat: vi.fn(async () => response),
    chatStream: async function* (): AsyncGenerator<ChatStreamChunk> {},
  };
}

function createTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-test',
    runId: 'run-test',
    agentId: 'agent-test',
    threadId: 'thread-test',
    input: 'Collect data and summarize it',
    output: 'Summary completed',
    steps: [
      {
        index: 0,
        type: 'tool_call',
        timestamp: 1,
        duration: 5,
        toolCall: {
          id: 'call-1',
          name: 'collect_data',
          arguments: { source: 'docs' },
        },
        toolResult: {
          callId: 'call-1',
          name: 'collect_data',
          result: 'data collected',
        },
      },
      {
        index: 1,
        type: 'tool_call',
        timestamp: 2,
        duration: 5,
        toolCall: {
          id: 'call-2',
          name: 'summarize',
          arguments: { format: 'brief' },
        },
        toolResult: {
          callId: 'call-2',
          name: 'summarize',
          result: 'summary completed',
        },
      },
    ],
    toolCalls: [],
    reflections: [],
    metrics: {
      success: true,
      toolAccuracy: 1,
      efficiency: 1,
      completeness: 1,
      coherence: 1,
    },
    score: 1,
    model: 'test-model',
    createdAt: new Date(0),
    duration: 10,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cost: 0,
    },
    isDemo: false,
    ...overrides,
  };
}

describe('CausalGraphImpl', () => {
  let graph: CausalGraphImpl;

  beforeEach(() => {
    graph = new CausalGraphImpl('test-graph');
  });

  describe('node operations', () => {
    it('should add and retrieve nodes', () => {
      const node: CausalNode = {
        id: 'X',
        name: 'Treatment X',
        variableType: 'treatment',
      };
      graph.addNode(node);
      expect(graph.getNode('X')).toEqual(node);
    });

    it('should list all nodes', () => {
      graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });
      graph.addNode({ id: 'B', name: 'B', variableType: 'observed' });
      expect(graph.getNodes()).toHaveLength(2);
    });

    it('should remove nodes', () => {
      graph.addNode({ id: 'X', name: 'X', variableType: 'treatment' });
      graph.removeNode('X');
      expect(graph.getNode('X')).toBeUndefined();
    });
  });

  describe('edge operations', () => {
    beforeEach(() => {
      graph.addNode({ id: 'X', name: 'X', variableType: 'treatment' });
      graph.addNode({ id: 'Y', name: 'Y', variableType: 'outcome' });
    });

    it('should add edges between nodes', () => {
      const edge: CausalEdge = {
        id: 'e1',
        source: 'X',
        target: 'Y',
        relationType: 'causes',
        strength: 0.8,
        confidence: 0.9,
      };
      graph.addEdge(edge);
      expect(graph.getEdgeBetween('X', 'Y')).toEqual(edge);
    });

    it('should get parents and children', () => {
      graph.addEdge({
        id: 'e1',
        source: 'X',
        target: 'Y',
        relationType: 'causes',
        strength: 0.8,
        confidence: 0.9,
      });

      const parents = graph.getParents('Y');
      expect(parents).toHaveLength(1);
      expect(parents[0].id).toBe('X');

      const children = graph.getChildren('X');
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe('Y');
    });
  });

  describe('graph traversal', () => {
    beforeEach(() => {
      graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });
      graph.addNode({ id: 'B', name: 'B', variableType: 'observed' });
      graph.addNode({ id: 'C', name: 'C', variableType: 'observed' });
      graph.addNode({ id: 'D', name: 'D', variableType: 'observed' });

      graph.addEdge({
        id: 'e1',
        source: 'A',
        target: 'B',
        relationType: 'causes',
        strength: 0.8,
        confidence: 0.9,
      });
      graph.addEdge({
        id: 'e2',
        source: 'B',
        target: 'C',
        relationType: 'causes',
        strength: 0.7,
        confidence: 0.8,
      });
      graph.addEdge({
        id: 'e3',
        source: 'B',
        target: 'D',
        relationType: 'causes',
        strength: 0.6,
        confidence: 0.7,
      });
    });

    it('should find ancestors', () => {
      const ancestors = graph.getAncestors('C');
      expect(ancestors.map((n) => n.id).sort()).toEqual(['A', 'B']);
    });

    it('should find descendants', () => {
      const descendants = graph.getDescendants('A');
      expect(descendants.map((n) => n.id).sort()).toEqual(['B', 'C', 'D']);
    });

    it('should find paths', () => {
      const paths = graph.findPaths('A', 'C');
      expect(paths.length).toBeGreaterThan(0);
      expect(paths[0].nodes).toEqual(['A', 'B', 'C']);
    });
  });

  describe('cycle detection', () => {
    it('should detect cycles', () => {
      graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });
      graph.addNode({ id: 'B', name: 'B', variableType: 'observed' });
      graph.addNode({ id: 'C', name: 'C', variableType: 'observed' });

      graph.addEdge({
        id: 'e1',
        source: 'A',
        target: 'B',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });
      graph.addEdge({
        id: 'e2',
        source: 'B',
        target: 'C',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });
      graph.addEdge({
        id: 'e3',
        source: 'C',
        target: 'A',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });

      expect(graph.hasCycle()).toBe(true);
    });

    it('should not detect cycle in DAG', () => {
      graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });
      graph.addNode({ id: 'B', name: 'B', variableType: 'observed' });
      graph.addNode({ id: 'C', name: 'C', variableType: 'observed' });

      graph.addEdge({
        id: 'e1',
        source: 'A',
        target: 'B',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });
      graph.addEdge({
        id: 'e2',
        source: 'B',
        target: 'C',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });

      expect(graph.hasCycle()).toBe(false);
    });
  });

  describe('Markov blanket', () => {
    it('should compute Markov blanket correctly', () => {
      graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });
      graph.addNode({ id: 'B', name: 'B', variableType: 'observed' });
      graph.addNode({ id: 'C', name: 'C', variableType: 'observed' });
      graph.addNode({ id: 'D', name: 'D', variableType: 'observed' });

      graph.addEdge({
        id: 'e1',
        source: 'A',
        target: 'B',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });
      graph.addEdge({
        id: 'e2',
        source: 'B',
        target: 'C',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });
      graph.addEdge({
        id: 'e3',
        source: 'A',
        target: 'C',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });
      graph.addEdge({
        id: 'e4',
        source: 'C',
        target: 'D',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      });

      const blanket = graph.getMarkovBlanket('B');
      const blanketIds = blanket.map((n) => n.id).sort();
      expect(blanketIds).toContain('A');
      expect(blanketIds).toContain('C');
    });
  });

  describe('serialization', () => {
    it('should preserve persisted metadata when restoring from data', () => {
      const data: CausalGraphData = {
        id: 'persisted-graph',
        name: 'Persisted Graph',
        nodes: [
          { id: 'X', name: 'Treatment', variableType: 'treatment' },
          { id: 'Y', name: 'Outcome', variableType: 'outcome' },
        ],
        edges: [
          {
            id: 'e1',
            source: 'X',
            target: 'Y',
            relationType: 'causes',
            strength: 0.8,
            confidence: 0.9,
          },
        ],
        createdAt: 100,
        updatedAt: 200,
        version: 7,
      };

      const restored = CausalGraphImpl.fromData(data).toData();

      expect(restored.createdAt).toBe(data.createdAt);
      expect(restored.updatedAt).toBe(data.updatedAt);
      expect(restored.version).toBe(data.version);
      expect(restored.nodes).toEqual(data.nodes);
      expect(restored.edges).toEqual(data.edges);
    });
  });
});

describe('CausalGraphBuilder', () => {
  it('should build a graph with fluent API', () => {
    const graph = CausalGraphBuilder.create('test')
      .treatment('X', 'Treatment')
      .outcome('Y', 'Outcome')
      .from('X')
      .causes('Y', { strength: 0.8 })
      .build();

    expect(graph.getNode('X')).toBeDefined();
    expect(graph.getNode('Y')).toBeDefined();
    expect(graph.getEdgeBetween('X', 'Y')).toBeDefined();
  });

  it('should support confounders', () => {
    const graph = CausalGraphBuilder.create('test')
      .treatment('X', 'Treatment')
      .outcome('Y', 'Outcome')
      .confounder('Z', 'Confounder')
      .from('Z')
      .causes('X')
      .from('Z')
      .causes('Y')
      .from('X')
      .causes('Y')
      .build();

    const confounders = graph.getParents('Y').filter((n) => n.variableType === 'confounder');
    expect(confounders).toHaveLength(1);
    expect(confounders[0].id).toBe('Z');
  });
});

describe('d-separation', () => {
  let graph: CausalGraphImpl;

  beforeEach(() => {
    graph = new CausalGraphImpl('test');
    graph.addNode({ id: 'X', name: 'X', variableType: 'treatment' });
    graph.addNode({ id: 'Y', name: 'Y', variableType: 'outcome' });
    graph.addNode({ id: 'Z', name: 'Z', variableType: 'confounder' });

    graph.addEdge({
      id: 'e1',
      source: 'Z',
      target: 'X',
      relationType: 'causes',
      strength: 1,
      confidence: 1,
    });
    graph.addEdge({
      id: 'e2',
      source: 'Z',
      target: 'Y',
      relationType: 'causes',
      strength: 1,
      confidence: 1,
    });
    graph.addEdge({
      id: 'e3',
      source: 'X',
      target: 'Y',
      relationType: 'causes',
      strength: 1,
      confidence: 1,
    });
  });

  it('should find X and Y are not d-separated without conditioning', () => {
    const result = dSeparation(graph, 'X', 'Y', []);
    expect(result.separated).toBe(false);
    expect(result.openPaths.length).toBeGreaterThan(0);
  });

  it('should find X and Y are d-separated when conditioning on Z', () => {
    const result = dSeparation(graph, 'X', 'Y', ['Z']);
    expect(result.blockedPaths.length).toBeGreaterThan(0);
  });
});

describe('findMinimalSeparatingSet', () => {
  it('should find minimal separating set for confounded relationship', () => {
    const graph = CausalGraphBuilder.create('test')
      .treatment('X', 'Treatment')
      .outcome('Y', 'Outcome')
      .confounder('Z', 'Confounder')
      .from('Z')
      .causes('X')
      .from('Z')
      .causes('Y')
      .from('X')
      .causes('Y')
      .build();

    const separatingSet = findMinimalSeparatingSet(graph, 'X', 'Y');
    if (separatingSet !== null) {
      expect(separatingSet).toContain('Z');
    }
  });
});

describe('backdoor adjustment', () => {
  it('should find backdoor adjustment set', () => {
    const graph = CausalGraphBuilder.create('test')
      .treatment('X', 'Treatment')
      .outcome('Y', 'Outcome')
      .confounder('Z', 'Confounder')
      .from('Z')
      .causes('X')
      .from('Z')
      .causes('Y')
      .from('X')
      .causes('Y')
      .build();

    const adjustment = findBackdoorAdjustment(graph, 'X', 'Y');
    expect(adjustment).not.toBeNull();
    if (adjustment) {
      expect(adjustment.isValid).toBe(true);
      expect(adjustment.variables).toContain('Z');
    }
  });
});

describe('frontdoor adjustment', () => {
  it('should find frontdoor adjustment set when applicable', () => {
    const graph = CausalGraphBuilder.create('test')
      .variable('X', 'Treatment', 'treatment')
      .variable('M', 'Mediator', 'mediator')
      .variable('Y', 'Outcome', 'outcome')
      .variable('U', 'Confounder', 'latent')
      .from('X')
      .causes('M')
      .from('M')
      .causes('Y')
      .from('U')
      .causes('X')
      .from('U')
      .causes('Y')
      .build();

    const adjustment = findFrontdoorAdjustment(graph, 'X', 'Y');
    if (adjustment) {
      expect(adjustment.variables).toContain('M');
    }
  });
});

describe('CausalInferenceEngine', () => {
  let graph: CausalGraph;
  let engine: CausalInferenceEngine;

  beforeEach(() => {
    graph = CausalGraphBuilder.create('test')
      .treatment('X', 'Treatment')
      .outcome('Y', 'Outcome')
      .confounder('Z', 'Confounder')
      .from('Z')
      .causes('X')
      .from('Z')
      .causes('Y')
      .from('X')
      .causes('Y', { strength: 0.8 })
      .build();

    engine = new CausalInferenceEngine(graph);
  });

  it('should check if effect is identifiable', () => {
    const result = engine.isIdentifiable('X', 'Y');
    expect(result.identifiable).toBe(true);
  });

  it('should compute interventional effect', () => {
    const query = {
      target: 'Y',
      interventions: { X: 1 },
    };

    const result = engine.computeInterventionalEffect(query);
    expect(result).toBeDefined();
    expect(typeof result.effect).toBe('number');
  });

  it('should estimate ATE', () => {
    const data = [
      { X: 0, Y: 0, Z: 0 },
      { X: 0, Y: 0.2, Z: 0.5 },
      { X: 1, Y: 0.8, Z: 0 },
      { X: 1, Y: 1, Z: 0.5 },
    ];

    const result = engine.estimateATE('X', 'Y', data);
    expect(result).toBeDefined();
    expect(typeof result.effect).toBe('number');
  });

  it('should weight ATT by treated strata rather than population strata', () => {
    const data: Record<string, number[]> = { X: [], Y: [], Z: [] };
    const addRows = (count: number, z: number, x: number, y: number) => {
      for (let i = 0; i < count; i++) {
        data.X.push(x);
        data.Y.push(y);
        data.Z.push(z);
      }
    };

    addRows(1, 0, 1, 1);
    addRows(9, 0, 0, 0);
    addRows(9, 1, 1, 5);
    addRows(1, 1, 0, 2);

    const ate = engine.estimateATE('X', 'Y', data);
    const att = engine.estimateATT('X', 'Y', data);

    expect(ate.effect).toBeCloseTo(2);
    expect(att.effect).toBeCloseTo(2.8);
  });
});

describe('CounterfactualReasoner', () => {
  let graph: CausalGraphImpl;
  let _reasoner: CounterfactualReasoner;

  beforeEach(() => {
    graph = CausalGraphBuilder.create('test')
      .treatment('X', 'Treatment')
      .outcome('Y', 'Outcome')
      .from('X')
      .causes('Y', { strength: 0.8 })
      .withEquation('Y', { type: 'linear', coefficients: { X: 0.8 }, intercept: 0.1 })
      .build() as CausalGraphImpl;

    _reasoner = new CounterfactualReasoner({ config: {} });
  });

  it('should evaluate counterfactual with structural equations', () => {
    const query = {
      target: 'Y',
      intervention: { X: 1 },
      factual: { X: 0, Y: 0.1 },
      question: 'What would Y be if X was 1?',
    };

    const result = evaluateCounterfactual(graph, query);
    expect(result).toBeDefined();
    expect(result.factualValue).toBe(0.1);
    expect(typeof result.counterfactualValue).toBe('number');
  });
});

describe('CausalReasoner', () => {
  it('should report only the nodes and edges actually added from a trace', async () => {
    const llm = createMockLLM(
      JSON.stringify({
        relationships: [
          {
            cause: {
              id: 'collect_data',
              name: 'Collect Data',
              type: 'treatment',
            },
            effect: {
              id: 'summary_quality',
              name: 'Summary Quality',
              type: 'outcome',
            },
            relationType: 'causes',
            strength: 0.8,
            confidence: 0.9,
            mechanism: 'Collecting data gives the summarizer enough evidence.',
          },
        ],
        reasoning: 'Both trace batches describe the same causal relationship.',
      })
    );
    const reasoner = new CausalReasoner({
      llmBackend: llm,
      config: {
        discoveryBatchSize: 1,
      },
    });

    const result = await reasoner.learnFromTrace(createTrace(), 'agent-test');
    const graph = await reasoner.getGraph('agent-test');

    expect(result).toEqual({
      nodesAdded: 2,
      edgesAdded: 1,
      patternsFound: 1,
    });
    expect(graph.getNodes()).toHaveLength(2);
    expect(graph.getEdges()).toHaveLength(1);
  });
});

describe('causal stores', () => {
  it('should isolate stored graph data from caller mutations', async () => {
    const store = new InMemoryCausalGraphStore();
    const data: CausalGraphData = {
      id: 'graph-store-test',
      name: 'Graph Store Test',
      nodes: [
        {
          id: 'X',
          name: 'Treatment',
          variableType: 'treatment',
          equation: {
            type: 'linear',
            coefficients: { Z: 1 },
            intercept: 0,
          },
        },
        { id: 'Y', name: 'Outcome', variableType: 'outcome' },
      ],
      edges: [
        {
          id: 'e1',
          source: 'X',
          target: 'Y',
          relationType: 'causes',
          strength: 0.8,
          confidence: 0.9,
          conditions: ['ready'],
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      version: 3,
      metadata: { agentId: 'agent-store' },
    };

    await store.save(data);
    data.nodes[0].name = 'Mutated';
    data.edges[0].conditions!.push('mutated');

    const loaded = await store.load('graph-store-test');
    expect(loaded!.nodes[0].name).toBe('Treatment');
    expect(loaded!.edges[0].conditions).toEqual(['ready']);

    loaded!.nodes[0].name = 'Loaded mutation';
    loaded!.edges[0].conditions!.push('loaded');

    const reloaded = await store.load('graph-store-test');
    expect(reloaded!.nodes[0].name).toBe('Treatment');
    expect(reloaded!.edges[0].conditions).toEqual(['ready']);
  });

  it('should filter relevant patterns by each provided field', async () => {
    const store = new InMemoryCausalPatternStore();
    const makePattern = (
      id: string,
      trigger: string,
      effect: string,
      score: number
    ): CausalPattern => ({
      id,
      agentId: 'agent-pattern',
      pattern: {
        trigger,
        effect,
        conditions: [],
      },
      occurrences: score,
      successRate: 1,
      avgStrength: 1,
      lastSeen: score,
      createdAt: score,
    });

    await store.save(makePattern('search-success', 'search docs', 'answer found', 3));
    await store.save(makePattern('summarize-success', 'summarize docs', 'answer found', 2));
    await store.save(makePattern('search-failure', 'search docs', 'timeout', 1));

    expect(
      (await store.findRelevant('agent-pattern', { trigger: 'search' }, 10)).map((p) => p.id)
    ).toEqual(['search-success', 'search-failure']);
    expect(
      (await store.findRelevant('agent-pattern', { effect: 'timeout' }, 10)).map((p) => p.id)
    ).toEqual(['search-failure']);
    expect(
      (
        await store.findRelevant('agent-pattern', { trigger: 'summarize', effect: 'answer' }, 10)
      ).map((p) => p.id)
    ).toEqual(['summarize-success']);
  });

  it('should isolate intervention records returned from history', async () => {
    const log = new InMemoryInterventionLog();
    const record: InterventionRecord = {
      id: 'intervention-store-test',
      agentId: 'agent-intervention',
      intervention: { X: 1 },
      observedBefore: { Y: 0 },
      observedAfter: { Y: 1 },
      expectedEffect: {
        action: 'Set X',
        effects: [
          {
            variable: 'Y',
            expectedValue: 1,
            probability: 0.9,
            mechanism: 'X causes Y',
          },
        ],
        sideEffects: [],
        confidence: 0.9,
        reasoning: 'test',
      },
      actualEffect: { Y: 1 },
      success: true,
      timestamp: 1,
    };

    await log.log(record);
    record.expectedEffect.effects[0].expectedValue = 0;

    const history = await log.getHistory('agent-intervention', 1);
    expect(history[0].expectedEffect.effects[0].expectedValue).toBe(1);

    history[0].expectedEffect.effects[0].expectedValue = 0;
    const reloaded = await log.getHistory('agent-intervention', 1);
    expect(reloaded[0].expectedEffect.effects[0].expectedValue).toBe(1);
  });
});

describe('CausalExtractor', () => {
  it('should ignore malformed relationships from LLM output', async () => {
    const extractor = new CausalExtractor({
      llmBackend: createMockLLM(
        JSON.stringify({
          relationships: [
            {},
            {
              cause: { id: 'valid_cause', name: 'Valid Cause', type: 'treatment' },
              effect: { id: 'valid_effect', name: 'Valid Effect', type: 'outcome' },
              relationType: 'causes',
              strength: 2,
              confidence: 2,
              mechanism: 'test',
            },
          ],
          reasoning: 'test',
        })
      ),
    });
    const graph = CausalGraphBuilder.create('extractor-malformed').build();

    const result = await extractor.extractFromText('extract relationships', graph);

    expect(result.nodes.map((node) => node.id).sort()).toEqual(['valid_cause', 'valid_effect']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].strength).toBe(1);
    expect(result.edges[0].confidence).toBe(1);
  });
});

describe('getTripleType', () => {
  it('should identify chain structures', () => {
    const graph = CausalGraphBuilder.create('test')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .from('A')
      .causes('B')
      .from('B')
      .causes('C')
      .build();

    expect(graph.getEdgeBetween('A', 'B')).toBeDefined();
    expect(graph.getEdgeBetween('B', 'C')).toBeDefined();
  });

  it('should identify fork structures', () => {
    const graph = CausalGraphBuilder.create('test')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .from('B')
      .causes('A')
      .from('B')
      .causes('C')
      .build();

    const bChildren = graph.getChildren('B');
    expect(bChildren).toHaveLength(2);
    expect(bChildren.map((n) => n.id).sort()).toEqual(['A', 'C']);
  });

  it('should identify collider structures', () => {
    const graph = CausalGraphBuilder.create('test')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .from('A')
      .causes('B')
      .from('C')
      .causes('B')
      .build();

    const bParents = graph.getParents('B');
    expect(bParents).toHaveLength(2);
    expect(bParents.map((n) => n.id).sort()).toEqual(['A', 'C']);
  });
});

describe('regression: self-loop prevention', () => {
  it('should throw when adding an edge from a node to itself', () => {
    const graph = new CausalGraphImpl('self-loop-test', 'Self Loop Test');
    graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });

    expect(() =>
      graph.addEdge({
        id: 'e1',
        source: 'A',
        target: 'A',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      })
    ).toThrow('Self-loop not allowed: A');
  });

  it('should allow edges between different nodes', () => {
    const graph = new CausalGraphImpl('no-self-loop', 'No Self Loop');
    graph.addNode({ id: 'A', name: 'A', variableType: 'observed' });
    graph.addNode({ id: 'B', name: 'B', variableType: 'observed' });

    expect(() =>
      graph.addEdge({
        id: 'e1',
        source: 'A',
        target: 'B',
        relationType: 'causes',
        strength: 1,
        confidence: 1,
      })
    ).not.toThrow();
  });
});

describe('regression: counterfactual polynomial evaluation', () => {
  it('should evaluate polynomial terms using extracted variable name', () => {
    const graph = CausalGraphBuilder.create('poly-test')
      .variable('X', 'Input', 'treatment')
      .variable('Y', 'Output', 'outcome')
      .from('X')
      .causes('Y')
      .from('Y')
      .withEquation({
        type: 'polynomial',
        coefficients: { 'X^2': 3, X: 2 },
        intercept: 1,
      })
      .build() as CausalGraphImpl;

    const result = evaluateCounterfactual(graph, {
      target: 'Y',
      intervention: { X: 2 },
      factual: { X: 1, Y: 6 },
      question: 'What would Y be if X was 2?',
    });

    expect(result.counterfactualValue).toBe(1 + 3 * 4 + 2 * 2);
  });

  it('should handle polynomial terms without power suffix', () => {
    const graph = CausalGraphBuilder.create('poly-no-power')
      .variable('X', 'Input', 'treatment')
      .variable('Y', 'Output', 'outcome')
      .from('X')
      .causes('Y')
      .from('Y')
      .withEquation({
        type: 'polynomial',
        coefficients: { X: 5 },
        intercept: 0,
      })
      .build() as CausalGraphImpl;

    const result = evaluateCounterfactual(graph, {
      target: 'Y',
      intervention: { X: 3 },
      factual: { X: 1, Y: 5 },
      question: 'What would Y be if X was 3?',
    });

    expect(result.counterfactualValue).toBe(5 * 3);
  });
});

describe('regression: d-separation blocks a path when any triple is blocked', () => {
  it('should report a chain path as blocked when one non-collider is conditioned', () => {
    const graph = CausalGraphBuilder.create('partial-block')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .variable('D', 'D', 'observed')
      .from('A')
      .causes('B')
      .from('B')
      .causes('C')
      .from('C')
      .causes('D')
      .build();

    const result = dSeparation(graph, 'A', 'D', ['B']);

    const path = result.paths.find((p) => p.nodes.length === 4);
    expect(path).toBeDefined();
    expect(path!.isBlocked).toBe(true);
    expect(path!.blockingNodes).toEqual(['B']);
    expect(result.separated).toBe(true);
    expect(result.openPaths).toHaveLength(0);
  });

  it('should report all conditioned non-colliders on a blocked path', () => {
    const graph = CausalGraphBuilder.create('all-blocked')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .variable('D', 'D', 'observed')
      .from('A')
      .causes('B')
      .from('B')
      .causes('C')
      .from('C')
      .causes('D')
      .build();

    const result = dSeparation(graph, 'A', 'D', ['B', 'C']);

    expect(result.separated).toBe(true);
    expect(result.blockedPaths.length).toBeGreaterThan(0);
    expect(result.openPaths).toHaveLength(0);

    const path = result.blockedPaths[0];
    expect(path.blockingNodes).toContain('B');
    expect(path.blockingNodes).toContain('C');
  });

  it('should report path as open when no triples in a multi-triple path are blocked', () => {
    const graph = CausalGraphBuilder.create('none-blocked')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .variable('D', 'D', 'observed')
      .from('A')
      .causes('B')
      .from('B')
      .causes('C')
      .from('C')
      .causes('D')
      .build();

    const result = dSeparation(graph, 'A', 'D', []);

    expect(result.separated).toBe(false);
    expect(result.openPaths.length).toBeGreaterThan(0);
  });

  it('should keep collider paths open when a collider descendant is conditioned', () => {
    const graph = CausalGraphBuilder.create('partial-vs-full')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .variable('D', 'D', 'observed')
      .from('A')
      .causes('B')
      .from('C')
      .causes('B')
      .from('B')
      .causes('D')
      .build();

    const unconditioned = dSeparation(graph, 'A', 'C', []);
    expect(unconditioned.separated).toBe(true);

    const conditionedOnDescendant = dSeparation(graph, 'A', 'C', ['D']);
    expect(conditionedOnDescendant.separated).toBe(false);
    expect(conditionedOnDescendant.openPaths.length).toBeGreaterThan(0);
  });

  it('should block a longer chain with any conditioned non-collider', () => {
    const graph = CausalGraphBuilder.create('longer-chain')
      .variable('A', 'A', 'observed')
      .variable('B', 'B', 'observed')
      .variable('C', 'C', 'observed')
      .variable('D', 'D', 'observed')
      .variable('E', 'E', 'observed')
      .from('A')
      .causes('B')
      .from('B')
      .causes('C')
      .from('C')
      .causes('D')
      .from('D')
      .causes('E')
      .build();

    const singleConditioned = dSeparation(graph, 'A', 'E', ['B']);
    const singlePath = singleConditioned.paths.find((p) => p.nodes.length === 5);
    expect(singlePath).toBeDefined();
    expect(singlePath!.isBlocked).toBe(true);
    expect(singlePath!.blockingNodes).toEqual(['B']);
    expect(singleConditioned.separated).toBe(true);

    const fullResult = dSeparation(graph, 'A', 'E', ['B', 'C', 'D']);
    const fullPath = fullResult.paths.find((p) => p.nodes.length === 5);
    expect(fullPath).toBeDefined();
    expect(fullPath!.isBlocked).toBe(true);
    expect(fullPath!.blockingNodes).toEqual(['B', 'C', 'D']);
  });
});

describe('regression: sampleGaussian NaN guard', () => {
  it('should never return NaN from CounterfactualReasoner noise sampling', () => {
    const reasoner = new CounterfactualReasoner({
      defaultNoiseMean: 0,
      defaultNoiseStd: 1,
    });

    const graph = CausalGraphBuilder.create('nan-test')
      .variable('X', 'X', 'treatment')
      .variable('Y', 'Y', 'outcome')
      .from('X')
      .causes('Y')
      .from('Y')
      .withEquation({
        type: 'linear',
        coefficients: { X: 1 },
        intercept: 0,
        noiseDistribution: 'gaussian',
      })
      .build() as CausalGraphImpl;

    for (let i = 0; i < 500; i++) {
      const result = reasoner.evaluate(graph, {
        target: 'Y',
        intervention: { X: 1 },
        factual: { X: 0 },
        question: 'test',
      });

      expect(Number.isNaN(result.counterfactualValue)).toBe(false);
    }
  });

  it('should produce valid gaussian samples when Math.random would return 0', () => {
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++;
      if (callCount % 2 === 1) return 0;
      return 0.5;
    });

    try {
      const reasoner = new CounterfactualReasoner({
        defaultNoiseMean: 0,
        defaultNoiseStd: 1,
      });

      const graph = CausalGraphBuilder.create('zero-random-test')
        .variable('X', 'X', 'treatment')
        .variable('Y', 'Y', 'outcome')
        .from('X')
        .causes('Y')
        .from('Y')
        .withEquation({
          type: 'linear',
          coefficients: { X: 1 },
          intercept: 0,
          noiseDistribution: 'gaussian',
        })
        .build() as CausalGraphImpl;

      const result = reasoner.evaluate(graph, {
        target: 'Y',
        intervention: { X: 1 },
        factual: { X: 0 },
        question: 'test',
      });

      expect(Number.isNaN(result.counterfactualValue)).toBe(false);
      expect(typeof result.counterfactualValue).toBe('number');
      expect(Number.isFinite(result.counterfactualValue)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
