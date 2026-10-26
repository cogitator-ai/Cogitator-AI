'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  AgentResponse,
  UseChatOptions,
  UseChatReturn,
  ChatMessage,
  MultitaskStrategy,
  PendingApproval,
  PendingInterrupt,
  ResumeDecisions,
  ToolCall,
  ToolResultEvent,
} from '../types.js';
import type { StreamEvent } from '../streaming/protocol.js';
import { parseSSEFrames } from './sse-parser.js';
import {
  chatReducer,
  createInitialState,
  type ChatAction,
  type ChatState,
} from './use-chat-state.js';
import { isRetryableError, sleep, withRetry } from './retry.js';
import { HttpError, toHttpError } from './http-error.js';

let idCounter = 0;
function generateClientId(): string {
  return `msg_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

function isEventStream(response: Response): boolean {
  return response.headers.get('Content-Type')?.includes('text/event-stream') ?? false;
}

/**
 * One request of the hook. Requests that are let through to the server while another one
 * streams (`multitaskStrategy` of `enqueue` or `reject`) wait in line: only the first open
 * request writes the assistant message, a later one keeps its events until its turn comes.
 */
interface ChatRequest {
  readonly controller: AbortController;
  readonly toolCalls: Map<string, { name: string; args: string }>;
  readonly backlog: StreamEvent[];
  readonly onFailure?: (error: Error) => void;
  /**
   * The thread the request runs on: the one it named, the one the server announced for it,
   * or `undefined` once it settled without one
   */
  readonly thread: Promise<string | undefined>;
  readonly announce: (threadId: string | undefined) => void;
  /**
   * Requests this one took over from without aborting them (`interrupt` and `rollback`):
   * the server stops their runs, the hook aborts whatever is left once this one settles
   */
  supersedes: ChatRequest[];
  /** Taken over by a later request: its stream is read to the end but no longer shown */
  detached: boolean;
  errored: boolean;
  ended: boolean;
  /** The code of the `error` event the stream sent, when it sent one */
  errorCode?: string;
  /** The id of the last event the stream sent, on a server that sends ids */
  lastEventId?: string;
  /** Sends the request again to resume its stream after `lastEventId` */
  resend?: (lastEventId: string) => Promise<Response>;
  /** Asks the server to cancel the run of the request's stream */
  cancelRun?: (streamId: string) => void;
}

/** The stream an event id names: the part before its last `:` */
function streamIdOf(lastEventId: string): string {
  return lastEventId.slice(0, lastEventId.lastIndexOf(':'));
}

/**
 * Asks the server to stop the run of a request's stream: aborting the fetch alone only
 * disconnects from a resumable stream, whose run goes on without the client
 */
function cancelRunOf(request: ChatRequest): void {
  if (request.lastEventId === undefined || request.ended) return;
  request.cancelRun?.(streamIdOf(request.lastEventId));
}

/** How a read of a stream ended: at `finish` or `error`, cut short, or no longer wanted */
type StreamEnd = 'ended' | 'cut' | 'closed';

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 1000;

/** Codes of a resume the server refused before it ran: the paused run still waits */
const REFUSED_RESUME_CODES = new Set(['INTERRUPT_ANSWER_INVALID', 'INTERRUPT_EXPIRED']);

type ResponseHandler = (response: Response, request: ChatRequest) => Promise<void>;

interface RequestPlan {
  readonly url: string;
  /** The thread the request names, `undefined` to let the server pick one */
  readonly threadId: string | undefined;
  readonly body: (threadId: string | undefined) => unknown;
  readonly handle: ResponseHandler;
  readonly onFailure?: (error: Error) => void;
  readonly supersedes?: ChatRequest[];
}

/**
 * What `send` does with the requests still open: `abort` them first (no strategy), `hand-over`
 * to the new one and let the server stop them (`interrupt`, `rollback`), or `line-up` behind
 * them and let the server decide (`enqueue`, `reject`)
 */
type Takeover = 'abort' | 'hand-over' | 'line-up';

function takeoverOf(strategy: MultitaskStrategy | undefined): Takeover {
  switch (strategy) {
    case 'enqueue':
    case 'reject':
      return 'line-up';
    case 'interrupt':
    case 'rollback':
      return 'hand-over';
    default:
      return 'abort';
  }
}

function createChatRequest(
  onFailure: ((error: Error) => void) | undefined,
  supersedes: ChatRequest[]
): ChatRequest {
  let announce!: (threadId: string | undefined) => void;
  const thread = new Promise<string | undefined>((resolve) => {
    announce = resolve;
  });
  return {
    controller: new AbortController(),
    toolCalls: new Map(),
    backlog: [],
    onFailure,
    thread,
    announce,
    supersedes,
    detached: false,
    errored: false,
    ended: false,
  };
}

function announcedThread(event: StreamEvent): string | undefined {
  switch (event.type) {
    case 'start':
    case 'finish':
    case 'approval-required':
    case 'interrupt-required':
      return event.threadId || undefined;
    default:
      return undefined;
  }
}

function isRefusal(request: ChatRequest): boolean {
  return request.backlog.every((event) => event.type === 'start');
}

function pendingAssistantMessage(state: ChatState): ChatMessage | null {
  if (!state.currentMessageId) return null;
  return {
    id: state.currentMessageId,
    role: 'assistant',
    content: state.currentContent,
    ...(state.currentReasoning && { reasoning: state.currentReasoning }),
    toolCalls: state.currentToolCalls.length > 0 ? state.currentToolCalls : undefined,
  };
}

export function useCogitatorChat(options: UseChatOptions): UseChatReturn {
  const {
    api,
    initialMessages,
    headers,
    onError,
    onFinish,
    onToolCall,
    onToolResult,
    onToolCallDropped,
    onReasoning,
    onApprovalRequired,
    onInterruptRequired,
    resumeApi,
    multitaskStrategy,
    retry,
    reconnect,
  } = options;
  const reconnectAttempts =
    reconnect === false
      ? 0
      : Math.max(0, Math.floor(reconnect?.attempts ?? DEFAULT_RECONNECT_ATTEMPTS));
  const reconnectDelayMs =
    reconnect === false ? 0 : Math.max(0, reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS);

  const [state, dispatch] = useReducer(
    chatReducer,
    createInitialState(initialMessages, options.threadId)
  );

  const stateRef = useRef<ChatState>(state);
  const requestsRef = useRef<ChatRequest[]>([]);
  const liveRef = useRef(new Set<ChatRequest>());
  const pendingThreadRef = useRef<Promise<string | undefined> | null>(null);
  const pausedByRef = useRef<ChatRequest | null>(null);

  const apply = useCallback((action: ChatAction) => {
    stateRef.current = chatReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  useEffect(() => {
    const live = liveRef.current;
    return () => {
      requestsRef.current = [];
      for (const request of live) request.controller.abort();
    };
  }, []);

  const isOpen = useCallback((request: ChatRequest) => requestsRef.current.includes(request), []);

  const closeOpen = useCallback((): ChatRequest[] => {
    const open = requestsRef.current;
    if (open.length === 0) return [];
    requestsRef.current = [];
    apply({ type: 'FINISH_ASSISTANT_MESSAGE' });
    apply({ type: 'STOP_LOADING' });
    return open;
  }, [apply]);

  const interrupt = useCallback(() => {
    closeOpen();
    for (const request of liveRef.current) {
      cancelRunOf(request);
      request.controller.abort();
    }
  }, [closeOpen]);

  const handOver = useCallback((): ChatRequest[] => {
    const superseded: ChatRequest[] = [];
    for (const request of closeOpen()) {
      request.detached = true;
      superseded.push(request, ...request.supersedes);
      request.supersedes = [];
    }
    return superseded;
  }, [closeOpen]);

  const release = useCallback(
    (request: ChatRequest): boolean => {
      const wasCurrent = requestsRef.current[0] === request;
      requestsRef.current = requestsRef.current.filter((open) => open !== request);
      if (wasCurrent) apply({ type: 'FINISH_ASSISTANT_MESSAGE' });
      if (requestsRef.current.length === 0) apply({ type: 'STOP_LOADING' });
      return wasCurrent;
    },
    [apply]
  );

  const report = useCallback(
    (request: ChatRequest, error: Error) => {
      request.onFailure?.(error);
      apply({ type: 'SET_ERROR', payload: error });
      onError?.(error);
    },
    [apply, onError]
  );

  const followThread = useCallback(
    (threadId: string) => {
      if (threadId && threadId !== stateRef.current.threadId) {
        apply({ type: 'SET_THREAD_ID', payload: threadId });
      }
    },
    [apply]
  );

  const clearPause = useCallback(() => {
    pausedByRef.current = null;
    apply({ type: 'SET_PENDING_APPROVALS', payload: [] });
    apply({ type: 'SET_PENDING_INTERRUPTS', payload: [] });
  }, [apply]);

  /**
   * Drops the pause of an earlier request once `request` ran on the thread: the server gives up
   * a paused run when the next one starts, so its approvals and questions can no longer be answered
   */
  const supersedePause = useCallback(
    (request: ChatRequest) => {
      if (pausedByRef.current && pausedByRef.current !== request) clearPause();
    },
    [clearPause]
  );

  const pauseFor = useCallback(
    (request: ChatRequest, threadId: string) => {
      supersedePause(request);
      pausedByRef.current = request;
      followThread(threadId);
    },
    [followThread, supersedePause]
  );

  const requireApproval = useCallback(
    (request: ChatRequest, approvals: PendingApproval[], threadId: string) => {
      pauseFor(request, threadId);
      apply({ type: 'SET_PENDING_APPROVALS', payload: approvals });
      onApprovalRequired?.(approvals);
    },
    [apply, onApprovalRequired, pauseFor]
  );

  const requireAnswers = useCallback(
    (request: ChatRequest, interrupts: PendingInterrupt[], threadId: string) => {
      pauseFor(request, threadId);
      apply({ type: 'SET_PENDING_INTERRUPTS', payload: interrupts });
      onInterruptRequired?.(interrupts);
    },
    [apply, onInterruptRequired, pauseFor]
  );

  const handleStreamEvent = useCallback(
    (event: StreamEvent, request: ChatRequest): boolean => {
      const { toolCalls } = request;
      switch (event.type) {
        case 'start':
          apply({ type: 'START_ASSISTANT_MESSAGE', payload: event.messageId });
          if (event.threadId) followThread(event.threadId);
          return false;

        case 'text-delta':
          apply({ type: 'APPEND_CONTENT', payload: event.delta });
          return false;

        case 'reasoning-delta':
          apply({ type: 'APPEND_REASONING', payload: event.delta });
          onReasoning?.(event.delta);
          return false;

        case 'tool-call-start':
          toolCalls.set(event.id, { name: event.toolName, args: '' });
          return false;

        case 'tool-call-delta': {
          const tc = toolCalls.get(event.id);
          if (tc) tc.args += event.argsTextDelta;
          return false;
        }

        case 'tool-call-end': {
          const tc = toolCalls.get(event.id);
          if (!tc) return false;
          toolCalls.delete(event.id);
          if (event.dropped) return false;
          const toolCall: ToolCall = {
            id: event.id,
            name: tc.name,
            arguments: parseToolArguments(tc.args),
          };
          apply({ type: 'ADD_TOOL_CALL', payload: toolCall });
          onToolCall?.(toolCall);
          return false;
        }

        case 'tool-update': {
          if (!event.arguments) return false;
          const known = stateRef.current.currentToolCalls.find(
            (call) => call.id === event.toolCallId
          );
          if (!known) return false;
          const corrected: ToolCall = { ...known, arguments: event.arguments };
          apply({ type: 'UPDATE_TOOL_CALL', payload: corrected });
          onToolCall?.(corrected);
          return false;
        }

        case 'tool-result': {
          if (event.dropped) {
            apply({ type: 'REMOVE_TOOL_CALL', payload: event.toolCallId });
            onToolCallDropped?.(event.toolCallId);
            return false;
          }
          const toolResult: ToolResultEvent = {
            id: event.id,
            toolCallId: event.toolCallId,
            result: event.result,
            ...(event.details !== undefined && { details: event.details }),
            ...(event.presentation && { presentation: event.presentation }),
          };
          onToolResult?.(toolResult);
          return false;
        }

        case 'approval-required':
          requireApproval(request, event.approvals, event.threadId);
          return false;

        case 'interrupt-required':
          requireAnswers(request, event.interrupts, event.threadId);
          return false;

        case 'finish':
          supersedePause(request);
          if (event.threadId) followThread(event.threadId);
          if (event.interrupts?.length && event.pendingApprovals?.length) {
            requireApproval(request, event.pendingApprovals, event.threadId ?? '');
          }
          return false;

        case 'error': {
          if (event.code !== undefined) request.errorCode = event.code;
          const error = new Error(event.message);
          apply({ type: 'SET_ERROR', payload: error });
          onError?.(error);
          return true;
        }

        default:
          return false;
      }
    },
    [
      apply,
      followThread,
      onError,
      onReasoning,
      onToolCall,
      onToolCallDropped,
      onToolResult,
      requireAnswers,
      requireApproval,
      supersedePause,
    ]
  );

  const advance = useCallback(() => {
    for (let head = requestsRef.current[0]; head; head = requestsRef.current[0]) {
      for (const event of head.backlog.splice(0)) {
        if (handleStreamEvent(event, head)) head.errored = true;
      }
      if (requestsRef.current[0] !== head) continue;
      if (!head.ended) return;

      const finished = pendingAssistantMessage(stateRef.current);
      release(head);
      if (finished && !head.errored) onFinish?.(finished);
    }
  }, [handleStreamEvent, onFinish, release]);

  const deliver = useCallback(
    (request: ChatRequest, event: StreamEvent) => {
      if (requestsRef.current[0] === request) {
        if (handleStreamEvent(event, request)) request.errored = true;
      } else if (event.type === 'error' && isRefusal(request)) {
        release(request);
        report(request, new Error(event.message));
      } else {
        request.backlog.push(event);
      }
    },
    [handleStreamEvent, release, report]
  );

  /**
   * Reads one response of a stream, noting the id of each event, and says how it ended. It
   * stops at `finish` or `error` and lets the rest of the body go, so a connection that drops
   * before `[DONE]` cannot turn a whole answer into a cut one
   */
  const readStream = useCallback(
    async (response: Response, request: ChatRequest, onEvent: () => void): Promise<StreamEnd> => {
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      let terminal = false;

      try {
        for await (const { event, id } of parseSSEFrames(reader)) {
          if (id !== undefined) request.lastEventId = id;
          onEvent();
          if (event.type === 'finish' || event.type === 'error') terminal = true;
          const threadId = announcedThread(event);
          if (threadId) request.announce(threadId);
          if (!request.detached) {
            if (!isOpen(request)) return 'closed';
            deliver(request, event);
          }
          if (terminal) break;
        }
      } finally {
        if (terminal) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }

      return terminal ? 'ended' : 'cut';
    },
    [deliver, isOpen]
  );

  /**
   * Reads a stream to its end. One cut short, by the network or by a body that ends before
   * `finish`, is resumed where it stopped when the server sends event ids: the request goes
   * again with `Last-Event-ID`, up to `reconnect.attempts` times in a row without an event
   */
  const processStream = useCallback(
    async (response: Response, request: ChatRequest) => {
      let current: Response | undefined = response;
      let failure: { error: unknown } | undefined;
      let failures = 0;

      for (;;) {
        let progressed = false;
        if (current) {
          failure = undefined;
          try {
            const end = await readStream(current, request, () => (progressed = true));
            if (end === 'closed') return;
            if (end === 'ended') break;
            if (request.lastEventId !== undefined && reconnectAttempts > 0) {
              failure = { error: new Error('The stream ended before the run finished') };
            }
          } catch (error) {
            if (isAbortError(error) || request.controller.signal.aborted) throw error;
            failure = { error };
          }
        }
        if (progressed) failures = 0;

        const { lastEventId, resend } = request;
        const resumable = !request.detached && lastEventId !== undefined && resend !== undefined;
        if (!resumable || failures >= reconnectAttempts) {
          if (failure) throw failure.error;
          break;
        }

        failures++;
        await sleep(reconnectDelayMs * 2 ** (failures - 1), request.controller.signal);
        if (!isOpen(request)) return;
        try {
          current = await resend(lastEventId);
          if (!current.ok) throw await toHttpError(current);
          if (!isEventStream(current)) {
            throw new Error('The server answered the reconnect without a stream');
          }
        } catch (error) {
          if (isAbortError(error) || !isRetryableError(error)) throw error;
          current = undefined;
          failure = { error };
        }
      }

      if (!isOpen(request)) return;
      request.ended = true;
      if (requestsRef.current[0] === request) advance();
    },
    [advance, isOpen, readStream, reconnectAttempts, reconnectDelayMs]
  );

  const processResult = useCallback(
    async (response: Response, request: ChatRequest) => {
      const result = (await response.json()) as AgentResponse;
      if (!isOpen(request)) return;

      const message: ChatMessage = {
        id: generateClientId(),
        role: 'assistant',
        content: result.output,
        ...(result.reasoning && { reasoning: result.reasoning }),
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        createdAt: new Date(),
      };
      apply({ type: 'APPEND_MESSAGE', payload: message });
      const approvals = result.pendingApprovals ?? [];
      if (result.status !== 'paused') {
        supersedePause(request);
        followThread(result.threadId);
      } else if (result.interrupts?.length) {
        requireAnswers(request, result.interrupts, result.threadId);
        if (approvals.length > 0) requireApproval(request, approvals, result.threadId);
      } else {
        requireApproval(request, approvals, result.threadId);
      }
      const wasCurrent = release(request);
      onFinish?.(message);
      if (wasCurrent) advance();
    },
    [
      advance,
      apply,
      followThread,
      isOpen,
      onFinish,
      release,
      requireAnswers,
      requireApproval,
      supersedePause,
    ]
  );

  /**
   * Sends one request. One that names no thread while an earlier one has not learned its thread
   * yet waits for it under a `multitaskStrategy`, so the messages sent in a row share the thread
   * the server picks for the first instead of starting one thread each
   */
  const request = useCallback(
    async ({ url, threadId, body, handle, onFailure, supersedes = [] }: RequestPlan) => {
      const chatRequest = createChatRequest(onFailure, supersedes);
      const previous =
        threadId === undefined && multitaskStrategy !== undefined ? pendingThreadRef.current : null;
      if (threadId === undefined) pendingThreadRef.current = chatRequest.thread;
      else chatRequest.announce(threadId);
      liveRef.current.add(chatRequest);
      requestsRef.current = [...requestsRef.current, chatRequest];

      apply({ type: 'START_LOADING' });

      const { controller } = chatRequest;
      let sent = false;
      try {
        const thread = threadId ?? (previous ? await previous : undefined);
        if (!isOpen(chatRequest)) return;
        if (thread !== undefined) chatRequest.announce(thread);
        sent = true;

        const payload = JSON.stringify(body(thread));
        const send = (resumeAfter?: string) =>
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...headers,
              ...(resumeAfter !== undefined && { 'Last-Event-ID': resumeAfter }),
            },
            body: payload,
            signal: controller.signal,
          });
        chatRequest.resend = send;
        chatRequest.cancelRun = (streamId) => {
          const cancelUrl = `${url}${url.includes('?') ? '&' : '?'}streamId=${encodeURIComponent(streamId)}`;
          void fetch(cancelUrl, { method: 'DELETE', headers: { ...headers } }).catch(
            () => undefined
          );
        };

        const doFetch = async () => {
          const response = await send();

          if (!response.ok) {
            throw await toHttpError(response);
          }

          return response;
        };

        const response = await withRetry(doFetch, retry, controller.signal);
        await handle(response, chatRequest);
      } catch (err) {
        if (!isOpen(chatRequest)) return;
        const wasCurrent = release(chatRequest);
        if (!isAbortError(err)) {
          report(chatRequest, err instanceof Error ? err : new Error('Unknown error'));
        }
        if (wasCurrent) advance();
      } finally {
        liveRef.current.delete(chatRequest);
        if (sent || !previous) chatRequest.announce(undefined);
        else void previous.then(chatRequest.announce);
        for (const predecessor of chatRequest.supersedes) {
          if (liveRef.current.has(predecessor)) predecessor.controller.abort();
        }
      }
    },
    [advance, apply, headers, isOpen, multitaskStrategy, release, report, retry]
  );

  const sendWithMessages = useCallback(
    async (
      messages: ChatMessage[],
      threadId: string | undefined,
      metadata?: Record<string, unknown>,
      supersedes?: ChatRequest[]
    ) => {
      clearPause();
      await request({
        url: api,
        threadId,
        body: (thread) => ({
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            metadata: m.metadata,
          })),
          threadId: thread,
          metadata,
          ...(multitaskStrategy !== undefined && { multitaskStrategy }),
        }),
        handle: processStream,
        supersedes,
      });
    },
    [api, clearPause, multitaskStrategy, processStream, request]
  );

  const send = useCallback(
    async (inputOverride?: string, metadata?: Record<string, unknown>) => {
      const messageContent = inputOverride ?? stateRef.current.input;
      if (!messageContent.trim()) return;

      const takeover = takeoverOf(multitaskStrategy);
      if (takeover === 'abort') interrupt();
      const supersedes = takeover === 'hand-over' ? handOver() : [];

      const userMessage: ChatMessage = {
        id: generateClientId(),
        role: 'user',
        content: messageContent,
        metadata,
        createdAt: new Date(),
      };

      apply({ type: 'ADD_USER_MESSAGE', payload: userMessage });
      apply({ type: 'SET_INPUT', payload: '' });

      const current = stateRef.current;
      await sendWithMessages(current.messages, current.threadId, metadata, supersedes);
    },
    [apply, handOver, interrupt, multitaskStrategy, sendWithMessages]
  );

  const stop = useCallback(() => {
    interrupt();
  }, [interrupt]);

  const reload = useCallback(async () => {
    interrupt();

    const current = stateRef.current;
    let lastUserIndex = -1;
    for (let i = current.messages.length - 1; i >= 0; i--) {
      if (current.messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;

    const lastUserMessage = current.messages[lastUserIndex];
    const messages = current.messages.slice(0, lastUserIndex + 1);

    apply({ type: 'SET_MESSAGES', payload: messages });
    await sendWithMessages(messages, current.threadId, lastUserMessage.metadata);
  }, [apply, interrupt, sendWithMessages]);

  const fail = useCallback(
    (message: string) => {
      const error = new Error(message);
      apply({ type: 'SET_ERROR', payload: error });
      onError?.(error);
    },
    [apply, onError]
  );

  const resume = useCallback(
    async (decisions: ResumeDecisions) => {
      const { threadId } = stateRef.current;
      if (!resumeApi) {
        fail('useCogitatorChat needs resumeApi to resume a paused run');
        return;
      }
      if (!threadId) {
        fail('There is no thread with a paused run to resume');
        return;
      }

      interrupt();

      await request({
        url: resumeApi,
        threadId,
        body: () => ({ threadId, ...decisions }),
        handle: async (response, chatRequest) => {
          const waiting = {
            approvals: stateRef.current.pendingApprovals,
            interrupts: stateRef.current.pendingInterrupts,
            by: pausedByRef.current,
          };
          clearPause();
          await (isEventStream(response) ? processStream : processResult)(response, chatRequest);
          const refused =
            chatRequest.errorCode !== undefined && REFUSED_RESUME_CODES.has(chatRequest.errorCode);
          if (refused && pausedByRef.current === null) {
            pausedByRef.current = waiting.by;
            apply({ type: 'SET_PENDING_APPROVALS', payload: waiting.approvals });
            apply({ type: 'SET_PENDING_INTERRUPTS', payload: waiting.interrupts });
          }
        },
        onFailure: (error) => {
          if (error instanceof HttpError && error.status === 409) clearPause();
        },
      });
    },
    [apply, clearPause, fail, interrupt, processResult, processStream, request, resumeApi]
  );

  const approve = useCallback(() => resume({ defaultDecision: { approved: true } }), [resume]);

  const approveAlways = useCallback(
    () => resume({ defaultDecision: { approved: true, remember: true } }),
    [resume]
  );

  const deny = useCallback(
    (reason?: string) =>
      resume({
        defaultDecision: reason === undefined ? { approved: false } : { approved: false, reason },
      }),
    [resume]
  );

  const setInput = useCallback(
    (value: string) => {
      apply({ type: 'SET_INPUT', payload: value });
    },
    [apply]
  );

  const setThreadId = useCallback(
    (id: string | undefined) => {
      pendingThreadRef.current = null;
      apply({ type: 'SET_THREAD_ID', payload: id });
      if (id === undefined) clearPause();
    },
    [apply, clearPause]
  );

  const appendMessage = useCallback(
    (message: ChatMessage) => {
      apply({ type: 'APPEND_MESSAGE', payload: message });
    },
    [apply]
  );

  const clearMessages = useCallback(() => {
    apply({ type: 'CLEAR_MESSAGES' });
  }, [apply]);

  const setMessages = useCallback(
    (messages: ChatMessage[]) => {
      apply({ type: 'SET_MESSAGES', payload: messages });
    },
    [apply]
  );

  const pending = pendingAssistantMessage(state);
  const displayMessages = pending ? [...state.messages, pending] : state.messages;

  return {
    messages: displayMessages,
    input: state.input,
    setInput,
    send,
    isLoading: state.isLoading,
    error: state.error,
    stop,
    reload,
    threadId: state.threadId,
    setThreadId,
    appendMessage,
    clearMessages,
    setMessages,
    pendingApprovals: state.pendingApprovals,
    pendingInterrupts: state.pendingInterrupts,
    resume,
    approve,
    approveAlways,
    deny,
  };
}
