import type {
  KeptModelTurn,
  MemoryAdapter,
  MemoryEntry,
  MemoryResult,
  Message,
  RunMemoryPlace,
  RunMiddleware,
  Tool,
  ToolInvocationAgent,
  ToolInvoker,
} from '@cogitator-ai/types';
import { AsyncQueue } from './async-queue.js';
import { DEFAULT_SETTLE_TIMEOUT, bounded } from './timing.js';
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
  /** Always false: the runner keeps what was spoken of an interrupted answer itself */
  saveInterruptedReply?: boolean;
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
  readonly name?: string;
  readonly model?: string;
  readonly tools?: readonly Tool[];
  readonly config?: { readonly middleware?: readonly RunMiddleware[] };
}

export interface CogitatorRunnerOptions {
  /**
   * Thread id used for agent memory. Defaults to `voice:<sessionId>` so each voice
   * session keeps its own conversation history.
   */
  threadId?: (context: VoiceRunContext) => string;
  /**
   * Longest a streamed turn's run waits for what the run before it in its thread does after it
   * saved its answer (`afterRun` hooks, reflection), in ms (default 10 000, as
   * `VoicePipelineConfig.settleTimeout`). It always waits for that answer to be saved first.
   */
  tailTimeout?: number;
}

/** Metadata of the assistant message that keeps the spoken part of an interrupted answer */
const INTERRUPTED = { interrupted: true } as const;

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

/**
 * Keeps the streamed turns of each thread in order: their settles run one after another, and a
 * run starts once the runs before it for its thread saved their answers (or ended) and the
 * settles queued for the thread are done. It also waits for the rest of those runs (`afterRun`
 * hooks, reflection), at most `tailTimeout` ms, so the runs of a thread overlap only when such a
 * tail takes longer than that
 */
class ThreadLanes {
  private readonly settles = new Map<string, Promise<void>>();
  private readonly answers = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<void>>();

  constructor(private readonly tailTimeout: number) {}

  /** Queues `task` after the settles of `threadId` queued before it */
  settle(threadId: string, task: () => Promise<void>): Promise<void> {
    const done = (this.settles.get(threadId) ?? Promise.resolve()).then(task);
    this.keep(
      this.settles,
      threadId,
      done.catch(() => undefined)
    );
    return done;
  }

  /** Resolves once the thread may take its next run, see the class */
  idle(threadId: string): Promise<void> {
    const runs = this.runs.get(threadId);
    return Promise.all([this.answers.get(threadId), this.settles.get(threadId)]).then(() =>
      runs ? bounded(runs, this.tailTimeout) : undefined
    );
  }

  /**
   * Records a run of `threadId` that saved its answer (or ended) when `answered` resolves and
   * ended when `finished` resolves. Neither rejects
   */
  run(threadId: string, answered: Promise<void>, finished: Promise<void>): void {
    this.keep(
      this.answers,
      threadId,
      Promise.all([this.answers.get(threadId), answered]).then(() => undefined)
    );
    this.keep(
      this.runs,
      threadId,
      Promise.all([this.runs.get(threadId), finished]).then(() => undefined)
    );
  }

  private keep(tails: Map<string, Promise<void>>, threadId: string, tail: Promise<void>): void {
    tails.set(threadId, tail);
    void tail.then(() => {
      if (tails.get(threadId) === tail) tails.delete(threadId);
    });
  }
}

/** Resolves with `promise`, or rejects with the abort reason once `signal` aborts first */
function unlessAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The voice turn was aborted');
}

/** The agent as `invokeTool` takes it, when it names itself like a Cogitator `Agent` does */
function invocationAgent(agent: CogitatorRunnerAgent): ToolInvocationAgent | undefined {
  if (agent.id === undefined || agent.name === undefined) return undefined;
  return {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    config: { ...(agent.config?.middleware && { middleware: agent.config.middleware }) },
  };
}

