import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const orders: Record<string, { total: number; refunded: number }> = {
  'A-1001': { total: 340, refunded: 0 },
  'A-1002': { total: 25, refunded: 0 },
};

const refund = tool({
  name: 'refund_order',
  description: 'Refund part or all of an order to the customer.',
  parameters: z.object({
    order: z.string().describe('Order id, e.g. "A-1001"'),
    amount: z.number().positive().describe('Amount in dollars'),
  }),
  requiresApproval: ({ amount }) => amount > 100,
  sideEffects: ['external'],
  execute: async ({ order, amount }) => {
    const record = orders[order];
    if (!record) throw new Error(`No order ${order}`);
    record.refunded += amount;
    return { order, refunded: amount, totalRefunded: record.refunded };
  },
});

async function main() {
  header('14 — Approvals: pause before a sensitive tool, resume later');

  const cog = createCogitator({ memory: { adapter: 'memory' } });
  const support = new Agent({
    name: 'support',
    model: DEFAULT_MODEL,
    instructions:
      'You are a support agent. Refund orders with refund_order when the customer asks. Answer briefly.',
    tools: [refund],
    temperature: 0.2,
  });
  const threadId = 'ticket-7731';

  section('1. A small refund runs at once');

  const small = await cog.run(support, {
    input: 'Please refund the $25 of order A-1002.',
    threadId: 'ticket-7730',
  });
  console.log(`  status: ${small.status}`);
  console.log(`  ${small.output.trim()}`);

  section('2. A large refund pauses the run');

  const paused = await cog.run(support, {
    input: 'Order A-1001 arrived broken, please refund all $340.',
    threadId,
  });
  console.log(`  status: ${paused.status}`);
  for (const call of paused.pendingApprovals ?? []) {
    console.log(`  waiting: ${call.toolName}(${JSON.stringify(call.arguments)})`);
  }
  console.log(`  A-1001 refunded so far: $${orders['A-1001'].refunded}`);

  section('3. A manager declines, the agent explains');

  const declined = await cog.resume(support, threadId, {
    defaultDecision: { approved: false, reason: 'refunds over $100 need photos of the damage' },
  });
  console.log(`  status: ${declined.status}`);
  console.log(`  ${declined.output.trim()}`);

  section('4. The customer sends photos, a manager approves');

  const retry = await cog.run(support, {
    input: 'I sent the photos to your email. Please refund the $340 now.',
    threadId,
  });
  if (retry.status === 'paused') {
    const approved = await cog.resume(support, threadId, {
      decisions: Object.fromEntries(
        (retry.pendingApprovals ?? []).map((call) => [call.toolCallId, { approved: true as const }])
      ),
    });
    console.log(`  status: ${approved.status}`);
    console.log(`  ${approved.output.trim()}`);
  } else {
    console.log(`  ${retry.output.trim()}`);
  }
  console.log(`  A-1001 refunded: $${orders['A-1001'].refunded}`);

  await cog.close();
  console.log('\nDone.');
}

main();
