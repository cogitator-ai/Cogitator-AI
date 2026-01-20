import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

export interface LLMErrorContext {
  provider: string;
  model?: string;
  endpoint?: string;
  requestId?: string;
  statusCode?: number;
  responseBody?: string;
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
  responseBody?: string
): LLMError {
  const ctx = { ...context, statusCode, responseBody };

  if (statusCode === 429) {
    const retryAfter = parseRetryAfter(responseBody);
    return new LLMError('Rate limit exceeded', ErrorCode.LLM_RATE_LIMITED, ctx, {
      retryable: true,
      retryAfter: retryAfter ?? 60000,
    });
  }

  if (statusCode === 401 || statusCode === 403) {
    return new LLMError(`Authentication failed (${statusCode})`, ErrorCode.LLM_UNAVAILABLE, ctx, {
      retryable: false,
    });
  }

  if (statusCode === 400) {
    const lower = responseBody?.toLowerCase() ?? '';
    if (lower.includes('context') || lower.includes('token') || lower.includes('length')) {
      return new LLMError('Context length exceeded', ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED, ctx, {
        retryable: false,
      });
    }
    if (lower.includes('content') || lower.includes('filter') || lower.includes('safety')) {
      return new LLMError(
        'Content filtered by safety policy',
        ErrorCode.LLM_CONTENT_FILTERED,
        ctx,
        {
          retryable: false,
        }
      );
    }
    return new LLMError(
      `Bad request: ${responseBody?.slice(0, 200) ?? 'unknown'}`,
      ErrorCode.VALIDATION_ERROR,
      ctx,
      { retryable: false }
    );
  }

  if (statusCode >= 500) {
    return new LLMError(
      `Server error (${statusCode}): ${responseBody?.slice(0, 200) ?? 'unknown'}`,
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { retryable: true, retryAfter: 5000 }
    );
  }

  if (statusCode === 404) {
    return new LLMError(
      `Model or endpoint not found: ${context.model ?? context.endpoint ?? 'unknown'}`,
      ErrorCode.LLM_UNAVAILABLE,
      ctx,
      { retryable: false }
    );
  }

  return new LLMError(
    `HTTP ${statusCode}: ${responseBody?.slice(0, 200) ?? 'unknown'}`,
    ErrorCode.LLM_INVALID_RESPONSE,
    ctx,
    { retryable: statusCode >= 500 }
  );
}

export function llmUnavailable(context: LLMErrorContext, reason: string, cause?: Error): LLMError {
  return new LLMError(reason, ErrorCode.LLM_UNAVAILABLE, context, {
    cause,
    retryable: true,
    retryAfter: 5000,
  });
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
    retryAfter: 1000,
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

function parseRetryAfter(responseBody?: string): number | undefined {
  if (!responseBody) return undefined;
  try {
    const json = JSON.parse(responseBody) as Record<string, unknown>;
    if (typeof json.retry_after === 'number') {
      return json.retry_after * 1000;
    }
    const error = json.error as Record<string, unknown> | undefined;
    if (error && typeof error.retry_after === 'number') {
      return (error.retry_after as number) * 1000;
    }
  } catch {
    const match = /retry.?after[:\s]+(\d+)/i.exec(responseBody);
    if (match) {
      return parseInt(match[1], 10) * 1000;
    }
  }
  return undefined;
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
