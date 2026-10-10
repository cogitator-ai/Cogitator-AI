import { createCogitator, DEFAULT_MODEL, header, requireEnv, section } from '../_shared/setup.js';
import { Agent, decisionTool } from '@cogitator-ai/core';

const JEV = 'openrouter/typesafe/jev-1.13';

const questions = {
  team: {
    type: 'choice',
    instructions: 'Which support team should answer this message?',
    criteria: {
      billing: 'Payments, invoices, charges and refunds',
      technical: 'Bugs, crashes, errors and how the product works',
      sales: 'Plans, pricing and buying more seats',
    },
  },
  spam: {
    type: 'noul',
    instructions: 'Is this message spam rather than a customer writing in?',
    criteria: {
      true: 'Advertising, scams or nonsense',
      false: 'A real customer with a real question',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently should the team answer it?',
    criteria: ['can wait', 'this week', 'today'],
  },
} as const;

async function main() {
  header('16 - Decision models: typed answers with probabilities');
  requireEnv('OPENROUTER_API_KEY');

  const cog = createCogitator();

  section('cog.decide: three kinds of question about one message');
  const message = 'Hi! I was charged twice for my subscription this month, can you refund one?';
  const result = await cog.decide({ model: JEV, state: message, questions });
  console.log(`Message: ${message}`);
  console.log(
    `Team: ${result.answers.team.choice} (${result.answers.team.probabilities?.[result.answers.team.choice] ?? '?'})`
  );
  console.log(
    `Spam: ${result.answers.spam.value} (p = ${result.answers.spam.probability.toFixed(2)})`
  );
  console.log(
    `Urgency: ${result.answers.urgency.score}`,
    result.answers.urgency.probabilities ?? {}
  );
  console.log(
    `Cost: $${result.usage.cost.toFixed(6)} for ${result.usage.inputTokens} input tokens`
  );

  section('Spam is set aside before an agent ever sees it');
  const spam = await cog.decide({
    model: JEV,
    state: 'BUY CHEAP WATCHES NOW!!! http://cheap-watches.example',
    questions: { spam: questions.spam },
  });
  console.log(`Spam: ${spam.answers.spam.value} (p = ${spam.answers.spam.probability.toFixed(2)})`);

  section('decisionTool: a support agent routes messages with the decision model');
  const routeTicket = decisionTool(cog, {
    name: 'route_ticket',
    description: 'Decide which team answers a support message',
    model: JEV,
    questions: { team: questions.team },
  });
  const support = new Agent({
    name: 'support-lead',
    model: `openrouter/${DEFAULT_MODEL}`,
    instructions:
      'You lead a support team. Route each message with route_ticket, then say in one sentence which team takes it and why.',
    tools: [routeTicket],
    temperature: 0.2,
  });
  const run = await cog.run(support, {
    input: 'A customer writes: the app crashes every time I open the settings page.',
  });
  console.log(run.output);

  await cog.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
