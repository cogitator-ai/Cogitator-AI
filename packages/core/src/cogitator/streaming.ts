import { nanoid } from 'nanoid';
import type {
  ChatUsage,
  FinishReason,
  LLMBackend,
  LLMResponseFormat,
  Message,
  PromptCacheConfig,
  ReasoningConfig,
  ToolCall,
  ToolChoice,
} from '@cogitator-ai/types';
import { countMessagesTokens } from '@cogitator-ai/memory';
import { ToolRegistry } from '../registry';
import { normalizeTurn } from '../llm/turn';
import type { Agent } from '../agent';

export interface StreamChatResult {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  finishMessage?: string;
  usage: ChatUsage;
  reasoning?: string;
}

export interface StreamChatExtras {
  reasoning?: ReasoningConfig;
  toolChoice?: ToolChoice;
  cache?: PromptCacheConfig | false;
  cachePrefix?: string;
  onReasoning?: (delta: string) => void;
}

/**
 * Runs one streamed model turn: text and reasoning reach `onToken` and `onReasoning` as they
 * arrive, and the turn comes back assembled and settled by `normalizeTurn`.
 */
export async function streamChat(
  backend: LLMBackend,
  model: string,
  messages: Message[],
  registry: ToolRegistry,
  agent: Agent,
  onToken: (token: string) => void,
  signal?: AbortSignal,
  responseFormat?: LLMResponseFormat,
  extras: StreamChatExtras = {}
): Promise<StreamChatResult> {
  throwIfStreamAborted(signal);

  let content = '';
  let reasoning = '';
  let streamUsage: ChatUsage | undefined;
  let toolCalls: ToolCall[] | undefined;
  let finishReason: FinishReason = 'stop';
  let finishMessage: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsageFromStream = false;

  const stream = backend.chatStream({
    model,
    messages,
    tools: registry.getSchemas(),
    ...(extras.toolChoice && { toolChoice: extras.toolChoice }),
    temperature: agent.config.temperature,
    topP: agent.config.topP,
    maxTokens: agent.config.maxTokens,
    stop: agent.config.stopSequences,
    responseFormat,
    reasoning: extras.reasoning,
    cache: extras.cache,
    ...(extras.cachePrefix !== undefined && { cachePrefix: extras.cachePrefix }),
    signal,
  });

  for await (const chunk of stream) {
    throwIfStreamAborted(signal);

    if (chunk.delta.content) {
      content += chunk.delta.content;
      onToken(chunk.delta.content);
    }
    if (chunk.delta.reasoning) {
      reasoning += chunk.delta.reasoning;
      extras.onReasoning?.(chunk.delta.reasoning);
    }
    if (chunk.delta.toolCalls) {
      if (!toolCalls) toolCalls = [];
      for (const partial of chunk.delta.toolCalls) {
        if (partial.id && partial.name) {
          const existing = toolCalls.find((tc) => tc.id === partial.id);
          if (existing) {
            if (partial.arguments) {
              existing.arguments = { ...existing.arguments, ...partial.arguments };
            }
            if (partial.thoughtSignature) {
              existing.thoughtSignature = partial.thoughtSignature;
            }
            if (partial.replay) {
              existing.replay = partial.replay;
            }
          } else {
            const toolCall: ToolCall = {
              id: partial.id,
              name: partial.name,
              arguments: partial.arguments ?? {},
            };
            if (partial.thoughtSignature) {
              toolCall.thoughtSignature = partial.thoughtSignature;
            }
            if (partial.replay) {
              toolCall.replay = partial.replay;
            }
            toolCalls.push(toolCall);
          }
        } else if (toolCalls.length > 0 && partial.arguments) {
          const last = toolCalls[toolCalls.length - 1];
          last.arguments = { ...last.arguments, ...partial.arguments };
        }
      }
    }
    if (chunk.finishReason) {
      finishReason = chunk.finishReason;
    }
    if (chunk.finishMessage) {
      finishMessage = chunk.finishMessage;
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.inputTokens;
      outputTokens = chunk.usage.outputTokens;
      streamUsage = chunk.usage;
      hasUsageFromStream = true;
    }
  }

  if (!hasUsageFromStream) {
    inputTokens = countMessagesTokens(messages);
    outputTokens = Math.ceil(content.length / 4);
  }

  return normalizeTurn({
    id: `stream_${nanoid(8)}`,
    content,
    toolCalls,
    finishReason,
    ...(finishMessage && { finishMessage }),
    usage: {
      ...streamUsage,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    ...(reasoning && { reasoning }),
  });
}

function throwIfStreamAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw new Error(signal.reason === undefined ? 'Stream aborted' : String(signal.reason));
}
