import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, tool } from '@cogitator-ai/core';
import {
  Dataset,
  EvalComparison,
  EvalSuite,
  assertion,
  contains,
  cost,
  latency,
  llmMetric,
  metric,
  noRegression,
  regex,
  relevance,
  threshold,
  tokenUsage,
} from '@cogitator-ai/evals';
import { z } from 'zod';
import type { StageDefinition } from '../../runner/types.js';
import { excerpt } from './shared.js';

const EVALS = '@cogitator-ai/evals';
const CORE = '@cogitator-ai/core';

/** Stock levels nobody can guess, below 1000 so no thousands separator gets in the way of `contains`. */
const STOCK: Record<string, number> = {
  'brass gears': 417,
  'copper rivets': 529,
  'tin springs': 58,
  'iron hinges': 733,
  'zinc washers': 246,
  'steel pins': 389,
  'nickel bolts': 151,
  'lead weights': 97,
  'bronze cogs': 864,
};

function stockCase(item: string) {
  return { input: `How many ${item} are in stock?`, expected: String(STOCK[item]) };
}

const stockLevel = tool({
  name: 'stock_level',
  description: 'Units of an item currently in the warehouse.',
  parameters: z.object({ item: z.string().describe('Item name, e.g. "brass gears"') }),
  execute: async ({ item }) => ({ item, units: STOCK[item.toLowerCase().trim()] ?? 0 }),
});

function clerk(model: string, withTool: boolean): Agent {
  return new Agent({
    name: withTool ? 'stock-clerk' : 'guessing-clerk',
    model,
    instructions: withTool
      ? 'You answer stock questions. Always look the item up with stock_level, then answer in one sentence with the number.'
      : 'You answer stock questions in one sentence with your best estimate as a number.',
    ...(withTool ? { tools: [stockLevel] } : {}),
    maxIterations: 3,
    temperature: 0,
  });
}

const concise = metric({
  name: 'concise',
  evaluate: ({ output }) => {
    const words = output.split(/\s+/).filter(Boolean).length;
    return { score: words <= 40 ? 1 : 0, details: `${words} words` };
  },
});

