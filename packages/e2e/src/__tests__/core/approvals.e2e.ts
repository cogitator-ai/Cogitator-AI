import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

describeGoogle('Core: approvals', () => {
  let cogitator: Cogitator;
  const refunded: Array<{ order: string; amount: number }> = [];

  const refund = tool({
    name: 'refund_order',
    description: 'Refund an order to the customer',
    parameters: z.object({ order: z.string(), amount: z.number() }),
    requiresApproval: ({ amount }) => amount > 100,
    execute: async (args) => {
      refunded.push(args);
      return { refunded: args.amount };
    },
  });

  const agent = new Agent({
    name: 'support',
    model: 'google/gemini-3.5-flash-lite',
    instructions: 'Refund orders with refund_order when asked. Answer in one short sentence.',
    tools: [refund],
    temperature: 0,
  });

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
      memory: { adapter: 'memory' },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it(
    'pauses on a call that needs approval and runs it once approved',
    { timeout: 120_000 },
    async () => {
      refunded.length = 0;
      const paused = await cogitator.run(agent, {
        input: 'Refund $340 for order A-1.',
        threadId: 'approve-thread',
        userId: 'ann',
      });

      expect(paused.status).toBe('paused');
      expect(paused.pendingApprovals?.[0]).toMatchObject({
        toolName: 'refund_order',
        arguments: { order: 'A-1', amount: 340 },
      });
      expect(refunded).toEqual([]);

      const done = await cogitator.resume(agent, 'approve-thread', {
        userId: 'ann',
        defaultDecision: { approved: true },
      });

      expect(done.status).toBe('completed');
      expect(refunded).toEqual([{ order: 'A-1', amount: 340 }]);
      expect(done.output).toMatch(/340|refund/i);
    }
  );

  it('lets the model explain a declined call', { timeout: 120_000 }, async () => {
    refunded.length = 0;
    await cogitator.run(agent, {
      input: 'Refund $500 for order B-2.',
      threadId: 'deny-thread',
      userId: 'ann',
    });

    const done = await cogitator.resume(agent, 'deny-thread', {
      userId: 'ann',
      defaultDecision: { approved: false, reason: 'a manager must sign off refunds over $100' },
    });

    expect(refunded).toEqual([]);
    expect(done.status).toBe('completed');
    expect(done.output).toMatch(/manager|approv|sign/i);
  });

  it('runs small refunds without asking', { timeout: 120_000 }, async () => {
    refunded.length = 0;
    const result = await cogitator.run(agent, { input: 'Refund $20 for order C-3.' });

    expect(result.status).toBe('completed');
    expect(refunded).toEqual([{ order: 'C-3', amount: 20 }]);
  });
});
