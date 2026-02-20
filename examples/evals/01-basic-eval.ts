import { header, section } from '../_shared/setup.js';
import { Dataset, EvalSuite, exactMatch, contains, threshold } from '@cogitator-ai/evals';

const QA_PAIRS = [
  { input: 'What is the capital of France?', expected: 'Paris' },
  { input: 'What is the capital of Germany?', expected: 'Berlin' },
  { input: 'What is the capital of Japan?', expected: 'Tokyo' },
  { input: 'What is the capital of Italy?', expected: 'Rome' },
  { input: 'What is the capital of Spain?', expected: 'Madrid' },
];

const ANSWERS: Record<string, string> = {
  'What is the capital of France?': 'Paris',
  'What is the capital of Germany?': 'Berlin',
  'What is the capital of Japan?': 'Tokyo',
  'What is the capital of Italy?': 'Rome',
  'What is the capital of Spain?': 'Madrid',
};

async function main() {
  header('01 — Basic Evaluation');

  section('1. Create dataset');
  const dataset = Dataset.from(QA_PAIRS);
  console.log(`Dataset: ${dataset.length} cases`);

  section('2. Define target function');
  const target = {
    fn: async (input: string) => ANSWERS[input] ?? 'unknown',
  };
  console.log('Target: mock function that returns expected answers');

  section('3. Run evaluation');
  const suite = new EvalSuite({
    dataset,
    target,
    metrics: [exactMatch(), contains()],
    assertions: [threshold('exactMatch', 0.8), threshold('contains', 0.9)],
  });

  const result = await suite.run();

  section('4. Results');
  result.report('console');

  section('5. Per-case details');
  for (const r of result.results) {
    const scores = r.scores.map((s) => `${s.name}=${s.score}`).join(', ');
    console.log(`  "${r.case.input}" → "${r.output}" [${scores}]`);
  }

  section('6. Assertion check');
  const allPassed = result.assertions.every((a) => a.passed);
  console.log(allPassed ? 'All assertions passed.' : 'Some assertions failed!');
  process.exit(allPassed ? 0 : 1);
}

main();
