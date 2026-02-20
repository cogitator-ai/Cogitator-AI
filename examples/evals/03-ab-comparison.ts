import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { Dataset, EvalComparison, exactMatch, contains } from '@cogitator-ai/evals';

const DATASET = Dataset.from([
  { input: 'What is 2 + 2?', expected: '4' },
  { input: 'What is the square root of 144?', expected: '12' },
  { input: 'What is 15% of 200?', expected: '30' },
  { input: 'What is 7 * 8?', expected: '56' },
  { input: 'What is 100 / 4?', expected: '25' },
  { input: 'What is 3^4?', expected: '81' },
  { input: 'What is 1000 - 373?', expected: '627' },
  { input: 'What is 17 + 28?', expected: '45' },
]);

async function main() {
  header('03 — A/B Comparison');

  section('1. Dataset');
  console.log(`${DATASET.length} math questions`);

  section('2. Create two agents');
  const cog = createCogitator();

  const preciseAgent = new Agent({
    name: 'precise',
    model: DEFAULT_MODEL,
    instructions: 'You are a calculator. Reply with ONLY the numeric answer, nothing else.',
    temperature: 0,
    maxIterations: 1,
  });

  const creativeAgent = new Agent({
    name: 'creative',
    model: DEFAULT_MODEL,
    instructions:
      'You are a math helper. Explain your reasoning step by step, then give the answer.',
    temperature: 0.7,
    maxIterations: 1,
  });

  console.log(`Baseline:   "${preciseAgent.name}" (temp=0, concise)`);
  console.log(`Challenger: "${creativeAgent.name}" (temp=0.7, verbose)`);

  section('3. Run comparison');
  const comparison = new EvalComparison({
    dataset: DATASET,
    targets: {
      baseline: { agent: preciseAgent, cogitator: cog },
      challenger: { agent: creativeAgent, cogitator: cog },
    },
    metrics: [exactMatch(), contains()],
    concurrency: 1,
    onProgress: (p) => {
      console.log(`  [${p.target}] ${p.completed}/${p.total}`);
    },
  });

  const result = await comparison.run();

  section('4. Metric comparisons');
  for (const [name, mc] of Object.entries(result.summary.metrics)) {
    console.log(`${name}:`);
    console.log(`  Baseline:   ${mc.baseline.toFixed(3)}`);
    console.log(`  Challenger: ${mc.challenger.toFixed(3)}`);
    console.log(`  p-value:    ${mc.pValue.toFixed(4)}`);
    console.log(`  Significant: ${mc.significant}`);
    console.log(`  Winner:     ${mc.winner}`);
    console.log();
  }

  section('5. Overall winner');
  console.log(`Winner: ${result.summary.winner}`);

  section('6. Individual results');
  console.log('Baseline:');
  result.baseline.report('console');
  console.log('\nChallenger:');
  result.challenger.report('console');

  await cog.close();
  console.log('\nDone.');
}

main();
