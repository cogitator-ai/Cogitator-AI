import OpenAI from 'openai';
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackendProvider,
  OpenAIWireApi,
} from '@cogitator-ai/types';
import { OpenAICompatibleBackend, type PromptCacheParams } from './openai-compatible-base';
import {
  promptCacheMarks,
  splitSystemPrompt,
  type CacheControl,
  type PromptCacheMarks,
} from './prompt-cache';
import type { LLMErrorContext } from './errors';
import {
  DEFAULT_OPENAI_MODEL,
  buildResponsesParams,
  isOpenAIReasoningModel,
  parseResponsesResponse,
  readResponsesStream,
} from './openai-responses';

interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  /** Name the backend reports (errors, traces); a built-in provider or your own, e.g. `openrouter`. */
  provider?: LLMBackendProvider;
  /**
   * Wire API to use. Defaults to the Responses API for the official OpenAI endpoint and to
   * Chat Completions for every other OpenAI-compatible server.
   */
  api?: OpenAIWireApi;
  /** Retries the provider's SDK makes on its own; leave unset for the SDK default. The runtime passes 0 and retries itself. */
  maxRetries?: number;
}

const OFFICIAL_OPENAI_HOST = 'api.openai.com';
const OPENROUTER_HOST = 'openrouter.ai';

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function isOfficialEndpoint(baseUrl: string | undefined): boolean {
  return !baseUrl || hostOf(baseUrl) === OFFICIAL_OPENAI_HOST;
}

/** A system text part carrying a cache breakpoint, as OpenRouter takes it for Claude. */
type CacheMarkedTextPart = OpenAI.Chat.ChatCompletionContentPartText & {
  cache_control?: CacheControl;
};

/** Claude as OpenRouter names it: `anthropic/claude-...`. */
function isClaudeModel(model: string): boolean {
  return /^anthropic\//i.test(model);
}

export class OpenAIBackend extends OpenAICompatibleBackend {
  readonly provider: LLMBackendProvider;
  readonly api: OpenAIWireApi;
  protected client: OpenAI;
  protected override readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  private readonly official: boolean;
  private readonly openRouter: boolean;

  constructor(config: OpenAIConfig) {
    super();
    this.provider = config.provider ?? 'openai';
    this.official = this.provider === 'openai' && isOfficialEndpoint(config.baseUrl);
    this.openRouter = this.provider === 'openrouter' || hostOf(config.baseUrl) === OPENROUTER_HOST;
    this.maxTokensField = this.official ? 'max_completion_tokens' : 'max_tokens';
    this.api = config.api ?? (this.official ? 'responses' : 'chat-completions');
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: config.maxRetries,
    });
  }

  protected override supportsResponseFormatWithTools(): boolean {
    return this.official;
  }

  /** OpenAI itself, or a proxy in front of it, serves OpenAI's reasoning models under their names. */
  protected override isReasoningModel(model: string): boolean {
    return this.provider === 'openai' && isOpenAIReasoningModel(model);
  }

  /**
   * Claude through OpenRouter caches only a prompt marked for it, the way Anthropic's own API
   * takes the marks, so a long system prompt is billed in full on every call without them.
   * Other models there, like OpenAI's, cache on their own. Only OpenRouter gets the marks: other
   * OpenAI-compatible servers may reject fields they do not know.
   */
  private claudeCacheMarks(request: ChatRequest, model: string): PromptCacheMarks | undefined {
    return this.openRouter && isClaudeModel(model) ? promptCacheMarks(request) : undefined;
  }

  /** The end of the conversation, as Anthropic's top-level `cache_control` marks it. */
  protected override promptCacheParams(request: ChatRequest, model: string): PromptCacheParams {
    const marks = this.claudeCacheMarks(request, model);
    return marks?.conversation ? { cache_control: marks.control } : {};
  }

  /**
   * The end of the stable system prompt: the system message becomes text blocks, the agent's
   * instructions marked and what the run added after them left unmarked, so runs with different
   * input read the instructions from the cache.
   */
  protected override markPromptCache(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    request: ChatRequest,
    model: string
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const marks = this.claudeCacheMarks(request, model);
    if (!marks?.systemPrefix) return messages;
    const index = messages.findIndex((message) => message.role === 'system');
    const system = messages[index];
    if (system?.role !== 'system' || typeof system.content !== 'string') return messages;
    const split = splitSystemPrompt(system.content, marks.systemPrefix);
    if (!split) return messages;
    const content: CacheMarkedTextPart[] = [
      { type: 'text', text: split.stable, cache_control: marks.control },
      ...(split.rest.trim() ? [{ type: 'text' as const, text: split.rest }] : []),
    ];
    return messages.map((message, i) => (i === index ? { role: 'system', content } : message));
  }

  protected override resolveModel(request: ChatRequest): string {
    if (request.model) return request.model;
    return this.provider === 'openai' ? DEFAULT_OPENAI_MODEL : request.model;
  }

  override async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.usesResponses(request)) {
      return super.chat(request);
    }

    const model = this.resolveModel(request);
    const ctx = this.errorContext(model);
    const params = { ...buildResponsesParams(request, model), stream: false as const };

    let response: Response;
    try {
      response = request.signal
        ? await this.client.responses.create(params, { signal: request.signal })
        : await this.client.responses.create(params);
    } catch (e) {
      throw this.wrapAPIError(e, ctx);
    }
    return parseResponsesResponse(response, ctx);
  }

  override async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    if (!this.usesResponses(request)) {
      yield* super.chatStream(request);
      return;
    }

    const model = this.resolveModel(request);
    const ctx = this.errorContext(model);
    const params = { ...buildResponsesParams(request, model), stream: true as const };

    let stream: AsyncIterable<ResponseStreamEvent>;
    try {
      stream = request.signal
        ? await this.client.responses.create(params, { signal: request.signal })
        : await this.client.responses.create(params);
    } catch (e) {
      throw this.wrapAPIError(e, ctx);
    }

    yield* readResponsesStream(stream, ctx);
  }

  /**
   * The Responses API has no stop-sequence parameter, so requests that need one keep using
   * Chat Completions, exactly as before the migration.
   */
  private usesResponses(request: ChatRequest): boolean {
    return this.api === 'responses' && !request.stop?.length;
  }

  private errorContext(model: string): LLMErrorContext {
    return { provider: this.provider, model, endpoint: this.client.baseURL };
  }
}
