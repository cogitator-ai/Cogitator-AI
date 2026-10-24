import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const checkStock = tool({
  name: 'check_stock',
  description: 'Checks how many units of a product are in stock.',
  parameters: z.object({ product: z.string() }),
  execute: async ({ product }) => ({ product, units: 12 }),
});

const placeOrder = tool({
  name: 'place_order',
  description: 'Orders more units of a product from the supplier, after asking for the amount.',
  parameters: z.object({ product: z.string() }),
  execute: async ({ product }, context) => {
    const { units } = await context.interrupt!({
      reason: 'order_amount',
      message: `How many units of ${product} should I order?`,
      responseSchema: z.object({ units: z.number().int().positive() }),
    });
    return { product, ordered: units };
  },
});

async function main() {
  header('24 - Run control: steer a run, ask a person from a tool, double-texting');

  const cog = createCogitator({ memory: { adapter: 'memory' } });
  const clerk = new Agent({
    name: 'stock-clerk',
    model: DEFAULT_MODEL,
    instructions:
      'You manage a shop inventory. Check stock with check_stock, order with place_order. Answer briefly.',
    tools: [checkStock, placeOrder],
    temperature: 0.2,
  });

  section('1. Steer a run while it goes on, then follow up');

  const handle = cog.start(clerk, {
    input: 'How many coffee mugs are in stock?',
    threadId: 'shop',
  });
  handle.steer('Answer in German.');
  handle.followUp('And how many teapots?');
  const steered = await handle.result;
  console.log(`  ${steered.output.trim()}`);

  section('2. A tool asks a person halfway through');

  const paused = await cog.run(clerk, {
    input: 'Order more coffee mugs from the supplier.',
    threadId: 'shop',
  });
  if (paused.status === 'paused') {
    for (const question of paused.interrupts ?? []) {
      console.log(`  ${question.kind}: ${question.message}`);
    }
    const resumed = await cog.resume(clerk, 'shop', {
      responses: Object.fromEntries(
        (paused.interrupts ?? [])
          .filter((question) => question.kind === 'input')
          .map((question) => [question.id, { units: 40 }])
      ),
    });
    console.log(`  ${resumed.output.trim()}`);
  } else {
    console.log(`  ${paused.output.trim()}`);
  }

  section('3. A second message interrupts the first');

  const first = cog.run(clerk, { input: 'List every product we sell.', threadId: 'shop' });
  const stopped = first.then(
    () => 'finished before the second message',
    (error: Error) => `stopped: ${error.message}`
  );
  const second = await cog.run(clerk, {
    input: 'Never mind, just tell me how many mugs we have.',
    threadId: 'shop',
    multitaskStrategy: 'interrupt',
  });
  console.log(`  first run ${await stopped}`);
  console.log(`  ${second.output.trim()}`);

  await cog.close();
  console.log('\nDone.');
}

main();
