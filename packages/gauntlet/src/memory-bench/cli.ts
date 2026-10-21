import { createHash } from 'node:crypto';
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
  budgetRefusal,
  callCost,
  EMBEDDING_PRICE,
} from './budget.js';
import { cacheDir } from './cache.js';
import { runCompactionLossSuite } from './compaction-loss.js';
import { runConsistencySuite, type ConsistencyCheck } from './consistency.js';
import { DATASETS, loadDataset } from './datasets/index.js';
import { CachedEmbeddingService, RateLimitedEmbeddingService } from './embeddings.js';
import { judge, JudgeStore } from './judge.js';
import { markdownReport, summarize } from './report.js';
import {
  ANSWER_INSTRUCTIONS,
  answerConversation,
  answerKey,
  CLOSING_TURN,
  compactionEstimate,
  compactionSettings,
  EXTRACTION_WINDOW_TOKENS,
  extractionEstimate,
  followUps,
  mapConcurrent,
  NEUTRAL_FOLLOW_UP,
  usesEmbeddings,
} from './runner.js';
import {
  latest,
  parseSample,
  pick,
  positive,
  readJsonl,
  sealJsonl,
  splitTurns,
  UsageError,
} from './options.js';
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

/**
 * A short digest of an answer, part of the id of its judge requests, so an answer asked again
 * gets judged again instead of taking the reply its earlier version got
 */
function outputDigest(output: string): string {
  return createHash('sha256').update(output).digest('hex').slice(0, 16);
}

