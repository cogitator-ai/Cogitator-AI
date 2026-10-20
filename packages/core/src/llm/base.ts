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
import { abortReason } from './errors';

export abstract class BaseLLMBackend implements LLMBackend {
  abstract readonly provider: LLMBackendProvider;

  abstract chat(request: ChatRequest): Promise<ChatResponse>;

  abstract chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;

  /**
   * The chunks of `chunks`, its errors rethrown as `wrap` makes them, or as the caller's abort
   * reason when the caller aborted. An abort the caller's signal did not make, such as one of a
   * signal of the caller's own the SDK passed on, goes on as it is. A stream that ends quietly
   * after the caller aborted, as the OpenAI SDK's does, fails with the abort reason too, so a
   * cut-off answer is never taken for a whole one.
   */
  protected async *guardStream<T>(
    chunks: AsyncIterable<T>,
    signal: AbortSignal | undefined,
    wrap: (error: unknown) => Error
  ): AsyncGenerator<T> {
    try {
      for await (const chunk of chunks) yield chunk;
    } catch (error) {
      throw abortReason(signal) ?? (isAbortError(error) ? error : wrap(error));
    }
    const aborted = abortReason(signal);
    if (aborted) throw aborted;
  }

  protected generateId(): string {
    return `chatcmpl-${Date.now().toString()}-${Math.random().toString(36).substring(7)}`;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
