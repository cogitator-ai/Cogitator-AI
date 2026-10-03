import type { Section } from './types';

export const evals: Section = {
  id: 'evals',
  title: 'Evals',
  icon: '📏',
  description:
    'Measure agents with datasets, metrics, LLM judges, assertions and statistically tested A/B comparisons.',
  recipes: [
    {
      id: 'basic-eval',
      title: 'Basic Eval Suite',
      difficulty: 'easy',
      time: '5 min',
      problem: 'You want a test that fails CI when answer quality drops below a threshold.',
      points: [
        'Build a `Dataset`, score with `exactMatch` and `contains`',
        'Fail on `threshold` assertions',
      ],
      file: 'basic-eval.ts',
      code: `import { Dataset, EvalSuite, contains, exactMatch, threshold } from '@cogitator-ai/evals';

const capitals: Record<string, string> = {
  'What is the capital of France?': 'Paris',
  'What is the capital of Japan?': 'Tokyo',
  'What is the capital of Spain?': 'Madrid',
};

const dataset = Dataset.from(
  Object.entries(capitals).map(([input, expected]) => ({ input, expected }))
);

const suite = new EvalSuite({
  dataset,
  target: { fn: async (input: string) => capitals[input] ?? 'unknown' },
  metrics: [exactMatch(), contains()],
  assertions: [threshold('exactMatch', 0.8), threshold('contains', 0.9)],
});

const result = await suite.run();
result.report('console');

for (const caseResult of result.results) {
  console.log(caseResult.case.input, '->', caseResult.output, caseResult.scores.map((s) => \`\${s.name}=\${s.score}\`));
}

process.exitCode = result.assertions.every((assertion) => assertion.passed) ? 0 : 1;`,
      install: 'pnpm add @cogitator-ai/evals',
      env: [],
      run: 'npx tsx basic-eval.ts',
      repoRun: 'npx tsx examples/evals/01-basic-eval.ts',
      example: 'evals/01-basic-eval.ts',
      docs: [
        {
          href: '/docs/evals',
          label: 'Evals',
        },
      ],
    },
    {
      id: 'llm-judge',
      title: 'LLM as Judge',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Free-text answers cannot be matched exactly. You want a model to grade faithfulness and relevance.',
      points: [
        'Evaluate an agent with `faithfulness()` and `relevance()` and a judge model',
        'Save a baseline',
      ],
      file: 'llm-judge.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Dataset, EvalSuite, faithfulness, relevance } from '@cogitator-ai/evals';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const dataset = Dataset.from([
  {
    input: 'Explain what a closure is in JavaScript.',
    expected: 'A closure is a function that keeps access to variables from its lexical scope after the outer function returned.',
  },
  {
    input: 'What is the difference between let and var?',
    expected: 'let is block-scoped with a temporal dead zone; var is function-scoped and hoisted.',
  },
]);

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const tutor = new Agent({
  name: 'js-tutor',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a JavaScript tutor. Answer in 2-3 sentences.',
  temperature: 0.3,
  maxIterations: 1,
});

const suite = new EvalSuite({
  dataset,
  target: { agent: tutor, cogitator: cog },
  metrics: [faithfulness(), relevance()],
  judge: { model: 'google/gemini-3.5-flash-lite', temperature: 0 },
  concurrency: 1,
  onProgress: (progress) => console.log(\`\${progress.completed}/\${progress.total}\`),
});

const result = await suite.run();
result.report('console');
result.saveBaseline('evals-baseline.json');

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/evals',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx llm-judge.ts',
      repoRun: 'npx tsx examples/evals/02-llm-judge.ts',
      example: 'evals/02-llm-judge.ts',
      docs: [
        {
          href: '/docs/evals/metrics',
          label: 'Metrics',
        },
      ],
    },
    {
      id: 'ab-comparison',
      title: 'A/B Comparison',
      difficulty: 'medium',
      time: '10 min',
      problem: 'Is the new prompt actually better, or is the difference noise?',
      points: [
        'Run two agents over the same dataset with `EvalComparison`',
        'Read per-metric p-values and the winner',
      ],
      file: 'ab-comparison.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Dataset, EvalComparison, contains, exactMatch } from '@cogitator-ai/evals';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const dataset = Dataset.from([
  { input: 'What is 7 * 8?', expected: '56' },
  { input: 'What is 15% of 200?', expected: '30' },
  { input: 'What is 1000 - 373?', expected: '627' },
  { input: 'What is 3^4?', expected: '81' },
]);

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const precise = new Agent({
  name: 'precise',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a calculator. Reply with ONLY the numeric answer.',
  temperature: 0,
  maxIterations: 1,
});

const verbose = new Agent({
  name: 'verbose',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'Explain your reasoning step by step, then give the answer.',
  temperature: 0.7,
  maxIterations: 1,
});

const comparison = new EvalComparison({
  dataset,
  targets: {
    baseline: { agent: precise, cogitator: cog },
    challenger: { agent: verbose, cogitator: cog },
  },
  metrics: [exactMatch(), contains()],
  concurrency: 1,
});

const result = await comparison.run();
for (const [metric, scores] of Object.entries(result.summary.metrics)) {
  console.log(
    \`\${metric}: baseline \${scores.baseline.toFixed(2)} vs challenger \${scores.challenger.toFixed(2)} \` +
      \`(p=\${scores.pValue.toFixed(3)}, winner: \${scores.winner})\`
  );
}
console.log('Overall winner:', result.summary.winner);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/evals',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx ab-comparison.ts',
      repoRun: 'npx tsx examples/evals/03-ab-comparison.ts',
      example: 'evals/03-ab-comparison.ts',
      docs: [
        {
          href: '/docs/evals/comparison',
          label: 'Comparison',
        },
      ],
    },
  ],
};
