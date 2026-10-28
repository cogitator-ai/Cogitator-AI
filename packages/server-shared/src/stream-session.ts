import type {
  DelegatedRunStart,
  DelegatedRunStream,
  RunOptions,
  RunResult,
} from '@cogitator-ai/types';
import { INTERNAL_ERROR, describeHttpError } from './contract.js';
import { generateId } from './helpers.js';
import { createJsonPatch } from './json-patch.js';
import {
  createApprovalRequiredEvent,
  createDataEvent,
  createResetStepEvent,
  createStateDeltaEvent,
  createStateSnapshotEvent,
  createErrorEvent,
  createFinishEvent,
  createInterruptRequiredEvent,
  createReasoningDeltaEvent,
  createReasoningEndEvent,
  createReasoningStartEvent,
  createStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createTextStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolCallStartEvent,
  createToolResultEvent,
  createToolUpdateEvent,
  createToolDroppedEvent,
  type StreamEvent,
} from './protocol.js';
import { toAgentRunOutcome, toPendingApprovals, toPendingInterrupts } from './response.js';

/** The run callbacks through which a streamed agent run reaches its client */
export type AgentStreamCallbacks = Required<
  Pick<
    RunOptions,
    | 'onToken'
    | 'onReasoning'
    | 'onToolCall'
    | 'onToolResult'
    | 'onToolUpdate'
    | 'onToolInputStart'
    | 'onToolInputDelta'
    | 'onToolInputAvailable'
    | 'onToolInputAbandoned'
    | 'onData'
    | 'onState'
  >
> &
  Pick<RunOptions, 'onDelegatedRun' | 'onStepReset'>;

export interface AgentStreamSessionOptions {
  /**
   * The thread the request named. Without one the session opens a new thread, announced in
   * the `start` event, so a client that loses the stream still knows where to continue.
   */
  threadId?: string;
  /**
   * Streams the runs the run delegates (subagents, agents used as tools): for each one it is
   * told of, the function its events go out through, or undefined to leave it out. A delegated
   * run gets a session of its own, with its own `start`, parts and `finish` (or `error`), and the
   * runs it delegates in turn come here too, each tagged by its own parent call. With it set,
   * `callbacks` carry `onDelegatedRun`. A background run may stream after this run finished
   */
  delegated?: (start: DelegatedRunStart) => ((event: StreamEvent) => void) | undefined;
  /**
   * Whether a step the model streamed may start over, announced by `reset-step` (default false):
   * the callbacks then carry `onStepReset`, so a model that fails mid-answer moves on to the next
   * of the agent's `fallbackModels` instead of failing the run. Turn it on only for a client that
   * takes back what a `reset-step` names, such as `useCogitatorChat`: any other shows the text of
   * the failed step before the new one
   */
  resetSteps?: boolean;
  /**
   * The state the client already holds, the run's `state`: the first change a tool makes goes
   * out as a `state-delta` on it. Without one the first change is a `state-snapshot`
   */
  state?: unknown;
}

type PartKind = 'text' | 'reasoning';

const PART_EVENTS = {
  text: {
    prefix: 'txt',
    start: createTextStartEvent,
    delta: createTextDeltaEvent,
    end: createTextEndEvent,
  },
  reasoning: {
    prefix: 'rsn',
    start: createReasoningStartEvent,
    delta: createReasoningDeltaEvent,
    end: createReasoningEndEvent,
  },
} as const;

/** A thread id nobody can guess, since a thread without an owner is open to whoever names it */
export function createThreadId(): string {
  return `thread_${globalThis.crypto.randomUUID()}`;
}

/**
 * The events of one streamed agent run or resume, the same in every adapter.
 *
 * `start` announces the message and the thread. Text and reasoning arrive as parts: a part
 * opens with its first delta and closes before anything else is sent, so a client never sees
 * two parts open at once, and a tool call never lands inside a text part. `complete` sends
 * what the run did not stream (an answer the model gave in one piece), the approvals or the
 * questions (`interrupt-required`) a paused run waits on, and `finish` with the usage, the thread and how the run ended. `fail` closes
 * the open part and sends `error`.
 *
 * A tool call goes out as `tool-call-start`, `tool-call-delta` and `tool-call-end`. In a streamed
 * run they follow the model as it writes the call, the deltas carrying its JSON arguments piece by
 * piece and the end coming as soon as the call is complete, so calls do not interleave, else
 * they all go out once the call is about to run, the arguments in one delta. A call that will
 * never run (the model never finished it, or the run did not keep it) gets a `tool-result` with
 * `dropped`, after a `tool-call-end` with `dropped` when its end had not gone out yet, also when
 * the stream ends. `tool-update` carries what a running tool reported, `tool-result` what it
 * returned.
 *
 * `data` carries a data part a tool sent (`context.data()`), replaced in place by a later one
 * with its id. The run's state (`context.state`) goes out as a `state-snapshot` when the client
 * holds none (`options.state`), then as `state-delta` JSON Patches. With `resetSteps`, when a step
 * the model streamed starts over (a fallback model takes over mid-answer, an empty answer is asked
 * again), `reset-step` names its parts and tool calls for the client to take back.
 *
 * Pass the thread to the run (`threadId: session.threadId`) and spread `callbacks` into its
 * options together with `stream: true`.
 */
