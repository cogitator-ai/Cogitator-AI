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
import { parseSSEStream } from './sse-parser.js';
import {
  chatReducer,
  createInitialState,
  type ChatAction,
  type ChatState,
} from './use-chat-state.js';
import { withRetry } from './retry.js';
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
  errored: boolean;
  ended: boolean;
}

type ResponseHandler = (response: Response, request: ChatRequest) => Promise<void>;

function lineUpBehindRunning(strategy: MultitaskStrategy | undefined): boolean {
  return strategy === 'enqueue' || strategy === 'reject';
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
    onReasoning,
    onApprovalRequired,
    onInterruptRequired,
    resumeApi,
    multitaskStrategy,
    retry,
  } = options;

  const [state, dispatch] = useReducer(
    chatReducer,
    createInitialState(initialMessages, options.threadId)
  );

  const stateRef = useRef<ChatState>(state);
  const requestsRef = useRef<ChatRequest[]>([]);

  const apply = useCallback((action: ChatAction) => {
    stateRef.current = chatReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  useEffect(() => {
    return () => {
      const open = requestsRef.current;
      requestsRef.current = [];
      for (const request of open) request.controller.abort();
    };
  }, []);

  const isOpen = useCallback((request: ChatRequest) => requestsRef.current.includes(request), []);

  const interrupt = useCallback(() => {
    const open = requestsRef.current;
    if (open.length === 0) return;
    requestsRef.current = [];
    for (const request of open) request.controller.abort();
    apply({ type: 'FINISH_ASSISTANT_MESSAGE' });
    apply({ type: 'STOP_LOADING' });
  }, [apply]);

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

  const requireApproval = useCallback(
    (approvals: PendingApproval[], threadId: string) => {
      followThread(threadId);
      apply({ type: 'SET_PENDING_APPROVALS', payload: approvals });
      onApprovalRequired?.(approvals);
    },
    [apply, followThread, onApprovalRequired]
  );

  const requireAnswers = useCallback(
    (interrupts: PendingInterrupt[], threadId: string) => {
      followThread(threadId);
      apply({ type: 'SET_PENDING_INTERRUPTS', payload: interrupts });
      onInterruptRequired?.(interrupts);
    },
    [apply, followThread, onInterruptRequired]
  );

  const clearPause = useCallback(() => {
    apply({ type: 'SET_PENDING_APPROVALS', payload: [] });
    apply({ type: 'SET_PENDING_INTERRUPTS', payload: [] });
  }, [apply]);

  const handleStreamEvent = useCallback(
    (event: StreamEvent, toolCalls: Map<string, { name: string; args: string }>): boolean => {
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
          const toolCall: ToolCall = {
            id: event.id,
            name: tc.name,
            arguments: parseToolArguments(tc.args),
          };
          apply({ type: 'ADD_TOOL_CALL', payload: toolCall });
          onToolCall?.(toolCall);
          return false;
        }

        case 'tool-result': {
          const toolResult: ToolResultEvent = {
            id: event.id,
            toolCallId: event.toolCallId,
            result: event.result,
          };
          onToolResult?.(toolResult);
          return false;
        }

        case 'approval-required':
          requireApproval(event.approvals, event.threadId);
          return false;

        case 'interrupt-required':
          requireAnswers(event.interrupts, event.threadId);
          return false;

        case 'finish':
          if (event.threadId) followThread(event.threadId);
          if (event.interrupts?.length && event.pendingApprovals?.length) {
            requireApproval(event.pendingApprovals, event.threadId ?? '');
          }
          return false;

        case 'error': {
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
      onToolResult,
      requireAnswers,
      requireApproval,
    ]
  );

  const advance = useCallback(() => {
    for (let head = requestsRef.current[0]; head; head = requestsRef.current[0]) {
      for (const event of head.backlog.splice(0)) {
        if (handleStreamEvent(event, head.toolCalls)) head.errored = true;
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
        if (handleStreamEvent(event, request.toolCalls)) request.errored = true;
      } else if (event.type === 'error' && isRefusal(request)) {
        release(request);
        report(request, new Error(event.message));
      } else {
        request.backlog.push(event);
      }
    },
    [handleStreamEvent, release, report]
  );

  const processStream = useCallback(
    async (response: Response, request: ChatRequest) => {
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();

      try {
        for await (const event of parseSSEStream(reader)) {
          if (!isOpen(request)) return;
          deliver(request, event);
        }
      } finally {
        reader.releaseLock();
      }

      if (!isOpen(request)) return;
      request.ended = true;
      if (requestsRef.current[0] === request) advance();
    },
    [advance, deliver, isOpen]
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
        followThread(result.threadId);
      } else if (result.interrupts?.length) {
        requireAnswers(result.interrupts, result.threadId);
        if (approvals.length > 0) requireApproval(approvals, result.threadId);
      } else {
        requireApproval(approvals, result.threadId);
      }
      const wasCurrent = release(request);
      onFinish?.(message);
      if (wasCurrent) advance();
    },
    [advance, apply, followThread, isOpen, onFinish, release, requireAnswers, requireApproval]
  );

  const request = useCallback(
    async (
      url: string,
      body: unknown,
      handle: ResponseHandler,
      onFailure?: (error: Error) => void
    ) => {
      const controller = new AbortController();
      const chatRequest: ChatRequest = {
        controller,
        toolCalls: new Map(),
        backlog: [],
        onFailure,
        errored: false,
        ended: false,
      };
      requestsRef.current = [...requestsRef.current, chatRequest];

      apply({ type: 'START_LOADING' });

      const doFetch = async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw await toHttpError(response);
        }

        return response;
      };

      try {
        const response = await withRetry(doFetch, retry, controller.signal);
        await handle(response, chatRequest);
      } catch (err) {
        if (!isOpen(chatRequest)) return;
        const wasCurrent = release(chatRequest);
        if (!isAbortError(err)) {
          report(chatRequest, err instanceof Error ? err : new Error('Unknown error'));
        }
        if (wasCurrent) advance();
      }
    },
    [advance, apply, headers, isOpen, release, report, retry]
  );

  const sendWithMessages = useCallback(
    async (
      messages: ChatMessage[],
      threadId: string | undefined,
      metadata?: Record<string, unknown>
    ) => {
      clearPause();
      await request(
        api,
        {
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            metadata: m.metadata,
          })),
          threadId,
          metadata,
          ...(multitaskStrategy !== undefined && { multitaskStrategy }),
        },
        processStream
      );
    },
    [api, clearPause, multitaskStrategy, processStream, request]
  );

  const send = useCallback(
    async (inputOverride?: string, metadata?: Record<string, unknown>) => {
      const messageContent = inputOverride ?? stateRef.current.input;
      if (!messageContent.trim()) return;

      if (!lineUpBehindRunning(multitaskStrategy)) interrupt();

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
      await sendWithMessages(current.messages, current.threadId, metadata);
    },
    [apply, interrupt, multitaskStrategy, sendWithMessages]
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

      await request(
        resumeApi,
        { threadId, ...decisions },
        async (response, chatRequest) => {
          clearPause();
          await (isEventStream(response) ? processStream : processResult)(response, chatRequest);
        },
        (error) => {
          if (error instanceof HttpError && error.status === 409) clearPause();
        }
      );
    },
    [clearPause, fail, interrupt, processResult, processStream, request, resumeApi]
  );

  const approve = useCallback(() => resume({ defaultDecision: { approved: true } }), [resume]);

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
    deny,
  };
}
