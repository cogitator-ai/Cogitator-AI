/**
 * Base LLM Backend interface
 */

import type {
  LLMBackend,
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator/types';

export abstract class BaseLLMBackend implements LLMBackend {
  abstract readonly provider: LLMProvider;

  abstract chat(request: ChatRequest): Promise<ChatResponse>;

  abstract chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;

  protected generateId(): string {
    return `chatcmpl-${Date.now().toString()}-${Math.random().toString(36).substring(7)}`;
  }
}
