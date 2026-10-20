import { CogitatorError, ErrorCode, type LLMErrorKind } from '@cogitator-ai/types';
import { classifyProviderError, statusOfKind } from './error-tables';

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
  /** The parsed error body, which the SDKs keep on errors they raise from a stream */
  error?: unknown;
}

export interface LLMErrorOptions {
  cause?: Error;
  retryable?: boolean;
  retryAfter?: number;
  /** Why the call failed, kept as `details.kind` too */
  kind?: LLMErrorKind;
}

export class LLMError extends CogitatorError {
  readonly provider: string;
  readonly model?: string;
  readonly endpoint?: string;
  /** Why the call failed, from the provider's error codes, absent for errors of the runtime's own, such as configuration */
  readonly kind?: LLMErrorKind;

  constructor(
    message: string,
    code: ErrorCode,
    context: LLMErrorContext,
    options?: LLMErrorOptions
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
        ...(options?.kind && { kind: options.kind }),
      },
      cause: options?.cause,
      retryable: options?.retryable,
      retryAfter: options?.retryAfter,
    });
    this.name = 'LLMError';
    this.provider = context.provider;
    this.model = context.model;
    this.endpoint = context.endpoint;
    this.kind = options?.kind;
  }

  static isLLMError(error: unknown): error is LLMError {
    return error instanceof LLMError;
  }
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

/**
 * The `LLMError` for a provider call that failed with HTTP `statusCode`: what kind of failure it
 * is comes from the provider's own error codes in `responseBody` (see `classifyProviderError`),
 * and the kind decides the error code and whether a retry may help. Quota and billing errors are
 * not retried, even when the provider sends them as a 429.
 */
export function createLLMError(
  context: LLMErrorContext,
  statusCode: number,
  responseBody?: string,
  options?: { cause?: Error; retryAfterOverride?: number; kind?: LLMErrorKind }
): LLMError {
  const ctx = { ...context, statusCode, responseBody };
  const cause = options?.cause;
  const said = providerMessage(responseBody);
  const kind = options?.kind ?? classifyProviderError(context.provider, statusCode, responseBody);
  const retryAfter = options?.retryAfterOverride ?? parseRetryAfter(responseBody);
  const error = (label: string, code: ErrorCode, retryable: boolean, extra?: string) =>
    new LLMError(withProviderMessage(label, said ?? extra), code, ctx, {
      cause,
      retryable,
      kind,
      ...(retryable && retryAfter !== undefined && { retryAfter }),
    });

  switch (kind) {
    case 'rate_limit':
      return error('Rate limit exceeded', ErrorCode.LLM_RATE_LIMITED, true);
    case 'quota':
      return error(`Quota exceeded (${statusCode})`, ErrorCode.LLM_QUOTA_EXCEEDED, false);
    case 'authentication':
      return error(`Authentication failed (${statusCode})`, ErrorCode.LLM_UNAVAILABLE, false);
    case 'permission':
      return error(`Permission denied (${statusCode})`, ErrorCode.LLM_UNAVAILABLE, false);
    case 'not_found':
      return error(
        `Model or endpoint not found: ${context.model ?? context.endpoint ?? 'unknown'}`,
        ErrorCode.LLM_UNAVAILABLE,
        false
      );
    case 'context_overflow':
      return error('Context length exceeded', ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED, false);
    case 'content_filter':
      return error('Content filtered by safety policy', ErrorCode.LLM_CONTENT_FILTERED, false);
    case 'invalid_request':
      return error('Bad request', ErrorCode.VALIDATION_ERROR, false, 'unknown');
    case 'overloaded':
      return error(`Provider overloaded (${statusCode})`, ErrorCode.LLM_UNAVAILABLE, true);
    case 'server_error':
    case 'network':
      return error(`Server error (${statusCode})`, ErrorCode.LLM_UNAVAILABLE, true, 'unknown');
    case 'timeout':
      return error(`Provider timed out (${statusCode})`, ErrorCode.LLM_TIMEOUT, true);
    case 'invalid_response':
      return error(`HTTP ${statusCode}`, ErrorCode.LLM_INVALID_RESPONSE, false, 'unknown');
  }
}

