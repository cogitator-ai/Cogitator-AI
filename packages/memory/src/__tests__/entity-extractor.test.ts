import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatResponse, LLMBackend } from '@cogitator-ai/types';
import { LLMEntityExtractor, type LLMBackendMinimal } from '../knowledge-graph/entity-extractor';

const extraction = JSON.stringify({
  entities: [
    { name: 'Marie Curie', type: 'person', confidence: 0.95 },
    { name: 'University of Paris', type: 'organization', confidence: 0.9 },
  ],
  relations: [
    {
      sourceEntity: 'Marie Curie',
      targetEntity: 'University of Paris',
      type: 'works_at',
      confidence: 0.9,
    },
  ],
});

function fakeBackend() {
  const chat = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
    id: 'r1',
    content: extraction,
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  }));
  const backend: LLMBackend = {
    provider: 'openai',
    chat,
    async *chatStream() {},
  };
  return { backend, chat };
}

describe('LLMEntityExtractor', () => {
  it('runs on an LLMBackend with the configured model', async () => {
    const { backend, chat } = fakeBackend();
    const extractor = new LLMEntityExtractor(backend, { model: 'gpt-4o-mini' });

    const result = await extractor.extract('Marie Curie worked at the University of Paris.');

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini', responseFormat: { type: 'json_object' } })
    );
    expect(result.entities.map((e) => e.name)).toEqual(['Marie Curie', 'University of Paris']);
    expect(result.relations).toHaveLength(1);
  });

  it('refuses an LLMBackend without a model', () => {
    const { backend } = fakeBackend();

    expect(() => Reflect.construct(LLMEntityExtractor, [backend, {}])).toThrow(
      'needs a model when given an LLMBackend'
    );
  });

  it('keeps working with a hand-written chat adapter', async () => {
    const chat = vi.fn(async (_options: Parameters<LLMBackendMinimal['chat']>[0]) => ({
      content: extraction,
    }));
    const minimal: LLMBackendMinimal = { chat };

    const result = await new LLMEntityExtractor(minimal).extract('text');

    expect(chat.mock.calls[0][0]).not.toHaveProperty('model');
    expect(result.entities).toHaveLength(2);
  });

  it('passes the configured model to a hand-written chat adapter', async () => {
    const chat = vi.fn(async (_options: Parameters<LLMBackendMinimal['chat']>[0]) => ({
      content: extraction,
    }));

    await new LLMEntityExtractor({ chat }, { model: 'llama3.3' }).extract('text');

    expect(chat.mock.calls[0][0].model).toBe('llama3.3');
  });
});
