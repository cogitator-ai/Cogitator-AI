import OpenAI from 'openai';
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackendProvider,
  OpenAIWireApi,
} from '@cogitator-ai/types';
import { OpenAICompatibleBackend } from './openai-compatible-base';
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

function isOfficialEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === OFFICIAL_OPENAI_HOST;
  } catch {
    return false;
  }
}

export class OpenAIBackend extends OpenAICompatibleBackend {
  readonly provider: LLMBackendProvider;
  readonly api: OpenAIWireApi;
  protected client: OpenAI;
  protected override readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  private readonly official: boolean;

  constructor(config: OpenAIConfig) {
    super();
    this.provider = config.provider ?? 'openai';
    this.official = this.provider === 'openai' && isOfficialEndpoint(config.baseUrl);
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
