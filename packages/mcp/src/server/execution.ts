/**
 * One run of a tool call on an MCP server, which may stop to ask the person at the client: in
 * place (`context.elicit()`, the run waiting for the answer) or by ending its round
 * (`context.input.ask()`, the client calling again with the answers)
 */

import { randomUUID } from 'node:crypto';
import type { ToolApprovalRequest } from '@cogitator-ai/types';
import type { GrantedApproval } from './request-state';
import type { MCPElicitRequest, MCPElicitResult, MCPInputPending, MCPToolInput } from '../types';

/** A tool result as an MCP server sends it */
export interface ServerToolResult {
  [key: string]: unknown;
  content: ServerContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type ServerContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text: string } }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } };

/** What a run of a call came to */
export type ExecutionStep =
  | { kind: 'done'; result: ServerToolResult; pendingApproval?: ToolApprovalRequest }
  | { kind: 'ask'; key: string; request: MCPElicitRequest }
  | { kind: 'input'; requests: Record<string, MCPElicitRequest>; state: unknown };

/** What a call carries from round to round */
export interface ExecutionCarry {
  /** The approvals the person gave the call so far, by the digest of the request */
  approvals: GrantedApproval[];
  /** The answers and kept state the run started with (`context.input`) */
  input?: { responses: Record<string, MCPElicitResult>; state: unknown };
}

/** What a run of a call gets to ask with */
export interface ExecutionAskers {
  elicit: (request: MCPElicitRequest) => Promise<MCPElicitResult>;
  /** Asking by ending the round, built from the answers and state the round came with */
  input: (
    responses: Record<string, MCPElicitResult>,
    state: unknown,
    stateRejected: boolean
  ) => MCPToolInput;
  /** The questions of `input.ask()`, once the tool asked them */
  asked: () => { requests: Record<string, MCPElicitRequest>; state: unknown } | undefined;
  signal: AbortSignal;
}

const PENDING: MCPInputPending = Object.freeze({ status: 'input_required' as const });

/**
 * A run of a tool call. `next()` resolves with what it came to: its result, a question it
 * waits on (answered with `respond()`), or the questions it ended its round with
 */
export class CallExecution {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  private readonly queue: ExecutionStep[] = [];
  private waiter: ((step: ExecutionStep) => void) | undefined;
  private waiting:
    | { key: string; request: MCPElicitRequest; resolve: (answer: MCPElicitResult) => void }
    | undefined;
  private askedCount = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(
    readonly owner: string,
    readonly tool: string,
    readonly digest: string,
    /** What the call carries from round to round: the approvals given and the last input */
    readonly carry: ExecutionCarry,
    run: (askers: ExecutionAskers) => Promise<ExecutionStep>
  ) {
    let asked: { requests: Record<string, MCPElicitRequest>; state: unknown } | undefined;
    const askers: ExecutionAskers = {
      elicit: (request) => this.ask(request),
      input: (responses, state, stateRejected) => ({
        responses,
        state,
        stateRejected,
        ask: (requests, kept) => {
          asked = { requests, state: kept };
          return PENDING;
        },
      }),
      asked: () => asked,
      signal: this.controller.signal,
    };
    run(askers).then(
      (step) => this.finish(step),
      (error: unknown) =>
        this.finish({
          kind: 'done',
          result: {
            content: [
              {
                type: 'text',
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          },
        })
    );
  }

  /**
   * What the run came to next. Rejects when the run already ended and told what it came to,
   * or when another round already waits on it
   */
  next(): Promise<ExecutionStep> {
    const step = this.queue.shift();
    if (step) return Promise.resolve(step);
    const refused = this.refusal();
    if (refused) return Promise.reject(refused);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** What the run came to next within `ms`, undefined when it is still on its way */
  nextWithin(ms: number): Promise<ExecutionStep | undefined> {
    const step = this.queue.shift();
    if (step) return Promise.resolve(step);
    const refused = this.refusal();
    if (refused) return Promise.reject(refused);
    return new Promise((resolve) => {
      const waiter = (next: ExecutionStep): void => {
        clearTimeout(timer);
        resolve(next);
      };
      const timer = setTimeout(() => {
        if (this.waiter === waiter) this.waiter = undefined;
        resolve(undefined);
      }, ms);
      this.waiter = waiter;
    });
  }

  private refusal(): Error | undefined {
    if (this.done) return new Error('The run of this call already ended');
    if (this.waiter) return new Error('Another round already waits on the run of this call');
    return undefined;
  }

  /** The question the run waits on, if it waits on one */
  get question(): { key: string; request: MCPElicitRequest } | undefined {
    return this.waiting && { key: this.waiting.key, request: this.waiting.request };
  }

  get finished(): boolean {
    return this.done;
  }

  /** Answers the question the run waits on; false when it waits on none */
  respond(answer: MCPElicitResult): boolean {
    const waiting = this.waiting;
    if (!waiting) return false;
    this.waiting = undefined;
    this.clearExpiry();
    waiting.resolve(answer);
    return true;
  }

  /**
   * Keeps the run waiting for the client for `ttlMs`: then its question counts as dismissed
   * and `onExpire` lets go of it
   */
  park(ttlMs: number, onExpire: () => void): void {
    this.clearExpiry();
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      this.respond({ action: 'cancel' });
      onExpire();
    }, ttlMs);
    this.expiry.unref?.();
  }

  /** Stops the run: its signal aborts and a question it waits on counts as dismissed */
  cancel(reason?: unknown): void {
    this.clearExpiry();
    this.controller.abort(reason);
    this.respond({ action: 'cancel' });
  }

  private ask(request: MCPElicitRequest): Promise<MCPElicitResult> {
    if (this.controller.signal.aborted) return Promise.resolve({ action: 'cancel' });
    return new Promise((resolve) => {
      const key = `elicit:${++this.askedCount}`;
      this.waiting = { key, request, resolve };
      this.push({ kind: 'ask', key, request });
    });
  }

  private finish(step: ExecutionStep): void {
    this.done = true;
    this.clearExpiry();
    this.push(step);
  }

  private push(step: ExecutionStep): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter(step);
    } else {
      this.queue.push(step);
    }
  }

  private clearExpiry(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
  }
}
