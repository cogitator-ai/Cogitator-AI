import { nanoid } from 'nanoid';
import type {
  LLMBackend,
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ToolCall,
} from '@cogitator-ai/types';

export interface MockChatResponse extends Partial<ChatResponse> {
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: ChatResponse['finishReason'];
  error?: Error;
  delay?: number;
}

export interface MockStreamChunk {
  content?: string;
  toolCalls?: Partial<ToolCall>[];
  finishReason?: ChatStreamChunk['finishReason'];
  delay?: number;
}

export class MockLLMBackend implements LLMBackend {
  readonly provider: LLMProvider = 'openai';

  private responses: MockChatResponse[] = [];
  private streamChunks: MockStreamChunk[][] = [];
  private _calls: ChatRequest[] = [];
  private responseIndex = 0;
  private streamIndex = 0;
  private defaultDelay = 0;

  setResponse(response: MockChatResponse): this {
    this.responses = [response];
    this.responseIndex = 0;
    return this;
  }

  setResponses(responses: MockChatResponse[]): this {
    this.responses = responses;
    this.responseIndex = 0;
    return this;
  }

  setToolCallResponse(toolCalls: ToolCall[], content = ''): this {
    return this.setResponse({
      content,
      toolCalls,
      finishReason: 'tool_calls',
    });
  }

  setStreamChunks(chunks: MockStreamChunk[]): this {
    this.streamChunks = [chunks];
    this.streamIndex = 0;
    return this;
  }

  setMultipleStreamChunks(chunksArray: MockStreamChunk[][]): this {
    this.streamChunks = chunksArray;
    this.streamIndex = 0;
    return this;
  }

  setDefaultDelay(ms: number): this {
    this.defaultDelay = ms;
    return this;
  }

  getCalls(): ChatRequest[] {
    return [...this._calls];
  }

  getLastCall(): ChatRequest | undefined {
    return this._calls[this._calls.length - 1];
  }

  getCallCount(): number {
    return this._calls.length;
  }

  wasCalledWith(predicate: (req: ChatRequest) => boolean): boolean {
    return this._calls.some(predicate);
  }

  reset(): void {
    this._calls = [];
    this.responses = [];
    this.streamChunks = [];
    this.responseIndex = 0;
    this.streamIndex = 0;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this._calls.push(snapshot(request));

    const mockResponse = this.responses[this.responseIndex] ?? this.responses[0];
    if (this.responseIndex < this.responses.length - 1) {
      this.responseIndex++;
    }

    if (mockResponse?.error) {
      throw mockResponse.error;
    }

    const delay = mockResponse?.delay ?? this.defaultDelay;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const id = `mock_${nanoid(8)}`;
    const content = mockResponse?.content ?? '';
    const toolCalls = mockResponse?.toolCalls;
    const finishReason = mockResponse?.finishReason ?? (toolCalls ? 'tool_calls' : 'stop');

    const inputTokens = mockResponse?.usage?.inputTokens ?? this.estimateTokens(request.messages);
    const outputTokens = mockResponse?.usage?.outputTokens ?? Math.ceil(content.length / 4);

    return {
      id,
      content,
      toolCalls,
      finishReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...mockResponse?.usage,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    this._calls.push(snapshot(request));

    const chunks = this.streamChunks[this.streamIndex] ?? this.streamChunks[0] ?? [];
    if (this.streamIndex < this.streamChunks.length - 1) {
      this.streamIndex++;
    }

    const id = `mock_stream_${nanoid(8)}`;
    let totalContent = '';

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const delay = chunk.delay ?? this.defaultDelay;

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (chunk.content) {
        totalContent += chunk.content;
      }

      const isLast = i === chunks.length - 1;
      const inputTokens = this.estimateTokens(request.messages);
      const outputTokens = Math.ceil(totalContent.length / 4);

      yield {
        id,
        delta: {
          content: chunk.content,
          toolCalls: chunk.toolCalls,
        },
        finishReason: isLast ? (chunk.finishReason ?? 'stop') : undefined,
        usage: isLast
          ? {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            }
          : undefined,
      };
    }

    if (chunks.length === 0) {
      yield {
        id,
        delta: { content: '' },
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }

  private estimateTokens(messages: ChatRequest['messages']): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4);
      }
    }
    return Math.max(total, 1);
  }
}

export function createMockLLMBackend(): MockLLMBackend {
  return new MockLLMBackend();
}

/**
 * The request as it was sent: callers keep appending to the same messages
 * array, so a recorded call would otherwise show the final conversation.
 */
function snapshot(request: ChatRequest): ChatRequest {
  return {
    ...request,
    messages: [...request.messages],
    ...(request.tools && { tools: [...request.tools] }),
    ...(request.stop && { stop: [...request.stop] }),
  };
}
