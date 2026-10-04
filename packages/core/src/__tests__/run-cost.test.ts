import { describe, it, expect, vi } from 'vitest';
import { calculateCost } from '@cogitator-ai/models';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { RunCostMeter } from '../cogitator/run-cost';

const PRICED = 'openai/gpt-4o-mini';
const tokens = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});
const registryPrice = (inputTokens: number, outputTokens: number) =>
  calculateCost(PRICED, { inputTokens, outputTokens }) ?? 0;

describe('RunCostMeter', () => {
  it('uses the cost providers report', () => {
    const meter = new RunCostMeter();
    meter.add({ ...tokens(1000, 100), cost: 0.0021 });
    meter.add({ ...tokens(500, 50), cost: 0.0004 });

    expect(meter.total(PRICED)).toBeCloseTo(0.0025, 10);
  });

  it('prices only the calls that report nothing from the registry', () => {
    const meter = new RunCostMeter();
    meter.add({ ...tokens(1000, 100), cost: 0.01 });
    meter.add(tokens(2000, 300));

    expect(registryPrice(2000, 300)).toBeGreaterThan(0);
    expect(meter.total(PRICED)).toBeCloseTo(0.01 + registryPrice(2000, 300), 10);
  });

  it('is 0 for a model the registry does not know and calls without a reported cost', () => {
    const meter = new RunCostMeter();
    meter.add(tokens(1000, 100));

    expect(meter.total('local/my-finetune-that-nobody-prices')).toBe(0);
  });

  it('continues from the state a paused run saved', () => {
    const before = new RunCostMeter();
    before.add({ ...tokens(100, 10), cost: 0.003 });
    before.add(tokens(400, 40));

    const after = new RunCostMeter(before.state());
    after.add({ ...tokens(100, 10), cost: 0.002 });

    expect(after.total(PRICED)).toBeCloseTo(0.005 + registryPrice(400, 40), 10);
  });

  it('prices every token of a checkpoint saved without cost state from the registry', () => {
    const meter = new RunCostMeter(undefined, {
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    meter.add({ ...tokens(10, 1), cost: 0.001 });

    expect(meter.total(PRICED)).toBeCloseTo(0.001 + registryPrice(1000, 100), 10);
  });
});

describe('run cost', () => {
  function reportingBackend(costs: number[]): LLMBackend {
    let call = 0;
    const answer = (): ChatResponse => {
      const cost = costs[Math.min(call, costs.length - 1)];
      call++;
      return {
        id: `r${call}`,
        content: 'done',
        finishReason: 'stop',
        usage: { ...tokens(100, 10), cost },
      };
    };
    return {
      provider: 'openrouter',
      chat: vi.fn(async (_request: ChatRequest) => answer()),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        const response = answer();
        yield { id: 's', delta: { content: response.content } };
        yield { id: 's', delta: {}, finishReason: 'stop', usage: response.usage };
      }),
    };
  }

  const agent = new Agent({
    name: 'priced',
    model: 'openrouter/vendor/unlisted-model',
    instructions: 'Answer.',
  });

  it('reports the provider cost of a run on a model the registry does not know', async () => {
    const cog = new Cogitator({ llm: { backends: { openrouter: reportingBackend([0.0123]) } } });

    const result = await cog.run(agent, { input: 'hi' });

    expect(result.usage.cost).toBeCloseTo(0.0123, 10);
    await cog.close();
  });

  it('reports the provider cost of a streamed run', async () => {
    const cog = new Cogitator({ llm: { backends: { openrouter: reportingBackend([0.0042]) } } });

    const result = await cog.run(agent, { input: 'hi', stream: true, onToken: () => {} });

    expect(result.usage.cost).toBeCloseTo(0.0042, 10);
    await cog.close();
  });
});
