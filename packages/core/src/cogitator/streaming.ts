import { nanoid } from 'nanoid';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type {
  ChatRequest,
  ChatStreamChunk,
  ChatUsage,
  FinishReason,
  LLMBackend,
  LLMResponseFormat,
  Message,
  ModelStreamSink,
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
  return streamChatRequest(
    backend,
    {
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
    },
    { onToken, ...(extras.onReasoning && { onReasoning: extras.onReasoning }) }
  );
}

/** When a streamed answer began to arrive, filled in by `streamChatRequest`. */
export interface StreamTiming {
  /** `Date.now()` at the first chunk carrying text, reasoning or a tool call */
  firstChunkAt?: number;
}

/** How `streamChatRequest` reads a stream beyond its sink */
export interface StreamChatOptions {
  /**
   * Milliseconds the stream may go without a chunk, the first one included: then it fails with
   * `RUN_CHUNK_TIMEOUT` (`timeouts.chunkMs` of a run)
   */
  chunkTimeout?: number;
}

/**
 * Streams `request` from `backend`: text and reasoning reach `sink` as they arrive, and the turn
 * comes back assembled and settled by `normalizeTurn`. `timing` gets the time of the first chunk
 * that carries any of the answer.
 *
 * Tool calls reach the sink as the model writes them: `onToolInputStart` once a call's id and
 * name are known, `onToolInputDelta` with each piece of its JSON arguments, and
 * `onToolInputAvailable` for each call of the settled turn whose arguments could be read. A
 * backend that only gets whole calls has each reported as a start and one delta when it arrives.
 */
export async function streamChatRequest(
  backend: LLMBackend,
  request: ChatRequest,
  sink: ModelStreamSink,
  timing?: StreamTiming,
  options: StreamChatOptions = {}
): Promise<StreamChatResult> {
  const { messages, signal } = request;
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

  const inputs = new Map<string, { name: string }>();
  const startInput = (toolCallId: string, toolName: string): boolean => {
    if (inputs.has(toolCallId)) return false;
    inputs.set(toolCallId, { name: toolName });
    sink.onToolInputStart?.({ toolCallId, toolName });
    return true;
  };

  for await (const chunk of chunksOf(backend.chatStream(request), options.chunkTimeout)) {
    throwIfStreamAborted(signal);
    if (
      timing &&
      timing.firstChunkAt === undefined &&
      (chunk.delta.content ||
        chunk.delta.reasoning ||
        chunk.delta.toolCalls?.length ||
        chunk.delta.toolInput?.length)
    ) {
      timing.firstChunkAt = Date.now();
    }
    for (const part of chunk.delta.toolInput ?? []) {
      if (part.type === 'start') {
        startInput(part.toolCallId, part.toolName);
        continue;
      }
      const input = inputs.get(part.toolCallId);
      if (input && part.delta) {
        sink.onToolInputDelta?.({
          toolCallId: part.toolCallId,
          toolName: input.name,
          delta: part.delta,
        });
      }
    }

    if (chunk.delta.content) {
      content += chunk.delta.content;
      sink.onToken(chunk.delta.content);
    }
    if (chunk.delta.reasoning) {
      reasoning += chunk.delta.reasoning;
      sink.onReasoning?.(chunk.delta.reasoning);
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
            if (partial.argumentsError !== undefined) {
              existing.argumentsError = partial.argumentsError;
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
            if (partial.argumentsError !== undefined) {
              toolCall.argumentsError = partial.argumentsError;
            }
            toolCalls.push(toolCall);
            if (startInput(toolCall.id, toolCall.name) && toolCall.argumentsError === undefined) {
              sink.onToolInputDelta?.({
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                delta: JSON.stringify(toolCall.arguments),
              });
            }
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

  const turn = normalizeTurn({
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
  for (const call of turn.toolCalls ?? []) {
    if (call.argumentsError !== undefined) continue;
    sink.onToolInputAvailable?.({
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
    });
  }
  return turn;
}

/**
 * The chunks of `stream`, failing with `RUN_CHUNK_TIMEOUT` when the next one takes longer than
 * `timeout` ms. The stream is closed either way.
 */
async function* chunksOf(
  stream: AsyncGenerator<ChatStreamChunk>,
  timeout: number | undefined
): AsyncGenerator<ChatStreamChunk> {
  if (timeout === undefined || timeout <= 0) {
    yield* stream;
    return;
  }
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(chunkTimeoutError(timeout)), timeout);
      });
      let next: IteratorResult<ChatStreamChunk>;
      try {
        next = await Promise.race([stream.next(), stalled]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    stream.return(undefined).catch(() => undefined);
  }
}

function chunkTimeoutError(timeout: number): Error {
  return new CogitatorError({
    message: `The model sent nothing for ${timeout}ms`,
    code: ErrorCode.RUN_CHUNK_TIMEOUT,
    details: { chunkMs: timeout },
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