export function llmUnavailable(context: LLMErrorContext, reason: string, cause?: Error): LLMError {
  return new LLMError(reason, ErrorCode.LLM_UNAVAILABLE, context, {
    cause,
    retryable: true,
    kind: 'network',
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
    kind: 'invalid_response',
  });
}

export function llmTimeout(context: LLMErrorContext, timeoutMs: number): LLMError {
  return new LLMError(`Request timed out after ${timeoutMs}ms`, ErrorCode.LLM_TIMEOUT, context, {
    retryable: true,
    kind: 'timeout',
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

/**
 * The error a call fails with when the caller aborted it: the reason the caller's `signal` was
 * aborted with, or an `AbortError` when that is not an `Error`. `undefined` while the signal is
 * not aborted. Backends throw it in place of whatever the SDK or `fetch` raised, so an abort is
 * never mistaken for a provider failure that a retry or a fallback model would act on.
 */
export function abortReason(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? 'The call was aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

/**
 * An error the provider's SDK raised, as an `LLMError` classified by the provider's error body:
 * one for an HTTP error, or one the SDK raises without a status for an error event in a stream
 * that had already begun (both the OpenAI and the Anthropic SDK do).
 */
export function wrapSDKError(error: unknown, ctx: LLMErrorContext): LLMError {
  if (error instanceof LLMError) return error;
  if (isSDKAPIError(error)) {
    const body = sdkErrorBody(error);
    const status = error.status ?? statusIn(error.error);
    const kind = classifyProviderError(ctx.provider, status, body);
    return createLLMError(ctx, status ?? statusOfKind(kind), body ?? error.message, {
      cause: error,
      retryAfterOverride: retryAfterFromHeaders(error.headers),
      kind,
    });
  }

  if (error instanceof Error) {
    return new LLMError(`Request failed: ${error.message}`, ErrorCode.LLM_UNAVAILABLE, ctx, {
      cause: error,
      retryable: true,
      kind: 'network',
    });
  }

  return new LLMError(`Unknown error: ${String(error)}`, ErrorCode.INTERNAL_ERROR, ctx);
}

/**
 * The HTTP status a numeric `code` of an error body stands for, as routers such as OpenRouter
 * report the failure of the model's own provider inside a stream.
 */
function statusIn(body: unknown): number | undefined {
  const record = asRecord(body);
  const code = (asRecord(record?.error) ?? record)?.code;
  return typeof code === 'number' && code >= 400 && code < 600 ? code : undefined;
}

/**
 * The error body an SDK kept, as JSON in the provider's own shape: the OpenAI SDK keeps the
 * inner `error` object (or the whole body when it is a list, as Gemini's OpenAI-compatible
 * endpoint sends it), the Anthropic SDK the whole body.
 */
function sdkErrorBody(error: SDKAPIError): string | undefined {
  if (Array.isArray(error.error)) return JSON.stringify(error.error);
  const kept = asRecord(error.error);
  if (!kept) return undefined;
  return JSON.stringify('error' in kept ? kept : { error: kept });
}

/**
 * The error a provider reported in the body of a successful response, as routers such as
 * OpenRouter do when the model's own provider fails: `{ error: { code, message } }` in place of
 * the choices, or in a chunk of a stream. A numeric code is read as the HTTP status it stands
 * for, otherwise the provider's error codes say what failed, so a rate limit or an overloaded
 * provider stays retryable and an exhausted quota does not. A failure they do not explain counts
 * as a bad gateway.
 */
export function providerErrorIn(
  body: unknown,
  context: LLMErrorContext,
  cause?: Error
): LLMError | undefined {
  const error = asRecord(asRecord(body)?.error);
  if (!error) return undefined;
  const { code } = error;
  const status = typeof code === 'number' && code >= 400 && code < 600 ? code : undefined;
  const text = JSON.stringify({ error });
  const kind = classifyProviderError(context.provider, status, text);
  const statusCode = status ?? (kind === 'server_error' ? 502 : statusOfKind(kind));
  return createLLMError(context, statusCode, text, { kind, ...(cause && { cause }) });
}

function isSDKAPIError(error: unknown): error is SDKAPIError {
  if (!(error instanceof Error)) return false;
  const { status, error: body } = error as SDKAPIError;
  return typeof status === 'number' || (status === undefined && asRecord(body) !== undefined);
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
