import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextBuilder } from '../context-builder';
import { InMemoryAdapter } from '../adapters/memory';
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

    it('injects graph context into system message', async () => {
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
      expect(result.messages[0].content).toContain('Knowledge Graph Context');
    });

    it('appends to existing system message', async () => {
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

      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toContain('Be helpful.');
      expect(result.messages[0].content).toContain('Knowledge Graph Context');
    });

    it('creates system message when none exists', async () => {
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

      expect(result.messages[0].role).toBe('system');
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