export class AgentStreamSession {
  readonly messageId = generateId('msg');
  readonly threadId: string;
  readonly callbacks: AgentStreamCallbacks;

  private open: { kind: PartKind; id: string } | undefined;
  /** The argument text each streamed call sent, by id */
  private readonly streamedArguments = new Map<string, string>();
  /** Tool calls announced, by id: written, ended, running (or about to), dropped or settled */
  private readonly toolCalls = new Map<
    string,
    'open' | 'ended' | 'running' | 'dropped' | 'settled'
  >();
  private streamedText = false;
  private streamedReasoning = false;
  /** What the step the model streams now sent: its text and reasoning parts and tool calls */
  private step: { parts: string[]; toolCalls: string[] } = { parts: [], toolCalls: [] };
  private state: { known: boolean; value: unknown };

  constructor(
    private readonly emit: (event: StreamEvent) => void,
    options: AgentStreamSessionOptions = {}
  ) {
    this.threadId = options.threadId ?? createThreadId();
    this.state = {
      known: options.state !== undefined,
      value: options.state === undefined ? undefined : structuredClone(options.state),
    };
    const delegated = options.delegated;
    const resetSteps = options.resetSteps === true;
    this.callbacks = {
      ...(delegated && {
        onDelegatedRun: (start: DelegatedRunStart) =>
          delegatedRunStream(start, delegated, resetSteps),
      }),
      ...(resetSteps && { onStepReset: () => this.resetStep() }),
      onData: (part) => {
        this.endPart();
        this.emit(createDataEvent(part));
      },
      onState: (state) => this.changeState(state),
      onToken: (token) => {
        if (!token) return;
        this.streamedText = true;
        this.delta('text', token);
      },
      onReasoning: (delta) => {
        if (!delta) return;
        this.streamedReasoning = true;
        this.delta('reasoning', delta);
      },
      onToolInputStart: ({ toolCallId, toolName }) => {
        if (this.toolCalls.has(toolCallId)) return;
        this.endPart();
        this.toolCalls.set(toolCallId, 'open');
        this.step.toolCalls.push(toolCallId);
        this.emit(createToolCallStartEvent(toolCallId, toolName));
      },
      onToolInputDelta: ({ toolCallId, delta }) => {
        if (this.toolCalls.get(toolCallId) !== 'open' || !delta) return;
        this.streamedArguments.set(
          toolCallId,
          `${this.streamedArguments.get(toolCallId) ?? ''}${delta}`
        );
        this.emit(createToolCallDeltaEvent(toolCallId, delta));
      },
      onToolInputAvailable: ({ toolCallId }) => this.endToolCall(toolCallId),
      onToolInputAbandoned: ({ toolCallId, reason }) => this.dropToolCall(toolCallId, reason),
      onToolCall: (call) => {
        this.endStep();
        const state = this.toolCalls.get(call.id);
        if (state === undefined || state === 'dropped') {
          this.endPart();
          this.emit(createToolCallStartEvent(call.id, call.name));
          this.emit(createToolCallDeltaEvent(call.id, JSON.stringify(call.arguments)));
          this.emit(createToolCallEndEvent(call.id));
        } else {
          this.endToolCall(call.id);
          if (!streamedAs(this.streamedArguments.get(call.id), call.arguments)) {
            this.emit(createToolUpdateEvent(call.id, { arguments: call.arguments }));
          }
        }
        this.streamedArguments.delete(call.id);
        if (state !== 'settled') this.toolCalls.set(call.id, 'running');
      },
      onToolUpdate: (update) => {
        this.endPart();
        this.emit(createToolUpdateEvent(update.callId, update));
      },
      onToolResult: (toolResult) => {
        this.endStep();
        this.toolCalls.set(toolResult.callId, 'settled');
        this.emit(
          createToolResultEvent(generateId('res'), toolResult.callId, toolResult.result, {
            details: toolResult.details,
            presentation: toolResult.presentation,
          })
        );
      },
    };
  }

  start(): void {
    this.emit(createStartEvent(this.messageId, this.threadId));
  }

  complete(result: RunResult): void {
    if (!this.streamedReasoning && result.reasoning) this.delta('reasoning', result.reasoning);
    if (!this.streamedText && result.output) this.delta('text', result.output);
    this.endPart();
    this.endToolCalls();
    if (result.status === 'paused') {
      const interrupts = toPendingInterrupts(result.interrupts ?? []);
      this.emit(
        interrupts.length > 0
          ? createInterruptRequiredEvent(result.threadId, interrupts)
          : createApprovalRequiredEvent(
              result.threadId,
              toPendingApprovals(result.pendingApprovals ?? [])
            )
      );
    }
    this.emit(
      createFinishEvent(this.messageId, result.usage, {
        threadId: result.threadId,
        ...toAgentRunOutcome(result),
      })
    );
  }

