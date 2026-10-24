import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool, toolOutput } from '@cogitator-ai/core';
import { z } from 'zod';

const PRICES: Record<string, number> = { mug: 8.5, teapot: 24, kettle: 39 };
const started = Date.now();
const at = () => `${String(Date.now() - started).padStart(5)}ms`;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      },
      { once: true }
    );
  });

const lookupPrice = tool({
  name: 'lookup_price',
  description: 'Looks up the unit price of one product.',
  parameters: z.object({ product: z.string() }),
  isConcurrencySafe: true,
  presentation: ({ product }) => ({ label: 'Look up price', icon: 'tag', detail: product }),
  execute: async ({ product }, context) => {
    console.log(`  ${at()} start lookup_price(${product})`);
    await sleep(500, context.signal);
    console.log(`  ${at()} end   lookup_price(${product})`);
    return { product, price: PRICES[product.toLowerCase()] ?? null };
  },
});

const saveQuote = tool({
  name: 'save_quote',
  description: 'Saves a price quote for the customer, one line per product.',
  parameters: z.object({
    customer: z.string(),
    lines: z.array(z.object({ product: z.string(), units: z.number(), price: z.number() })),
  }),
  presentation: ({ customer }) => ({ label: 'Save quote', icon: 'file-plus', detail: customer }),
  execute: async ({ customer, lines }, context) => {
    console.log(`  ${at()} start save_quote (runs alone)`);
    let total = 0;
    for (const [index, line] of lines.entries()) {
      total += line.units * line.price;
      context.update?.({ content: `line ${index + 1} of ${lines.length}: ${line.product}` });
      await sleep(100, context.signal);
    }
    console.log(`  ${at()} end   save_quote`);
    return toolOutput({
      content: { saved: true, total },
      details: { quoteId: `Q-${customer.slice(0, 3).toUpperCase()}-1`, lines },
      presentation: { label: 'Save quote', icon: 'file-check', detail: `${customer}, ${total}` },
    });
  },
});

const askSupplier = tool({
  name: 'ask_supplier',
  description: 'Asks the supplier when a product is back in stock.',
  parameters: z.object({ product: z.string() }),
  execute: async ({ product }, context) => {
    await sleep(60_000, context.signal);
    return { product, backInStock: 'next week' };
  },
});

async function main() {
  header('25 - Tool execution: parallel calls, rich results, streamed input, timeouts');

  const cog = createCogitator();
  const clerk = new Agent({
    name: 'quote-clerk',
    model: DEFAULT_MODEL,
    instructions:
      'You write price quotes. Look up the price of every product first, all lookups in one turn, ' +
      'then save the quote with save_quote. Answer briefly.',
    tools: [lookupPrice, saveQuote, askSupplier],
    temperature: 0.2,
  });

  section('1. Safe lookups run together, the save runs alone');

  const quote = await cog.run(clerk, {
    input: 'Quote 4 mugs, 2 teapots and 1 kettle for Alice.',
    parallelToolCalls: true,
    onToolResult: ({ name, presentation, details }) => {
      const shown = presentation ? `${presentation.label}: ${presentation.detail ?? ''}` : name;
      console.log(`  ${at()} result ${shown}${details ? ` ${JSON.stringify(details)}` : ''}`);
    },
    onToolUpdate: ({ name, content }) => console.log(`  ${at()} update ${name}: ${content}`),
  });
  console.log(`\n  ${quote.output.trim()}`);

  section('2. Tool calls stream while the model writes them');

  const written = new Map<string, string>();
  const streamed = await cog.run(clerk, {
    input: 'Quote 3 kettles for Bob.',
    stream: true,
    onToolInputStart: ({ toolCallId, toolName }) => {
      written.set(toolCallId, '');
      console.log(`  input start ${toolName} (${toolCallId})`);
    },
    onToolInputDelta: ({ toolCallId, delta }) => {
      written.set(toolCallId, (written.get(toolCallId) ?? '') + delta);
      console.log(`  input delta ${delta}`);
    },
    onToolInputAvailable: ({ toolName, input }) =>
      console.log(`  input done  ${toolName} ${JSON.stringify(input)}`),
  });
  console.log(`\n  ${streamed.output.trim()}`);

  section('3. A tool call that takes too long fails, the run goes on');

  const late = await cog.run(clerk, {
    input: 'Ask the supplier when teapots are back in stock, then tell me what you found out.',
    timeouts: { toolMs: 2000, stepMs: 60_000 },
    onToolResult: ({ name, error, errorCode }) => {
      if (error) console.log(`  ${name} failed (${errorCode}): ${error}`);
    },
  });
  console.log(`  ${late.output.trim()}`);

  await cog.close();
  console.log('\nDone.');
}

main();
