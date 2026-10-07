'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  AgentResponse,
  UseChatOptions,
  UseChatReturn,
  ChatMessage,
  PendingApproval,
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

type ResponseHandler = (response: Response, controller: AbortController) => Promise<void>;

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
    resumeApi,
    retry,
  } = options;

  const [state, dispatch] = useReducer(
    chatReducer,
    createInitialState(initialMessages, options.threadId)
  );

  const stateRef = useRef<ChatState>(state);
  const activeRequestRef = useRef<AbortController | null>(null);

  const apply = useCallback((action: ChatAction) => {
    stateRef.current = chatReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, []);

  const interrupt = useCallback(() => {
    const active = activeRequestRef.current;
    if (!active) return;
    activeRequestRef.current = null;
    active.abort();
    apply({ type: 'FINISH_ASSISTANT_MESSAGE' });
    apply({ type: 'STOP_LOADING' });
  }, [apply]);

  const requireApproval = useCallback(
    (approvals: PendingApproval[], threadId: string) => {
      if (threadId && threadId !== stateRef.current.threadId) {
        apply({ type: 'SET_THREAD_ID', payload: threadId });
      }
      apply({ type: 'SET_PENDING_APPROVALS', payload: approvals });
      onApprovalRequired?.(approvals);
    },
    [apply, onApprovalRequired]
  );

  const handleStreamEvent = useCallback(
    (event: StreamEvent, toolCalls: Map<string, { name: string; args: string }>): boolean => {
      switch (event.type) {
        case 'start':
          apply({ type: 'START_ASSISTANT_MESSAGE', payload: event.messageId });
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

        case 'finish':
          if (event.threadId && event.threadId !== stateRef.current.threadId) {
            apply({ type: 'SET_THREAD_ID', payload: event.threadId });
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
    [apply, onError, onReasoning, onToolCall, onToolResult, requireApproval]
  );

  const processStream = useCallback(
    async (response: Response, controller: AbortController) => {
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const toolCalls = new Map<string, { name: string; args: string }>();
      let errored = false;

      try {
        for await (const event of parseSSEStream(reader)) {
          if (activeRequestRef.current !== controller) return;
          if (handleStreamEvent(event, toolCalls)) errored = true;
        }
      } finally {
        reader.releaseLock();
      }

      if (activeRequestRef.current !== controller) return;
      activeRequestRef.current = null;

      const finished = pendingAssistantMessage(stateRef.current);
      apply({ type: 'FINISH_ASSISTANT_MESSAGE' });
      apply({ type: 'STOP_LOADING' });

      if (finished && !errored) {
        onFinish?.(finished);
      }
    },
    [apply, handleStreamEvent, onFinish]
  );

  const processResult = useCallback(
    async (response: Response, controller: AbortController) => {
      const result = (await response.json()) as AgentResponse;
      if (activeRequestRef.current !== controller) return;
      activeRequestRef.current = null;

      const message: ChatMessage = {
        id: generateClientId(),
        role: 'assistant',
        content: result.output,
        ...(result.reasoning && { reasoning: result.reasoning }),
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        createdAt: new Date(),
      };
      apply({ type: 'APPEND_MESSAGE', payload: message });
      if (result.status === 'paused') {
        requireApproval(result.pendingApprovals ?? [], result.threadId);
      } else if (result.threadId && result.threadId !== stateRef.current.threadId) {
        apply({ type: 'SET_THREAD_ID', payload: result.threadId });
      }
      apply({ type: 'STOP_LOADING' });
      onFinish?.(message);
    },
    [apply, onFinish, requireApproval]
  );

  const request = useCallback(
    async (
      url: string,
      body: unknown,
      handle: ResponseHandler,
      onFailure?: (error: Error) => void
    ) => {
      const controller = new AbortController();
      activeRequestRef.current = controller;

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
        await handle(response, controller);
      } catch (err) {
        if (activeRequestRef.current !== controller) return;
        activeRequestRef.current = null;

        apply({ type: 'FINISH_ASSISTANT_MESSAGE' });

        if (isAbortError(err)) {
          apply({ type: 'STOP_LOADING' });
          return;
        }

        const error = err instanceof Error ? err : new Error('Unknown error');
        onFailure?.(error);
        apply({ type: 'SET_ERROR', payload: error });
        onError?.(error);
      }
    },
    [apply, headers, onError, retry]
  );

  const sendWithMessages = useCallback(
    async (
      messages: ChatMessage[],
      threadId: string | undefined,
      metadata?: Record<string, unknown>
    ) => {
      apply({ type: 'SET_PENDING_APPROVALS', payload: [] });
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
        },
        processStream
      );
    },
    [api, apply, processStream, request]
  );

  const send = useCallback(
    async (inputOverride?: string, metadata?: Record<string, unknown>) => {
      const messageContent = inputOverride ?? stateRef.current.input;
      if (!messageContent.trim()) return;

      interrupt();

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
    [apply, interrupt, sendWithMessages]
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
        async (response, controller) => {
          apply({ type: 'SET_PENDING_APPROVALS', payload: [] });
          await (isEventStream(response) ? processStream : processResult)(response, controller);
        },
        (error) => {
          if (error instanceof HttpError && error.status === 409) {
            apply({ type: 'SET_PENDING_APPROVALS', payload: [] });
          }
        }
      );
    },
    [apply, fail, interrupt, processResult, processStream, request, resumeApi]
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
      if (id === undefined) apply({ type: 'SET_PENDING_APPROVALS', payload: [] });
    },
    [apply]
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
    resume,
    approve,
    deny,
  };
}
