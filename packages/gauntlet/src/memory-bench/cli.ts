import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { countTokens, GoogleEmbeddingService } from '@cogitator-ai/memory';
import { PACKAGE_DIR } from '../packages.js';
import {
  BENCH_MODEL,
  BENCH_PRICE,
  Budget,
  BudgetExceededError,
  callCost,
  EMBEDDING_PRICE,
} from './budget.js';
import { cacheDir } from './cache.js';
import { runConsistencySuite, type ConsistencyCheck } from './consistency.js';
import { DATASETS, loadDataset } from './datasets/index.js';
import { CachedEmbeddingService } from './embeddings.js';
import { judge } from './judge.js';
import { markdownReport, summarize } from './report.js';
import { ANSWER_INSTRUCTIONS, answerConversation, answerKey } from './runner.js';
import { stratifiedSample } from './sample.js';
import { scoringFor, type JudgeRequest } from './scoring.js';
import type {
  BenchAnswer,
  BenchConversation,
  BenchDatasetId,
  BenchQuestion,
  BenchScore,
  BenchStrategy,
} from './types.js';

const HELP = `Cogitator memory benchmarks: long-memory datasets against the runtime's memory.

Usage: pnpm memory-bench [options]

  --datasets <ids>       comma-separated, from: ${DATASETS.join(', ')}
                         (default longmemeval-s,beam-100k,mab-conflict)
  --strategies <names>   recent, relevant, hybrid (default all three)
  --sample <spec>        questions per dataset, stratified by category, e.g.
                         longmemeval-s=100,beam-1m=200 (default all)
  --context-tokens <n>   context budget of the memory (default 8192)
  --budget <usd>         most the run may spend on embeddings, paid from the project budget
                         (default 5)
  --anthropic-budget <usd>
                         most the run may spend on answers and the judge (default 30)
  --concurrency <n>      questions answered at once (default 6)
  --seed <n>             sample seed (default 42)
  --run <name>           results directory under the cache, reused to resume (default: now)
  --no-batch             judge one request at a time instead of Message Batches
  --estimate             print the questions, tokens and cost the run would take, and exit
  --consistency-only     only the fork and rewind suite (no API calls)
  -h, --help             show this help

Environment: ANTHROPIC_API_KEY (answers and judge), ANTHROPIC_WORKSPACE_ID (for a key that is
not scoped to a workspace), GOOGLE_API_KEY (embeddings for relevant
and hybrid), MEMORY_BENCH_CACHE (default ~/.cache/cogitator/memory-bench). Read from the
repository's .env too.`;

function parseSample(spec: string | undefined): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const part of spec?.split(',') ?? []) {
    const [id, size] = part.split('=');
    if (id && size && Number.isInteger(Number(size))) sizes.set(id.trim(), Number(size));
  }
  return sizes;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

/** Tokens the memory would embed for a conversation: the last 200 turns the strategies score. */
function embeddingTokens(conversation: BenchConversation): number {
  return conversation.turns.slice(-200).reduce((sum, turn) => sum + countTokens(turn.content), 0);
}

