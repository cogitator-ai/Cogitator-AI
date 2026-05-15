/**
 * LLM Debug Logger
 *
 * Wraps LLM backends with request/response logging for debugging.
 */

import type {
  LLMBackend,
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from '@cogitator-ai/types';

export interface LLMDebugOptions {
  enabled?: boolean;
  logRequest?: boolean;
  logResponse?: boolean;
  logStream?: boolean;
  logger?: LLMDebugLogger;
  redactApiKeys?: boolean;
  maxContentLength?: number;
}

export interface LLMDebugLogger {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

const defaultLogger: LLMDebugLogger = {
  log(level, message, data) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [LLM:${level.toUpperCase()}]`;
    if (data !== undefined) {
      console.log(prefix, message, JSON.stringify(data, null, 2));
    } else {
      console.log(prefix, message);
    }
  },
};

export class LLMDebugWrapper implements LLMBackend {
  readonly provider: LLMProvider;
  private backend: LLMBackend;
  private options: Required<LLMDebugOptions>;

  constructor(backend: LLMBackend, options: LLMDebugOptions = {}) {
    this.backend = backend;
    this.provider = backend.provider;
    this.options = {
      enabled: options.enabled ?? true,
      logRequest: options.logRequest ?? true,
      logResponse: options.logResponse ?? true,
      logStream: options.logStream ?? false,
      logger: options.logger ?? defaultLogger,
      redactApiKeys: options.redactApiKeys ?? true,
      maxContentLength: options.maxContentLength ?? 1000,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.options.enabled) {
      return this.backend.chat(request);
    }

    const requestId = this.generateRequestId();
    const startTime = Date.now();

    if (this.options.logRequest) {
      this.logRequest(requestId, request);
    }

    try {
      const response = await this.backend.chat(request);
      const duration = Date.now() - startTime;

      if (this.options.logResponse) {
        this.logResponse(requestId, response, duration);
      }

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logError(requestId, error, duration);
      throw error;
    }
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    if (!this.options.enabled) {
      yield* this.backend.chatStream(request);
      return;
    }

    const requestId = this.generateRequestId();
    const startTime = Date.now();

    if (this.options.logRequest) {
      this.logRequest(requestId, request, true);
    }

    let chunkCount = 0;
    let contentLength = 0;
    let contentPreview = '';
    let finalToolCalls: ChatStreamChunk['delta']['toolCalls'];
    let finalChunk: ChatStreamChunk | null = null;

    try {
      for await (const chunk of this.backend.chatStream(request)) {
        chunkCount++;
        if (chunk.delta.content) {
          contentLength += chunk.delta.content.length;
          contentPreview = this.appendTruncatedContent(contentPreview, chunk.delta.content);
        }
        if (chunk.delta.toolCalls) {
          finalToolCalls = chunk.delta.toolCalls;
        }

        if (this.options.logStream) {
          this.options.logger.log('debug', `[${requestId}] Stream chunk`, {
            id: chunk.id,
            hasContent: !!chunk.delta.content,
            hasToolCalls: !!chunk.delta.toolCalls,
            finishReason: chunk.finishReason,
          });
        }

        if (chunk.finishReason) {
          finalChunk = chunk;
        }
        yield chunk;
      }

      const duration = Date.now() - startTime;

      if (this.options.logResponse) {
        this.logStreamComplete(
          requestId,
          chunkCount,
          contentLength,
          contentPreview,
          finalToolCalls,
          finalChunk,
          duration
        );
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logError(requestId, error, duration);
      throw error;
    }
  }

  private generateRequestId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private logRequest(requestId: string, request: ChatRequest, isStream = false): void {
    const sanitized = this.sanitizeRequest(request);
    this.options.logger.log('info', `[${requestId}] ${isStream ? 'Stream' : 'Chat'} request`, {
      provider: this.provider,
      model: request.model,
      messageCount: request.messages.length,
      hasTools: !!(request.tools && request.tools.length > 0),
      toolCount: request.tools?.length ?? 0,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      messages: sanitized.messages,
      tools: request.tools?.map((t) => ({ name: t.name, description: t.description })),
    });
  }

  private logResponse(requestId: string, response: ChatResponse, duration: number): void {
    const truncatedContent = this.truncateContent(response.content);
    this.options.logger.log('info', `[${requestId}] Response`, {
      id: response.id,
      duration: `${duration}ms`,
      finishReason: response.finishReason,
      usage: response.usage,
      contentLength: response.content.length,
      content: truncatedContent,
      toolCalls: response.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        argumentsPreview: this.truncateContent(JSON.stringify(tc.arguments)),
      })),
    });
  }

  private logStreamComplete(
    requestId: string,
    chunkCount: number,
    contentLength: number,
    contentPreview: string,
    toolCalls: ChatStreamChunk['delta']['toolCalls'],
    finalChunk: ChatStreamChunk | null,
    duration: number
  ): void {
    this.options.logger.log('info', `[${requestId}] Stream complete`, {
      duration: `${duration}ms`,
      chunkCount,
      finishReason: finalChunk?.finishReason,
      usage: finalChunk?.usage,
      contentLength,
      content: contentPreview,
      toolCalls: toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        argumentsPreview: this.truncateContent(JSON.stringify(tc.arguments)),
      })),
    });
  }

  private logError(requestId: string, error: unknown, duration: number): void {
    this.options.logger.log('error', `[${requestId}] Request failed`, {
      duration: `${duration}ms`,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }

  private sanitizeRequest(request: ChatRequest): ChatRequest {
    return {
      ...request,
      messages: request.messages.map((m) => ({
        ...m,
        content:
          typeof m.content === 'string'
            ? this.truncateContent(m.content)
            : Array.isArray(m.content)
              ? m.content.map((p) => {
                  if (p.type === 'text') return { ...p, text: this.truncateContent(p.text) };
                  if (p.type === 'image_url')
                    return {
                      type: 'image_url',
                      image_url: { url: '[image]', detail: p.image_url.detail },
                    };
                  if (p.type === 'image_base64')
                    return {
                      type: 'image_base64',
                      image_base64: {
                        data: `[base64 ${p.image_base64.media_type}]`,
                        media_type: p.image_base64.media_type,
                      },
                    };
                  return p;
                })
              : m.content,
      })),
    };
  }

  private truncateContent(content: string): string {
    if (content.length <= this.options.maxContentLength) {
      return content;
    }
    return content.substring(0, this.options.maxContentLength) + '... [truncated]';
  }

  private appendTruncatedContent(current: string, next: string): string {
    if (current.endsWith('... [truncated]')) {
      return current;
    }
    return this.truncateContent(current + next);
  }
}

export function withDebug(backend: LLMBackend, options?: LLMDebugOptions): LLMBackend {
  return new LLMDebugWrapper(backend, options);
}
