import type {
  LLMBackend,
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  Message,
  CapturedPrompt,
  PromptStore,
} from '@cogitator-ai/types';

export interface PromptLoggerContext {
  runId: string;
  agentId: string;
  threadId: string;
  injectedDemos?: string;
  injectedInsights?: string;
}

export interface PromptLoggerConfig {
  enabled?: boolean;
  captureContent?: boolean;
  captureTools?: boolean;
}

export class PromptLogger implements LLMBackend {
  readonly provider: LLMProvider;

  private backend: LLMBackend;
  private store: Pick<PromptStore, 'capture'>;
  private config: Required<PromptLoggerConfig>;
  private context: PromptLoggerContext | null = null;

  constructor(
    backend: LLMBackend,
    store: Pick<PromptStore, 'capture'>,
    config: PromptLoggerConfig = {}
  ) {
    this.backend = backend;
    this.store = store;
    this.provider = backend.provider;
    this.config = {
      enabled: config.enabled ?? true,
      captureContent: config.captureContent ?? true,
      captureTools: config.captureTools ?? true,
    };
  }

  setContext(context: PromptLoggerContext): void {
    this.context = context;
  }

  clearContext(): void {
    this.context = null;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.config.enabled || !this.context) {
      return this.backend.chat(request);
    }

    const startTime = Date.now();
    const promptId = this.generateId();

    const systemPrompt = this.extractSystemPrompt(request.messages);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    const captured: CapturedPrompt = {
      id: promptId,
      runId: this.context.runId,
      agentId: this.context.agentId,
      threadId: this.context.threadId,
      model: request.model,
      provider: this.provider,
      timestamp: new Date(),

      systemPrompt,
      messages: this.config.captureContent ? nonSystemMessages : [],
      tools: this.config.captureTools ? request.tools : undefined,
      injectedDemos: this.context.injectedDemos,
      injectedInsights: this.context.injectedInsights,

      temperature: request.temperature,
      topP: request.topP,
      maxTokens: request.maxTokens,

      promptTokens: 0,
    };

    try {
      const response = await this.backend.chat(request);
      const latencyMs = Date.now() - startTime;

      captured.promptTokens = response.usage.inputTokens;
      captured.response = {
        content: this.config.captureContent ? response.content : '',
        toolCalls: response.toolCalls,
        completionTokens: response.usage.outputTokens,
        finishReason: response.finishReason,
        latencyMs,
      };

      await this.captureSafely(captured);

      return response;
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      captured.response = {
        content: '',
        completionTokens: 0,
        finishReason: 'error',
        latencyMs,
      };
      captured.metadata = {
        error: error instanceof Error ? error.message : String(error),
      };

      await this.captureSafely(captured);

      throw error;
    }
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    if (!this.config.enabled || !this.context) {
      yield* this.backend.chatStream(request);
      return;
    }

    const startTime = Date.now();
    const promptId = this.generateId();

    const systemPrompt = this.extractSystemPrompt(request.messages);
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    const captured: CapturedPrompt = {
      id: promptId,
      runId: this.context.runId,
      agentId: this.context.agentId,
      threadId: this.context.threadId,
      model: request.model,
      provider: this.provider,
      timestamp: new Date(),

      systemPrompt,
      messages: this.config.captureContent ? nonSystemMessages : [],
      tools: this.config.captureTools ? request.tools : undefined,
      injectedDemos: this.context.injectedDemos,
      injectedInsights: this.context.injectedInsights,

      temperature: request.temperature,
      topP: request.topP,
      maxTokens: request.maxTokens,

      promptTokens: 0,
    };

    let fullContent = '';
    let finalUsage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string = 'stop';
    let hasError = false;

    try {
      for await (const chunk of this.backend.chatStream(request)) {
        if (chunk.delta.content) {
          fullContent += chunk.delta.content;
        }
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
        if (chunk.usage) {
          finalUsage = {
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
          };
        }
        yield chunk;
      }
    } catch (error) {
      hasError = true;
      finishReason = 'error';
      captured.metadata = {
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      const latencyMs = Date.now() - startTime;

      captured.promptTokens = finalUsage.inputTokens;
      captured.response = {
        content: this.config.captureContent ? fullContent : '',
        completionTokens: finalUsage.outputTokens,
        finishReason: hasError ? 'error' : finishReason,
        latencyMs,
      };

      await this.captureSafely(captured);
    }
  }

  private extractSystemPrompt(messages: Message[]): string {
    const systemMessages = messages.filter((m) => m.role === 'system');
    return systemMessages.map((m) => m.content).join('\n\n');
  }

  private generateId(): string {
    return `prompt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private async captureSafely(prompt: CapturedPrompt): Promise<void> {
    try {
      await this.store.capture(prompt);
    } catch {
      return;
    }
  }
}

export function wrapWithPromptLogger(
  backend: LLMBackend,
  store: Pick<PromptStore, 'capture'>,
  config?: PromptLoggerConfig
): PromptLogger {
  return new PromptLogger(backend, store, config);
}
