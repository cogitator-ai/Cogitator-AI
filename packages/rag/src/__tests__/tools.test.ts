import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchTool, createIngestTool, ragTools } from '../tools';
import type { RAGPipeline } from '../rag-pipeline';

function mockPipeline() {
  return {
    ingest: vi.fn(),
    query: vi.fn(),
    getStats: vi.fn(),
  } as unknown as RAGPipeline;
}

describe('createSearchTool', () => {
  let pipeline: RAGPipeline;

  beforeEach(() => {
    pipeline = mockPipeline();
  });

  it('has correct name and description', () => {
    const tool = createSearchTool(pipeline);
    expect(tool.name).toBe('rag_search');
    expect(tool.description).toContain('Search');
  });

  it('has valid parameter schema', () => {
    const tool = createSearchTool(pipeline);
    const parsed = tool.parameters.parse({ query: 'test' });
    expect(parsed).toEqual({ query: 'test' });
  });

  it('accepts optional limit and threshold', () => {
    const tool = createSearchTool(pipeline);
    const parsed = tool.parameters.parse({ query: 'test', limit: 5, threshold: 0.7 });
    expect(parsed).toEqual({ query: 'test', limit: 5, threshold: 0.7 });
  });

  it('rejects missing query', () => {
    const tool = createSearchTool(pipeline);
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it('calls pipeline.query with correct args', async () => {
    const results = [{ chunkId: 'c1', documentId: 'd1', content: 'hello', score: 0.9 }];
    vi.mocked(pipeline.query).mockResolvedValue(results);

    const tool = createSearchTool(pipeline);
    const response = await tool.execute({ query: 'hello', limit: 5, threshold: 0.7 });

    expect(pipeline.query).toHaveBeenCalledWith('hello', { topK: 5, threshold: 0.7 });
    expect(response).toEqual({
      success: true,
      query: 'hello',
      results,
      count: 1,
    });
  });

  it('uses defaults when limit/threshold omitted', async () => {
    vi.mocked(pipeline.query).mockResolvedValue([]);

    const tool = createSearchTool(pipeline);
    await tool.execute({ query: 'test' });

    expect(pipeline.query).toHaveBeenCalledWith('test', {
      topK: undefined,
      threshold: undefined,
    });
  });

  it('returns error on pipeline failure', async () => {
    vi.mocked(pipeline.query).mockRejectedValue(new Error('connection lost'));

    const tool = createSearchTool(pipeline);
    const response = await tool.execute({ query: 'test' });

    expect(response).toEqual({ success: false, error: 'connection lost' });
  });
});

describe('createIngestTool', () => {
  let pipeline: RAGPipeline;

  beforeEach(() => {
    pipeline = mockPipeline();
  });

  it('has correct name and description', () => {
    const tool = createIngestTool(pipeline);
    expect(tool.name).toBe('rag_ingest');
    expect(tool.description).toContain('Ingest');
  });

  it('has valid parameter schema', () => {
    const tool = createIngestTool(pipeline);
    const parsed = tool.parameters.parse({ source: '/data/file.txt' });
    expect(parsed).toEqual({ source: '/data/file.txt' });
  });

  it('rejects missing source', () => {
    const tool = createIngestTool(pipeline);
    expect(() => tool.parameters.parse({})).toThrow();
  });

  it('calls pipeline.ingest with correct args', async () => {
    vi.mocked(pipeline.ingest).mockResolvedValue({ documents: 3, chunks: 15 });

    const tool = createIngestTool(pipeline);
    const response = await tool.execute({ source: '/data/docs' });

    expect(pipeline.ingest).toHaveBeenCalledWith('/data/docs');
    expect(response).toEqual({
      success: true,
      source: '/data/docs',
      documents: 3,
      chunks: 15,
    });
  });

  it('returns error on pipeline failure', async () => {
    vi.mocked(pipeline.ingest).mockRejectedValue(new Error('file not found'));

    const tool = createIngestTool(pipeline);
    const response = await tool.execute({ source: '/nope' });

    expect(response).toEqual({ success: false, error: 'file not found' });
  });
});

describe('ragTools', () => {
  it('returns both tools', () => {
    const pipeline = mockPipeline();
    const tools = ragTools(pipeline);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('rag_search');
    expect(tools[1].name).toBe('rag_ingest');
  });
});
