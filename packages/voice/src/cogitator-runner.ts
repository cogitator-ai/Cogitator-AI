import type {
  KeptModelTurn,
  MemoryAdapter,
  MemoryEntry,
  MemoryResult,
  Message,
  RunMemoryPlace,
  Tool,
  ToolInvoker,
} from '@cogitator-ai/types';
import { AsyncQueue } from './async-queue.js';
import { createRealtimeTools } from './realtime/cogitator-tools.js';
import type {
  RealtimeToolContext,
  VoiceAgentRunner,
  VoiceRunContext,
  VoiceTurn,
  VoiceTurnOutcome,
} from './types.js';

/** The options `createCogitatorRunner` passes to `cogitator.run`. */
export interface CogitatorRunnerRunOptions {
  input: string;
  threadId?: string;
  signal?: AbortSignal;
  stream?: boolean;
  onToken?: (token: string) => void;
  onModelTurn?: (turn: KeptModelTurn) => void;
  onMemoryEntry?: (entry: MemoryEntry) => void;
}

export interface CogitatorLike<TAgent> {
  run(
    agent: TAgent,
    options: CogitatorRunnerRunOptions
  ): Promise<{ readonly output: string; readonly memory?: RunMemoryPlace }>;
  /** Lets a streamed turn keep only what was spoken in the thread when it is interrupted */
  getMemory?(): Promise<MemoryAdapter | undefined>;
  /** Lets the runner offer the agent's tools to a realtime session (`realtimeTools`) */
  invokeTool?: ToolInvoker['invokeTool'];
}

/** What `createCogitatorRunner` reads from an agent: a Cogitator `Agent` has all of it. */
export interface CogitatorRunnerAgent {
  readonly instructions?: string;
  readonly id?: string;
  readonly tools?: readonly Tool[];
}

export interface CogitatorRunnerOptions {
  /**
   * Thread id used for agent memory. Defaults to `voice:<sessionId>` so each voice
   * session keeps its own conversation history.
   */
  threadId?: (context: VoiceRunContext) => string;
}

/** Metadata of the assistant message that keeps the spoken part of an interrupted answer */
const INTERRUPTED = { interrupted: true } as const;

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

/**
 * Adapt a Cogitator runtime + agent to the `VoiceAgentRunner` interface used by
 * `VoicePipeline` and `VoiceAgent`.
 *
 * `stream` runs the agent with `stream: true`, so a `PipelineSession` speaks the answer while it
 * is generated. When such a turn is interrupted, the thread keeps only what was spoken: the
 * answer's assistant message is replaced by its spoken part, marked `metadata.interrupted`, or
 * removed when none of it was spoken, and a run stopped mid-answer gets its spoken part saved
 * after it. Text the model said alongside tool calls stays as the run saved it. A turn that
 * completes and is spoken in full leaves the thread as `run` does. Keeping the thread needs a
 * runtime with `getMemory()`, as a `Cogitator` has.
 *
 * `realtimeTools` gives a realtime `VoiceAgent` the agent's tools, run through
 * `cogitator.invokeTool` (approvals, guardrails, the sandbox), with the same thread id the runs
 * of the session use.
 *
 * @example
 * ```ts
 * const voice = new VoiceAgent({
 *   mode: 'pipeline',
 *   agent: createCogitatorRunner(cogitator, agent),
 *   stt, tts,
 * });
 * ```
 */
export function createCogitatorRunner<TAgent extends CogitatorRunnerAgent>(
  cogitator: CogitatorLike<TAgent>,
  agent: TAgent,
  options: CogitatorRunnerOptions = {}
): VoiceAgentRunner {
  const resolveThreadId = options.threadId ?? ((ctx: VoiceRunContext) => `voice:${ctx.sessionId}`);
  const runner: VoiceAgentRunner = {
    instructions: agent.instructions,
    async run(input, context) {
      const result = await cogitator.run(agent, {
        input,
        ...(context && { threadId: resolveThreadId(context) }),
        ...(context?.signal && { signal: context.signal }),
      });
      return { content: result.output };
    },
    stream(input, context) {
      return new CogitatorVoiceTurn(cogitator, agent, input, resolveThreadId(context), context);
    },
  };

  const invokeTool = cogitator.invokeTool;
  if (invokeTool) {
    const invoker: ToolInvoker = {
      invokeTool: (tool, args, invocation) => invokeTool.call(cogitator, tool, args, invocation),
    };
    runner.realtimeTools = (toolOptions = {}) =>
      createRealtimeTools(invoker, agent.tools ?? [], {
        ...(agent.id !== undefined && { agentId: agent.id }),
        threadId: (ctx: RealtimeToolContext) =>
          ctx.sessionId === undefined ? undefined : resolveThreadId({ sessionId: ctx.sessionId }),
        ...toolOptions,
      });
  }

  return runner;
}