/** Proves an eval suite scores real agent answers with deterministic, judged and statistical metrics. */
const evalsStage: StageDefinition = {
  id: 'evals',
  title: 'Evals',
  description:
    'An eval suite runs a tool-using agent over a dataset, scores it with deterministic, custom, LLM-judge and statistical metrics, enforces assertions and baselines, catches an off-topic target, and an A/B comparison finds the agent with the tool better.',
  packages: [EVALS, CORE],
  needs: ['handshake'],
  timeoutMs: 240_000,
  async run(ctx) {
    const judge = { model: ctx.models[1] ?? ctx.model, temperature: 0, cogitator: ctx.cogitator };
    const baselinePath = join(ctx.tmpDir, 'baseline-in.json');
    await writeFile(baselinePath, JSON.stringify({ contains: 0.5, concise: 0.5 }));
    const dataset = Dataset.from(['brass gears', 'copper rivets', 'tin springs'].map(stockCase));

    const result = await ctx.check('the suite scores a tool-using agent', async (evidence) => {
      const suite = new EvalSuite({
        dataset,
        target: { agent: clerk(ctx.model, true), cogitator: ctx.cogitator },
        metrics: [
          contains(),
          regex(/\d+/),
          concise,
          relevance(),
          llmMetric({
            name: 'statesCount',
            prompt:
              'Rate whether the response states exactly the expected stock count as the answer.',
          }),
        ],
        statisticalMetrics: [latency(), tokenUsage(), cost()],
        judge,
        assertions: [
          threshold('contains', 0.66),
          threshold('latency', 90_000),
          noRegression(baselinePath, { tolerance: 0 }),
          assertion({
            name: 'everyCaseAnswered',
            check: (_aggregated, stats) => stats.total === 3,
            message: 'Not every case produced a result',
          }),
        ],
        concurrency: 3,
        timeout: 90_000,
      });
      const outcome = await suite.run();
      const mean = (name: string) => outcome.aggregated[name]?.mean;
      evidence(
        'answers',
        outcome.results.map((entry) => excerpt(entry.output, 60))
      );
      evidence(
        'errors',
        outcome.results.flatMap((entry) => (entry.error ? [entry.error] : []))
      );
      evidence(
        'toolCalls',
        outcome.results.map((entry) => entry.toolCalls?.map((call) => call.name) ?? [])
      );
      evidence('means', {
        contains: mean('contains'),
        concise: mean('concise'),
        relevance: mean('relevance'),
        statesCount: mean('statesCount'),
        tokenUsage: mean('tokenUsage'),
      });
      evidence(
        'assertions',
        outcome.assertions.map((entry) => `${entry.passed ? 'pass' : 'FAIL'} ${entry.name}`)
      );
      evidence(
        'judgeDetails',
        outcome.results.map((entry) =>
          excerpt(entry.scores.find((score) => score.name === 'relevance')?.details ?? '', 60)
        )
      );
      if (outcome.results.some((entry) => entry.error)) throw new Error('A case failed to run');
      if (
        outcome.results.some(
          (entry) => !entry.toolCalls?.some((call) => call.name === 'stock_level')
        )
      ) {
        throw new Error('A case result does not record the stock_level call');
      }
      const unparsed = outcome.results.flatMap((entry) =>
        entry.scores.filter((score) =>
          /could not parse|judge error|unbound/i.test(score.details ?? '')
        )
      );
      if (unparsed.length > 0) {
        throw new Error(`The judge did not produce a verdict: ${unparsed[0]?.details}`);
      }
      if ((mean('relevance') ?? 0) < 0.6) {
        throw new Error(`The judge rated correct answers ${mean('relevance')}`);
      }
      if (!((mean('tokenUsage') ?? 0) > 0)) throw new Error('tokenUsage saw no tokens');
      const failed = outcome.assertions.filter((entry) => !entry.passed);
      if (failed.length > 0) throw new Error(failed.map((entry) => entry.message).join('; '));
      return outcome;
    });

    await ctx.check('reports and baselines are written', (evidence) => {
      const reportBase = join(ctx.tmpDir, 'reports', 'stock-eval');
      const baselineOut = join(ctx.tmpDir, 'baseline-out.json');
      result.report(['json', 'csv'], { path: reportBase });
      result.saveBaseline(baselineOut);
      const json = existsSync(`${reportBase}.json`);
      const csv = existsSync(`${reportBase}.csv`);
      const baseline = z
        .record(z.string(), z.number())
        .parse(JSON.parse(readFileSync(baselineOut, 'utf8')));
      evidence('files', { json, csv });
      evidence('baseline', baseline);
      if (!json || !csv) throw new Error('A report file is missing');
      if (baseline.contains !== result.aggregated.contains?.mean) {
        throw new Error('The baseline does not hold the means');
      }
    });

    await ctx.check('the judge and assertions catch an off-topic target', async (evidence) => {
      const offTopic = await new EvalSuite({
        dataset,
        target: { fn: async () => 'The weather in Lisbon is sunny with a light breeze today.' },
        metrics: [contains(), relevance()],
        judge,
        assertions: [threshold('contains', 0.66)],
      }).run();
      const relevanceMean = offTopic.aggregated.relevance?.mean ?? 1;
      evidence('relevance', relevanceMean);
      evidence(
        'assertions',
        offTopic.assertions.map((entry) => ({ passed: entry.passed, message: entry.message }))
      );
      if (relevanceMean > 0.3) {
        throw new Error(`The judge rated an off-topic answer ${relevanceMean}`);
      }
      if (offTopic.assertions.every((entry) => entry.passed)) {
        throw new Error('The threshold let the off-topic target pass');
      }
    });

    await ctx.check('an A/B comparison prefers the agent with the tool', async (evidence) => {
      const model = ctx.models[2] ?? ctx.model;
      const comparison = await new EvalComparison({
        dataset: Dataset.from(
          [
            'iron hinges',
            'zinc washers',
            'steel pins',
            'nickel bolts',
            'lead weights',
            'bronze cogs',
          ].map(stockCase)
        ),
        targets: {
          baseline: { agent: clerk(model, false), cogitator: ctx.cogitator },
          challenger: { agent: clerk(model, true), cogitator: ctx.cogitator },
        },
        metrics: [contains()],
        concurrency: 6,
        timeout: 60_000,
      }).run();
      const outcome = comparison.summary.metrics.contains;
      evidence('model', model);
      evidence('contains', outcome);
      evidence('winner', comparison.summary.winner);
      if (!outcome) throw new Error('The comparison has no contains result');
      if (!(outcome.challenger > outcome.baseline)) {
        throw new Error('The tool-using agent did not score higher');
      }
      const won = (scores: ReadonlyArray<{ name: string; score: number }>) =>
        scores.find((score) => score.name === 'contains')?.score === 1;
      const challengerWins = comparison.challenger.results.filter((entry) => {
        const baseline = comparison.baseline.results.find(
          (other) => other.case.input === entry.case.input
        );
        return baseline !== undefined && won(entry.scores) && !won(baseline.scores);
      }).length;
      evidence('discordantWins', challengerWins);
      if (challengerWins >= 6 && comparison.summary.winner !== 'challenger') {
        throw new Error(
          'Six of six discordant pairs favour the challenger, yet it was not declared the winner'
        );
      }
    });
  },
};

export const evalStages: StageDefinition[] = [evalsStage];
