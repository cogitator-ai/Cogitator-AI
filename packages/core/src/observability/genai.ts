import { CogitatorError } from '@cogitator-ai/types';
import type {
  ChatRequest,
  ChatResponse,
  FinishReason,
  LLMBackendProvider,
  Message,
  Span,
  ToolCall,
  ToolCallMessage,
  ToolSchema,
} from '@cogitator-ai/types';

/**
 * Attributes of the OpenTelemetry GenAI semantic conventions
 * (github.com/open-telemetry/semantic-conventions-genai), recorded next to Cogitator's own
 * `llm.*`, `tool.*` and `run.*` attributes.
 */
export const GEN_AI = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  requestTemperature: 'gen_ai.request.temperature',
  requestTopP: 'gen_ai.request.top_p',
  requestMaxTokens: 'gen_ai.request.max_tokens',
  requestStopSequences: 'gen_ai.request.stop_sequences',
  requestStream: 'gen_ai.request.stream',
  outputType: 'gen_ai.output.type',
  responseId: 'gen_ai.response.id',
  responseModel: 'gen_ai.response.model',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  responseTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  usageCacheWriteInputTokens: 'gen_ai.usage.cache_write.input_tokens',
  usageReasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',
  conversationId: 'gen_ai.conversation.id',
  agentId: 'gen_ai.agent.id',
  agentName: 'gen_ai.agent.name',
  agentDescription: 'gen_ai.agent.description',
  workflowName: 'gen_ai.workflow.name',
  toolName: 'gen_ai.tool.name',
  toolType: 'gen_ai.tool.type',
  toolCallId: 'gen_ai.tool.call.id',
  toolCallArguments: 'gen_ai.tool.call.arguments',
  toolCallResult: 'gen_ai.tool.call.result',
  toolDefinitions: 'gen_ai.tool.definitions',
  systemInstructions: 'gen_ai.system_instructions',
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  errorType: 'error.type',
} as const;

/** Attributes the convention types as doubles, whole numbers among their values included. */
export const GEN_AI_DOUBLE_ATTRIBUTES: ReadonlySet<string> = new Set([
  GEN_AI.requestTemperature,
  GEN_AI.requestTopP,
  GEN_AI.responseTimeToFirstChunk,
  'gen_ai.request.frequency_penalty',
  'gen_ai.request.presence_penalty',
]);

/** The attributes that carry model and tool content, recorded only on opt-in. */
export const GEN_AI_CONTENT_ATTRIBUTES: readonly string[] = [
  GEN_AI.systemInstructions,
  GEN_AI.inputMessages,
  GEN_AI.outputMessages,
  GEN_AI.toolDefinitions,
  GEN_AI.toolCallArguments,
  GEN_AI.toolCallResult,
];

/** `span` without the content attributes, the span itself when it has none. */
export function withoutContent(span: Span): Span {
  if (!GEN_AI_CONTENT_ATTRIBUTES.some((key) => key in span.attributes)) return span;
  const attributes = { ...span.attributes };
  for (const key of GEN_AI_CONTENT_ATTRIBUTES) delete attributes[key];
  return { ...span, attributes };
}

const PROVIDER_NAMES: Partial<Record<string, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gcp.gemini',
  azure: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
  mistral: 'mistral',
  groq: 'groq',
  deepseek: 'deepseek',
};

/**
 * `gen_ai.provider.name` of a backend: the convention's well-known value where it has one
 * (`google` is the Gemini API, `gcp.gemini`), else the backend's own name (`ollama`, `vllm`,
 * `openrouter`, a custom backend).
 */
export function genAiProviderName(provider: LLMBackendProvider): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

const FINISH_REASONS: Record<FinishReason, string> = {
  stop: 'stop',
  tool_calls: 'tool_call',
  length: 'length',
  content_filter: 'content_filter',
  refusal: 'content_filter',
  error: 'error',
};

/** The convention's finish reason for a Cogitator one. */
export function genAiFinishReason(reason: FinishReason): string {
  return FINISH_REASONS[reason];
}

type Part =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_call_response'; id: string | null; response: string }
  | { type: 'uri'; modality: 'image'; uri: string }
  | { type: 'blob'; modality: 'image'; mime_type: string; content: string };

interface GenAiMessage {
  role: string;
  parts: Part[];
  name?: string;
  finish_reason?: string;
}

function contentParts(content: Message['content']): Part[] {
  if (typeof content === 'string') return content ? [{ type: 'text', content }] : [];
  return content.map((part): Part => {
    switch (part.type) {
      case 'text':
        return { type: 'text', content: part.text };
      case 'image_url':
        return { type: 'uri', modality: 'image', uri: part.image_url.url };
      case 'image_base64':
        return {
          type: 'blob',
          modality: 'image',
          mime_type: part.image_base64.media_type,
          content: part.image_base64.data,
        };
    }
  });
}

function toolCallParts(toolCalls: readonly ToolCall[] | undefined): Part[] {
  return (toolCalls ?? []).map((call) => ({
    type: 'tool_call',
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));
}

function hasToolCalls(message: Message): message is ToolCallMessage {
  return Array.isArray((message as Partial<ToolCallMessage>).toolCalls);
}

function inputMessage(message: Message): GenAiMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      parts: [
        {
          type: 'tool_call_response',
          id: message.toolCallId ?? null,
          response: typeof message.content === 'string' ? message.content : '',
        },
      ],
    };
  }
  return {
    role: message.role,
    parts: [
      ...contentParts(message.content),
      ...toolCallParts(hasToolCalls(message) ? message.toolCalls : undefined),
    ],
    ...(message.name && { name: message.name }),
  };
}

