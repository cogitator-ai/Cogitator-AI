import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryInsightStore } from '../reflection/insight-store';
import {
  parseReflectionResponse,
  buildToolReflectionPrompt,
  buildErrorReflectionPrompt,
} from '../reflection/prompts';
import type { Insight, AgentContext, ReflectionAction } from '@cogitator-ai/types';

describe('InMemoryInsightStore', () => {
  let store: InMemoryInsightStore;

  beforeEach(() => {
    store = new InMemoryInsightStore();
  });

  const createInsight = (overrides: Partial<Insight> = {}): Insight => ({
    id: `insight_${Math.random().toString(36).slice(2)}`,
    type: 'tip',
    content: 'Test insight content',
    context: 'When testing',
    confidence: 0.8,
    usageCount: 0,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    agentId: 'agent_1',
    source: {
      runId: 'run_1',
      reflectionId: 'ref_1',
    },
    ...overrides,
  });

  it('stores and retrieves insights', async () => {
    const insight = createInsight();
    await store.store(insight);

    const retrieved = await store.getById(insight.id);
    expect(retrieved).toEqual(insight);
  });

  it('stores many insights at once', async () => {
    const insights = [
      createInsight({ id: 'i1' }),
      createInsight({ id: 'i2' }),
      createInsight({ id: 'i3' }),
    ];
    await store.storeMany(insights);

    const all = await store.getAll('agent_1');
    expect(all).toHaveLength(3);
  });

  it('gets all insights for an agent', async () => {
    await store.store(createInsight({ agentId: 'agent_1' }));
    await store.store(createInsight({ agentId: 'agent_1' }));
    await store.store(createInsight({ agentId: 'agent_2' }));

    const agent1Insights = await store.getAll('agent_1');
    const agent2Insights = await store.getAll('agent_2');

    expect(agent1Insights).toHaveLength(2);
    expect(agent2Insights).toHaveLength(1);
  });

  it('finds relevant insights by context matching', async () => {
    await store.store(
      createInsight({
        id: 'i1',
        content: 'Always validate user input before processing',
        context: 'When handling user data',
        confidence: 0.9,
      })
    );
    await store.store(
      createInsight({
        id: 'i2',
        content: 'Use timeout for external API calls',
        context: 'When calling external services',
        confidence: 0.8,
      })
    );
    await store.store(
      createInsight({
        id: 'i3',
        content: 'Log errors with stack traces',
        context: 'When debugging',
        confidence: 0.7,
      })
    );

    const relevant = await store.findRelevant('agent_1', 'handling user input validation', 2);
    expect(relevant.length).toBeLessThanOrEqual(2);
    expect(relevant[0].content).toContain('validate');
  });

  it('marks insight as used and updates usage count', async () => {
    const insight = createInsight({ usageCount: 0 });
    await store.store(insight);

    await store.markUsed(insight.id);
    const updated = await store.getById(insight.id);

    expect(updated?.usageCount).toBe(1);
    expect(updated?.lastUsedAt.getTime()).toBeGreaterThanOrEqual(insight.lastUsedAt.getTime());
  });

  it('prunes old insights when limit exceeded', async () => {
    for (let i = 0; i < 10; i++) {
      await store.store(
        createInsight({
          id: `insight_${i}`,
          usageCount: i,
          confidence: 0.5 + i * 0.05,
        })
      );
    }

    const pruned = await store.prune('agent_1', 5);
    expect(pruned).toBe(5);

    const remaining = await store.getAll('agent_1');
    expect(remaining).toHaveLength(5);
  });

  it('deletes insight by id', async () => {
    const insight = createInsight();
    await store.store(insight);

    const deleted = await store.delete(insight.id);
    expect(deleted).toBe(true);

    const retrieved = await store.getById(insight.id);
    expect(retrieved).toBeNull();
  });

  it('clears all insights for an agent', async () => {
    await store.store(createInsight({ agentId: 'agent_1' }));
    await store.store(createInsight({ agentId: 'agent_1' }));
    await store.store(createInsight({ agentId: 'agent_2' }));

    await store.clear('agent_1');

    expect(await store.getAll('agent_1')).toHaveLength(0);
    expect(await store.getAll('agent_2')).toHaveLength(1);
  });

  it('returns stats', async () => {
    await store.store(createInsight({ agentId: 'agent_1' }));
    await store.store(createInsight({ agentId: 'agent_2' }));

    const stats = store.getStats();
    expect(stats.totalInsights).toBe(2);
    expect(stats.agentCount).toBe(2);
  });
});

