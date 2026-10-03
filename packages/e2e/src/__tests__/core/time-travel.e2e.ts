import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Agent, Cogitator, TimeTravel, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';

describeGoogle('Core: Time travel on live runs', () => {
  let cogitator: Cogitator;
  let priceCalls = 0;

  const getPrice = tool({
    name: 'get_price',
    description: 'Current price of a product in USD',
    parameters: z.object({ product: z.string() }),
    execute: async () => {
      priceCalls++;
      return { price: 120 };
    },
  });

  const agent = () =>
    new Agent({
      name: 'shopper',
      model: MODEL,
      instructions:
        'Always call get_price for the product, then answer with the exact price as a number of dollars.',
      tools: [getPrice],
      temperature: 0,
    });

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { defaultModel: MODEL, providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('forks with a mocked tool and compares the fork with the original', async () => {
    const tt = new TimeTravel(cogitator);
    const run = await cogitator.run(agent(), { input: 'How much is the headset?' });
    expect(run.toolCalls.map((call) => call.name)).toContain('get_price');
    expect(run.output).toContain('120');

    const [first] = await tt.checkpointAll(run);
    const callsBeforeFork = priceCalls;
    const fork = await tt.forkWithMockedTool(agent(), first.id, 'get_price', { price: 75 });

    expect(priceCalls).toBe(callsBeforeFork);
    expect(fork.result.output).toContain('75');

    const diff = await tt.compareWithOriginal(fork.result);
    expect(diff.trace1Id).toBe(run.trace.traceId);
    expect(diff.trace2Id).toBe(fork.result.trace.traceId);
    expect(diff.stepDiffs.length).toBeGreaterThan(0);
  }, 120_000);
});
