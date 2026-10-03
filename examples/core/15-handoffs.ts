import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const invoices: Record<string, { amount: number; status: 'paid' | 'due' }> = {
  'INV-204': { amount: 129, status: 'due' },
};

const lookupInvoice = tool({
  name: 'lookup_invoice',
  description: 'Look up an invoice by its number.',
  parameters: z.object({ invoice: z.string().describe('Invoice number, e.g. "INV-204"') }),
  execute: async ({ invoice }) => invoices[invoice] ?? { error: `No invoice ${invoice}` },
});

const checkStatus = tool({
  name: 'service_status',
  description: 'Current status of the service and known incidents.',
  parameters: z.object({}),
  execute: async () => ({
    status: 'degraded',
    incident: 'Login emails are delayed by ~10 minutes',
  }),
});

async function main() {
  header('15 — Handoffs: a triage agent passes the conversation on');

  const cog = createCogitator({ memory: { adapter: 'memory' } });

  const billing = new Agent({
    name: 'billing',
    description: 'Invoices, payments and refunds',
    model: DEFAULT_MODEL,
    instructions:
      'You are the billing specialist. Use lookup_invoice for invoice questions. Answer in two sentences at most.',
    tools: [lookupInvoice],
    temperature: 0.2,
  });

  const support = new Agent({
    name: 'tech_support',
    description: 'Login problems, outages and bugs',
    model: DEFAULT_MODEL,
    instructions:
      'You are technical support. Check service_status first. Answer in two sentences at most.',
    tools: [checkStatus],
    temperature: 0.2,
  });

  const triage = new Agent({
    name: 'triage',
    model: DEFAULT_MODEL,
    instructions:
      'You greet customers and hand the conversation over to the right specialist. Never answer billing or technical questions yourself.',
    handoffs: [billing, support],
    temperature: 0,
  });

  for (const [title, input] of [
    ['1. A billing question', 'How much do I owe on invoice INV-204?'],
    ['2. A technical question', "I can't log in, the email with the code never arrives."],
  ] as const) {
    section(title);
    const result = await cog.run(triage, {
      input,
      onHandoff: ({ from, to, reason }) =>
        console.log(`  ${from} → ${to}${reason ? ` (${reason})` : ''}`),
    });
    console.log(`  ${result.finalAgent ?? 'triage'}: ${result.output.trim()}`);
  }

  await cog.close();
  console.log('\nDone.');
}

main();
