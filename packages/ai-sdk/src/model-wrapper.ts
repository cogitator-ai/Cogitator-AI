import type { LanguageModelV1 } from '@ai-sdk/provider';
import type {
  LLMBackend,
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  Message,
  ToolCall,
  ContentPart,
  ToolSchema,
} from '@cogitator-ai/types';

function convertMessagesToCoreMessages(
  messages: Message[]
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages.map((msg) => {
    let content: string;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else {
      content = msg.content
        .filter((p: ContentPart): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p: { type: 'text'; text: string }) => p.text)
        .join('\n');
    }

    let role: 'system' | 'user' | 'assistant';
    if (msg.role === 'tool') {
      role = 'user';
      content = `[Tool result for ${msg.name}]: ${content}`;
    } else {
      role = msg.role as 'system' | 'user' | 'assistant';
    }

    return { role, content };
  });
}

function parseToolCallsFromResponse(
  response: Awaited<ReturnType<LanguageModelV1['doGenerate']>>
): ToolCall[] | undefined {
  if (!response.toolCalls || response.toolCalls.length === 0) {
    return undefined;
  }

  return response.toolCalls.map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    arguments: JSON.parse(tc.args) as Record<string, unknown>,
  }));
}

function mapFinishReason(reason: string): 'stop' | 'tool_calls' | 'length' | 'error' {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

export class AISDKBackend implements LLMBackend {
  readonly provider: LLMProvider;

  private model: LanguageModelV1;

  constructor(model: LanguageModelV1) {
    this.model = model;
    this.provider = (model.provider ?? 'ai-sdk') as LLMProvider;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const coreMessages = convertMessagesToCoreMessages(request.messages);

    const systemMessage = coreMessages.find((m) => m.role === 'system');
    const nonSystemMessages = coreMessages.filter((m) => m.role !== 'system');

    const prompt = nonSystemMessages.map((msg) => {
      if (msg.role === 'user') {
        return {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: msg.content }],
        };
      }
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: msg.content }],
      };
    });

    const toolsConfig = request.tools?.map((tool: ToolSchema) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    }));

    const response = await this.model.doGenerate({
      inputFormat: 'prompt',
      mode:
        toolsConfig && toolsConfig.length > 0
          ? { type: 'regular', tools: toolsConfig }
          : { type: 'regular' },
      prompt: [
        ...(systemMessage ? [{ role: 'system' as const, content: systemMessage.content }] : []),
        ...prompt,
      ],
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      topP: request.topP,
      stopSequences: request.stop,
      abortSignal: undefined,
      headers: {},
    });

    const toolCalls = parseToolCallsFromResponse(response);

    return {
      id: `aisdk-${Date.now()}`,
      content: response.text ?? '',
      toolCalls,
      finishReason: mapFinishReason(response.finishReason),
      usage: {
        inputTokens: response.usage.promptTokens,
        outputTokens: response.usage.completionTokens,
        totalTokens: response.usage.promptTokens + response.usage.completionTokens,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const coreMessages = convertMessagesToCoreMessages(request.messages);

    const systemMessage = coreMessages.find((m) => m.role === 'system');
    const nonSystemMessages = coreMessages.filter((m) => m.role !== 'system');

    const prompt = nonSystemMessages.map((msg) => {
      if (msg.role === 'user') {
        return {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: msg.content }],
        };
      }
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: msg.content }],
      };
    });

    const toolsConfig = request.tools?.map((tool: ToolSchema) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    }));

    const { stream } = await this.model.doStream({
      inputFormat: 'prompt',
      mode:
        toolsConfig && toolsConfig.length > 0
          ? { type: 'regular', tools: toolsConfig }
          : { type: 'regular' },
      prompt: [
        ...(systemMessage ? [{ role: 'system' as const, content: systemMessage.content }] : []),
        ...prompt,
      ],
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      topP: request.topP,
      stopSequences: request.stop,
      abortSignal: undefined,
      headers: {},
    });

    const reader = stream.getReader();
    const chunkId = `aisdk-stream-${Date.now()}`;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const pendingToolCalls: ToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.type === 'text-delta') {
          yield {
            id: chunkId,
            delta: { content: value.textDelta },
          };
        } else if (value.type === 'tool-call') {
          const toolCall: ToolCall = {
            id: value.toolCallId,
            name: value.toolName,
            arguments: JSON.parse(value.args) as Record<string, unknown>,
          };
          pendingToolCalls.push(toolCall);
          yield {
            id: chunkId,
            delta: { toolCalls: [toolCall] },
          };
        } else if (value.type === 'finish') {
          totalInputTokens = value.usage?.promptTokens ?? 0;
          totalOutputTokens = value.usage?.completionTokens ?? 0;

          yield {
            id: chunkId,
            delta: {},
            finishReason: mapFinishReason(value.finishReason),
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens: totalInputTokens + totalOutputTokens,
            },
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function fromAISDK(model: LanguageModelV1): LLMBackend {
  return new AISDKBackend(model);
}
