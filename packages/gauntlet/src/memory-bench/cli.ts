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
import { judge, JudgeStore } from './judge.js';
import { markdownReport, summarize } from './report.js';
import { ANSWER_INSTRUCTIONS, answerConversation, answerKey, mapConcurrent } from './runner.js';
import { latest, parseSample, pick, positive, readJsonl, UsageError } from './options.js';
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
  --concurrency <n>      questions answered at once per conversation, four conversations at
                         a time (default 6)
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

/**
 * Version of how datasets are rendered and scored: a run is resumed only by the same method, so
 * answers and scores of different methods never mix in one report.
 */
const METHOD_VERSION = 3;

const STRATEGIES = ['recent', 'relevant', 'hybrid'] as const;

/** Conversations answered at once, each with its own runtime and its questions concurrent. */
const CONVERSATIONS_AT_ONCE = 4;

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

  const datasets = pick<BenchDatasetId>('datasets', values.datasets, DATASETS);
  const contextTokens = positive('context-tokens', values['context-tokens'], true);
  const strategies: BenchStrategy[] = pick<BenchStrategy['name']>(
    'strategies',
    values.strategies,
    STRATEGIES
  ).map((name) => ({ name, contextTokens }));
  const sizes = parseSample(values.sample);
  for (const id of sizes.keys()) {
    if (!(datasets as readonly string[]).includes(id)) {
      throw new UsageError(`--sample names ${id}, which is not among --datasets`);
    }
  }
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed))
    throw new UsageError(`--seed takes an integer, not ${values.seed}`);
  const anthropicLimit = positive('anthropic-budget', values['anthropic-budget']);
  const embeddingLimit = positive('budget', values.budget);
  const concurrency = positive('concurrency', values.concurrency, true);
  if (values.run !== undefined && !/^(?!\.{1,2}$)[\w.-]+$/.test(values.run)) {
    throw new UsageError(
      `--run takes a name of letters, digits, '.', '_' and '-', not ${values.run}`
    );
  }

  log('Fork and rewind consistency');
  const consistency: ConsistencyCheck[] = await runConsistencySuite();
  for (const check of consistency) {
    log(
      `  ${check.passed ? 'pass' : 'FAIL'}  ${check.strategy.padEnd(8)} ${check.name}${check.passed ? '' : `: ${check.detail}`}`
    );
  }
  if (values['consistency-only']) return consistency.every((check) => check.passed) ? 0 : 1;

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
      `(Anthropic budget $${anthropicLimit.toFixed(2)}), embeddings ` +
      `$${embeddingEstimate.toFixed(3)} (budget $${embeddingLimit.toFixed(2)})`
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
  const settings = {
    method: METHOD_VERSION,
    model: BENCH_MODEL,
    contextTokens,
    instructions: ANSWER_INSTRUCTIONS,
    seed,
  };
  const settingsPath = join(runDir, 'settings.json');
  if (existsSync(settingsPath)) {
    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as typeof settings;
    const changed = (Object.keys(settings) as (keyof typeof settings)[]).filter(
      (key) => saved[key] !== settings[key]
    );
    if (changed.length > 0) {
      log(`Run ${run} was started with other ${changed.join(', ')}: start a new --run instead`);
      return 1;
    }
  } else {
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  const budget = new Budget(anthropicLimit, run, join(cacheDir(), 'ledger-anthropic.json'));
  const embeddingBudget = new Budget(embeddingLimit, run, join(cacheDir(), 'ledger.json'));
  const embedding = embedded
    ? new CachedEmbeddingService(
        new GoogleEmbeddingService({ apiKey: googleKey ?? '' }),
        join(cacheDir(), 'embeddings.sqlite'),
        (tokens) => {
          const usd = (tokens * EMBEDDING_PRICE) / 1e6;
          embeddingBudget.reserve(usd)();
          embeddingBudget.charge('embeddings', usd);
        }
      )
    : undefined;

  const answers = await readJsonl<BenchAnswer>(answersPath);
  const done = new Set(
    [...latest(answers)].flatMap(([key, answer]) => (answer.error ? [] : [key]))
  );
  let stopped: string | undefined;
  try {
    for (const [id, conversations] of loaded) {
      for (const strategy of strategies) {
        log(`${id} / ${strategy.name}`);
        await mapConcurrent(conversations, CONVERSATIONS_AT_ONCE, async (conversation) => {
          await answerConversation(conversation, {
            strategy,
            anthropicApiKey,
            ...(anthropicWorkspace && { anthropicWorkspace }),
            ...(strategy.name !== 'recent' && embedding && { embedding }),
            budget,
            concurrency,
            done,
            log,
            onAnswer: async (answer) => {
              answers.push(answer);
              done.add(answerKey(answer.dataset, answer.questionId, answer.strategy));
              await appendFile(answersPath, `${JSON.stringify(answer)}\n`);
            },
          });
          await Promise.all([budget.save(), embeddingBudget.save()]);
        });
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
  const inScope = (answer: BenchAnswer) =>
    questions.has(`${answer.dataset}\u0000${answer.questionId}`) &&
    strategies.some((strategy) => strategy.name === answer.strategy);
  const answered = [...latest(answers).values()].filter(inScope);
  const scores = latest(await readJsonl<BenchScore>(scoresPath));
  const pending: {
    answer: BenchAnswer;
    requests: JudgeRequest[];
    combine(scores: number[]): number;
  }[] = [];
  const saveScore = async (score: BenchScore) => {
    scores.set(answerKey(score.dataset, score.questionId, score.strategy), score);
    await appendFile(scoresPath, `${JSON.stringify(score)}\n`);
  };
  for (const answer of answered) {
    const key = answerKey(answer.dataset, answer.questionId, answer.strategy);
    const question = questions.get(`${answer.dataset}\u0000${answer.questionId}`);
    if (answer.error || !question) continue;
    const existing = scores.get(key);
    if (existing?.output === answer.output) continue;
    const scoring = scoringFor(question, answer.output);
    if (scoring.kind === 'score') {
      await saveScore({ ...answer, score: scoring.score, judgeCostUsd: 0 });
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
  if (pending.length > 0) {
    const store = new JudgeStore(
      join(runDir, 'judge-replies.jsonl'),
      join(runDir, 'judge-batches.json')
    );
    if (!stopped) log(`Judging ${pending.length} answers`);
    try {
      if (!stopped)
        await judge(
          pending.flatMap((item) => item.requests),
          {
            client: new Anthropic({
              apiKey: anthropicApiKey,
              maxRetries: 6,
              ...(anthropicWorkspace && {
                defaultHeaders: { 'anthropic-workspace-id': anthropicWorkspace },
              }),
            }),
            batch: !values['no-batch'],
            budget,
            store,
            concurrency,
            log,
          }
        );
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      stopped = error.message;
      log(`Stopped while judging: ${stopped}`);
    }
    for (const item of pending) {
      const replies = item.requests.map((request) => store.replies.get(request.id));
      if (replies.some((reply) => reply === undefined)) continue;
      await saveScore({
        ...item.answer,
        score: item.combine(
          item.requests.map((request, i) => request.read(replies[i]?.text ?? ''))
        ),
        judgeCostUsd: replies.reduce((sum, reply) => sum + (reply?.costUsd ?? 0), 0),
      });
    }
  }
  await Promise.all([budget.save(), embeddingBudget.save()]);
  embedding?.close();

  const final: BenchScore[] = answered.flatMap((answer) => {
    if (answer.error) return [{ ...answer, score: 0, judgeCostUsd: 0 }];
    const score = scores.get(answerKey(answer.dataset, answer.questionId, answer.strategy));
    return score ? [score] : [];
  });
  const unjudged = answered.length - final.length;
  if (unjudged > 0) log(`${unjudged} answers are not judged yet: run again with --run ${run}`);
  const rows = summarize(final);
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
    unjudged,
    consistency,
    rows,
  };
  const reportsDir = join(PACKAGE_DIR, 'reports', 'memory');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, `${run}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const notes = [
    stopped && `Stopped early: ${stopped}.`,
    unjudged > 0 && `${unjudged} answers are not judged yet and are left out of the tables.`,
  ].filter(Boolean);
  const markdown = `# Memory benchmarks: ${run}\n\nModel ${BENCH_MODEL}, context budget ${contextTokens} tokens, spent $${budget.spentUsd.toFixed(3)} on answers and the judge and $${embeddingBudget.spentUsd.toFixed(3)} on embeddings.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}\n\n${markdownReport(rows)}`;
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
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${HELP}\n`);
      process.exitCode = 64;
      return;
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  }
);
