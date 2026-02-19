import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaBackend } from '@cogitator-ai/core';
import { createOllamaBackend, isOllamaRunning, getTestModel } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Error Handling', () => {
  let backend: OllamaBackend;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    backend = createOllamaBackend();
  });

  it('throws on invalid model name', async () => {
    await expect(
      backend.chat({
        model: 'nonexistent-model-that-does-not-exist-xyz',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      })
    ).rejects.toThrow();
  });

  it('throws on unreachable backend', async () => {
    const deadBackend = new OllamaBackend({ baseUrl: 'http://localhost:99999' });

    await expect(
      deadBackend.chat({
        model: getTestModel(),
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      })
    ).rejects.toThrow();
  });

  it('throws on unreachable backend during streaming', async () => {
    const deadBackend = new OllamaBackend({ baseUrl: 'http://localhost:99999' });

    await expect(async () => {
      for await (const _chunk of deadBackend.chatStream({
        model: getTestModel(),
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      })) {
        void _chunk;
      }
    }).rejects.toThrow();
  });
});
