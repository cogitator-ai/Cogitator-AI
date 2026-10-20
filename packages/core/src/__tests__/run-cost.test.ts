import { describe, it, expect, vi, afterEach } from 'vitest';
import { calculateCost } from '@cogitator-ai/models';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { CallPricer, RunCostMeter } from '../cogitator/run-cost';
import { getLogger } from '../logger';

const PRICED = 'openai/gpt-4o-mini';
const tokens = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});
const EXPENSIVE = 'openai/gpt-4o';
const priceOn = (model: string, inputTokens: number, outputTokens: number) =>
  calculateCost(model, { inputTokens, outputTokens }) ?? 0;
const registryPrice = (inputTokens: number, outputTokens: number) =>
  priceOn(PRICED, inputTokens, outputTokens);

describe('RunCostMeter', () => {
  it('uses the cost providers report', () => {
    const meter = new RunCostMeter(new CallPricer());
    meter.add({ ...tokens(1000, 100), cost: 0.0021 }, PRICED);
    meter.add({ ...tokens(500, 50), cost: 0.0004 }, PRICED);

    expect(meter.total(PRICED)).toBeCloseTo(0.0025, 10);
  });

  it('prices only the calls that report nothing from the registry', () => {
    const meter = new RunCostMeter(new CallPricer());
    meter.add({ ...tokens(1000, 100), cost: 0.01 }, PRICED);
    meter.add(tokens(2000, 300), PRICED);

    expect(registryPrice(2000, 300)).toBeGreaterThan(0);
    expect(meter.total(PRICED)).toBeCloseTo(0.01 + registryPrice(2000, 300), 10);
  });

  it('is 0 for a model the registry does not know and calls without a reported cost', () => {
    const meter = new RunCostMeter(new CallPricer());
    meter.add(tokens(1000, 100), 'local/my-finetune-that-nobody-prices');

    expect(meter.total('local/my-finetune-that-nobody-prices')).toBe(0);
  });

  it('continues from the state a paused run saved', () => {
    const before = new RunCostMeter(new CallPricer());
    before.add({ ...tokens(100, 10), cost: 0.003 }, PRICED);
    before.add(tokens(400, 40), PRICED);

    const after = new RunCostMeter(new CallPricer(), before.state());
    after.add({ ...tokens(100, 10), cost: 0.002 }, PRICED);

    expect(after.total(PRICED)).toBeCloseTo(0.005 + registryPrice(400, 40), 10);
  });

  it('prices every token of a checkpoint saved without cost state from the registry', () => {
    const meter = new RunCostMeter(new CallPricer(), undefined, {
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    meter.add({ ...tokens(10, 1), cost: 0.001 }, PRICED);

    expect(meter.total(PRICED)).toBeCloseTo(0.001 + registryPrice(1000, 100), 10);
  });

  it('prices each call on the model that answered it, whichever model the run is on', () => {
    const meter = new RunCostMeter(new CallPricer());
    meter.add(tokens(10_000, 1000), EXPENSIVE);
    meter.add(tokens(10_000, 1000), PRICED);

    const expected = priceOn(EXPENSIVE, 10_000, 1000) + registryPrice(10_000, 1000);
    expect(priceOn(EXPENSIVE, 10_000, 1000)).toBeGreaterThan(registryPrice(10_000, 1000));
    expect(meter.total(PRICED)).toBeCloseTo(expected, 10);
    expect(meter.total(EXPENSIVE)).toBeCloseTo(expected, 10);

    const resumed = new RunCostMeter(new CallPricer(), meter.state());
    expect(resumed.total(PRICED)).toBeCloseTo(expected, 10);
  });

  it('prices the tokens of a checkpoint saved before costs were kept per model on the run model', () => {
    const meter = new RunCostMeter(new CallPricer(), {
      reportedUsd: 0.001,
      unreported: {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    meter.add(tokens(1000, 100), EXPENSIVE);

    expect(meter.total(PRICED)).toBeCloseTo(
      0.001 + registryPrice(1000, 100) + priceOn(EXPENSIVE, 1000, 100),
      10
    );
  });
});

describe('1-hour cache writes', () => {
  it('prices them at their own rate', () => {
    const meter = new RunCostMeter(new CallPricer());
    meter.add(
      { ...tokens(1_000_000, 0), cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 400_000 },
      'anthropic/claude-opus-5-5'
    );

    expect(meter.total('anthropic/claude-opus-5-5')).toBeCloseTo(
      (600_000 * 5 + 400_000 * 8) / 1e6,
      10
    );
    expect(
      new RunCostMeter(new CallPricer(), meter.state()).total('anthropic/claude-opus-5-5')
    ).toBeCloseTo((600_000 * 5 + 400_000 * 8) / 1e6, 10);
  });
});

describe('a model without a price', () => {
  const unpriced = (cost?: number): LLMBackend => ({
    provider: 'local',
    chat: vi.fn(async (): Promise<ChatResponse> => ({
      id: 'r',
      content: 'done',
      finishReason: 'stop',
      usage: { ...tokens(100, 10), ...(cost !== undefined && { cost }) },
    })),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: 'done' }, finishReason: 'stop' };
    }),
  });
  const agent = new Agent({ name: 'local', model: 'local/my-finetune', instructions: 'Answer.' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once that its calls cannot be counted', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { local: unpriced() } },
      costRouting: { enabled: true, budget: { maxCostPerRun: 1 } },
    });

    await cog.run(agent, { input: 'hi' });
    await cog.run(agent, { input: 'again' });

    const warnings = warn.mock.calls.filter(([message]) => message.includes('local/my-finetune'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toContain('initializeModels');
    await cog.close();
  });

  it('stays quiet when the provider reports the cost', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { local: unpriced(0.001) } },
      costRouting: { enabled: true, budget: { maxCostPerRun: 1 } },
    });

    await cog.run(agent, { input: 'hi' });

    expect(warn.mock.calls.filter(([m]) => m.includes('local/my-finetune'))).toHaveLength(0);
    await cog.close();
  });

  it('warns without a budget too, since the run cost counts it as $0', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({ llm: { backends: { local: unpriced() } } });

    const result = await cog.run(agent, { input: 'hi' });

    const warnings = warn.mock.calls.filter(([m]) => m.includes('local/my-finetune'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toContain("llm.pricing['local/my-finetune']");
    expect(result.usage.cost).toBe(0);
    await cog.close();
  });

  it('prices it by llm.pricing and stays quiet', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: {
        backends: { local: unpriced() },
        pricing: { 'local/my-finetune': { input: 2, output: 8 } },
      },
    });

    const result = await cog.run(agent, { input: 'hi' });

    expect(result.usage.cost).toBeCloseTo((100 * 2 + 10 * 8) / 1_000_000, 12);
    expect(warn.mock.calls.filter(([m]) => m.includes('local/my-finetune'))).toHaveLength(0);
    await cog.close();
  });

  it('matches a price of llm.pricing by the tail of the model string', () => {
    const pricer = new CallPricer({ 'my-finetune': { input: 1, output: 1 } });

    expect(pricer.cost('local/my-finetune', tokens(1_000_000, 0))).toBe(1);
    expect(pricer.cost('LOCAL/My-Finetune', tokens(0, 1_000_000))).toBe(1);
    expect(pricer.cost('local/other', tokens(1_000_000, 0))).toBe(0);
  });

  it('lets llm.pricing win over the registry price', () => {
    const pricer = new CallPricer({ [PRICED]: { input: 100, output: 100 } });

    expect(pricer.cost(PRICED, tokens(1_000_000, 0))).toBe(100);
    expect(new CallPricer().cost(PRICED, tokens(1_000_000, 0))).toBe(registryPrice(1_000_000, 0));
  });

  it('keeps a self-hosted model free even when a reseller lists one of that name', () => {
    const pricer = new CallPricer({ 'vllm/qwen/qwen3-32b': { input: 1, output: 1 } });
    const model = 'vllm/meta-llama/Llama-3.3-70B-Instruct';

    expect(new CallPricer().pricing('meta-llama/Llama-3.3-70B-Instruct')).not.toBeNull();
    expect(pricer.cost(model, tokens(1_000_000, 1_000_000))).toBe(0);
    expect(pricer.cost('ollama/llama3.3', tokens(1_000_000, 1_000_000))).toBe(0);
    expect(pricer.cost('vllm/Qwen/Qwen3-32B', tokens(1_000_000, 0))).toBe(1);
  });

  it('prices a call by the provider it routes to, by the name it is registered under', () => {
    const cog = new Cogitator({
      llm: { defaultProvider: 'ollama', backends: { vllm: { ...unpriced(), provider: 'openai' } } },
    });

    expect(cog.pricedModel('llama3.3')).toBe('ollama/llama3.3');
    expect(cog.pricedModel('ollama/llama3.3')).toBe('ollama/llama3.3');
    expect(cog.pricedModel('gpt-4o', 'openai')).toBe('openai/gpt-4o');
    expect(cog.pricedModel('vllm/meta-llama/Llama-3.3-70B-Instruct')).toBe(
      'vllm/meta-llama/Llama-3.3-70B-Instruct'
    );
  });

  it('keeps a self-hosted backend of your own free whatever provider it reports', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const cog = new Cogitator({
      llm: { backends: { vllm: { ...unpriced(), provider: 'openai' } } },
    });

    const result = await cog.run(
      new Agent({
        name: 'v',
        model: 'vllm/meta-llama/Llama-3.3-70B-Instruct',
        instructions: 'Hi.',
      }),
      { input: 'hi' }
    );

    expect(result.usage.cost).toBe(0);
    expect(warn.mock.calls.filter(([m]) => m.includes('No price'))).toHaveLength(0);
    await cog.close();
  });

  it('stays quiet for a self-hosted provider', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const local = { ...unpriced(), provider: 'ollama' };
    const cog = new Cogitator({ llm: { backends: { ollama: local } } });

    await cog.run(new Agent({ name: 'o', model: 'ollama/my-local-model', instructions: 'Hi.' }), {
      input: 'hi',
    });

    expect(warn.mock.calls.filter(([m]) => m.includes('my-local-model'))).toHaveLength(0);
    await cog.close();
  });

  it('checks a budget before the run by llm.pricing', async () => {
    const backend = unpriced();
    const cog = new Cogitator({
      llm: {
        backends: { local: backend },
        pricing: { 'local/my-finetune': { input: 1_000_000, output: 0 } },
      },
      costRouting: { enabled: true, budget: { maxCostPerRun: 50 } },
    });

    await expect(cog.run(agent, { input: 'hi' })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(backend.chat).not.toHaveBeenCalled();
    await cog.close();
  });

  it('records the cost llm.pricing gives a run against the budget', async () => {
    const cog = new Cogitator({
      llm: {
        backends: { local: unpriced() },
        pricing: { 'local/my-finetune': { input: 1, output: 1 } },
      },
      costRouting: { enabled: true, budget: { maxCostPerHour: 50 } },
    });

    const result = await cog.run(agent, { input: 'hi' });

    expect(result.usage.cost).toBeCloseTo(110 / 1_000_000, 12);
    expect(cog.getCostSummary()?.totalCost).toBeCloseTo(110 / 1_000_000, 12);
    await cog.close();
  });
});