/**
 * Adapt a Cogitator runtime + agent to the `VoiceAgentRunner` interface used by
 * `VoicePipeline` and `VoiceAgent`.
 *
 * `stream` runs the agent with `stream: true`, so a `PipelineSession` speaks the answer while it
 * is generated. The stream ends with the final model turn, its value the answer `run` returns,
 * and text the model says before a tool call ends with a line break so it is spoken on its own.
 * When such a turn is interrupted, the thread keeps only what was spoken: the answer's assistant
 * message is replaced by its spoken part, marked `metadata.interrupted`, or removed when none of
 * it was spoken, and a run stopped before it saved an answer gets its spoken part saved after it.
 * Text the model said alongside tool calls stays as the run saved it. A turn that completes and
 * is spoken in full leaves the thread as `run` does. The rewrite happens only while the run's
 * last entry is still the thread's active leaf: when something else wrote to the thread after
 * it, the thread is left as it is. The thread is fixed as soon as the run saved its answer, and
 * a streamed turn's run starts after the runs before it for its thread saved their answers and
 * their settles are done, and after the rest of those runs, waited for at most `tailTimeout`. Keeping the thread needs a runtime with `getMemory()`, as a
 * `Cogitator` has.
 *
 * `realtimeTools` gives a realtime `VoiceAgent` the agent's tools, run through
 * `cogitator.invokeTool` with the agent (approvals, its guardrails and middleware, the sandbox),
 * with the same thread id the runs of the session use. A runtime without `invokeTool` gets none.
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
  const tailTimeout = options.tailTimeout ?? DEFAULT_SETTLE_TIMEOUT;
  if (!(tailTimeout >= 0)) {
    throw new RangeError(`tailTimeout must be 0 or more, got ${String(options.tailTimeout)}`);
  }
  const lanes = new ThreadLanes(tailTimeout);
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
      return new CogitatorVoiceTurn(
        cogitator,
        agent,
        input,
        resolveThreadId(context),
        context,
        lanes
      );
    },
  };

  const invokeTool = cogitator.invokeTool;
  if (invokeTool) {
    const invoker: ToolInvoker = {
      invokeTool: (tool, args, invocation) => invokeTool.call(cogitator, tool, args, invocation),
    };
    const owner = invocationAgent(agent);
    runner.realtimeTools = (toolOptions = {}) =>
      createRealtimeTools(invoker, agent.tools ?? [], {
        ...(agent.id !== undefined && { agentId: agent.id }),
        ...(owner && { agent: owner }),
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
  private readonly tokens = new AsyncQueue<string, string>(() =>
    this.controller.abort(new Error('The voice turn stopped reading the answer'))
  );
  private readonly entries: MemoryEntry[] = [];
  private streamed = '';
  private answerStart = 0;
  private finished: Promise<void> | undefined;
  private failure: Error | undefined;
  private failureDelivered = false;
  private settled: Promise<void> | undefined;
  private answerSaved!: () => void;
  /** Resolves once the run saved its final answer: what `settle` needs, before the run's tail */
  private readonly answered = new Promise<void>((resolve) => {
    this.answerSaved = resolve;
  });

  constructor(
    private readonly cogitator: CogitatorLike<TAgent>,
    private readonly agent: TAgent,
    private readonly input: string,
    private readonly threadId: string,
    private readonly context: VoiceRunContext,
    private readonly lanes: ThreadLanes
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<string, string | undefined, undefined> {
    this.start();
    return this.tokens;
  }

  settle(outcome: VoiceTurnOutcome): Promise<void> {
    this.settled ??= this.settleOnce(outcome);
    return this.settled;
  }

  /**
   * Fixes the thread as soon as the run saved its answer (or ended without one), not after what
   * the run does afterwards (`afterRun` hooks, reflection), then waits for the run to end and
   * reports a failure the stream did not deliver
   */
  private async settleOnce(outcome: VoiceTurnOutcome): Promise<void> {
    const finished = this.finished;
    if (!finished) return;
    if (outcome.interrupted) {
      const ready = Promise.race([this.answered, finished]);
      await this.lanes.settle(this.threadId, async () => {
        await ready;
        await this.keepSpoken(outcome.spoken);
      });
    }
    await finished;
    if (this.failure && !this.failureDelivered && !this.controller.signal.aborted) {
      throw this.failure;
    }
  }

  private start(): void {
    if (this.finished) return;
    const { signal } = this.context;
    const forwardAbort = () => this.controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });

    const turnsBefore = this.lanes.idle(this.threadId);
    this.finished = unlessAborted(turnsBefore, this.controller.signal)
      .then(() =>
        this.cogitator.run(this.agent, {
          input: this.input,
          threadId: this.threadId,
          signal: this.controller.signal,
          stream: true,
          saveInterruptedReply: false,
          onToken: (token) => this.say(token),
          onModelTurn: (turn) => {
            if (turn.toolCalls.length > 0) {
              if (this.streamed.length > 0 && !this.streamed.endsWith('\n')) this.say('\n');
              this.answerStart = this.streamed.length;
              return;
            }
            this.endAnswer(turn.content);
          },
          onMemoryEntry: (entry) => {
            if (entry.threadId !== this.threadId) return;
            this.entries.push(entry);
            if (isAnswer(entry)) this.answerSaved();
          },
        })
      )
      .then(
        (result) => this.endRun(result.output),
        (error: unknown) => {
          this.failure = error instanceof Error ? error : new Error(String(error));
          if (this.tokens.ended) return;
          this.failureDelivered = true;
          this.tokens.fail(this.failure);
        }
      )
      .finally(() => signal?.removeEventListener('abort', forwardAbort));
    this.lanes.run(this.threadId, Promise.race([this.answered, this.finished]), this.finished);
  }

  private say(text: string): void {
    if (text.length === 0 || this.tokens.ended) return;
    this.streamed += text;
    this.tokens.push(text);
  }

  /** The final model turn: ends the stream with its text, said at once when none of it streamed */
  private endAnswer(answer: string): void {
    if (this.tokens.ended) return;
    if (this.streamed.length === this.answerStart) this.say(answer);
    this.tokens.end(answer);
  }

  /**
   * The run ended without a final model turn the stream saw (a paused run, an iteration limit,
   * a runtime that does not stream): end the stream with its output, said only when nothing was
   * streamed at all, since otherwise it was already said
   */
  private endRun(output: string): void {
    if (this.tokens.ended) return;
    if (this.streamed.length === 0) this.say(output);
    this.tokens.end(output);
  }

  private async keepSpoken(spoken: string): Promise<void> {
    const said = spoken.length > this.answerStart ? spoken.slice(this.answerStart).trim() : '';
    const memory = await this.cogitator.getMemory?.();
    if (!memory) return;

    const answer = [...this.entries].reverse().find(isAnswer);
    if (answer) {
      if (said !== textOf(answer.message).trim()) await this.replaceAnswer(memory, answer, said);
      return;
    }
    const last = this.entries.at(-1);
    if (last && said.length > 0) await this.appendSpoken(memory, last, said);
  }

  /**
   * The run saved its whole answer: put its spoken part in its place, or remove it when none
   * was spoken. The new entry is added after the answer, as the thread's next entry, then the
   * answer is spliced out, so a write that came in between is never hidden
   */
  private async replaceAnswer(
    memory: MemoryAdapter,
    answer: MemoryEntry,
    said: string
  ): Promise<void> {
    if (!(await isActiveLeaf(memory, answer))) return;
    if (said.length > 0) {
      const added = await addSpoken(memory, answer.threadId, said, answer.metadata);
      if (added.parentId !== answer.id) {
        unwrap(await memory.deleteEntry(added.id), 'undo the spoken part of the answer');
        return;
      }
    }
    unwrap(await memory.deleteEntry(answer.id), 'remove the unspoken answer');
  }

  /** The run saved no answer: save its spoken part after the run's last entry */
  private async appendSpoken(
    memory: MemoryAdapter,
    last: MemoryEntry,
    said: string
  ): Promise<void> {
    if (!(await isActiveLeaf(memory, last))) return;
    const added = await addSpoken(memory, last.threadId, said);
    if (added.parentId !== last.id) {
      unwrap(await memory.deleteEntry(added.id), 'undo the spoken part of the answer');
    }
  }
}

async function isActiveLeaf(memory: MemoryAdapter, entry: MemoryEntry): Promise<boolean> {
  const thread = unwrap(await memory.getThread(entry.threadId), 'read the thread');
  return thread?.activeLeafId === entry.id;
}

/** Adds the spoken part after the thread's active leaf, marked as interrupted */
async function addSpoken(
  memory: MemoryAdapter,
  threadId: string,
  said: string,
  metadata?: Record<string, unknown>
): Promise<MemoryEntry> {
  return unwrap(
    await memory.addEntry({
      threadId,
      message: { role: 'assistant', content: said },
      tokenCount: messageTokens(said),
      metadata: { ...metadata, ...INTERRUPTED },
    }),
    'save the spoken part of the answer'
  );
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
