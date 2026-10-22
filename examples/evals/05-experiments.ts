import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { header, section } from '../_shared/setup.js';
import {
  Dataset,
  EvalSuite,
  RunStore,
  compareRuns,
  contains,
  exactMatch,
  reportComparison,
  threshold,
} from '@cogitator-ai/evals';

const DATASET = Dataset.from([
  { input: 'What is the capital of France?', expected: 'Paris' },
  { input: 'What is the capital of Germany?', expected: 'Berlin' },
  { input: 'What is the capital of Japan?', expected: 'Tokyo' },
  { input: 'What is the capital of Italy?', expected: 'Rome' },
  { input: 'What is the capital of Spain?', expected: 'Madrid' },
  { input: 'What is the capital of Canada?', expected: 'Ottawa' },
  { input: 'What is the capital of Australia?', expected: 'Canberra' },
  { input: 'What is the capital of Brazil?', expected: 'Brasilia' },
]);

const KNOWN: Record<string, string> = {
  France: 'Paris',
  Germany: 'Berlin',
  Japan: 'Tokyo',
  Italy: 'Rome',
  Spain: 'Madrid',
  Canada: 'Ottawa',
  Australia: 'Canberra',
  Brazil: 'Brasilia',
};

const country = (input: string) => input.replace('What is the capital of ', '').replace('?', '');

/** The first version answers with the largest city where it is not the capital */
const LARGEST_CITY: Record<string, string> = {
  Canada: 'Toronto',
  Australia: 'Sydney',
  Brazil: 'Sao Paulo',
};

function suiteFor(version: 'v1' | 'v2', answer: (input: string) => string) {
  return new EvalSuite({
    dataset: DATASET,
    target: { fn: async (input) => answer(input) },
    metrics: [exactMatch(), contains()],
    assertions: [threshold('exactMatch', 0.75)],
    name: 'capitals',
    metadata: { version, branch: version === 'v1' ? 'main' : 'feature/capitals' },
  });
}

async function main() {
  header('05 - Experiment Tracking');
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-experiments-'));
  const store = new RunStore(join(dir, 'runs'));

  try {
    section('1. Run and save the first version');
    const v1 = await suiteFor('v1', (input) => {
      const c = country(input);
      return LARGEST_CITY[c] ?? KNOWN[c];
    }).run();
    console.log(`Run ${v1.runId}: exactMatch ${v1.aggregated.exactMatch.mean.toFixed(3)}`);
    console.log(`Saved to ${store.save(v1)}`);

    section('2. Run and save the second version');
    const v2 = await suiteFor('v2', (input) => {
      const c = country(input);
      return c === 'Spain' ? 'Barcelona' : `The capital is ${KNOWN[c]}.`;
    }).run();
    console.log(`Run ${v2.runId}: exactMatch ${v2.aggregated.exactMatch.mean.toFixed(3)}`);
    console.log(`Saved to ${store.save(v2)}`);

    section('3. Runs in the store, newest first');
    for (const run of store.list({ name: 'capitals' })) {
      const metrics = Object.entries(run.metrics)
        .map(([name, mean]) => `${name}=${mean.toFixed(3)}`)
        .join(', ');
      console.log(`${run.id}  ${run.startedAt}  ${String(run.metadata?.version)}  ${metrics}`);
    }

    section('4. Compare the two runs');
    const base = store.load(v1.runId);
    const head = store.latest({ name: 'capitals' })!;
    const comparison = compareRuns(base, head, { seed: 42 });
    reportComparison(comparison, 'console');

    section('5. Markdown for a pull request comment');
    reportComparison(comparison, 'markdown', { path: join(dir, 'comparison') });
    console.log(readFileSync(join(dir, 'comparison.md'), 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('Done.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
