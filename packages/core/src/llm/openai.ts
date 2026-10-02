import OpenAI from 'openai';
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMProvider,
  OpenAIWireApi,
} from '@cogitator-ai/types';
import { OpenAICompatibleBackend } from './openai-compatible-base';
import type { LLMErrorContext } from './errors';
import {
  DEFAULT_OPENAI_MODEL,
  buildResponsesParams,
  parseResponsesResponse,
  readResponsesStream,
} from './openai-responses';

interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  provider?: LLMProvider;
  /**
   * Wire API to use. Defaults to the Responses API for the official OpenAI endpoint and to
   * Chat Completions for every other OpenAI-compatible server.
   */
  api?: OpenAIWireApi;
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
  readonly provider: LLMProvider;
  readonly api: OpenAIWireApi;
  protected client: OpenAI;
  protected override readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';

  constructor(config: OpenAIConfig) {
    super();
    this.provider = config.provider ?? 'openai';
    const official = this.provider === 'openai' && isOfficialEndpoint(config.baseUrl);
    this.maxTokensField = official ? 'max_completion_tokens' : 'max_tokens';
    this.api = config.api ?? (official ? 'responses' : 'chat-completions');
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
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
