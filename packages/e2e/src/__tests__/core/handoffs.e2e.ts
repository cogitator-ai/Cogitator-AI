import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';

describeGoogle('Core: handoffs', () => {
  let cogitator: Cogitator;
  const lookups: string[] = [];

  const lookupInvoice = tool({
    name: 'lookup_invoice',
    description: 'Look up an invoice by its number',
    parameters: z.object({ invoice: z.string() }),
    execute: async ({ invoice }) => {
      lookups.push(invoice);
      return { invoice, amount: 129, status: 'due' };
    },
  });

  const billing = new Agent({
    name: 'billing',
    description: 'Invoices, payments and refunds',
    model: MODEL,
    instructions:
      'You are billing. Use lookup_invoice, then state the amount owed in one sentence.',
    tools: [lookupInvoice],
    temperature: 0,
  });
  const triage = new Agent({
    name: 'triage',
    model: MODEL,
    instructions:
      'Hand every billing or invoice question over to billing. Never answer it yourself.',
    handoffs: [billing],
    temperature: 0,
  });

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it(
    'hands a billing question to billing, which answers with its own tool',
    { timeout: 120_000 },
    async () => {
      const result = await cogitator.run(triage, {
        input: 'How much do I owe on invoice INV-204?',
      });

      expect(result.handoffs?.[0]).toMatchObject({ from: 'triage', to: 'billing' });
      expect(result.finalAgent).toBe('billing');
      expect(lookups).toContain('INV-204');
      expect(result.output).toContain('129');
    }
  );
});
