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

export function createLLMError(
  context: LLMErrorContext,
  statusCode: number,
  responseBody?: string,
  options?: { cause?: Error; retryAfterOverride?: number }
): LLMError {
  const ctx = { ...context, statusCode, responseBody };
  const cause = options?.cause;

  const retryAfter = options?.retryAfterOverride ?? parseRetryAfter(responseBody);

  if (statusCode === 429) {
    return new LLMError('Rate limit exceeded', ErrorCode.LLM_RATE_LIMITED, ctx, {
      cause,
      retryable: true,
      retryAfter,
    });
  }

  if (statusCode === 401 || statusCode === 403) {
    return new LLMError(`Authentication failed (${statusCode})`, ErrorCode.LLM_UNAVAILABLE, ctx, {
      cause,
      retryable: false,
    });
  }

  if (statusCode === 400) {
    const lower = responseBody?.toLowerCase() ?? '';
    if (lower.includes('context') || lower.includes('token') || lower.includes('length')) {
      return new LLMError('Context length exceeded', ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED, ctx, {
        cause,
        retryable: false,
      });
    }
    if (
      (lower.includes('safety') || lower.includes('blocked')) &&
      !lower.includes('invalid json') &&
      !lower.includes('unknown name')
    ) {
      return new LLMError(
        'Content filtered by safety policy',
        ErrorCode.LLM_CONTENT_FILTERED,
        ctx,
        {
          cause,
          retryable: false,
        }
      );
    }
    return new LLMError(
      `Bad request: ${responseBody?.slice(0, 200) ?? 'unknown'}`,
      ErrorCode.VALIDATION_ERROR,
      ctx,
      { cause, retryable: false }
    );
  }

  if (statusCode >= 500) {
    return new LLMError(
      `Server error (${statusCode}): ${responseBody?.slice(0, 200) ?? 'unknown'}`,
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { cause, retryable: true, retryAfter }
    );
  }

  if (statusCode === 404) {
    return new LLMError(
      `Model or endpoint not found: ${context.model ?? context.endpoint ?? 'unknown'}`,
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { cause, retryable: false }
    );
  }

  return new LLMError(
    `HTTP ${statusCode}: ${responseBody?.slice(0, 200) ?? 'unknown'}`,
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
export function providerErrorIn(body: unknown, context: LLMErrorContext): LLMError | undefined {
  const error = asRecord(asRecord(body)?.error);
  if (!error) return undefined;
  const { code } = error;
  const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 502;
  return createLLMError(context, status, JSON.stringify(error));
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
