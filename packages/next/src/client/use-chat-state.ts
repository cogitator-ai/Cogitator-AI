import type { ChatMessage, ToolCall } from '../types.js';

export interface ChatState {
  messages: ChatMessage[];
  input: string;
  isLoading: boolean;
  error: Error | null;
  threadId: string | undefined;
  currentMessageId: string | null;
  currentContent: string;
  currentToolCalls: ToolCall[];
}

export type ChatAction =
  | { type: 'SET_INPUT'; payload: string }
  | { type: 'SET_THREAD_ID'; payload: string }
  | { type: 'START_LOADING' }
  | { type: 'STOP_LOADING' }
  | { type: 'SET_ERROR'; payload: Error | null }
  | { type: 'ADD_USER_MESSAGE'; payload: ChatMessage }
  | { type: 'APPEND_MESSAGE'; payload: ChatMessage }
  | { type: 'START_ASSISTANT_MESSAGE'; payload: string }
  | { type: 'APPEND_CONTENT'; payload: string }
  | { type: 'ADD_TOOL_CALL'; payload: ToolCall }
  | { type: 'FINISH_ASSISTANT_MESSAGE' }
  | { type: 'REMOVE_LAST_MESSAGE' }
  | { type: 'SET_MESSAGES'; payload: ChatMessage[] }
  | { type: 'CLEAR_MESSAGES' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_INPUT':
      return { ...state, input: action.payload };

    case 'SET_THREAD_ID':
      return { ...state, threadId: action.payload };

    case 'START_LOADING':
      return { ...state, isLoading: true, error: null };

    case 'STOP_LOADING':
      return { ...state, isLoading: false };

    case 'SET_ERROR':
      return { ...state, error: action.payload, isLoading: false };

    case 'ADD_USER_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload] };

    case 'APPEND_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload] };

    case 'START_ASSISTANT_MESSAGE':
      return {
        ...state,
        currentMessageId: action.payload,
        currentContent: '',
        currentToolCalls: [],
      };

    case 'APPEND_CONTENT':
      return { ...state, currentContent: state.currentContent + action.payload };

    case 'ADD_TOOL_CALL':
      return { ...state, currentToolCalls: [...state.currentToolCalls, action.payload] };

    case 'FINISH_ASSISTANT_MESSAGE': {
      if (!state.currentMessageId) return state;

      const assistantMessage: ChatMessage = {
        id: state.currentMessageId,
        role: 'assistant',
        content: state.currentContent,
        toolCalls: state.currentToolCalls.length > 0 ? state.currentToolCalls : undefined,
        createdAt: new Date(),
      };

      return {
        ...state,
        messages: [...state.messages, assistantMessage],
        currentMessageId: null,
        currentContent: '',
        currentToolCalls: [],
      };
    }

    case 'REMOVE_LAST_MESSAGE':
      return { ...state, messages: state.messages.slice(0, -1) };

    case 'SET_MESSAGES':
      return { ...state, messages: action.payload };

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };

    default:
      return state;
  }
}

export function createInitialState(initialMessages?: ChatMessage[], threadId?: string): ChatState {
  return {
    messages: initialMessages ?? [],
    input: '',
    isLoading: false,
    error: null,
    threadId,
    currentMessageId: null,
    currentContent: '',
    currentToolCalls: [],
  };
}