/**
 * One streamed run of the agent: its tokens as an async iterator, and the run's entries, so
 * `settle` can make the thread hold what was spoken.
 */
class CogitatorVoiceTurn<TAgent> implements VoiceTurn {
  private readonly controller = new AbortController();
  private readonly tokens = new AsyncQueue<string>(() =>
    this.controller.abort(new Error('The voice turn stopped reading the answer'))
  );
  private readonly entries: MemoryEntry[] = [];
  private streamed = '';
  private answerStart = 0;
  private completed = false;
  private finished: Promise<void> | undefined;

  constructor(
    private readonly cogitator: CogitatorLike<TAgent>,
    private readonly agent: TAgent,
    private readonly input: string,
    private readonly threadId: string,
    private readonly context: VoiceRunContext
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<string> {
    this.start();
    return this.tokens;
  }

  async settle(outcome: VoiceTurnOutcome): Promise<void> {
    if (!this.finished) return;
    await this.finished;
    if (!outcome.interrupted) return;

    const spoken =
      outcome.spoken.length > this.answerStart ? outcome.spoken.slice(this.answerStart).trim() : '';
    const memory = await this.cogitator.getMemory?.();
    if (!memory) return;

    if (this.completed) await this.keepSpokenAnswer(memory, spoken);
    else if (spoken.length > 0) await this.saveSpokenPart(memory, spoken);
  }

  private start(): void {
    if (this.finished) return;
    const { signal } = this.context;
    const forwardAbort = () => this.controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });

    this.finished = this.cogitator
      .run(this.agent, {
        input: this.input,
        threadId: this.threadId,
        signal: this.controller.signal,
        stream: true,
        onToken: (token) => {
          if (token.length === 0) return;
          this.streamed += token;
          this.tokens.push(token);
        },
        onModelTurn: (turn) => {
          if (turn.toolCalls.length > 0) this.answerStart = this.streamed.length;
        },
        onMemoryEntry: (entry) => {
          if (entry.threadId === this.threadId) this.entries.push(entry);
        },
      })
      .then(
        (result) => {
          this.completed = true;
          if (this.streamed.length === 0 && result.output.length > 0) {
            this.streamed = result.output;
            this.tokens.push(result.output);
          }
          this.tokens.end();
        },
        (error: unknown) => {
          this.tokens.fail(error instanceof Error ? error : new Error(String(error)));
        }
      )
      .finally(() => signal?.removeEventListener('abort', forwardAbort));
  }

  /** A completed run saved its whole answer: keep its spoken part in its place, or nothing */
  private async keepSpokenAnswer(memory: MemoryAdapter, spoken: string): Promise<void> {
    const answer = [...this.entries].reverse().find(isAnswer);
    if (!answer) return;
    if (spoken === textOf(answer.message).trim()) return;

    if (spoken.length > 0) {
      const active = await this.isActiveLeaf(memory, answer);
      unwrap(
        await memory.addEntry({
          threadId: answer.threadId,
          message: { role: 'assistant', content: spoken },
          tokenCount: messageTokens(spoken),
          metadata: { ...answer.metadata, ...INTERRUPTED },
          parentId: answer.parentId ?? null,
          activate: active,
        }),
        'save the spoken part of the answer'
      );
    }
    unwrap(await memory.deleteEntry(answer.id), 'remove the unspoken answer');
  }

  /** A run stopped mid-answer saved none of it: save the spoken part after the run's entries */
  private async saveSpokenPart(memory: MemoryAdapter, spoken: string): Promise<void> {
    const last = this.entries.at(-1);
    if (!last) return;
    const active = await this.isActiveLeaf(memory, last);
    unwrap(
      await memory.addEntry({
        threadId: last.threadId,
        message: { role: 'assistant', content: spoken },
        tokenCount: messageTokens(spoken),
        metadata: { ...INTERRUPTED },
        parentId: last.id,
        activate: active,
      }),
      'save the spoken part of the answer'
    );
  }

  /**
   * Whether the thread still goes on from `entry`: when something else was written after it,
   * the spoken part goes on the run's branch without taking the thread's active leaf
   */
  private async isActiveLeaf(memory: MemoryAdapter, entry: MemoryEntry): Promise<boolean> {
    const thread = unwrap(await memory.getThread(entry.threadId), 'read the thread');
    return thread?.activeLeafId === entry.id;
  }
}

function isAnswer(entry: MemoryEntry): boolean {
  return (
    (entry.type ?? 'message') === 'message' &&
    entry.message.role === 'assistant' &&
    !entry.toolCalls?.length
  );
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function messageTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;
}

function unwrap<T>(result: MemoryResult<T>, action: string): T {
  if (!result.success) throw new Error(`Could not ${action}: ${result.error}`);
  return result.data;
}
