import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { generateId } from './helpers.js';
import {
  createApprovalRequiredEvent,
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
  >
>;

export interface AgentStreamSessionOptions {
  /**
   * The thread the request named. Without one the session opens a new thread, announced in
   * the `start` event, so a client that loses the stream still knows where to continue.
   */
  threadId?: string;
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
 * Pass the thread to the run (`threadId: session.threadId`) and spread `callbacks` into its
 * options together with `stream: true`.
 */
export class AgentStreamSession {
  readonly messageId = generateId('msg');
  readonly threadId: string;
  readonly callbacks: AgentStreamCallbacks;

  private open: { kind: PartKind; id: string } | undefined;
  /** Tool calls announced, by id: written, ended, running (or about to) or settled */
  private readonly toolCalls = new Map<string, 'open' | 'ended' | 'running' | 'settled'>();
  private streamedText = false;
  private streamedReasoning = false;

  constructor(
    private readonly emit: (event: StreamEvent) => void,
    options: AgentStreamSessionOptions = {}
  ) {
    this.threadId = options.threadId ?? createThreadId();
    this.callbacks = {
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
        this.emit(createToolCallStartEvent(toolCallId, toolName));
      },
      onToolInputDelta: ({ toolCallId, delta }) => {
        if (this.toolCalls.get(toolCallId) !== 'open' || !delta) return;
        this.emit(createToolCallDeltaEvent(toolCallId, delta));
      },
      onToolInputAvailable: ({ toolCallId }) => this.endToolCall(toolCallId),
      onToolInputAbandoned: ({ toolCallId, reason }) => this.dropToolCall(toolCallId, reason),
      onToolCall: (call) => {
        const state = this.toolCalls.get(call.id);
        if (state === undefined) {
          this.endPart();
          this.emit(createToolCallStartEvent(call.id, call.name));
          this.emit(createToolCallDeltaEvent(call.id, JSON.stringify(call.arguments)));
          this.emit(createToolCallEndEvent(call.id));
        } else {
          this.endToolCall(call.id);
        }
        if (state !== 'settled') this.toolCalls.set(call.id, 'running');
      },
      onToolUpdate: (update) => {
        this.endPart();
        this.emit(createToolUpdateEvent(update.callId, update));
      },
      onToolResult: (toolResult) => {
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
    this.toolCalls.set(id, 'settled');
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
