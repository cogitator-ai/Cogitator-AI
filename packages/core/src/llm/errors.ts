import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

export interface LLMErrorContext {
  provider: string;
  model?: string;
  endpoint?: string;
  requestId?: string;
  statusCode?: number;
  responseBody?: string;
}

interface SDKAPIError extends Error {
  status?: number;
  headers?: Headers;
}

export class LLMError extends CogitatorError {
  readonly provider: string;
  readonly model?: string;
  readonly endpoint?: string;

  constructor(
    message: string,
    code: ErrorCode,
    context: LLMErrorContext,
    options?: { cause?: Error; retryable?: boolean; retryAfter?: number }
  ) {
    super({
      message: `[${context.provider}] ${message}`,
      code,
      details: {
        provider: context.provider,
        model: context.model,
        endpoint: context.endpoint,
        requestId: context.requestId,
        statusCode: context.statusCode,
        responseBody: context.responseBody?.slice(0, 500),
      },
      cause: options?.cause,
      retryable: options?.retryable,
      retryAfter: options?.retryAfter,
    });
    this.name = 'LLMError';
    this.provider = context.provider;
    this.model = context.model;
    this.endpoint = context.endpoint;
  }

  static isLLMError(error: unknown): error is LLMError {
    return error instanceof LLMError;
  }
}

/**
 * Phrases providers use when the prompt does not fit the model's context window, matched in
 * lower case: OpenAI, Azure, DeepSeek, Groq and vLLM, Anthropic, Gemini, Bedrock, Mistral.
 * A bare mention of tokens or length is not enough: a rejected `max_tokens` value says that too.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context_length_exceeded/,
  /maximum context length/,
  /context window/,
  /prompt is too long/,
  /input is too long/,
  /too many input tokens/,
  /input token count.*exceeds/,
  /too large for model with \d+ maximum context length/,
  /reduce the length of the messages/,
];

function isContextOverflow(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * What the provider said, for the message of an `LLMError`: the `message` of a JSON error body
 * (`{ error: { message } }`, a list of those, or `{ message }`), otherwise the body as it is.
 */
export function providerMessage(responseBody: string | undefined): string | undefined {
  const text = responseBody?.trim();
  if (!text) return undefined;
  let message: unknown;
  try {
    const json: unknown = JSON.parse(text);
    const body = asRecord(Array.isArray(json) ? json[0] : json);
    const error = body?.error;
    message = asRecord(error)?.message ?? (typeof error === 'string' ? error : body?.message);
  } catch {
    message = undefined;
  }
  const said = typeof message === 'string' && message.trim() ? message.trim() : text;
  return said.length > 300 ? `${said.slice(0, 300)}...` : said;
}

/** `label`, followed by what the provider said unless that adds nothing. */
function withProviderMessage(label: string, said: string | undefined): string {
  if (!said || said.toLowerCase() === label.toLowerCase()) return label;
  return `${label}: ${said}`;
}

export function createLLMError(
  context: LLMErrorContext,
  statusCode: number,
  responseBody?: string,
  options?: { cause?: Error; retryAfterOverride?: number }
): LLMError {
  const ctx = { ...context, statusCode, responseBody };
  const cause = options?.cause;
  const said = providerMessage(responseBody);

  const retryAfter = options?.retryAfterOverride ?? parseRetryAfter(responseBody);

  if (statusCode === 429) {
    return new LLMError(
      withProviderMessage('Rate limit exceeded', said),
      ErrorCode.LLM_RATE_LIMITED,
      ctx,
      {
        cause,
        retryable: true,
        retryAfter,
      }
    );
  }

  if (statusCode === 401 || statusCode === 403) {
    return new LLMError(
      withProviderMessage(`Authentication failed (${statusCode})`, said),
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { cause, retryable: false }
    );
  }

  if (statusCode === 400) {
    if (isContextOverflow(responseBody ?? '')) {
      return new LLMError(
        withProviderMessage('Context length exceeded', said),
        ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED,
        ctx,
        { cause, retryable: false }
      );
    }
    const lower = responseBody?.toLowerCase() ?? '';
    if (
      (lower.includes('safety') || lower.includes('blocked')) &&
      !lower.includes('invalid json') &&
      !lower.includes('unknown name')
    ) {
      return new LLMError(
        withProviderMessage('Content filtered by safety policy', said),
        ErrorCode.LLM_CONTENT_FILTERED,
        ctx,
        { cause, retryable: false }
      );
    }
    return new LLMError(
      withProviderMessage('Bad request', said ?? 'unknown'),
      ErrorCode.VALIDATION_ERROR,
      ctx,
      { cause, retryable: false }
    );
  }

  if (statusCode >= 500) {
    return new LLMError(
      withProviderMessage(`Server error (${statusCode})`, said ?? 'unknown'),
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { cause, retryable: true, retryAfter }
    );
  }

  if (statusCode === 404) {
    return new LLMError(
      withProviderMessage(
        `Model or endpoint not found: ${context.model ?? context.endpoint ?? 'unknown'}`,
        said
      ),
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { cause, retryable: false }
    );
  }

  return new LLMError(
    withProviderMessage(`HTTP ${statusCode}`, said ?? 'unknown'),
    ErrorCode.LLM_INVALID_RESPONSE,
    ctx,
    { cause, retryable: false }
  );
}