  fail(message: string, code?: string): void {
    this.endPart();
    this.endToolCalls();
    this.emit(createErrorEvent(message, code));
  }

  /** The step the model streamed is over: what it sent stays */
  private endStep(): void {
    this.step = { parts: [], toolCalls: [] };
  }

  /** The step the model streamed starts over: what it sent is taken back */
  private resetStep(): void {
    this.endPart();
    const { parts, toolCalls } = this.step;
    this.step = { parts: [], toolCalls: [] };
    for (const id of toolCalls) {
      this.toolCalls.delete(id);
      this.streamedArguments.delete(id);
    }
    this.emit(createResetStepEvent(parts, toolCalls));
  }

  /**
   * Sends how the run's state changed. The session keeps a copy of each state it sent, so a tool
   * that changes the state object in place and sets it again still gets its changes out
   */
  private changeState(state: unknown): void {
    const previous = this.state;
    const next = structuredClone(state);
    this.state = { known: true, value: next };
    if (!previous.known) {
      this.emit(createStateSnapshotEvent(next));
      return;
    }
    const delta = createJsonPatch(previous.value, next);
    if (delta.length > 0) this.emit(createStateDeltaEvent(delta));
  }

  private endToolCall(id: string): void {
    if (this.toolCalls.get(id) !== 'open') return;
    this.toolCalls.set(id, 'ended');
    this.emit(createToolCallEndEvent(id));
  }

  /** Closes a call that will never run: its end with `dropped` if it was still open, its result */
  private dropToolCall(id: string, reason: 'incomplete' | 'discarded'): void {
    const state = this.toolCalls.get(id);
    if (state !== 'open' && state !== 'ended') return;
    if (state === 'open') this.emit(createToolCallEndEvent(id, true));
    this.toolCalls.set(id, 'dropped');
    this.emit(createToolDroppedEvent(generateId('res'), id, reason));
  }

  /** Drops the calls the stream announced that never came to run */
  private endToolCalls(): void {
    for (const [id, state] of this.toolCalls) {
      if (state === 'open') this.dropToolCall(id, 'incomplete');
      else if (state === 'ended') this.dropToolCall(id, 'discarded');
    }
  }

  private delta(kind: PartKind, delta: string): void {
    const part = PART_EVENTS[kind];
    if (this.open?.kind !== kind) {
      this.endPart();
      this.open = { kind, id: generateId(part.prefix) };
      this.step.parts.push(this.open.id);
      this.emit(part.start(this.open.id));
    }
    this.emit(part.delta(this.open.id, delta));
  }

  private endPart(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    this.emit(PART_EVENTS[open.kind].end(open.id));
  }
}

/**
 * The callbacks of a run delegated with `start`, streamed through what `delegated` gives for it
 * by a session of its own: opened as the run starts (or, for a resumed run, with its first
 * event), finished with its result or failed with its error
 */
function delegatedRunStream(
  start: DelegatedRunStart,
  delegated: NonNullable<AgentStreamSessionOptions['delegated']>,
  resetSteps: boolean
): DelegatedRunStream | undefined {
  const emit = delegated(start);
  if (!emit) return undefined;
  let session: AgentStreamSession | undefined;
  const open = (threadId = start.threadId): AgentStreamSession => {
    if (session) return session;
    session = new AgentStreamSession(emit, {
      ...(threadId !== undefined && { threadId }),
      delegated,
      resetSteps,
    });
    session.start();
    return session;
  };
  const callbacks = (): AgentStreamCallbacks => open().callbacks;
  return {
    onToken: (token) => callbacks().onToken(token),
    onReasoning: (delta) => callbacks().onReasoning(delta),
    onToolCall: (call) => callbacks().onToolCall(call),
    onToolResult: (result) => callbacks().onToolResult(result),
    onToolUpdate: (update) => callbacks().onToolUpdate(update),
    onToolInputStart: (event) => callbacks().onToolInputStart(event),
    onToolInputDelta: (event) => callbacks().onToolInputDelta(event),
    onToolInputAvailable: (event) => callbacks().onToolInputAvailable(event),
    onToolInputAbandoned: (event) => callbacks().onToolInputAbandoned(event),
    onData: (part) => callbacks().onData(part),
    ...(resetSteps && { onStepReset: (reset) => callbacks().onStepReset?.(reset) }),
    onDelegatedRun: (child) => delegatedRunStream(child, delegated, resetSteps),
    onRunStart: ({ threadId }) => {
      open(threadId);
    },
    onRunComplete: (result) => open(result.threadId).complete(result),
    onRunError: (error) => {
      const described = describeHttpError(error) ?? INTERNAL_ERROR;
      open().fail(described.message, described.code);
    },
  };
}

/** Whether the argument text a call streamed reads as `args`, keys in any order */
function streamedAs(text: string | undefined, args: Record<string, unknown>): boolean {
  let streamed: unknown;
  try {
    streamed = text === undefined || text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return false;
  }
  return canonicalJson(streamed) === canonicalJson(args);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        )
      : inner
  );
}
