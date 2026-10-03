import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatRequest, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { defineBackend, registerLLMBackend, unregisterLLMBackend } from '../llm/plugin';

vi.mock('../llm/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('../llm/index')>();
  return { ...original, createLLMBackend: vi.fn() };
});

function recordingBackend(reply: string) {
  const models: string[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      models.push(request.model);
      return {
        id: 'r',
        content: reply,
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, models };
}

const agent = (model: string, provider?: string) =>
  new Agent({ name: 'a', model, instructions: 'x', ...(provider && { provider }) });

afterEach(() => {
  vi.clearAllMocks();
  unregisterLLMBackend('acme');
});

describe('backend routing', () => {
  it('runs `name/model` on the backend registered under that name', async () => {
    const custom = recordingBackend('from custom');
    const cog = new Cogitator({ llm: { backends: { local: custom.backend } } });

    const result = await cog.run(agent('local/tiny-model'), { input: 'hi' });

    expect(result.output).toBe('from custom');
    expect(custom.models).toEqual(['tiny-model']);
    await cog.close();
  });

  it('lets a custom backend replace a built-in provider', async () => {
    const wrapped = recordingBackend('wrapped openai');
    const cog = new Cogitator({ llm: { backends: { openai: wrapped.backend } } });

    await cog.run(agent('openai/gpt-6-luna'), { input: 'hi' });

    expect(wrapped.models).toEqual(['gpt-6-luna']);
    const { createLLMBackend } = await import('../llm/index');
    expect(createLLMBackend).not.toHaveBeenCalled();
    await cog.close();
  });

  it('creates registered plugins with their config from llm.plugins', async () => {
    const plugin = recordingBackend('from plugin');
    const create = vi.fn((_config: { apiKey: string }) => plugin.backend);
    registerLLMBackend(
      defineBackend({ provider: 'acme', metadata: { name: 'Acme', version: '1.0.0' }, create })
    );
    const cog = new Cogitator({ llm: { plugins: { acme: { apiKey: 'k' } } } });

    await cog.run(agent('acme/rocket-1'), { input: 'hi' });
    await cog.run(agent('acme/rocket-2'), { input: 'hi' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ apiKey: 'k' });
    expect(plugin.models).toEqual(['rocket-1', 'rocket-2']);
    await cog.close();
  });

  it('keeps unknown prefixes in the model name on the default provider', async () => {
    const fallback = recordingBackend('ok');
    const { createLLMBackend } = await import('../llm/index');
    vi.mocked(createLLMBackend).mockReturnValue(fallback.backend);
    const cog = new Cogitator({ llm: { defaultProvider: 'openai' } });

    await cog.run(agent('meta-llama/llama-4-scout'), { input: 'hi' });

    expect(vi.mocked(createLLMBackend).mock.calls[0][0]).toBe('openai');
    expect(fallback.models).toEqual(['meta-llama/llama-4-scout']);
    await cog.close();
  });

  it('refuses an explicit provider nobody provides', async () => {
    const cog = new Cogitator();

    const error = await cog.run(agent('m', 'nowhere'), { input: 'hi' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CogitatorError);
    expect((error as CogitatorError).code).toBe(ErrorCode.CONFIGURATION_ERROR);
    expect((error as Error).message).toContain('"nowhere"');
    await cog.close();
  });

  it('exposes the route of a model string', () => {
    const custom = recordingBackend('x');
    const cog = new Cogitator({ llm: { backends: { local: custom.backend } } });

    expect(cog.route('local/a/b')).toEqual({ backend: custom.backend, model: 'a/b' });
  });
});
