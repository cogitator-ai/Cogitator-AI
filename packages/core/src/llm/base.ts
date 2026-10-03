/**
 * Base LLM Backend interface
 */

import type {
  LLMBackend,
  LLMBackendProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator-ai/types';

export abstract class BaseLLMBackend implements LLMBackend {
  abstract readonly provider: LLMBackendProvider;

  abstract chat(request: ChatRequest): Promise<ChatResponse>;

  abstract chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;

  protected generateId(): string {
    return `chatcmpl-${Date.now().toString()}-${Math.random().toString(36).substring(7)}`;
  }
}