const HELP = `Cogitator memory benchmarks: long-memory datasets against the runtime's memory.

Usage: pnpm memory-bench [options]

  --datasets <ids>       comma-separated, from: ${DATASETS.join(', ')}
                         (default longmemeval-s,beam-100k,mab-conflict)
  --strategies <names>   recent, relevant, hybrid, compacted, extracted (default the first
                         three).
                         compacted is opt-in: after a conversation goes in, a closing turn
                         ("${CLOSING_TURN}") is saved on its thread and the runtime
                         compacts the thread (memory.compaction, hierarchical, the bench model
                         writing the chapters) once it passed the context budget, keeping a
                         quarter of the budget verbatim, then recent answers from the summary
                         and the kept tail. The closing turn and the chapter calls are charged
                         as the compaction stage. extracted is opt-in too: the memory items of
                         a conversation are extracted once it went in (MemoryExtractor, the
                         bench model, windows of ${EXTRACTION_WINDOW_TOKENS} tokens), scoped to its thread, and
                         recent answers with them as its facts. The calls are charged as the
                         extraction stage
  --sample <spec>        questions per dataset, stratified by category, e.g.
                         longmemeval-s=100,beam-1m=200 (default all)
  --context-tokens <n>   context budget of the memory (default 8192)
  --turns <n>            turns per question (default 1): each question opens a chain on a
                         branch of its conversation's thread, saved turn after turn, whose
                         follow-ups are the next questions of the same conversation (BEAM,
                         LoCoMo and the like), then, once those run out or for a conversation
                         with one question (LongMemEval-S), a neutral one:
                         "${NEUTRAL_FOLLOW_UP}"
                         Follow-ups are not judged: they measure how the prompt cache of a
                         turn carries over to the next, reported apart from the first turns.
                         A resumed run asks a chain with a turn missing again whole
  --budget <usd>         most the run may spend on embeddings, paid from the project budget
                         (default 5)
  --anthropic-budget <usd>
                         most the run may spend on answers and the judge (default 30)
  --concurrency <n>      questions answered at once per conversation, four conversations at
                         a time (default 6)
  --seed <n>             sample seed (default 42)
  --run <name>           results directory under the cache, reused to resume, lowercase
                         letters, digits, '.', '_' and '-' (default: now)
  --no-batch             judge one request at a time instead of Message Batches
  --estimate             print the questions, tokens and cost the run would take, and exit
                         (compacted: the closing turn and one chapter call per 4000 tokens
                         of conversation, extracted: one call per ${EXTRACTION_WINDOW_TOKENS} tokens, roughly)
  --consistency-only     only the offline suites, fork and rewind and compaction loss (no API
                         calls)
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

const STRATEGIES = ['recent', 'relevant', 'hybrid', 'compacted', 'extracted'] as const;

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
      turns: { type: 'string', default: '1' },
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
  const turns = positive('turns', values.turns, true);
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
  if (values.run !== undefined && !/^(?!\.{1,2}$)[a-z0-9._-]+$/.test(values.run)) {
    throw new UsageError(
      `--run takes a name of lowercase letters, digits, '.', '_' and '-', not ${values.run}`
    );
  }

  const printChecks = (checks: readonly ConsistencyCheck[]) => {
    for (const check of checks) {
      log(
        `  ${check.passed ? 'pass' : 'FAIL'}  ${check.strategy.padEnd(8)} ${check.name}${check.passed ? '' : `: ${check.detail}`}`
      );
    }
  };
  log('Fork and rewind consistency');
  const consistency: ConsistencyCheck[] = await runConsistencySuite();
  printChecks(consistency);
  log('Compaction loss');
  const compactionLoss: ConsistencyCheck[] = await runCompactionLossSuite();
  printChecks(compactionLoss);
  if (values['consistency-only']) {
    return [...consistency, ...compactionLoss].every((check) => check.passed) ? 0 : 1;
  }

  const loaded = new Map<BenchDatasetId, BenchConversation[]>();
  for (const id of datasets) {
    const conversations = stratifiedSample(await loadDataset(id, log), sizes.get(id), seed);
    loaded.set(id, conversations);
    log(
      `${id}: ${conversations.length} conversations, ${conversations.reduce((n, c) => n + c.questions.length, 0)} questions`
    );
  }

  const embedded = strategies.some((strategy) => usesEmbeddings(strategy.name));
  const compacted = strategies.some((strategy) => strategy.name === 'compacted');
  const extracted = strategies.some((strategy) => strategy.name === 'extracted');
  let embeddingEstimate = 0;
  let answerEstimate = 0;
  let judgeEstimate = 0;
  let compactionCost = 0;
  let extractionCost = 0;
  for (const conversations of loaded.values()) {
    for (const conversation of conversations) {
      if (embedded) embeddingEstimate += (embeddingTokens(conversation) * EMBEDDING_PRICE) / 1e6;
      if (compacted) compactionCost += compactionEstimate(conversation, contextTokens);
      if (extracted) extractionCost += extractionEstimate(conversation);
      for (const question of conversation.questions) {
        const inputs = [question.question, ...followUps(conversation, question, turns)];
        for (const input of inputs) {
          answerEstimate +=
            callCost(contextTokens + countTokens(input) + 200, 800) * strategies.length;
        }
        judgeEstimate +=
          callCost(judgeTokens(question), 50, !values['no-batch']) * strategies.length;
      }
    }
  }
  if (turns > 1) {
    log(`${turns} turns per question: follow-ups priced like first turns, at the input price`);
  }
  log(
    `Estimated cost: answers $${answerEstimate.toFixed(3)}, judge $${judgeEstimate.toFixed(3)}` +
      `${compacted ? `, compaction $${compactionCost.toFixed(3)}` : ''}` +
      `${extracted ? `, extraction $${extractionCost.toFixed(3)}` : ''} ` +
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

  const run = values.run ?? new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
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
        new RateLimitedEmbeddingService(new GoogleEmbeddingService({ apiKey: googleKey ?? '' })),
        join(cacheDir(), 'embeddings.sqlite'),
        (tokens) => {
          const usd = (tokens * EMBEDDING_PRICE) / 1e6;
          embeddingBudget.reserve(usd)();
          embeddingBudget.charge('embeddings', usd);
        }
      )
    : undefined;

  sealJsonl(answersPath);
  sealJsonl(scoresPath);
  const answers = await readJsonl<BenchAnswer>(answersPath);
  budget.reconcile(
    'answers',
    answers.reduce((sum, answer) => sum + answer.costUsd, 0)
  );
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
            turns,
            anthropicApiKey,
            ...(anthropicWorkspace && { anthropicWorkspace }),
            ...(usesEmbeddings(strategy.name) && embedding && { embedding }),
            budget,
            concurrency,
            done,
            log,
            onAnswer: async (answer) => {
              answers.push(answer);
              done.add(answerKey(answer.dataset, answer.questionId, answer.strategy, answer.turn));
              await appendFile(answersPath, `${JSON.stringify(answer)}\n`);
            },
          });
          await Promise.all([budget.save(), embeddingBudget.save()]);
        });
      }
    }
  } catch (error) {
    const refusal = budgetRefusal(error);
    if (!refusal) throw error;
    stopped = `${refusal.ledger === embeddingBudget.ledger ? 'embeddings' : 'answers and the judge'}: ${refusal.message}`;
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
  const { first: answered, followUps: followUpAnswers } = splitTurns(
    [...latest(answers).values()].filter(inScope),
    turns
  );
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
          id: `${key}\u0000${outputDigest(answer.output)}\u0000${request.id}`,
        })),
        combine: scoring.combine,
      });
    }
  }
  const store = new JudgeStore(
    join(runDir, 'judge-replies.jsonl'),
    join(runDir, 'judge-batches.json')
  );
  budget.reconcile('judge', store.costUsd);
  if (pending.length > 0) {
    log(`Judging ${pending.length} answers`);
    try {
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
      const refusal = budgetRefusal(error);
      if (!refusal) throw error;
      stopped = `the judge: ${refusal.message}`;
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
  const waiting = answered.filter(
    (answer) =>
      !answer.error && !scores.has(answerKey(answer.dataset, answer.questionId, answer.strategy))
  );
  const unjudged = waiting.length;
  if (unjudged > 0) log(`${unjudged} answers are not judged yet: run again with --run ${run}`);
  const rows = summarize(final, waiting, followUpAnswers);
  const report = {
    run,
    finishedAt: new Date().toISOString(),
    config: {
      model: BENCH_MODEL,
      price: BENCH_PRICE,
      judge: `${BENCH_MODEL} (thinking off), Message Batches: ${!values['no-batch']}`,
      embedding: embedding?.model ?? null,
      contextTokens,
      ...(compacted && {
        compaction: { ...compactionSettings(contextTokens), closingTurn: CLOSING_TURN },
      }),
      ...(extracted && { extraction: { windowTokens: EXTRACTION_WINDOW_TOKENS } }),
      turns,
      instructions: ANSWER_INSTRUCTIONS,
      samples: Object.fromEntries(sizes),
      seed,
    },
    spentUsd: { anthropic: budget.spentUsd, embeddings: embeddingBudget.spentUsd },
    spentByStage: { ...budget.byStage(), ...embeddingBudget.byStage() },
    ...(stopped && { stopped }),
    unjudged,
    consistency,
    compactionLoss,
    rows,
  };
  const reportsDir = join(PACKAGE_DIR, 'reports', 'memory');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, `${run}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const notes = [
    stopped && `Stopped early: ${stopped}.`,
    unjudged > 0 && `${unjudged} answers are not judged yet and are left out of the tables.`,
  ].filter(Boolean);
  const markdown = `# Memory benchmarks: ${run}\n\nModel ${BENCH_MODEL}, context budget ${contextTokens} tokens${turns > 1 ? `, ${turns} turns per question` : ''}, spent $${budget.spentUsd.toFixed(3)} on answers${compacted ? ', compaction' : ''}${extracted ? ', extraction' : ''} and the judge and $${embeddingBudget.spentUsd.toFixed(3)} on embeddings.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}\n\n${markdownReport(rows)}`;
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
