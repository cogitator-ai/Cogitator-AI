import { Agent, Cogitator, type RunMiddleware } from '@cogitator-ai/core';
import { ContextBuilder, countMessagesTokens, countTokens } from '@cogitator-ai/memory';
import type { EmbeddingService, Message, RunUsage } from '@cogitator-ai/types';
import { BENCH_MODEL, BENCH_PRICE, answerCost, Budget, budgetRefusal, callCost } from './budget.js';
import type { BenchAnswer, BenchConversation, BenchQuestion, BenchStrategy } from './types.js';

export const ANSWER_INSTRUCTIONS =
  'You are a helpful assistant with a long-term memory of earlier conversations with the user. ' +
  'Answer the question from the conversation history you can see. If the history does not ' +
  'hold the answer, say that you do not know. Follow any answer format the question asks for.';

/** Tokens a model turn may write, thinking included. */
const ANSWER_MAX_TOKENS = 4096;

export interface AnswerOptions {
  strategy: BenchStrategy;
  /**
   * Turns of each question's chain (default 1): the question, then follow-ups in the same branch
   * of the thread, see `followUps`
   */
  turns?: number;
  anthropicApiKey: string;
  /** Workspace of a key that is not scoped to one (`anthropic-workspace-id`) */
  anthropicWorkspace?: string;
  embedding?: EmbeddingService;
  budget: Budget;
  concurrency: number;
  /**
   * Answers already in the results, by `answerKey`, skipped so a rerun pays only for the rest. A
   * chain with a turn missing runs again whole, since its later turns read the cache its first
   * one wrote
   */
  done: ReadonlySet<string>;
  onAnswer(answer: BenchAnswer): Promise<void>;
  log(line: string): void;
}

/** The key of an answer in the results: the first turn keeps the key answers had before turns. */
export function answerKey(dataset: string, questionId: string, strategy: string, turn = 1): string {
  const key = `${dataset}\u0000${questionId}\u0000${strategy}`;
  return turn > 1 ? `${key}\u0000${turn}` : key;
}

/** What a follow-up asks once its conversation has no other question left to ask. */
export const NEUTRAL_FOLLOW_UP = 'Restate your previous answer in one short sentence.';

/**
 * The inputs of the turns after `question` in a chain of `turns`: the questions that follow it in
 * its conversation (wrapping around to the ones before it), as a user goes on asking about the
 * same history, then `NEUTRAL_FOLLOW_UP` once they run out, at once for a conversation with a
 * single question (LongMemEval-S). Follow-ups are not judged: a question asked as a follow-up is
 * scored only as the first turn of its own chain.
 */
export function followUps(
  conversation: BenchConversation,
  question: BenchQuestion,
  turns: number
): string[] {
  const questions = conversation.questions;
  const at = questions.findIndex((other) => other.id === question.id);
  const others = (at < 0 ? questions : [...questions.slice(at + 1), ...questions.slice(0, at)])
    .filter((other) => other.id !== question.id)
    .map((other) => other.question);
  return Array.from({ length: Math.max(turns - 1, 0) }, (_, i) => others[i] ?? NEUTRAL_FOLLOW_UP);
}

/** The 1-hour part of a run's cache writes, read only when the run's usage reports it. */
function cacheWrite1hTokens(usage: RunUsage): number | undefined {
  return 'cacheWrite1hTokens' in usage && typeof usage.cacheWrite1hTokens === 'number'
    ? usage.cacheWrite1hTokens
    : undefined;
}

