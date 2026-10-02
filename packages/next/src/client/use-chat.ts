'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  UseChatOptions,
  UseChatReturn,
  ChatMessage,
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
import { toHttpError } from './http-error.js';

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

function pendingAssistantMessage(state: ChatState): ChatMessage | null {
  if (!state.currentMessageId) return null;
  return {
    id: state.currentMessageId,
    role: 'assistant',
    content: state.currentContent,
    toolCalls: state.currentToolCalls.length > 0 ? state.currentToolCalls : undefined,
  };
}

export function useCogitatorChat(options: UseChatOptions): UseChatReturn {
  const { api, initialMessages, headers, onError, onFinish, onToolCall, onToolResult, retry } =
    options;

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

  const handleStreamEvent = useCallback(
    (event: StreamEvent, toolCalls: Map<string, { name: string; args: string }>): boolean => {
      switch (event.type) {
        case 'start':
          apply({ type: 'START_ASSISTANT_MESSAGE', payload: event.messageId });
          return false;

        case 'text-delta':
          apply({ type: 'APPEND_CONTENT', payload: event.delta });
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
    [apply, onError, onToolCall, onToolResult]
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

  const sendWithMessages = useCallback(
    async (
      messages: ChatMessage[],
      threadId: string | undefined,
      metadata?: Record<string, unknown>
    ) => {
      const controller = new AbortController();
      activeRequestRef.current = controller;

      apply({ type: 'START_LOADING' });

      const doFetch = async () => {
        const response = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({
            messages: messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              metadata: m.metadata,
            })),
            threadId,
            metadata,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw await toHttpError(response);
        }

        return response;
      };

      try {
        const response = await withRetry(doFetch, retry, controller.signal);
        await processStream(response, controller);
      } catch (err) {
        if (activeRequestRef.current !== controller) return;
        activeRequestRef.current = null;

        apply({ type: 'FINISH_ASSISTANT_MESSAGE' });

        if (isAbortError(err)) {
          apply({ type: 'STOP_LOADING' });
          return;
        }

        const error = err instanceof Error ? err : new Error('Unknown error');
        apply({ type: 'SET_ERROR', payload: error });
        onError?.(error);
      }
    },
    [api, apply, headers, onError, processStream, retry]
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

  const setInput = useCallback(
    (value: string) => {
      apply({ type: 'SET_INPUT', payload: value });
    },
    [apply]
  );

  const setThreadId = useCallback(
    (id: string) => {
      apply({ type: 'SET_THREAD_ID', payload: id });
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
  };
}
