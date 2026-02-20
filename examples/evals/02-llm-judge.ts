import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { Dataset, EvalSuite, faithfulness, relevance } from '@cogitator-ai/evals';

const QUESTIONS = [
  {
    input: 'Explain what a closure is in JavaScript.',
    expected:
      'A closure is a function that captures variables from its surrounding lexical scope, retaining access to them even after the outer function has returned.',
  },
  {
    input: 'What is the difference between let and var in JavaScript?',
    expected:
      'let is block-scoped and not hoisted to the top of the function, while var is function-scoped and hoisted. let also has a temporal dead zone.',
  },
  {
    input: 'How does the event loop work in Node.js?',
    expected:
      'The event loop processes callbacks from a queue after the call stack is empty. It has multiple phases: timers, I/O callbacks, idle/prepare, poll, check, and close callbacks.',
  },
];

async function main() {
  header('02 — LLM-as-Judge Evaluation');

  section('1. Create dataset');
  const dataset = Dataset.from(QUESTIONS);
  console.log(`Dataset: ${dataset.length} cases`);

  section('2. Set up agent');
  const cog = createCogitator();

  const agent = new Agent({
    name: 'js-tutor',
    model: DEFAULT_MODEL,
    instructions: 'You are a JavaScript tutor. Answer questions concisely in 2-3 sentences.',
    temperature: 0.3,
    maxIterations: 1,
  });

  section('3. Run evaluation with LLM judge');
  const suite = new EvalSuite({
    dataset,
    target: { agent, cogitator: cog },
    metrics: [faithfulness(), relevance()],
    judge: { model: DEFAULT_MODEL, temperature: 0 },
    concurrency: 1,
    onProgress: (p) => {
      console.log(`  [${p.completed}/${p.total}] ${p.currentCase?.input.slice(0, 50)}...`);
    },
  });

  const result = await suite.run();

  section('4. Results');
  result.report('console');

  section('5. Save baseline');
  const baselinePath = 'evals-baseline.json';
  result.saveBaseline(baselinePath);
  console.log(`Baseline saved to ${baselinePath}`);

  await cog.close();
  console.log('\nDone.');
}

main();