/**
 * Runs `run` on every item, at most `limit` at once, in no particular order. After a failure no
 * new item starts, the running ones finish, and the first error is thrown.
 */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      try {
        await run(items[next++]);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

/**
 * The instructions a question is answered with: the bench's, the dataset's own rules, and "today"
 * when the dataset gives it. They go to the agent, not into the question, so retrieval searches
 * the question alone.
 */
export function answerInstructions(
  conversation: BenchConversation,
  question: BenchQuestion
): string {
  return [
    ANSWER_INSTRUCTIONS,
    conversation.protocol,
    question.askedOn && `Today is ${question.askedOn}.`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

/** The share of `evidence` texts that appear in `messages`. */
export function evidenceRecall(evidence: readonly string[], messages: readonly Message[]): number {
  if (evidence.length === 0) return 0;
  const texts = messages.map((message) =>
    typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
  );
  const found = evidence.filter((text) => {
    const needle = text.slice(0, 300);
    return texts.some((content) => content.includes(needle));
  });
  return found.length / evidence.length;
}

interface Probe {
  messages: number;
  tokens: number;
  recall?: number;
}

/** A middleware that records what each question's model call was sent. */
function probe(
  evidence: readonly string[] | undefined,
  record: (probe: Probe) => void,
  memoryErrors: readonly unknown[]
): RunMiddleware {
  return {
    name: 'memory-bench-probe',
    wrapModelCall(call, next) {
      const refusal = memoryErrors.map(budgetRefusal).find(Boolean);
      if (refusal) throw refusal;
      record({
        messages: call.request.messages.length,
        tokens: countMessagesTokens(call.request.messages),
        ...(evidence?.length && { recall: evidenceRecall(evidence, call.request.messages) }),
      });
      return next(call);
    },
  };
}

/**
 * Retries of a model call: a run of thousands of questions meets rate limits and dropped
 * connections, and an answer lost to one would only be asked again on the next run.
 */
const BENCH_RETRY = { maxRetries: 8, maxDelay: 60_000 };

/** Time a question's run may take: room for the retries to wait out rate limits. */
const RUN_TIMEOUT_MS = 600_000;

/** A runtime whose memory holds conversations for `strategy`, the bench model priced. */
export function benchRuntime(
  options: Pick<AnswerOptions, 'strategy' | 'anthropicApiKey' | 'anthropicWorkspace' | 'embedding'>
) {
  return new Cogitator({
    llm: {
      providers: {
        anthropic: {
          apiKey: options.anthropicApiKey,
          ...(options.anthropicWorkspace && {
            headers: { 'anthropic-workspace-id': options.anthropicWorkspace },
          }),
        },
      },
      pricing: { [`anthropic/${BENCH_MODEL}`]: BENCH_PRICE },
      retry: BENCH_RETRY,
    },
    memory: {
      adapter: 'memory',
      inMemory: { maxEntries: 5_000_000 },
      ...(options.embedding && { embedding: options.embedding }),
      contextBuilder: {
        strategy: options.strategy.name,
        maxTokens: options.strategy.contextTokens,
      },
    },
  });
}

export function benchAgent(instructions = ANSWER_INSTRUCTIONS): Agent {
  return new Agent({
    id: 'memory-bench',
    name: 'memory-bench',
    model: `anthropic/${BENCH_MODEL}`,
    instructions,
    maxTokens: ANSWER_MAX_TOKENS,
    maxIterations: 1,
    timeout: RUN_TIMEOUT_MS,
  });
}

/** A conversation put into memory: its thread and the thread's last entry. */
export interface IngestedThread {
  threadId: string;
  /** The last entry, where every chain of turns branches off, null for an empty conversation */
  leafId: string | null;
}

/**
 * Puts `conversation` into the memory of `cog` as one thread. Turns go in by their dates, so the
 * thread's branch reads in the order the conversation happened even when the dataset lists
 * sessions out of order.
 */
export async function ingest(
  cog: Cogitator,
  agent: Agent,
  conversation: BenchConversation
): Promise<IngestedThread> {
  const memory = await cog.getMemory();
  if (!memory) throw new Error('The bench runtime has no memory');
  const threadId = `bench:${conversation.dataset}:${conversation.id}`;
  const created = await memory.createThread(agent.id, { bench: conversation.dataset }, threadId);
  if (!created.success) throw new Error(`Thread ${threadId}: ${created.error}`);
  const start = conversation.turns[0]?.at?.getTime() ?? Date.UTC(2023, 0, 1);
  const dated = conversation.turns
    .map((turn, index) => ({
      turn,
      index,
      at: Math.max(turn.at?.getTime() ?? 0, start) + index,
    }))
    .sort((a, b) => a.at - b.at);
  let leafId: string | null = null;
  for (const { turn, index, at } of dated) {
    const added = await memory.addEntry({
      threadId,
      message: { role: turn.role, content: turn.content },
      tokenCount: countTokens(turn.content),
      createdAt: new Date(at),
    });
    if (!added.success) throw new Error(`Entry ${index} of ${threadId}: ${added.error}`);
    leafId = added.data.id;
  }
  return { threadId, leafId };
}

/**
 * Embeds the history the strategy will score and every question before the questions run, so
 * each strategy's context build is measured on a warm cache, the provider's embedding latency
 * left out alike for all of them (a strategy that runs later must not find the questions cached
 * by an earlier one). A context builder of the same strategy and budget builds the thread's
 * context once: it embeds exactly the entries the runtime's builder will score (its order,
 * filters and limits), and the vectors land in the shared embedding cache.
 */
async function warm(
  cog: Cogitator,
  agent: Agent,
  threadId: string,
  conversation: BenchConversation,
  options: AnswerOptions
): Promise<void> {
  const memoryAdapter = await cog.getMemory();
  if (!memoryAdapter) throw new Error('The bench runtime has no memory');
  const builder = new ContextBuilder(
    { strategy: options.strategy.name, maxTokens: options.strategy.contextTokens },
    { memoryAdapter, ...(options.embedding && { embeddingService: options.embedding }) }
  );
  const context = await builder.build({
    threadId,
    agentId: agent.id,
    currentInput: conversation.questions[0]?.question ?? 'warm-up',
  });
  const errors = (context.errors ?? []).map(({ error }) => error);
  if (options.embedding) {
    try {
      const inputs = conversation.questions.map((question) => question.question);
      if ((options.turns ?? 1) > 1) inputs.push(NEUTRAL_FOLLOW_UP);
      await options.embedding.embedBatch(inputs);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  for (const error of errors) {
    const refusal = budgetRefusal(error);
    if (refusal) throw refusal;
    options.log(`  warming ${conversation.id}: ${error.message}`);
  }
}

/** One turn of a question's chain. */
interface TurnRequest {
  question: BenchQuestion;
  /** What the turn asks: the question on the first turn, a follow-up after it */
  input: string;
  turn: number;
  /** The entry the turn's branch goes after, for a turn of a chain that saves its history */
  after?: string | null;
}

/**
 * Answers the questions of `conversation` from memory: the conversation goes into a thread
 * once, then each question runs as its own turn that is not saved, so questions do not see each
 * other. With `turns` above one each question opens a chain instead: its turn and the follow-ups
 * (`followUps`) are saved one after another on a branch of their own that leaves the thread's
 * active leaf where it was, so chains running at once do not see each other either, and each
 * follow-up can read the prompt cache the turn before it wrote. Every answer records the tokens,
 * cache reads and writes, cost and time of its run, what reached the model and how much of the
 * marked evidence did. An answer whose context lost a part to a memory error (the embeddings
 * failed, so the strategy fell back to the newest turns) is marked failed: it did not measure the
 * strategy. A failed turn ends its chain.
 */
export async function answerConversation(
  conversation: BenchConversation,
  options: AnswerOptions
): Promise<void> {
  const turns = options.turns ?? 1;
  const strategy = options.strategy.name;
  const pending = conversation.questions.filter((question) =>
    Array.from({ length: turns }, (_, i) =>
      answerKey(conversation.dataset, question.id, strategy, i + 1)
    ).some((key) => !options.done.has(key))
  );
  if (pending.length === 0) return;

  const cog = benchRuntime(options);
  const agent = benchAgent();

  const answerTurn = async (
    threadId: string,
    request: TurnRequest
  ): Promise<{ ok: boolean; leafId?: string }> => {
    const { question, input, turn } = request;
    const estimate = callCost(
      options.strategy.contextTokens + countTokens(input),
      ANSWER_MAX_TOKENS
    );
    const release = options.budget.reserve(estimate);
    let seen: Probe | undefined;
    const memoryErrors: Error[] = [];
    const evidence = turn === 1 ? question.evidence : undefined;
    const base = {
      dataset: conversation.dataset,
      conversationId: conversation.id,
      questionId: question.id,
      category: question.category,
      strategy,
      ...(turn > 1 && { turn }),
    };
    try {
      const result = await cog.run(benchAgent(answerInstructions(conversation, question)), {
        input,
        threadId,
        ...(request.after === undefined
          ? { saveHistory: false }
          : { saveHistory: true, branch: { fromEntryId: request.after, activate: false } }),
        middleware: [probe(evidence, (value) => (seen = value), memoryErrors)],
        onMemoryError: (error) => memoryErrors.push(error),
      });
      const llmMs = result.trace.spans
        .filter((span) => span.name === 'llm.chat')
        .reduce((sum, span) => sum + span.duration, 0);
      const costUsd = answerCost(result.usage.inputTokens, result.usage.cost);
      options.budget.charge('answers', costUsd);
      const written1h = cacheWrite1hTokens(result.usage);
      await options.onAnswer({
        ...base,
        output: result.output,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens ?? 0,
        cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
        ...(written1h !== undefined && { cacheWrite1hTokens: written1h }),
        costUsd,
        durationMs: result.usage.duration,
        contextMs: Math.max(result.usage.duration - llmMs, 0),
        contextMessages: seen?.messages ?? 0,
        contextTokens: seen?.tokens ?? 0,
        ...(seen?.recall !== undefined && { evidenceRecall: seen.recall }),
        ...(memoryErrors.length > 0 && {
          error: `memory: ${memoryErrors.map((error) => error.message).join(', ')} (the strategy fell back)`,
        }),
      });
      return {
        ok: memoryErrors.length === 0,
        ...(result.memory?.leafId !== undefined && { leafId: result.memory.leafId }),
      };
    } catch (error) {
      const refusal = budgetRefusal(error);
      if (refusal) throw refusal;
      const label = turn > 1 ? `${question.id} turn ${turn}` : question.id;
      options.log(`  ${label}: ${error instanceof Error ? error.message : String(error)}`);
      await options.onAnswer({
        ...base,
        output: '',
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs: 0,
        contextMs: 0,
        contextMessages: 0,
        contextTokens: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    } finally {
      release();
    }
  };

  try {
    const thread = await ingest(cog, agent, conversation);
    if (options.embedding) await warm(cog, agent, thread.threadId, conversation, options);
    await mapConcurrent(pending, options.concurrency, async (question) => {
      if (turns === 1) {
        await answerTurn(thread.threadId, { question, input: question.question, turn: 1 });
        return;
      }
      const inputs = [question.question, ...followUps(conversation, question, turns)];
      let after: string | null = thread.leafId;
      for (const [index, input] of inputs.entries()) {
        const turn = index + 1;
        const answered = await answerTurn(thread.threadId, { question, input, turn, after });
        if (!answered.ok) return;
        if (answered.leafId === undefined) {
          if (turn < turns) options.log(`  ${question.id}: turn ${turn} saved nothing to follow`);
          return;
        }
        after = answered.leafId;
      }
    });
  } finally {
    await cog.close();
  }
}
