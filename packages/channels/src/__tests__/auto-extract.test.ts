import { describe, it, expect, vi } from 'vitest';
import { AutoExtractMiddleware, autoExtract } from '../middleware/auto-extract';
import type { ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';

describe('AutoExtractMiddleware', () => {
  const createMocks = () => ({
    extractor: {
      extract: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
    },
    graphAdapter: {
      addNode: vi.fn().mockResolvedValue({ success: true, data: { id: 'n1' } }),
      getNodeByName: vi.fn().mockResolvedValue({ success: true, data: null }),
      updateNode: vi.fn().mockResolvedValue({ success: true }),
      addEdge: vi.fn().mockResolvedValue({ success: true }),
    },
  });

  it('calls next() before extracting', async () => {
    const { extractor, graphAdapter } = createMocks();
    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });

    const callOrder: string[] = [];
    const next = vi.fn().mockImplementation(async () => {
      callOrder.push('next');
    });
    extractor.extract.mockImplementation(async () => {
      callOrder.push('extract');
      return { entities: [], relations: [] };
    });

    const msg = { text: 'Hello world' } as ChannelMessage;
    await mw.handle(msg, {} as MiddlewareContext, next);

    expect(next).toHaveBeenCalled();
  });

  it('does not block on slow extraction', async () => {
    const { extractor, graphAdapter } = createMocks();
    extractor.extract.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ entities: [], relations: [] }), 500))
    );

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    const start = Date.now();
    await mw.handle({ text: 'test' } as ChannelMessage, {} as MiddlewareContext, next);
    const elapsed = Date.now() - start;

    expect(next).toHaveBeenCalled();
    expect(elapsed).toBeLessThan(100);
  });

  it('creates new nodes for extracted entities', async () => {
    const { extractor, graphAdapter } = createMocks();
    extractor.extract.mockResolvedValue({
      entities: [
        { name: 'TypeScript', type: 'concept', confidence: 0.9, description: 'A language' },
      ],
      relations: [],
    });

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      { text: 'I love TypeScript' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );

    await vi.waitFor(() => {
      expect(graphAdapter.addNode).toHaveBeenCalled();
    });
    expect(graphAdapter.addNode.mock.calls[0][0].name).toBe('TypeScript');
  });

  it('updates existing node if confidence is higher', async () => {
    const { extractor, graphAdapter } = createMocks();
    graphAdapter.getNodeByName.mockResolvedValue({
      success: true,
      data: { id: 'n1', confidence: 0.5 },
    });
    extractor.extract.mockResolvedValue({
      entities: [{ name: 'TypeScript', type: 'concept', confidence: 0.9 }],
      relations: [],
    });

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      { text: 'TypeScript is great' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );

    await vi.waitFor(() => {
      expect(graphAdapter.updateNode).toHaveBeenCalledWith(
        'n1',
        expect.objectContaining({ confidence: 0.9 })
      );
    });
  });

  it('does not update node if confidence is lower', async () => {
    const { extractor, graphAdapter } = createMocks();
    graphAdapter.getNodeByName.mockResolvedValue({
      success: true,
      data: { id: 'n1', confidence: 0.95 },
    });
    extractor.extract.mockResolvedValue({
      entities: [{ name: 'TypeScript', type: 'concept', confidence: 0.5 }],
      relations: [],
    });

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      { text: 'TypeScript' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );

    await vi.waitFor(() => {
      expect(graphAdapter.getNodeByName).toHaveBeenCalled();
    });
    expect(graphAdapter.updateNode).not.toHaveBeenCalled();
  });

  it('creates edges for extracted relations', async () => {
    const { extractor, graphAdapter } = createMocks();
    graphAdapter.getNodeByName
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({ success: true, data: { id: 'n1' } })
      .mockResolvedValueOnce({ success: true, data: { id: 'n2' } });

    graphAdapter.addNode
      .mockResolvedValueOnce({ success: true, data: { id: 'n1' } })
      .mockResolvedValueOnce({ success: true, data: { id: 'n2' } });

    extractor.extract.mockResolvedValue({
      entities: [
        { name: 'Alice', type: 'person', confidence: 0.9 },
        { name: 'Berlin', type: 'location', confidence: 0.8 },
      ],
      relations: [{ from: 'Alice', to: 'Berlin', type: 'lives_in', confidence: 0.85 }],
    });

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      { text: 'Alice lives in Berlin' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );

    await vi.waitFor(() => {
      expect(graphAdapter.addEdge).toHaveBeenCalled();
    });
  });

  it('skips edge creation when nodes are not found', async () => {
    const { extractor, graphAdapter } = createMocks();
    graphAdapter.getNodeByName.mockResolvedValue({ success: true, data: null });

    extractor.extract.mockResolvedValue({
      entities: [],
      relations: [{ from: 'Unknown1', to: 'Unknown2', type: 'related_to', confidence: 0.5 }],
    });

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      { text: 'some text' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );

    await vi.waitFor(() => {
      expect(graphAdapter.getNodeByName).toHaveBeenCalled();
    });
    expect(graphAdapter.addEdge).not.toHaveBeenCalled();
  });

  it('checks core fact patterns', async () => {
    const { extractor, graphAdapter } = createMocks();
    const coreFacts = { set: vi.fn() };
    extractor.extract.mockResolvedValue({ entities: [], relations: [] });

    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
      coreFacts: coreFacts as never,
      coreFactPatterns: {
        city: /(?:I moved to|I live in|I'm in)\s+(.+?)(?:\.|$)/i,
      },
    });

    await mw.handle(
      { text: 'I moved to Berlin.' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );

    await vi.waitFor(() => {
      expect(coreFacts.set).toHaveBeenCalledWith('city', 'Berlin');
    });
  });

  it('skips extraction for empty messages', async () => {
    const { extractor, graphAdapter } = createMocks();
    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      { text: '' } as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it('skips extraction for messages without text', async () => {
    const { extractor, graphAdapter } = createMocks();
    const mw = autoExtract({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    await mw.handle(
      {} as ChannelMessage,
      {} as MiddlewareContext,
      vi.fn().mockResolvedValue(undefined)
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it('has name "auto-extract"', () => {
    const { extractor, graphAdapter } = createMocks();
    const mw = new AutoExtractMiddleware({
      extractor: extractor as never,
      graphAdapter: graphAdapter as never,
      agentId: 'a1',
    });
    expect(mw.name).toBe('auto-extract');
  });
});
