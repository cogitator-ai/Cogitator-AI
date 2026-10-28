import type {
  ChatDataPart,
  ChatMessage,
  PendingApproval,
  PendingInterrupt,
  ToolCall,
} from '../types.js';

export interface ChatState {
  messages: ChatMessage[];
  input: string;
  isLoading: boolean;
  error: Error | null;
  threadId: string | undefined;
  currentMessageId: string | null;
  currentContent: string;
  currentReasoning: string;
  currentToolCalls: ToolCall[];
  currentData: ChatDataPart[];
  pendingApprovals: PendingApproval[];
  pendingInterrupts: PendingInterrupt[];
  /** The run's state, see `UseChatReturn.state` */
  agentState: unknown;
}

export type ChatAction =
  | { type: 'SET_INPUT'; payload: string }
  | { type: 'SET_THREAD_ID'; payload: string | undefined }
  | { type: 'START_LOADING' }
  | { type: 'STOP_LOADING' }
  | { type: 'SET_ERROR'; payload: Error | null }
  | { type: 'ADD_USER_MESSAGE'; payload: ChatMessage }
  | { type: 'APPEND_MESSAGE'; payload: ChatMessage }
  | { type: 'START_ASSISTANT_MESSAGE'; payload: string }
  | { type: 'APPEND_CONTENT'; payload: string }
  | { type: 'APPEND_REASONING'; payload: string }
  | { type: 'ADD_TOOL_CALL'; payload: ToolCall }
  | { type: 'REMOVE_TOOL_CALL'; payload: string }
  | { type: 'UPDATE_TOOL_CALL'; payload: ToolCall }
  | { type: 'UPSERT_DATA'; payload: ChatDataPart }
  | { type: 'SET_AGENT_STATE'; payload: unknown }
  | {
      type: 'RESET_STEP';
      payload: { content: number; reasoning: number; toolCallIds: readonly string[] };
    }
  | { type: 'FINISH_ASSISTANT_MESSAGE' }
  | { type: 'SET_PENDING_APPROVALS'; payload: PendingApproval[] }
  | { type: 'SET_PENDING_INTERRUPTS'; payload: PendingInterrupt[] }
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
      return { ...state, error: action.payload };

    case 'ADD_USER_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload] };

    case 'APPEND_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload] };

    case 'START_ASSISTANT_MESSAGE':
      return {
        ...state,
        currentMessageId: action.payload,
        currentContent: '',
        currentReasoning: '',
        currentToolCalls: [],
        currentData: [],
      };

    case 'APPEND_CONTENT':
      return { ...state, currentContent: state.currentContent + action.payload };

    case 'APPEND_REASONING':
      return { ...state, currentReasoning: state.currentReasoning + action.payload };

    case 'ADD_TOOL_CALL':
      return { ...state, currentToolCalls: [...state.currentToolCalls, action.payload] };

    case 'UPDATE_TOOL_CALL':
      return {
        ...state,
        currentToolCalls: state.currentToolCalls.map((call) =>
          call.id === action.payload.id ? action.payload : call
        ),
      };

    case 'UPSERT_DATA': {
      const at = state.currentData.findIndex((part) => part.id === action.payload.id);
      const currentData =
        at === -1
          ? [...state.currentData, action.payload]
          : state.currentData.map((part, i) => (i === at ? action.payload : part));
      return { ...state, currentData };
    }

    case 'SET_AGENT_STATE':
      return { ...state, agentState: action.payload };

    case 'RESET_STEP': {
      const { content, reasoning, toolCallIds } = action.payload;
      return {
        ...state,
        currentContent: state.currentContent.slice(
          0,
          Math.max(0, state.currentContent.length - content)
        ),
        currentReasoning: state.currentReasoning.slice(
          0,
          Math.max(0, state.currentReasoning.length - reasoning)
        ),
        currentToolCalls: state.currentToolCalls.filter((call) => !toolCallIds.includes(call.id)),
      };
    }

    case 'REMOVE_TOOL_CALL':
      return {
        ...state,
        currentToolCalls: state.currentToolCalls.filter((call) => call.id !== action.payload),
      };

    case 'FINISH_ASSISTANT_MESSAGE': {
      if (!state.currentMessageId) return state;

      const assistantMessage: ChatMessage = {
        id: state.currentMessageId,
        role: 'assistant',
        content: state.currentContent,
        ...(state.currentReasoning && { reasoning: state.currentReasoning }),
        toolCalls: state.currentToolCalls.length > 0 ? state.currentToolCalls : undefined,
        ...(state.currentData.length > 0 && { data: state.currentData }),
        createdAt: new Date(),
      };

      return {
        ...state,
        messages: [...state.messages, assistantMessage],
        currentMessageId: null,
        currentContent: '',
        currentReasoning: '',
        currentToolCalls: [],
        currentData: [],
      };
    }

    case 'SET_PENDING_APPROVALS':
      if (action.payload.length === 0 && state.pendingApprovals.length === 0) return state;
      return { ...state, pendingApprovals: action.payload };

    case 'SET_PENDING_INTERRUPTS':
      if (action.payload.length === 0 && state.pendingInterrupts.length === 0) return state;
      return { ...state, pendingInterrupts: action.payload };

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
    currentReasoning: '',
    currentToolCalls: [],
    currentData: [],
    pendingApprovals: [],
    pendingInterrupts: [],
    agentState: undefined,
  };
}
