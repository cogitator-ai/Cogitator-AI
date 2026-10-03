import { describe, it, expect, vi } from 'vitest';
import type { LanguageModelV2, LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { fromAISDK } from '../model-wrapper';

type V2Result = Awaited<ReturnType<LanguageModelV2['doGenerate']>>;

function scriptedModel(steps: V2Result['content'][]) {
  let step = 0;
  const doGenerate = vi.fn(async (_options: LanguageModelV2CallOptions): Promise<V2Result> => {
    const content = steps[Math.min(step, steps.length - 1)];
    step++;
    return {
      content,
      finishReason: content.some((part) => part.type === 'tool-call') ? 'tool-calls' : 'stop',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      warnings: [],
    };
  });
  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: 'mock.v2',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate,
    doStream: vi.fn(),
  };
  return { model, doGenerate };
}

const lookup = tool({
  name: 'lookup',
  description: 'Look up the capital of a country',
  parameters: z.object({ country: z.string() }),
  execute: async ({ country }) => (country === 'Japan' ? 'Tokyo' : 'unknown'),
});

describe('running agents on an AI SDK model', () => {
  it('runs an agent, its tool calls included, on a backend from llm.backends', async () => {
    const { model, doGenerate } = scriptedModel([
      [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'lookup',
          input: JSON.stringify({ country: 'Japan' }),
        },
      ],
      [{ type: 'text', text: 'The capital of Japan is Tokyo.' }],
    ]);
    const cog = new Cogitator({ llm: { backends: { aisdk: fromAISDK(model) } } });
    const agent = new Agent({
      name: 'geo',
      model: 'aisdk/mock-model',
      instructions: 'Answer with the lookup tool.',
      tools: [lookup],
    });

    const result = await cog.run(agent, { input: 'Capital of Japan?' });

    expect(result.output).toBe('The capital of Japan is Tokyo.');
    expect(result.toolCalls.map((call) => call.name)).toEqual(['lookup']);
    expect(doGenerate).toHaveBeenCalledTimes(2);
    const secondPrompt = JSON.stringify(doGenerate.mock.calls[1][0].prompt);
    expect(secondPrompt).toContain('Tokyo');
    await cog.close();
  });

  it('is reached through an explicit provider as well', async () => {
    const { model } = scriptedModel([[{ type: 'text', text: 'hi' }]]);
    const cog = new Cogitator({ llm: { backends: { mine: fromAISDK(model) } } });

    const result = await cog.run(
      new Agent({ name: 'a', provider: 'mine', model: 'whatever', instructions: 'x' }),
      { input: 'hello' }
    );

    expect(result.output).toBe('hi');
    await cog.close();
  });
});
