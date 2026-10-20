import { describe, it, expect, afterAll } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { countTokens, GoogleEmbeddingService } from '@cogitator-ai/memory';
import type { EmbeddingService } from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

/** An embedding service of the application's own: Gemini behind a wrapper that counts its calls. */
class CountingEmbeddingService implements EmbeddingService {
  calls = 0;
  readonly embedded: string[] = [];

  constructor(private readonly inner: EmbeddingService) {}

  get model(): string {
    return this.inner.model;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  embed(text: string): Promise<number[]> {
    this.calls++;
    this.embedded.push(text);
    return this.inner.embed(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.embedded.push(...texts);
    return this.inner.embedBatch(texts);
  }
}

describeGoogle('Memory: an embedding service instance in the config', () => {
  const embedding = new CountingEmbeddingService(
    new GoogleEmbeddingService({ apiKey: process.env.GOOGLE_API_KEY! })
  );
  const cog = new Cogitator({
    llm: {
      defaultModel: 'google/gemini-3.5-flash-lite',
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
    },
    memory: {
      adapter: 'memory',
      embedding,
      contextBuilder: { strategy: 'relevant', maxTokens: 600 },
    },
  });

  afterAll(async () => {
    await cog.close();
  });

  it(
    'retrieves an old fact through the given service instead of building its own',
    { timeout: 120_000 },
    async () => {
      const agent = new Agent({
        name: 'custom-embedding',
        model: 'google/gemini-3.5-flash-lite',
        instructions: 'Answer briefly from the conversation history.',
      });
      const memory = await cog.getMemory();
      if (!memory) throw new Error('No memory');
      const threadId = 'custom-embedding-thread';
      await memory.createThread(agent.id, {}, threadId);
      const history = [
        'My locker code at the climbing gym is 4471.',
        ...Array.from(
          { length: 30 },
          (_, i) =>
            `Note ${i}: the weather was mild, the bakery on the corner reopened and traffic downtown was slow again.`
        ),
      ];
      for (const [index, content] of history.entries()) {
        const added = await memory.addEntry({
          threadId,
          message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
          tokenCount: countTokens(content),
          createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
        });
        expect(added.success).toBe(true);
      }

      const memoryErrors: Error[] = [];
      const result = await cog.run(agent, {
        input: 'What is my locker code at the climbing gym?',
        threadId,
        saveHistory: false,
        onMemoryError: (error) => memoryErrors.push(error),
      });

      expect(memoryErrors).toEqual([]);
      expect(embedding.calls).toBeGreaterThan(0);
      expect(embedding.embedded).toContain(history[0]);
      expect(result.output).toContain('4471');
    }
  );
});