export function llmUnavailable(context: LLMErrorContext, reason: string, cause?: Error): LLMError {
  return new LLMError(reason, ErrorCode.LLM_UNAVAILABLE, context, { cause, retryable: true });
}

export function llmInvalidResponse(
  context: LLMErrorContext,
  reason: string,
  cause?: Error
): LLMError {
  return new LLMError(reason, ErrorCode.LLM_INVALID_RESPONSE, context, {
    cause,
    retryable: false,
  });
}

export function llmTimeout(context: LLMErrorContext, timeoutMs: number): LLMError {
  return new LLMError(`Request timed out after ${timeoutMs}ms`, ErrorCode.LLM_TIMEOUT, context, {
    retryable: true,
  });
}

export function llmConfigError(context: LLMErrorContext, message: string): LLMError {
  return new LLMError(message, ErrorCode.CONFIGURATION_ERROR, context, { retryable: false });
}

export function llmNotImplemented(context: LLMErrorContext, feature: string): LLMError {
  return new LLMError(`${feature} is not implemented`, ErrorCode.NOT_IMPLEMENTED, context, {
    retryable: false,
  });
}

export function wrapSDKError(error: unknown, ctx: LLMErrorContext): LLMError {
  if (isSDKAPIError(error)) {
    const statusCode = error.status ?? 500;
    const enrichedCtx = { ...ctx, statusCode, responseBody: error.message };

    return createLLMError(enrichedCtx, statusCode, error.message, {
      cause: error,
      retryAfterOverride: retryAfterFromHeaders(error.headers),
    });
  }

  if (error instanceof Error) {
    return new LLMError(`Request failed: ${error.message}`, ErrorCode.LLM_UNAVAILABLE, ctx, {
      cause: error,
      retryable: true,
    });
  }

  return new LLMError(`Unknown error: ${String(error)}`, ErrorCode.INTERNAL_ERROR, ctx);
}

/**
 * The error a provider reported in the body of a successful response, as routers such as
 * OpenRouter do when the model's own provider fails: `{ error: { code, message } }` in place of
 * the choices, or in a chunk of a stream. The code is read as the HTTP status it stands for, so a
 * rate limit or a server error stays retryable. A code that is not a status counts as a bad gateway.
 */
export function providerErrorIn(
  body: unknown,
  context: LLMErrorContext,
  cause?: Error
): LLMError | undefined {
  const error = asRecord(asRecord(body)?.error);
  if (!error) return undefined;
  const { code } = error;
  const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 502;
  return createLLMError(context, status, JSON.stringify(error), cause && { cause });
}

function isSDKAPIError(error: unknown): error is SDKAPIError {
  return error instanceof Error && typeof (error as SDKAPIError).status === 'number';
}

/**
 * The wait a provider asks for in its response headers, in milliseconds:
 * `retry-after-ms`, or `retry-after` as seconds or an HTTP date.
 */
export function retryAfterFromHeaders(headers?: Headers | null): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The wait a provider asks for in an error body: `retry_after` seconds, or Google's `RetryInfo.retryDelay`. */
function parseRetryAfter(responseBody?: string): number | undefined {
  if (!responseBody) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(responseBody);
  } catch {
    const match = /retry.?after[:\s]+(\d+)/i.exec(responseBody);
    return match ? parseInt(match[1], 10) * 1000 : undefined;
  }
  const body = asRecord(Array.isArray(json) ? json[0] : json);
  const error = asRecord(body?.error);
  const seconds = body?.retry_after ?? error?.retry_after;
  if (typeof seconds === 'number') return seconds * 1000;
  const details = Array.isArray(error?.details) ? error.details : [];
  for (const detail of details) {
    const delay = asRecord(detail)?.retryDelay;
    const match = typeof delay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
    if (match) return Math.round(parseFloat(match[1]) * 1000);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function tryParseJson<T>(
  json: string,
  context: LLMErrorContext,
  fallback?: T
): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch (e) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw llmInvalidResponse(
      context,
      `Failed to parse JSON response: ${json.slice(0, 100)}`,
      e instanceof Error ? e : undefined
    );
  }
}
