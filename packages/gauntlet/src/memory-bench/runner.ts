import { Agent, Cogitator, type RunMiddleware } from '@cogitator-ai/core';
import { countMessagesTokens, countTokens } from '@cogitator-ai/memory';
import type { EmbeddingService, Message } from '@cogitator-ai/types';
import { BENCH_MODEL, BENCH_PRICE, Budget, callCost, LONG_PROMPT_TOKENS } from './budget.js';
import type { BenchAnswer, BenchConversation, BenchQuestion, BenchStrategy } from './types.js';

export const ANSWER_INSTRUCTIONS =
  'You are a helpful assistant with a long-term memory of earlier conversations with the user. ' +
  'Answer the question from the conversation history you can see. If the history does not ' +
  'hold the answer, say that you do not know. Follow any answer format the question asks for.';

/**
 * Turns the `relevant` and `hybrid` strategies score at most (`MAX_SCORED_ENTRIES` of the
 * context builder). Their embeddings are computed before the questions, so the context build
 * time of every strategy is measured on a warm cache.
 */
const SCORED_ENTRIES = 200;

/** Tokens a model turn may write, thinking included. */
const ANSWER_MAX_TOKENS = 4096;

export interface AnswerOptions {
  strategy: BenchStrategy;
  anthropicApiKey: string;
  /** Workspace of a key that is not scoped to one (`anthropic-workspace-id`) */
  anthropicWorkspace?: string;
  embedding?: EmbeddingService;
  budget: Budget;
  concurrency: number;
  /** Answers already in the results, by `answerKey`, skipped so a rerun pays only for the rest */
  done: ReadonlySet<string>;
  onAnswer(answer: BenchAnswer): Promise<void>;
  log(line: string): void;
}

export function answerKey(dataset: string, questionId: string, strategy: string): string {
  return `${dataset}\u0000${questionId}\u0000${strategy}`;
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
  record: (probe: Probe) => void
): RunMiddleware {
  return {
    name: 'memory-bench-probe',
    wrapModelCall(call, next) {
      record({
        messages: call.request.messages.length,
        tokens: countMessagesTokens(call.request.messages),
        ...(evidence?.length && { recall: evidenceRecall(evidence, call.request.messages) }),
      });
      return next(call);
    },
  };
}

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
  });
}

/** Puts `conversation` into the memory of `cog` as one thread, returning its id. */
export async function ingest(
  cog: Cogitator,
  agent: Agent,
  conversation: BenchConversation
): Promise<string> {
  const memory = await cog.getMemory();
  if (!memory) throw new Error('The bench runtime has no memory');
  const threadId = `bench:${conversation.dataset}:${conversation.id}`;
  const created = await memory.createThread(agent.id, { bench: conversation.dataset }, threadId);
  if (!created.success) throw new Error(`Thread ${threadId}: ${created.error}`);
  const start = conversation.turns[0]?.at?.getTime() ?? Date.UTC(2023, 0, 1);
  for (const [index, turn] of conversation.turns.entries()) {
    const added = await memory.addEntry({
      threadId,
      message: { role: turn.role, content: turn.content },
      tokenCount: countTokens(turn.content),
      createdAt: new Date(Math.max(turn.at?.getTime() ?? 0, start) + index),
    });
    if (!added.success) throw new Error(`Entry ${index} of ${threadId}: ${added.error}`);
  }
  return threadId;
}

/**
 * Answers the questions of `conversation` from memory: the conversation goes into a thread
 * once, then each question runs as its own turn that is not saved, so questions do not see each
 * other. Every answer records the tokens, cost and time of its run, what reached the model and
 * how much of the marked evidence did. An answer whose context lost a part to a memory error
 * (the embeddings failed, so the strategy fell back to the newest turns) is marked failed: it
 * did not measure the strategy.
 */
export async function answerConversation(
  conversation: BenchConversation,
  options: AnswerOptions
): Promise<void> {
  const pending = conversation.questions.filter(
    (question) =>
      !options.done.has(answerKey(conversation.dataset, question.id, options.strategy.name))
  );
  if (pending.length === 0) return;

  const cog = benchRuntime(options);
  const agent = benchAgent();
  try {
    const threadId = await ingest(cog, agent, conversation);
    if (options.embedding) {
      await options.embedding.embedBatch(
        conversation.turns.slice(-SCORED_ENTRIES).map((turn) => turn.content)
      );
    }
    await mapConcurrent(pending, options.concurrency, async (question) => {
      const estimate = callCost(
        options.strategy.contextTokens + countTokens(question.question),
        1500
      );
      const release = options.budget.reserve(estimate);
      let seen: Probe | undefined;
      const memoryErrors: string[] = [];
      const base = {
        dataset: conversation.dataset,
        conversationId: conversation.id,
        questionId: question.id,
        category: question.category,
        strategy: options.strategy.name,
      };
      try {
        const result = await cog.run(benchAgent(answerInstructions(conversation, question)), {
          input: question.question,
          threadId,
          saveHistory: false,
          middleware: [probe(question.evidence, (value) => (seen = value))],
          onMemoryError: (error) => memoryErrors.push(error.message),
        });
        const llmMs = result.trace.spans
          .filter((span) => span.name === 'llm.chat')
          .reduce((sum, span) => sum + span.duration, 0);
        const costUsd =
          result.usage.inputTokens > LONG_PROMPT_TOKENS
            ? callCost(result.usage.inputTokens, result.usage.outputTokens)
            : result.usage.cost;
        options.budget.charge('answers', costUsd);
        await options.onAnswer({
          ...base,
          output: result.output,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens ?? 0,
          costUsd,
          durationMs: result.usage.duration,
          contextMs: Math.max(result.usage.duration - llmMs, 0),
          contextMessages: seen?.messages ?? 0,
          contextTokens: seen?.tokens ?? 0,
          ...(seen?.recall !== undefined && { evidenceRecall: seen.recall }),
          ...(memoryErrors.length > 0 && {
            error: `memory: ${memoryErrors.join('; ')} (the strategy fell back)`,
          }),
        });
      } catch (error) {
        options.log(`  ${question.id}: ${error instanceof Error ? error.message : String(error)}`);
        await options.onAnswer({
          ...base,
          output: '',
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd: 0,
          durationMs: 0,
          contextMs: 0,
          contextMessages: 0,
          contextTokens: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        release();
      }
    });
  } finally {
    await cog.close();
  }
}