/**
 * The content attributes of a model call, in the convention's JSON shapes: the system messages
 * as `gen_ai.system_instructions`, the rest as `gen_ai.input.messages`, the answer as
 * `gen_ai.output.messages`, and the tools offered as `gen_ai.tool.definitions`.
 */
export function chatContentAttributes(
  request: ChatRequest,
  response: ChatResponse
): Record<string, string> {
  const system = request.messages.filter((message) => message.role === 'system');
  const input = request.messages.filter((message) => message.role !== 'system');
  const output: GenAiMessage = {
    role: 'assistant',
    parts: [
      ...(response.reasoning ? [{ type: 'reasoning' as const, content: response.reasoning }] : []),
      ...(response.content ? [{ type: 'text' as const, content: response.content }] : []),
      ...toolCallParts(response.toolCalls),
    ],
    finish_reason: genAiFinishReason(response.finishReason),
  };
  return {
    ...(system.length > 0 && {
      [GEN_AI.systemInstructions]: JSON.stringify(
        system.flatMap((message) => contentParts(message.content))
      ),
    }),
    [GEN_AI.inputMessages]: JSON.stringify(input.map(inputMessage)),
    [GEN_AI.outputMessages]: JSON.stringify([output]),
    ...(request.tools &&
      request.tools.length > 0 && {
        [GEN_AI.toolDefinitions]: JSON.stringify(request.tools.map(toolDefinition)),
      }),
  };
}

function toolDefinition(tool: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/** The request attributes of a model call: model, sampling parameters and streaming. */
export function chatRequestAttributes(request: ChatRequest): Record<string, unknown> {
  return {
    [GEN_AI.requestModel]: request.model,
    ...(request.temperature !== undefined && { [GEN_AI.requestTemperature]: request.temperature }),
    ...(request.topP !== undefined && { [GEN_AI.requestTopP]: request.topP }),
    ...(request.maxTokens !== undefined && { [GEN_AI.requestMaxTokens]: request.maxTokens }),
    ...(request.stop &&
      request.stop.length > 0 && { [GEN_AI.requestStopSequences]: [...request.stop] }),
    ...(request.stream && { [GEN_AI.requestStream]: true }),
    ...(request.responseFormat &&
      request.responseFormat.type !== 'text' && { [GEN_AI.outputType]: 'json' }),
  };
}

/** The response attributes of a model call: id, model, finish reason and token usage. */
export function chatResponseAttributes(response: ChatResponse): Record<string, unknown> {
  const { usage } = response;
  return {
    ...(response.id && { [GEN_AI.responseId]: response.id }),
    [GEN_AI.responseFinishReasons]: [genAiFinishReason(response.finishReason)],
    [GEN_AI.usageInputTokens]: usage.inputTokens,
    [GEN_AI.usageOutputTokens]: usage.outputTokens,
    ...(usage.cachedInputTokens && { [GEN_AI.usageCacheReadInputTokens]: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens && { [GEN_AI.usageCacheWriteInputTokens]: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens && { [GEN_AI.usageReasoningOutputTokens]: usage.reasoningTokens }),
  };
}

/**
 * The name the convention gives a span, `{gen_ai.operation.name} {target}` (`chat gpt-5`,
 * `execute_tool search`, `invoke_agent researcher`), or `undefined` for a span that is not a
 * GenAI operation.
 */
export function genAiSpanName(attributes: Record<string, unknown>): string | undefined {
  const operation = attributes[GEN_AI.operationName];
  if (typeof operation !== 'string') return undefined;
  const target = {
    chat: attributes[GEN_AI.requestModel],
    execute_tool: attributes[GEN_AI.toolName],
    invoke_agent: attributes[GEN_AI.agentName],
    invoke_workflow: attributes[GEN_AI.workflowName],
  }[operation];
  return typeof target === 'string' && target ? `${operation} ${target}` : operation;
}

/** `error.type` of a tool call whose tool failed. */
export const TOOL_ERROR_TYPE = 'tool_error';

/**
 * `error.type` of a failed operation: the Cogitator error code (`RUN_TIMEOUT`, `LLM_RATE_LIMIT`),
 * else the error's class name, else the convention's fallback `_OTHER`.
 */
export function errorType(error: unknown): string {
  if (error instanceof CogitatorError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return '_OTHER';
}

/** The attributes of an agent's `invoke_agent` span: the agent, its model and the conversation. */
export function invokeAgentAttributes(
  agent: { id: string; name: string; config?: { description?: string } },
  conversationId: string | undefined,
  model: string | undefined
): Record<string, unknown> {
  return {
    [GEN_AI.operationName]: 'invoke_agent',
    [GEN_AI.agentId]: agent.id,
    [GEN_AI.agentName]: agent.name,
    ...(agent.config?.description && { [GEN_AI.agentDescription]: agent.config.description }),
    ...(model && { [GEN_AI.requestModel]: model }),
    ...(conversationId && { [GEN_AI.conversationId]: conversationId }),
  };
}
