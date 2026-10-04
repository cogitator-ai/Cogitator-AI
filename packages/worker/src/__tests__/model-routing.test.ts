import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Cogitator,
  defineBackend,
  registerLLMBackend,
  unregisterLLMBackend,
} from '@cogitator-ai/core';
import type { ChatRequest, ChatStreamChunk, LLMBackend, LLMProvider } from '@cogitator-ai/types';
import { processAgentJob } from '../processors/agent';
import { executeSwarmAgentJob } from '../processors/swarm-agent';
import type { SerializedAgent, SwarmAgentJobPayload } from '../types';

function recordingBackend(reply: string) {
  const models: string[] = [];
  const backend: LLMBackend = {
    provider: 'openrouter',
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

const agentConfig = (overrides: Partial<SerializedAgent>): SerializedAgent => ({
  name: 'a',
  instructions: 'x',
  model: 'openrouter/deepseek/deepseek-v4-pro',
  tools: [],
  ...overrides,
});

const runAgent = (config: SerializedAgent, cogitator: Cogitator) =>
  processAgentJob(
    { type: 'agent', jobId: 'j', threadId: 't', input: 'hi', agentConfig: config },
    { cogitator }
  );

const cogitators: Cogitator[] = [];

function cogitatorWith(backends: Record<string, LLMBackend>, defaultProvider?: LLMProvider) {
  const cog = new Cogitator({
    llm: { backends, retry: false, ...(defaultProvider && { defaultProvider }) },
  });
  cogitators.push(cog);
  return cog;
}

afterEach(async () => {
  unregisterLLMBackend('acme');
  await Promise.all(cogitators.splice(0).map((cog) => cog.close()));
});

describe('serialized agent model routing', () => {
  it('keeps a model on the custom backend its prefix names, whatever the fallback provider', async () => {
    const openrouter = recordingBackend('from openrouter');
    const cog = cogitatorWith({ openrouter: openrouter.backend });

    const viaOpenAI = await runAgent(agentConfig({ provider: 'openai' }), cog);
    const viaOllama = await runAgent(agentConfig({ provider: 'ollama' }), cog);

    expect(viaOpenAI.output).toBe('from openrouter');
    expect(viaOllama.output).toBe('from openrouter');
    expect(openrouter.models).toEqual(['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro']);
  });

  it('accepts a custom backend as the provider of a bare model name', async () => {
    const openrouter = recordingBackend('ok');
    const cog = cogitatorWith({ openrouter: openrouter.backend });

    await runAgent(agentConfig({ model: 'meta-llama/llama-4-scout', provider: 'openrouter' }), cog);

    expect(openrouter.models).toEqual(['meta-llama/llama-4-scout']);
  });

  it('routes a model prefixed with a registered plugin to that plugin', async () => {
    const plugin = recordingBackend('from plugin');
    registerLLMBackend(
      defineBackend({
        provider: 'acme',
        metadata: { name: 'Acme', version: '1.0.0' },
        create: () => plugin.backend,
      })
    );
    const cog = cogitatorWith({});

    await runAgent(agentConfig({ model: 'acme/rocket-1', provider: 'openai' }), cog);

    expect(plugin.models).toEqual(['rocket-1']);
  });

  it('runs a bare model without a provider on the default provider, as in-process', async () => {
    const fallback = recordingBackend('ok');
    const cog = cogitatorWith({ groq: fallback.backend }, 'groq');

    await runAgent(agentConfig({ model: 'meta-llama/llama-4-scout', provider: undefined }), cog);

    expect(fallback.models).toEqual(['meta-llama/llama-4-scout']);
  });

  it('refuses a fallback provider the worker cannot route to', async () => {
    const cog = cogitatorWith({});

    await expect(
      runAgent(agentConfig({ model: 'tiny', provider: 'nowhere' }), cog)
    ).rejects.toThrow('"nowhere"');
  });

  it('runs a distributed swarm turn on the backend its model names', async () => {
    const openrouter = recordingBackend('turn done');
    const cog = cogitatorWith({ openrouter: openrouter.backend });
    const payload: SwarmAgentJobPayload = {
      type: 'swarm-agent',
      jobId: 'job_1',
      swarmId: 'swarm_1',
      agentName: 'writer',
      agentConfig: agentConfig({ provider: undefined }),
      input: 'draft',
      stateKeys: { blackboard: 'b', messages: 'm', results: 'r' },
    };

    const result = await executeSwarmAgentJob(payload, { cogitator: cog });

    expect(result.error).toBeUndefined();
    expect(result.output).toBe('turn done');
    expect(openrouter.models).toEqual(['deepseek/deepseek-v4-pro']);
  });
});
