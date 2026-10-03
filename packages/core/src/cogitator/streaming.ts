import { nanoid } from 'nanoid';
import type {
  ChatUsage,
  LLMBackend,
  LLMResponseFormat,
  Message,
  PromptCacheConfig,
  ReasoningConfig,
  ToolCall,
} from '@cogitator-ai/types';
import { countMessagesTokens } from '@cogitator-ai/memory';
import { ToolRegistry } from '../registry';
import type { Agent } from '../agent';

export interface StreamChatResult {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: ChatUsage;
  reasoning?: string;
}

export interface StreamChatExtras {
  reasoning?: ReasoningConfig;
  cache?: PromptCacheConfig | false;
  onReasoning?: (delta: string) => void;
}

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
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsageFromStream = false;

  const stream = backend.chatStream({
    model,
    messages,
    tools: registry.getSchemas(),
    temperature: agent.config.temperature,
    topP: agent.config.topP,
    maxTokens: agent.config.maxTokens,
    stop: agent.config.stopSequences,
    responseFormat,
    reasoning: extras.reasoning,
    cache: extras.cache,
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

  if (toolCalls && toolCalls.length > 0 && finishReason !== 'tool_calls') {
    finishReason = 'tool_calls';
  }

  return {
    id: `stream_${nanoid(8)}`,
    content,
    toolCalls,
    finishReason,
    usage: {
      ...streamUsage,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    ...(reasoning && { reasoning }),
  };
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
