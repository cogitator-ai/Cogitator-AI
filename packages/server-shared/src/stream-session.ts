import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { generateId } from './helpers.js';
import {
  createApprovalRequiredEvent,
  createErrorEvent,
  createFinishEvent,
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
  type StreamEvent,
} from './protocol.js';
import { toAgentRunOutcome, toPendingApprovals } from './response.js';

/** The run callbacks through which a streamed agent run reaches its client */
export type AgentStreamCallbacks = Required<
  Pick<RunOptions, 'onToken' | 'onReasoning' | 'onToolCall' | 'onToolResult'>
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
 * what the run did not stream (an answer the model gave in one piece), the approvals a paused
 * run waits on, and `finish` with the usage, the thread and how the run ended. `fail` closes
 * the open part and sends `error`.
 *
 * Pass the thread to the run (`threadId: session.threadId`) and spread `callbacks` into its
 * options together with `stream: true`.
 */
export class AgentStreamSession {
  readonly messageId = generateId('msg');
  readonly threadId: string;
  readonly callbacks: AgentStreamCallbacks;

  private open: { kind: PartKind; id: string } | undefined;
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
      onToolCall: (call) => {
        this.endPart();
        this.emit(createToolCallStartEvent(call.id, call.name));
        this.emit(createToolCallDeltaEvent(call.id, JSON.stringify(call.arguments)));
        this.emit(createToolCallEndEvent(call.id));
      },
      onToolResult: (toolResult) => {
        this.emit(createToolResultEvent(generateId('res'), toolResult.callId, toolResult.result));
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
    if (result.status === 'paused') {
      this.emit(
        createApprovalRequiredEvent(
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
    this.emit(createErrorEvent(message, code));
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