describe('the cost of a run that hands off', () => {
  const usage = { ...tokens(10_000, 1000) };
  const cheap = new Agent({ name: 'cheap', model: PRICED, instructions: 'You are cheap.' });
  const expensive = new Agent({
    name: 'expensive',
    model: EXPENSIVE,
    instructions: 'You are expensive.',
    handoffs: [cheap],
  });
  const backend = (): LLMBackend => ({
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      if (String(request.messages[0].content).startsWith('You are expensive.')) {
        return {
          id: 'e',
          content: '',
          toolCalls: [{ id: 'h', name: 'transfer_to_cheap', arguments: { reason: 'routine' } }],
          finishReason: 'tool_calls',
          usage,
        };
      }
      return { id: 'c', content: 'done', finishReason: 'stop', usage };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  });
  const expensiveCall = () => priceOn(EXPENSIVE, 10_000, 1000);

  it('counts each call at the price of the model that answered it', async () => {
    const cog = new Cogitator({ llm: { backends: { openai: backend() } } });

    const result = await cog.run(expensive, { input: 'hi' });

    expect(result.finalAgent).toBe('cheap');
    expect(result.usage.cost).toBeCloseTo(expensiveCall() + registryPrice(10_000, 1000), 10);
    await cog.close();
  });

  it('holds maxCostPerRun after handing off to a cheaper model', async () => {
    const llm = backend();
    const cog = new Cogitator({
      llm: { backends: { openai: llm } },
      costRouting: { enabled: true, budget: { maxCostPerRun: expensiveCall() * 0.9 } },
    });

    await expect(cog.run(expensive, { input: 'hi' })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    await cog.close();
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
