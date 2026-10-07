import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { hasFeature } from '../spec.js';
import { cogitatorVersion } from '../versions.js';
import type { FeatureModule } from './types.js';

const DATASET_JSONL = [
  { input: 'What is 17 * 23?', expected: '391' },
  { input: 'What is the square root of 1764?', expected: '42' },
  { input: 'What is 2 to the power of 10?', expected: '1024' },
  { input: 'How many days does a leap year have?', expected: '366' },
]
  .map((line) => JSON.stringify(line))
  .join('\n')
  .concat('\n');

const SUITE_TS = code`
  import { fileURLToPath } from 'node:url';
  import type { Cogitator } from '@cogitator-ai/core';
  import { contains, cost, Dataset, EvalSuite, latency, threshold } from '@cogitator-ai/evals';
  import { agents, cogitator } from '../src/cogitator.js';

  const DATASET = fileURLToPath(new URL('./assistant.jsonl', import.meta.url));

  /**
   * Scores the assistant on evals/assistant.jsonl: an answer passes when it
   * contains the expected text, and the suite passes when 80% of them do.
   */
  export async function createAssistantSuite(runtime: Cogitator, options: { concurrency?: number } = {}) {
    return new EvalSuite({
      dataset: await Dataset.fromJsonl(DATASET),
      target: { agent: agents.assistant, cogitator: runtime },
      metrics: [contains()],
      statisticalMetrics: [latency(), cost()],
      assertions: [threshold('contains', 0.8)],
      concurrency: options.concurrency ?? 2,
      timeout: 60_000,
      retries: 1,
    });
  }

  export default await createAssistantSuite(cogitator);
`;

const SUITE_TEST_TS = code`
  import { describe, expect, it } from 'vitest';
  import { createAssistantSuite } from '../evals/assistant.eval.js';
  import { mockCogitator } from './helpers.js';

  describe('assistant eval suite', () => {
    it('passes when the answers contain the expected text', async () => {
      const { cogitator } = mockCogitator(
        { content: '17 * 23 = 391' },
        { content: 'It is 42.' },
        { content: '1024' },
        { content: 'A leap year has 366 days.' }
      );
      try {
        const suite = await createAssistantSuite(cogitator, { concurrency: 1 });
        const result = await suite.run();
        expect(result.aggregated.contains?.mean).toBe(1);
        expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
      } finally {
        await cogitator.close();
      }
    });

    it('fails when the answers are wrong', async () => {
      const { cogitator } = mockCogitator({ content: 'I do not know.' });
      try {
        const suite = await createAssistantSuite(cogitator, { concurrency: 1 });
        const result = await suite.run();
        expect(result.assertions.some((assertion) => !assertion.passed)).toBe(true);
      } finally {
        await cogitator.close();
      }
    });
  });
`;

/** A dataset, metrics and a threshold for the assistant, run with `cogitator eval` locally and in CI. */
export const evalsFeature: FeatureModule = {
  id: 'feature:evals',
  applies: (spec) => hasFeature(spec, 'evals'),
  apply(project) {
    project
      .dependency('@cogitator-ai/evals', cogitatorVersion('@cogitator-ai/evals'))
      .file('evals/assistant.jsonl', DATASET_JSONL)
      .file('evals/assistant.eval.ts', SUITE_TS)
      .file('tests/evals.test.ts', SUITE_TEST_TS)
      .script('eval', 'cogitator eval --skip-without-key')
      .ignore('eval-report.json');
  },
  finalize(project) {
    const pm = project.spec.packageManager;
    project.section(
      'Evals',
      code`
        \`evals/assistant.eval.ts\` scores the assistant on \`evals/assistant.jsonl\` with \`@cogitator-ai/evals\`: \`contains\` checks each answer against the expected text, \`threshold\` fails the suite below 80%, and latency and cost are measured too. \`${runScript(pm, 'eval')}\` runs every \`evals/*.eval.ts\` with the real model and exits 1 when an assertion fails, so CI can gate on it. Without an API key it skips instead. Add a case when you fix a bug, and \`tests/evals.test.ts\` checks the suite itself offline.
      `
    );
  },
};
