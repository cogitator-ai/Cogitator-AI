import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Agent,
  Cogitator,
  LLMError,
  OllamaBackend,
  createLLMBackend,
  getLogger,
} from '@cogitator-ai/core';
import { ErrorCode } from '@cogitator-ai/types';
import { getOllamaUrl, getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

const question = { role: 'user' as const, content: 'Say hello in one word.' };

describeE2E('Core: provider errors on a real Ollama', () => {
  it('reports a model that is not pulled as not found, not retryable', async () => {
    const backend = new OllamaBackend({ baseUrl: getOllamaUrl() });

    const error: unknown = await backend
      .chat({ model: 'no-such-model-cogitator-e2e:latest', messages: [question], maxTokens: 8 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({
      code: ErrorCode.LLM_UNAVAILABLE,
      kind: 'not_found',
      retryable: false,
      details: { kind: 'not_found', statusCode: 404 },
    });
  });

  it('reports a server it cannot reach as a retryable network error', async () => {
    const backend = new OllamaBackend({ baseUrl: 'http://127.0.0.1:9' });

    const error: unknown = await backend
      .chat({ model: getTestModel(), messages: [question], maxTokens: 8 })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'network', retryable: true });
  });

  it('fails a stream the caller aborts with the abort reason', async () => {
    const backend = new OllamaBackend({ baseUrl: getOllamaUrl() });
    const controller = new AbortController();
    const reason = new Error('The user closed the page');

    const started = Date.now();
    const error: unknown = await (async () => {
      for await (const chunk of backend.chatStream({
        model: getTestModel(),
        messages: [{ role: 'user', content: 'Count from 1 to 200, one number per line.' }],
        maxTokens: 400,
        signal: controller.signal,
      })) {
        if (chunk.delta.content) controller.abort(reason);
      }
    })().catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describeE2E('Core: an OpenAI-compatible server profile on a real Ollama', () => {
  it('streams text and usage from Ollama /v1 with the ollama profile', async () => {
    const backend = createLLMBackend('openai', {
      providers: {
        openai: { apiKey: 'ollama', baseUrl: `${getOllamaUrl()}/v1`, profile: 'ollama' },
      },
    });

    let content = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [question],
      maxTokens: 16,
    })) {
      content += chunk.delta.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }

    expect(content.trim().length).toBeGreaterThan(0);
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });
});

describeE2E('Core: llm.pricing on a real run', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const agent = () =>
    new Agent({
      name: 'priced',
      model: `ollama/${getTestModel()}`,
      instructions: 'Answer in one word.',
      maxIterations: 1,
    });

  it('prices a self-hosted model by llm.pricing', async () => {
    const cog = new Cogitator({
      llm: {
        providers: { ollama: { baseUrl: getOllamaUrl() } },
        pricing: { [`ollama/${getTestModel()}`]: { input: 1_000_000, output: 2_000_000 } },
      },
    });

    const result = await cog.run(agent(), { input: 'Hello' });

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.cost).toBeCloseTo(
      result.usage.inputTokens * 1 + result.usage.outputTokens * 2,
      6
    );
    await cog.close();
  });

  it('counts a self-hosted model without a price as free and does not warn', async () => {
    const warn = vi.spyOn(getLogger(), 'warn');
    const cog = new Cogitator({ llm: { providers: { ollama: { baseUrl: getOllamaUrl() } } } });

    const result = await cog.run(agent(), { input: 'Hello' });

    expect(result.usage.cost).toBe(0);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('No price'))).toEqual([]);
    await cog.close();
  });
});
