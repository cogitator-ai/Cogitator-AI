import { createCogitator, DEFAULT_MODEL, header, requireEnv, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import {
  Dataset,
  EvalSuite,
  contains,
  passAtK,
  retrievalRecall,
  threshold,
  toolCalls,
  trajectory,
} from '@cogitator-ai/evals';
import { z } from 'zod';

const HANDBOOK = [
  { id: 'refunds', content: 'A refund is issued within 5 days after the invoice is cancelled.' },
  { id: 'vacation', content: 'Every employee gets 25 vacation days a year.' },
  { id: 'password', content: 'Reset your password from the login page.' },
];

const searchHandbook = tool({
  name: 'search_handbook',
  description: 'Search the company handbook',
  parameters: z.object({ query: z.string().describe('A few keywords') }),
  execute: async ({ query }) => {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    const results = HANDBOOK.filter((entry) =>
      words.some((word) => entry.content.toLowerCase().includes(word))
    );
    return { results };
  },
});

const fileTicket = tool({
  name: 'file_ticket',
  description: 'File a support ticket for the user',
  parameters: z.object({ topic: z.string().describe('One word topic, such as "refund"') }),
  execute: async ({ topic }) => ({ ticket: `T-${topic.length}42`, topic }),
});

async function main() {
  header('04 - Agent Evaluation');
  requireEnv('GOOGLE_API_KEY');

  section('1. Agent cases: expected tool calls, passages and a follow-up turn');
  const dataset = Dataset.from([
    {
      input: 'How long does a refund take?',
      expected: '5 days',
      expectedToolCalls: [{ name: 'search_handbook' }],
      expectedPassages: ['refunds'],
    },
    {
      input: 'My refund has not arrived. Please file a ticket about it.',
      turns: ['What topic did you file the ticket under? Answer with one word.'],
      expected: 'refund',
      expectedToolCalls: [{ name: 'file_ticket', arguments: { topic: 'refund' } }],
      expectedPassages: [],
    },
  ]);
  console.log(`Dataset: ${dataset.length} cases, one of them two turns long`);

  section('2. Agent with tools, Cogitator with memory for the follow-up turn');
  const cog = createCogitator({ memory: { adapter: 'memory' } });
  const agent = new Agent({
    name: 'support',
    model: DEFAULT_MODEL,
    instructions:
      'You are a support agent. Answer handbook questions by calling search_handbook first. File tickets with file_ticket when asked. Keep answers short.',
    tools: [searchHandbook, fileTicket],
    temperature: 0,
  });

  section('3. Run three trials of each case');
  const suite = new EvalSuite({
    dataset,
    target: { agent, cogitator: cog },
    metrics: [contains(), toolCalls(), trajectory(), retrievalRecall()],
    statisticalMetrics: [passAtK('toolCalls', { k: 1 }), passAtK('toolCalls', { k: 3 })],
    assertions: [threshold('passAtK(toolCalls,3)', 0.5)],
    trials: 3,
    concurrency: 2,
    timeout: 60_000,
  });
  const result = await suite.run();

  section('4. Results');
  result.report('console');

  section('5. What the agent did');
  for (const r of result.results) {
    console.log(`  "${r.case.input}"`);
    for (const turn of r.turns ?? [{ input: r.case.input, output: r.output }]) {
      console.log(`    > ${turn.input}\n    < ${turn.output.trim()}`);
    }
    console.log(`    tools: ${(r.toolCalls ?? []).map((c) => c.name).join(', ') || 'none'}`);
    console.log(`    retrieved: ${(r.retrieved ?? []).map((p) => p.id).join(', ') || 'nothing'}`);
    const perTrial = (r.trials ?? [r]).map(
      (t) => t.scores.find((s) => s.name === 'toolCalls')?.score ?? 'error'
    );
    console.log(`    toolCalls per trial: ${perTrial.join(', ')}`);
  }

  await cog.close();
  console.log('\nDone.');
}

void main();
