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
   * Claude through OpenRouter caches only a prompt marked for it, with the same top-level
   * `cache_control` as Anthropic's own API, so a long system prompt is billed in full on every
   * turn without it. Other models there, like OpenAI's, cache on their own. Only OpenRouter gets
   * the field: other OpenAI-compatible servers may reject what they do not know.
   */
  protected override promptCacheParams(request: ChatRequest, model: string): PromptCacheParams {
    if (!request.cache || !this.openRouter || !isClaudeModel(model)) return {};
    const ttl = request.cache.ttl;
    return { cache_control: { type: 'ephemeral', ...(ttl && { ttl }) } };
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