describe('parseReflectionResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify({
      wasSuccessful: true,
      confidence: 0.85,
      reasoning: 'The tool call was appropriate',
      alternativesConsidered: ['other_tool'],
      whatCouldImprove: 'Add caching',
      insights: [{ type: 'pattern', content: 'Cache results', context: 'When calling APIs' }],
    });

    const parsed = parseReflectionResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.wasSuccessful).toBe(true);
    expect(parsed?.confidence).toBe(0.85);
    expect(parsed?.insights).toHaveLength(1);
  });

  it('handles markdown code blocks', () => {
    const response =
      '```json\n{"wasSuccessful": true, "confidence": 0.9, "reasoning": "ok", "insights": []}\n```';

    const parsed = parseReflectionResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.wasSuccessful).toBe(true);
  });

  it('handles plain code blocks', () => {
    const response =
      '```\n{"wasSuccessful": false, "confidence": 0.3, "reasoning": "failed", "insights": []}\n```';

    const parsed = parseReflectionResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.wasSuccessful).toBe(false);
  });

  it('returns null for invalid JSON', () => {
    const response = 'This is not JSON at all';
    const parsed = parseReflectionResponse(response);
    expect(parsed).toBeNull();
  });

  it('fixes missing boolean fields', () => {
    const response = JSON.stringify({
      confidence: 0.5,
      reasoning: 'test',
      insights: [],
    });

    const parsed = parseReflectionResponse(response);
    expect(parsed?.wasSuccessful).toBe(false);
  });

  it('clamps confidence to valid range', () => {
    const response = JSON.stringify({
      wasSuccessful: true,
      confidence: 1.5,
      reasoning: 'test',
      insights: [],
    });

    const parsed = parseReflectionResponse(response);
    expect(parsed?.confidence).toBe(0.5);
  });

  it('filters invalid insights', () => {
    const response = JSON.stringify({
      wasSuccessful: true,
      confidence: 0.8,
      reasoning: 'test',
      insights: [
        { type: 'tip', content: 'valid', context: 'when testing' },
        { type: 'invalid' },
        'not an object',
        null,
      ],
    });

    const parsed = parseReflectionResponse(response);
    expect(parsed?.insights).toHaveLength(1);
  });
});

describe('Reflection Prompts', () => {
  const createContext = (): AgentContext => ({
    agentId: 'agent_1',
    agentName: 'TestAgent',
    runId: 'run_1',
    threadId: 'thread_1',
    goal: 'Analyze data and generate report',
    iterationIndex: 0,
    previousActions: [],
    availableTools: ['calculator', 'web_search', 'file_write'],
  });

  describe('buildToolReflectionPrompt', () => {
    it('builds prompt with tool call details', () => {
      const action: ReflectionAction = {
        type: 'tool_call',
        toolName: 'calculator',
        input: { expression: '2 + 2' },
        output: 4,
        duration: 50,
      };

      const prompt = buildToolReflectionPrompt(action, createContext(), []);

      expect(prompt).toContain('calculator');
      expect(prompt).toContain('2 + 2');
      expect(prompt).toContain('4');
      expect(prompt).toContain('50');
      expect(prompt).toContain('Analyze data and generate report');
    });

    it('includes relevant insights', () => {
      const action: ReflectionAction = {
        type: 'tool_call',
        toolName: 'web_search',
        input: { query: 'test' },
        output: { results: [] },
      };

      const insights: Insight[] = [
        {
          id: 'i1',
          type: 'tip',
          content: 'Use specific search terms',
          context: 'When searching',
          confidence: 0.9,
          usageCount: 5,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          agentId: 'agent_1',
          source: { runId: 'r1', reflectionId: 'ref1' },
        },
      ];

      const prompt = buildToolReflectionPrompt(action, createContext(), insights);

      expect(prompt).toContain('Relevant past learnings');
      expect(prompt).toContain('Use specific search terms');
    });

    it('lists available tools', () => {
      const action: ReflectionAction = {
        type: 'tool_call',
        toolName: 'calculator',
        input: {},
        output: null,
      };

      const prompt = buildToolReflectionPrompt(action, createContext(), []);

      expect(prompt).toContain('calculator');
      expect(prompt).toContain('web_search');
      expect(prompt).toContain('file_write');
    });
  });

  describe('buildErrorReflectionPrompt', () => {
    it('builds prompt with error details', () => {
      const action: ReflectionAction = {
        type: 'error',
        toolName: 'web_search',
        error: 'Connection timeout',
      };

      const prompt = buildErrorReflectionPrompt(action, createContext(), []);

      expect(prompt).toContain('Connection timeout');
      expect(prompt).toContain('web_search');
      expect(prompt).toContain('What caused this error');
    });

    it('includes previous actions', () => {
      const action: ReflectionAction = {
        type: 'error',
        error: 'Out of memory',
      };

      const context = createContext();
      context.previousActions = [
        { type: 'tool_call', toolName: 'file_read' },
        { type: 'tool_call', toolName: 'process_data' },
      ];

      const prompt = buildErrorReflectionPrompt(action, context, []);

      expect(prompt).toContain('Previous actions');
      expect(prompt).toContain('file_read');
      expect(prompt).toContain('process_data');
    });
  });
});
