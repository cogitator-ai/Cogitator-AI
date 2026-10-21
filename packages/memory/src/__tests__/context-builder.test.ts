import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextBuilder } from '../context-builder';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryItems } from '../memory-items';
import type { Message, GraphNode, GraphEdge, GraphContext } from '@cogitator-ai/types';
import type { GraphContextBuilder } from '../knowledge-graph/graph-context-builder';

describe('ContextBuilder', () => {
  let adapter: InMemoryAdapter;
  let threadId: string;

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();

    const thread = await adapter.createThread('agent1');
    if (!thread.success) throw new Error('Failed to create thread');
    threadId = thread.data.id;
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('basic context building', () => {
    it('builds empty context for empty thread', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(0);
      expect(result.tokenCount).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('includes system prompt when provided', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeSystemPrompt: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'You are helpful.',
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe('You are helpful.');
    });

    it('excludes system prompt when disabled', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeSystemPrompt: false },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'You are helpful.',
      });

      expect(result.messages).toHaveLength(0);
    });
  });

  describe('recent strategy', () => {
    it('includes all messages when they fit', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      for (const msg of messages) {
        await adapter.addEntry({ threadId, message: msg, tokenCount: 10 });
      }

      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(3);
      expect(result.truncated).toBe(false);
    });

    it('truncates oldest messages when exceeding limit', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.addEntry({
          threadId,
          message: { role: 'user', content: `Message ${i}` },
          tokenCount: 10,
        });
      }

      const builder = new ContextBuilder(
        { maxTokens: 35, reserveTokens: 5, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(3);
      expect(result.truncated).toBe(true);
      expect(result.messages[0].content).toBe('Message 2');
      expect(result.messages[2].content).toBe('Message 4');
    });

    it('keeps a contiguous window of the newest messages when an older one does not fit', async () => {
      const turns: Array<{ message: Message; tokenCount: number }> = [
        { message: { role: 'user', content: 'Q1' }, tokenCount: 10 },
        { message: { role: 'assistant', content: 'A1, a very long answer' }, tokenCount: 300 },
        { message: { role: 'user', content: 'Q2' }, tokenCount: 10 },
        { message: { role: 'assistant', content: 'A2' }, tokenCount: 10 },
        { message: { role: 'user', content: 'Thanks' }, tokenCount: 10 },
      ];
      for (const turn of turns) {
        await adapter.addEntry({ threadId, ...turn });
      }

      const builder = new ContextBuilder(
        { maxTokens: 200, reserveTokens: 0, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages.map((message) => message.content)).toEqual(['Q2', 'A2', 'Thanks']);
      expect(result.truncated).toBe(true);
    });

    it('keeps no history when the newest message alone exceeds the budget', async () => {
      await adapter.addEntry({ threadId, message: { role: 'user', content: 'Hi' }, tokenCount: 5 });
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'A huge paste' },
        tokenCount: 500,
      });

      const builder = new ContextBuilder(
        { maxTokens: 100, reserveTokens: 0, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });

    it('respects reserve tokens', async () => {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'Hello' },
        tokenCount: 50,
      });

      const builder = new ContextBuilder(
        { maxTokens: 100, reserveTokens: 60, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.messages).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });
  });

  describe('metadata tracking', () => {
    it('tracks original and included message counts', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.addEntry({
          threadId,
          message: { role: 'user', content: `Msg ${i}` },
          tokenCount: 10,
        });
      }

      const builder = new ContextBuilder(
        { maxTokens: 35, reserveTokens: 5, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.metadata.originalMessageCount).toBe(5);
      expect(result.metadata.includedMessageCount).toBe(3);
    });

    it('tracks token count correctly', async () => {
      await adapter.addEntry({
        threadId,
        message: { role: 'user', content: 'Hello' },
        tokenCount: 15,
      });
      await adapter.addEntry({
        threadId,
        message: { role: 'assistant', content: 'Hi' },
        tokenCount: 10,
      });

      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent' },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.tokenCount).toBe(25);
    });

    it('includes system prompt tokens in count', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeSystemPrompt: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'Be helpful.',
      });

      expect(result.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('empty facts and semantic results', () => {
    it('returns empty arrays when adapters not provided', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeFacts: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.facts).toHaveLength(0);
      expect(result.semanticResults).toHaveLength(0);
      expect(result.metadata.factsIncluded).toBe(0);
      expect(result.metadata.semanticResultsIncluded).toBe(0);
    });
  });

  describe('memory items as facts', () => {
    it('lists what holds for the user, instructions first, with the value a fact replaced', async () => {
      const items = new MemoryItems({ adapter });
      const said = {
        trust: 'user' as const,
        confidence: 0.9,
        evidence: [],
        verified: true,
        saidAt: new Date('2026-01-01'),
      };
      await items.write([
        {
          ...said,
          kind: 'fact',
          content: 'Ana lives in Porto',
          subject: 'Ana',
          attribute: 'city',
          value: 'Porto',
          scope: { agentId: 'agent1', userId: 'u1' },
          sessionAt: new Date('2026-01-01'),
        },
        {
          ...said,
          kind: 'fact',
          content: 'Ana lives in Lisbon',
          subject: 'Ana',
          attribute: 'city',
          value: 'Lisbon',
          scope: { agentId: 'agent1', userId: 'u1' },
          sessionAt: new Date('2026-01-10'),
        },
        {
          ...said,
          kind: 'instruction',
          content: 'Answer Ana in Portuguese',
          scope: { agentId: 'agent1', userId: 'u1' },
          sessionAt: new Date('2026-01-01'),
        },
        {
          ...said,
          kind: 'fact',
          content: 'Bo lives in Oslo',
          scope: { agentId: 'agent1', userId: 'u2' },
          sessionAt: new Date('2026-01-01'),
        },
      ]);
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeFacts: true },
        { memoryAdapter: adapter, memoryItems: items }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        userId: 'u1',
        currentInput: 'hi',
      });

      expect(result.facts.map((fact) => fact.content)).toEqual([
        'Answer Ana in Portuguese',
        'Ana lives in Lisbon',
      ]);
      expect(result.memoryContext).toContain(
        'Known facts:\n- Answer Ana in Portuguese\n- Ana lives in Lisbon (previously: Porto)'
      );
    });
  });

  describe('hybrid recall', () => {
    it('keeps the tail as history and brings older turns and items as memory of the turn', async () => {
      const day = (n: number) => new Date(Date.UTC(2026, 2, n, 9));
      const say = async (role: 'user' | 'assistant', content: string, n: number) =>
        adapter.addEntry({
          threadId,
          message: { role, content },
          tokenCount: 1,
          createdAt: day(n),
        });
      await say('user', 'I adopted a dog named Rex from the shelter', 1);
      await say('assistant', 'Congratulations on Rex!', 1);
      for (let n = 0; n < 40; n++) {
        await say('user', `Let us plan the garden bed number ${n} together`, 2);
        await say('assistant', `Bed ${n} gets tomatoes and basil this year`, 2);
      }
      const items = new MemoryItems({ adapter });
      const base = {
        trust: 'user' as const,
        confidence: 0.9,
        evidence: [],
        verified: true,
        saidAt: day(1),
        scope: { agentId: 'agent1', userId: 'u1' },
      };
      await items.write([
        {
          ...base,
          kind: 'fact',
          content: 'Ana lived in Porto',
          subject: 'Ana',
          attribute: 'city',
          value: 'Porto',
          sessionAt: day(1),
        },
        {
          ...base,
          kind: 'fact',
          content: 'Ana lives in Lisbon',
          subject: 'Ana',
          attribute: 'city',
          value: 'Lisbon',
          sessionAt: day(3),
        },
        { ...base, kind: 'event', content: 'Rex had his first vet visit', sessionAt: day(1) },
      ]);
      const builder = new ContextBuilder(
        { maxTokens: 1200, strategy: 'hybrid', includeFacts: true },
        { memoryAdapter: adapter, memoryItems: items }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        userId: 'u1',
        currentInput: 'What is my dog Rex like?',
        asOf: day(10),
      });

      const history = result.messages.filter((m) => m.role !== 'system').slice(0, -1);
      expect(history.some((m) => String(m.content).includes('Rex'))).toBe(false);
      expect(result.memoryContext).toContain(
        'Earlier in this conversation:\n[2026-03-01] user: I adopted a dog named Rex from the shelter\n[2026-03-01] assistant: Congratulations on Rex!'
      );
      expect(result.memoryContext?.match(/I adopted a dog named Rex/g)).toHaveLength(1);
      expect(result.facts.map((fact) => fact.content)).toContain('Rex had his first vet visit');
      expect(result.recalled?.items.map((item) => item.content) ?? []).not.toContain(
        'Rex had his first vet visit'
      );

      const before = await builder.build({
        threadId,
        agentId: 'agent1',
        userId: 'u1',
        currentInput: 'Where did Ana live before Lisbon?',
        asOf: day(10),
      });
      expect(before.memoryContext).toContain(
        'From memory:\n- Ana lived in Porto (2026-03-01 to 2026-03-03)'
      );
    });
  });

  describe('memory items under the runtime agent id', () => {
    it('reads facts kept for agent.id beside the memory id of the agent', async () => {
      const items = new MemoryItems({ adapter });
      const fact = (content: string, agentId: string) => ({
        kind: 'fact' as const,
        content,
        trust: 'system' as const,
        confidence: 1,
        evidence: [],
        saidAt: new Date(),
        sessionAt: new Date(),
        scope: { agentId },
      });
      await items.write([fact('Plan is pro', 'agent_123'), fact('Likes tea', 'concierge')]);
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeFacts: true },
        { memoryAdapter: adapter, memoryItems: items }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent_123',
        memoryAgentId: 'concierge',
      });

      expect(result.facts.map((f) => f.content).sort()).toEqual(['Likes tea', 'Plan is pro']);
    });
  });

  describe('memory items as facts, let go and narrowed', () => {
    it('does not show a value memory let go and keeps one state per slot', async () => {
      const items = new MemoryItems({ adapter });
      const fact = (value: string, at: string, scope: Record<string, string>) => ({
        kind: 'fact' as const,
        content: `Ana lives in ${value}`,
        subject: 'Ana',
        attribute: 'city',
        value,
        trust: 'user' as const,
        confidence: 0.9,
        evidence: [],
        verified: true,
        saidAt: new Date(at),
        sessionAt: new Date(at),
        scope: { agentId: 'agent1', ...scope },
      });
      const [porto] = await items.write([fact('Porto', '2026-01-01', { userId: 'u1' })]);
      await items.write([fact('Lisbon', '2026-01-10', { userId: 'u1' })]);
      await items.write([fact('Faro', '2026-01-10', { userId: 'u1', threadId })]);
      await items.expire([porto!.id]);
      const builder = new ContextBuilder(
        { maxTokens: 1000, strategy: 'recent', includeFacts: true },
        { memoryAdapter: adapter, memoryItems: items }
      );

      const result = await builder.build({ threadId, agentId: 'agent1', userId: 'u1' });

      expect(result.facts.map((fact) => fact.content)).toEqual(['Ana lives in Faro']);
      expect(result.memoryContext).not.toContain('Porto');
    });
  });

  describe('graph context', () => {
    const makeNode = (id: string, name: string): GraphNode => ({
      id,
      agentId: 'agent1',
      type: 'person',
      name,
      aliases: [],
      properties: {},
      confidence: 0.9,
      source: 'extracted',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 1,
    });

    const makeEdge = (id: string, sourceId: string, targetId: string): GraphEdge => ({
      id,
      agentId: 'agent1',
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      type: 'knows',
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 0.9,
      source: 'extracted',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    function mockGraphContextBuilder(context: GraphContext): GraphContextBuilder {
      return { buildContext: vi.fn().mockResolvedValue(context) } as unknown as GraphContextBuilder;
    }

    it('sends graph context with the turn, not in the system message', async () => {
      const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Bob')];
      const edges = [makeEdge('e1', 'n1', 'n2')];
      const gcb = mockGraphContextBuilder({
        nodes,
        edges,
        formattedContext:
          '## Knowledge Graph Context\n\n### Entities\n- **Alice** (Person)\n- **Bob** (Person)',
        tokenCount: 50,
      });

      const builder = new ContextBuilder(
        { maxTokens: 2000, strategy: 'recent', includeGraphContext: true },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'You are helpful.',
        currentInput: 'Tell me about Alice',
      });

      expect(result.metadata.graphNodesIncluded).toBe(2);
      expect(result.metadata.graphEdgesIncluded).toBe(1);
      expect(result.graphContext).toBeDefined();
      expect(result.graphContext!.nodes).toHaveLength(2);
      expect(result.memoryContext).toContain('Knowledge Graph Context');
      expect(result.messages[0].content).not.toContain('Knowledge Graph Context');
      expect(result.messages.at(-1)).toEqual({ role: 'user', content: result.memoryContext });
    });

    it('keeps the system prompt apart from the graph context', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [makeNode('n1', 'Alice')],
        edges: [],
        formattedContext: '## Knowledge Graph Context\n\n### Entities\n- **Alice** (Person)',
        tokenCount: 30,
      });

      const builder = new ContextBuilder(
        {
          maxTokens: 2000,
          strategy: 'recent',
          includeSystemPrompt: true,
          includeGraphContext: true,
        },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        systemPrompt: 'Be helpful.',
        currentInput: 'Who is Alice?',
      });

      expect(result.messages[0]).toEqual({ role: 'system', content: 'Be helpful.' });
      expect(result.memoryContext).toContain('Knowledge Graph Context');
    });

    it('adds no system message for graph context alone', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [makeNode('n1', 'Alice')],
        edges: [],
        formattedContext: '## Knowledge Graph Context\n\n### Entities\n- **Alice** (Person)',
        tokenCount: 30,
      });

      const builder = new ContextBuilder(
        {
          maxTokens: 2000,
          strategy: 'recent',
          includeSystemPrompt: false,
          includeGraphContext: true,
        },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        currentInput: 'Who is Alice?',
      });

      expect(result.messages.map((m) => m.role)).toEqual(['user']);
      expect(result.messages[0].content).toContain('Knowledge Graph Context');
    });

    it('does nothing when graphContextBuilder is not provided', async () => {
      const builder = new ContextBuilder(
        { maxTokens: 2000, strategy: 'recent', includeGraphContext: true },
        { memoryAdapter: adapter }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        currentInput: 'Tell me about Alice',
      });

      expect(result.metadata.graphNodesIncluded).toBe(0);
      expect(result.metadata.graphEdgesIncluded).toBe(0);
      expect(result.graphContext).toBeUndefined();
    });

    it('does nothing when currentInput is not provided', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [makeNode('n1', 'Alice')],
        edges: [],
        formattedContext: '## Knowledge Graph Context',
        tokenCount: 30,
      });

      const builder = new ContextBuilder(
        { maxTokens: 2000, strategy: 'recent', includeGraphContext: true },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({ threadId, agentId: 'agent1' });

      expect(result.metadata.graphNodesIncluded).toBe(0);
      expect(gcb.buildContext).not.toHaveBeenCalled();
    });

    it('does nothing when includeGraphContext is false', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [makeNode('n1', 'Alice')],
        edges: [],
        formattedContext: '## Knowledge Graph Context',
        tokenCount: 30,
      });

      const builder = new ContextBuilder(
        { maxTokens: 2000, strategy: 'recent', includeGraphContext: false },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        currentInput: 'Who is Alice?',
      });

      expect(result.metadata.graphNodesIncluded).toBe(0);
      expect(gcb.buildContext).not.toHaveBeenCalled();
    });

    it('skips when graph returns no nodes', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [],
        edges: [],
        formattedContext: '',
        tokenCount: 0,
      });

      const builder = new ContextBuilder(
        { maxTokens: 2000, strategy: 'recent', includeGraphContext: true },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        currentInput: 'Something unknown',
      });

      expect(result.metadata.graphNodesIncluded).toBe(0);
      expect(result.graphContext).toBeUndefined();
    });

    it('passes graphContextOptions to buildContext', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [makeNode('n1', 'Alice')],
        edges: [],
        formattedContext: '## Knowledge Graph Context',
        tokenCount: 30,
      });

      const builder = new ContextBuilder(
        {
          maxTokens: 2000,
          strategy: 'recent',
          includeGraphContext: true,
          graphContextOptions: { maxNodes: 5, maxDepth: 2 },
        },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      await builder.build({
        threadId,
        agentId: 'agent1',
        currentInput: 'Tell me about Alice',
      });

      expect(gcb.buildContext).toHaveBeenCalledWith('agent1', 'Tell me about Alice', {
        maxNodes: 5,
        maxDepth: 2,
      });
    });

    it('adds graph token count to total', async () => {
      const gcb = mockGraphContextBuilder({
        nodes: [makeNode('n1', 'Alice')],
        edges: [],
        formattedContext: '## Knowledge Graph Context\n\n### Entities\n- **Alice** (Person)',
        tokenCount: 60,
      });

      const builder = new ContextBuilder(
        {
          maxTokens: 2000,
          strategy: 'recent',
          includeSystemPrompt: false,
          includeGraphContext: true,
        },
        { memoryAdapter: adapter, graphContextBuilder: gcb }
      );

      const result = await builder.build({
        threadId,
        agentId: 'agent1',
        currentInput: 'Who is Alice?',
      });

      expect(result.tokenCount).toBe(60);
    });
  });
});
