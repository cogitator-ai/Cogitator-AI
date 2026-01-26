'use client';

import { useCallback, useReducer, useRef } from 'react';
import type {
  UseChatOptions,
  UseChatReturn,
  ChatMessage,
  ToolCall,
  ToolResultEvent,
} from '../types.js';
import type { StreamEvent } from '../streaming/protocol.js';
import { parseSSEStream } from './sse-parser.js';
import { chatReducer, createInitialState } from './use-chat-state.js';
import { withRetry } from './retry.js';

let idCounter = 0;
function generateClientId(): string {
  return `msg_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export function useCogitatorChat(options: UseChatOptions): UseChatReturn {
  const { api, initialMessages, headers, onError, onFinish, onToolCall, onToolResult, retry } =
    options;

  const [state, dispatch] = useReducer(
    chatReducer,
    createInitialState(initialMessages, options.threadId)
  );

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleStreamEvent = useCallback(
    (event: StreamEvent, toolCalls: Map<string, { name: string; args: string }>) => {
      switch (event.type) {
        case 'start':
          dispatch({ type: 'START_ASSISTANT_MESSAGE', payload: event.messageId });
          break;

        case 'text-delta':
          dispatch({ type: 'APPEND_CONTENT', payload: event.delta });
          break;

        case 'tool-call-start':
          toolCalls.set(event.id, { name: event.toolName, args: '' });
          break;

        case 'tool-call-delta': {
          const tc = toolCalls.get(event.id);
          if (tc) {
            tc.args += event.argsTextDelta;
          }
          break;
        }

        case 'tool-call-end': {
          const tc = toolCalls.get(event.id);
          if (tc) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.args);
            } catch {}

            const toolCall: ToolCall = {
              id: event.id,
              name: tc.name,
              arguments: args,
            };

            dispatch({ type: 'ADD_TOOL_CALL', payload: toolCall });
            onToolCall?.(toolCall);
          }
          break;
        }

        case 'tool-result': {
          const toolResult: ToolResultEvent = {
            id: event.id,
            toolCallId: event.toolCallId,
            result: event.result,
          };
          onToolResult?.(toolResult);
          break;
        }

        case 'error':
          dispatch({ type: 'SET_ERROR', payload: new Error(event.message) });
          onError?.(new Error(event.message));
          break;
      }
    },
    [onError, onToolCall, onToolResult]
  );

  const processStream = useCallback(
    async (response: Response) => {
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const toolCalls = new Map<string, { name: string; args: string }>();

      try {
        for await (const event of parseSSEStream(reader)) {
          handleStreamEvent(event, toolCalls);
        }
      } finally {
        reader.releaseLock();
      }

      dispatch({ type: 'FINISH_ASSISTANT_MESSAGE' });
      dispatch({ type: 'STOP_LOADING' });

      if (onFinish && state.currentMessageId) {
        onFinish({
          id: state.currentMessageId,
          role: 'assistant',
          content: state.currentContent,
          toolCalls: state.currentToolCalls.length > 0 ? state.currentToolCalls : undefined,
        });
      }
    },
    [
      handleStreamEvent,
      onFinish,
      state.currentContent,
      state.currentMessageId,
      state.currentToolCalls,
    ]
  );

  const send = useCallback(
    async (inputOverride?: string, metadata?: Record<string, unknown>) => {
      const messageContent = inputOverride ?? state.input;
      if (!messageContent.trim()) return;

      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();

      const userMessage: ChatMessage = {
        id: generateClientId(),
        role: 'user',
        content: messageContent,
        metadata,
        createdAt: new Date(),
      };

      dispatch({ type: 'ADD_USER_MESSAGE', payload: userMessage });
      dispatch({ type: 'SET_INPUT', payload: '' });
      dispatch({ type: 'START_LOADING' });

      const allMessages = [...state.messages, userMessage];

      const doFetch = async () => {
        const response = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({
            messages: allMessages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              metadata: m.metadata,
            })),
            threadId: state.threadId,
            metadata,
          }),
          signal: abortControllerRef.current!.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || `HTTP ${response.status}`);
        }

        return response;
      };

      try {
        const response = await withRetry(doFetch, retry);
        await processStream(response);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          dispatch({ type: 'STOP_LOADING' });
          return;
        }

        const error = err instanceof Error ? err : new Error('Unknown error');
        dispatch({ type: 'SET_ERROR', payload: error });
        onError?.(error);
      }
    },
    [api, headers, onError, processStream, retry, state.input, state.messages, state.threadId]
  );

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    dispatch({ type: 'STOP_LOADING' });
  }, []);

  const reload = useCallback(async () => {
    if (state.messages.length === 0) return;

    let lastUserIndex = -1;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;

    const lastUserMessage = state.messages[lastUserIndex];
    const messagesBeforeReload = state.messages.slice(0, lastUserIndex);

    dispatch({ type: 'SET_MESSAGES', payload: messagesBeforeReload });
    await send(lastUserMessage.content, lastUserMessage.metadata);
  }, [send, state.messages]);

  const setInput = useCallback((value: string) => {
    dispatch({ type: 'SET_INPUT', payload: value });
  }, []);

  const setThreadId = useCallback((id: string) => {
    dispatch({ type: 'SET_THREAD_ID', payload: id });
  }, []);

  const appendMessage = useCallback((message: ChatMessage) => {
    dispatch({ type: 'APPEND_MESSAGE', payload: message });
  }, []);

  const clearMessages = useCallback(() => {
    dispatch({ type: 'CLEAR_MESSAGES' });
  }, []);

  const setMessages = useCallback((messages: ChatMessage[]) => {
    dispatch({ type: 'SET_MESSAGES', payload: messages });
  }, []);

  const displayMessages = state.currentMessageId
    ? [
        ...state.messages,
        {
          id: state.currentMessageId,
          role: 'assistant' as const,
          content: state.currentContent,
          toolCalls: state.currentToolCalls.length > 0 ? state.currentToolCalls : undefined,
        },
      ]
    : state.messages;

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