function judgeTokens(question: BenchQuestion): number {
  switch (question.scoring.kind) {
    case 'longmemeval':
      return 400 + countTokens(question.answer);
    case 'beam-rubric':
      return question.scoring.rubric.length * 1400;
    case 'lme-v2':
      return question.scoring.evalFunction.startsWith('llm_') ? 700 : 0;
    default:
      return 0;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      datasets: { type: 'string', default: 'longmemeval-s,beam-100k,mab-conflict' },
      strategies: { type: 'string', default: 'recent,relevant,hybrid' },
      sample: { type: 'string' },
      'context-tokens': { type: 'string', default: '8192' },
      budget: { type: 'string', default: '5' },
      'anthropic-budget': { type: 'string', default: '30' },
      concurrency: { type: 'string', default: '6' },
      seed: { type: 'string', default: '42' },
      run: { type: 'string' },
      'no-batch': { type: 'boolean', default: false },
      estimate: { type: 'boolean', default: false },
      'consistency-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const log = (line: string) => process.stdout.write(`${line}\n`);

  for (const envFile of [join(PACKAGE_DIR, '.env'), resolve(PACKAGE_DIR, '../../.env')]) {
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }

  log('Fork and rewind consistency');
  const consistency: ConsistencyCheck[] = await runConsistencySuite();
  for (const check of consistency) {
    log(
      `  ${check.passed ? 'pass' : 'FAIL'}  ${check.strategy.padEnd(8)} ${check.name}${check.passed ? '' : `: ${check.detail}`}`
    );
  }
  if (values['consistency-only']) return consistency.every((check) => check.passed) ? 0 : 1;

  const datasets = values.datasets
    .split(',')
    .map((id) => id.trim())
    .filter((id): id is BenchDatasetId => (DATASETS as readonly string[]).includes(id));
  const contextTokens = Number(values['context-tokens']);
  const strategies: BenchStrategy[] = values.strategies
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is BenchStrategy['name'] =>
      ['recent', 'relevant', 'hybrid'].includes(name)
    )
    .map((name) => ({ name, contextTokens }));
  const sizes = parseSample(values.sample);
  const seed = Number(values.seed);

  const loaded = new Map<BenchDatasetId, BenchConversation[]>();
  for (const id of datasets) {
    const conversations = stratifiedSample(await loadDataset(id, log), sizes.get(id), seed);
    loaded.set(id, conversations);
    log(
      `${id}: ${conversations.length} conversations, ${conversations.reduce((n, c) => n + c.questions.length, 0)} questions`
    );
  }

  const embedded = strategies.some((strategy) => strategy.name !== 'recent');
  let embeddingEstimate = 0;
  let answerEstimate = 0;
  let judgeEstimate = 0;
  for (const conversations of loaded.values()) {
    for (const conversation of conversations) {
      if (embedded) embeddingEstimate += (embeddingTokens(conversation) * EMBEDDING_PRICE) / 1e6;
      for (const question of conversation.questions) {
        answerEstimate +=
          callCost(contextTokens + countTokens(question.question) + 200, 800) * strategies.length;
        judgeEstimate +=
          callCost(judgeTokens(question), 50, !values['no-batch']) * strategies.length;
      }
    }
  }
  log(
    `Estimated cost: answers $${answerEstimate.toFixed(3)}, judge $${judgeEstimate.toFixed(3)} ` +
      `(Anthropic budget $${Number(values['anthropic-budget']).toFixed(2)}), embeddings ` +
      `$${embeddingEstimate.toFixed(3)} (budget $${Number(values.budget).toFixed(2)})`
  );
  if (values.estimate) return 0;

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    log('ANTHROPIC_API_KEY is not set');
    return 1;
  }
  const anthropicWorkspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const googleKey = process.env.GOOGLE_API_KEY;
  if (embedded && !googleKey) {
    log('GOOGLE_API_KEY is not set: relevant and hybrid need embeddings');
    return 1;
  }

  const run = values.run ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(cacheDir(), 'runs', run);
  await mkdir(runDir, { recursive: true });
  const answersPath = join(runDir, 'answers.jsonl');
  const scoresPath = join(runDir, 'scores.jsonl');
  const budget = new Budget(
    Number(values['anthropic-budget']),
    run,
    join(cacheDir(), 'ledger-anthropic.json')
  );
  const embeddingBudget = new Budget(Number(values.budget), run, join(cacheDir(), 'ledger.json'));
  const embedding = embedded
    ? new CachedEmbeddingService(
        new GoogleEmbeddingService({ apiKey: googleKey ?? '' }),
        join(cacheDir(), 'embeddings.sqlite')
      )
    : undefined;

  const answers = await readJsonl<BenchAnswer>(answersPath);
  const done = new Set(answers.map((a) => answerKey(a.dataset, a.questionId, a.strategy)));
  let stopped: string | undefined;
  try {
    for (const [id, conversations] of loaded) {
      for (const strategy of strategies) {
        log(`${id} / ${strategy.name}`);
        for (const conversation of conversations) {
          const embeddedBefore = embedding?.embeddedTokens ?? 0;
          if (strategy.name !== 'recent') {
            embeddingBudget.reserve((embeddingTokens(conversation) * EMBEDDING_PRICE) / 1e6);
          }
          await answerConversation(conversation, {
            strategy,
            anthropicApiKey,
            ...(anthropicWorkspace && { anthropicWorkspace }),
            ...(strategy.name !== 'recent' && embedding && { embedding }),
            budget,
            concurrency: Number(values.concurrency),
            done,
            log,
            onAnswer: async (answer) => {
              answers.push(answer);
              done.add(answerKey(answer.dataset, answer.questionId, answer.strategy));
              await appendFile(answersPath, `${JSON.stringify(answer)}\n`);
            },
          });
          embeddingBudget.charge(
            'embeddings',
            (((embedding?.embeddedTokens ?? 0) - embeddedBefore) * EMBEDDING_PRICE) / 1e6
          );
          await Promise.all([budget.save(), embeddingBudget.save()]);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    stopped = error.message;
    log(`Stopped: ${stopped}`);
  }

  const questions = new Map<string, BenchQuestion>();
  for (const conversations of loaded.values()) {
    for (const conversation of conversations) {
      for (const question of conversation.questions)
        questions.set(`${conversation.dataset}\u0000${question.id}`, question);
    }
  }
  const scores = await readJsonl<BenchScore>(scoresPath);
  const scored = new Set(scores.map((s) => answerKey(s.dataset, s.questionId, s.strategy)));
  const pending: {
    answer: BenchAnswer;
    requests: JudgeRequest[];
    combine(scores: number[]): number;
  }[] = [];
  for (const answer of answers) {
    const key = answerKey(answer.dataset, answer.questionId, answer.strategy);
    const question = questions.get(`${answer.dataset}\u0000${answer.questionId}`);
    if (scored.has(key) || !question) continue;
    const scoring = answer.error
      ? ({ kind: 'score', score: 0 } as const)
      : scoringFor(question, answer.output);
    if (scoring.kind === 'score') {
      const score: BenchScore = { ...answer, score: scoring.score, judgeCostUsd: 0 };
      scores.push(score);
      scored.add(key);
      await appendFile(scoresPath, `${JSON.stringify(score)}\n`);
    } else {
      pending.push({
        answer,
        requests: scoring.requests.map((request) => ({
          ...request,
          id: `${key}\u0000${request.id}`,
        })),
        combine: scoring.combine,
      });
    }
  }
  if (pending.length > 0 && !stopped) {
    log(`Judging ${pending.length} answers`);
    try {
      const replies = await judge(
        pending.flatMap((item) => item.requests),
        {
          client: new Anthropic({
            apiKey: anthropicApiKey,
            ...(anthropicWorkspace && {
              defaultHeaders: { 'anthropic-workspace-id': anthropicWorkspace },
            }),
          }),
          batch: !values['no-batch'],
          budget,
          concurrency: Number(values.concurrency),
          log,
        }
      );
      for (const item of pending) {
        const results = item.requests.map((request) => {
          const reply = replies.get(request.id);
          return { score: reply ? request.read(reply.text) : 0, cost: reply?.costUsd ?? 0 };
        });
        const score: BenchScore = {
          ...item.answer,
          score: item.combine(results.map((result) => result.score)),
          judgeCostUsd: results.reduce((sum, result) => sum + result.cost, 0),
        };
        scores.push(score);
        await appendFile(scoresPath, `${JSON.stringify(score)}\n`);
      }
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      stopped = error.message;
      log(`Stopped before judging: ${stopped}`);
    }
  }
  await Promise.all([budget.save(), embeddingBudget.save()]);
  embedding?.close();

  const rows = summarize(scores);
  const report = {
    run,
    finishedAt: new Date().toISOString(),
    config: {
      model: BENCH_MODEL,
      price: BENCH_PRICE,
      judge: `${BENCH_MODEL} (thinking off), Message Batches: ${!values['no-batch']}`,
      embedding: embedding?.model ?? null,
      contextTokens,
      instructions: ANSWER_INSTRUCTIONS,
      samples: Object.fromEntries(sizes),
      seed,
    },
    spentUsd: { anthropic: budget.spentUsd, embeddings: embeddingBudget.spentUsd },
    spentByStage: { ...budget.byStage(), ...embeddingBudget.byStage() },
    ...(stopped && { stopped }),
    consistency,
    rows,
  };
  const reportsDir = join(PACKAGE_DIR, 'reports', 'memory');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, `${run}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = `# Memory benchmarks: ${run}\n\nModel ${BENCH_MODEL}, context budget ${contextTokens} tokens, spent $${budget.spentUsd.toFixed(3)} on answers and the judge and $${embeddingBudget.spentUsd.toFixed(3)} on embeddings.\n\n${markdownReport(rows)}`;
  await writeFile(join(reportsDir, `${run}.md`), markdown);
  log(markdown);
  log(`Report: ${join(reportsDir, `${run}.json`)}`);
  return stopped ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  }
);
