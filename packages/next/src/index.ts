export { createChatHandler } from './handlers/chat.js';
export { createAgentHandler } from './handlers/agent.js';

export type {
  ChatMessage,
  ChatInput,
  AgentInput,
  ChatHandlerOptions,
  AgentHandlerOptions,
  AgentResponse,
  ToolCall,
  ToolResult,
  RunResult,
} from './types.js';

export { StreamWriter } from './streaming/stream-writer.js';
export { encodeSSE, generateId } from './streaming/encoder.js';
export type { StreamEvent, Usage } from './streaming/protocol.js';
