import type { LLMErrorKind } from '@cogitator-ai/types';

/**
 * Why a provider call failed, read from the provider's own error codes first and its HTTP status
 * second. `status` is absent for an error a provider reports inside a stream that already began.
 *
 * - Anthropic: `{ type: 'error', error: { type, message } }`, by `error.type`
 * - Gemini: `{ error: { code, status, message, details } }`, by `status` and the quota that ran out
 * - OpenAI and OpenAI-compatible servers (the default): `{ error: { type, code, message } }`
 */
export function classifyProviderError(
  provider: string,
  status: number | undefined,
  body: string | undefined
): LLMErrorKind {
  const parsed = parseBody(body);
  const text = (body ?? '').toLowerCase();
  const fromTable =
    provider === 'anthropic'
      ? anthropicKind(parsed, text)
      : provider === 'google'
        ? geminiKind(status, parsed)
        : openAIKind(status, parsed, text);
  return fromTable ?? kindOfStatus(status, text);
}

/** The HTTP status an error of `kind` stands for, for an error that came without one. */
export function statusOfKind(kind: LLMErrorKind): number {
  switch (kind) {
    case 'rate_limit':
      return 429;
    case 'quota':
      return 402;
    case 'authentication':
      return 401;
    case 'permission':
      return 403;
    case 'not_found':
      return 404;
    case 'invalid_request':
    case 'context_overflow':
    case 'content_filter':
      return 400;
    case 'overloaded':
      return 503;
    case 'timeout':
      return 504;
    case 'server_error':
    case 'network':
      return 500;
    case 'invalid_response':
      return 502;
  }
}

/**
 * Phrases providers use when the prompt does not fit the model's context window, matched in
 * lower case: OpenAI, Azure, DeepSeek, Groq and vLLM, Anthropic, Gemini, Bedrock, Mistral,
 * Ollama and llama.cpp. A bare mention of tokens or length is not enough: a rejected
 * `max_tokens` value says that too.
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
  /exceeds (the )?(maximum |available )?context (length|size)/,
  /context (length|size|window) exceeded/,
];

/** Phrases of an account out of credits or over a billing or usage cap, in lower case. */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient[_ ]quota/,
  /exceeded your current quota/,
  /credit balance/,
  /spend(ing)? (limit|cap)/,
  /usage limit/,
  /out of credits/,
  /insufficient (credits|balance|funds)/,
];

/**
 * OpenAI error codes that mean the account cannot pay for more requests, from
 * developers.openai.com/api/docs/guides/error-codes: a 429 with one of them does not lift by
 * waiting. `insufficient_quota` is what the API sent before these and still the `type` of some.
 */
const OPENAI_QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'billing_hard_limit_reached',
  'billing_not_active',
]);

function openAIKind(
  status: number | undefined,
  body: Record<string, unknown> | undefined,
  text: string
): LLMErrorKind | undefined {
  const error = asRecord(body?.error);
  const code = stringOf(error?.code);
  const type = stringOf(error?.type);
  if ((code && OPENAI_QUOTA_CODES.has(code)) || (type && OPENAI_QUOTA_CODES.has(type))) {
    return 'quota';
  }
  if (status === 429 || status === undefined) {
    if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return 'quota';
  }
  switch (code ?? type) {
    case 'rate_limit_exceeded':
    case 'rate_limit_error':
    case 'slow_down':
    case 'tokens_exceeded':
      return 'rate_limit';
    case 'server_is_overloaded':
    case 'service_unavailable_error':
    case 'engine_overloaded':
      return 'overloaded';
    case 'invalid_api_key':
    case 'invalid_authentication':
    case 'authentication_error':
      return 'authentication';
    case 'unsupported_country_region_territory':
    case 'permission_error':
      return 'permission';
    case 'model_not_found':
      return 'not_found';
    case 'context_length_exceeded':
      return 'context_overflow';
    case 'content_filter':
    case 'content_policy_violation':
    case 'image_content_policy_violation':
    case 'bio_policy':
    case 'misalignment_policy_violation':
      return 'content_filter';
    case 'invalid_prompt':
      return 'invalid_request';
    case 'vector_store_timeout':
      return 'timeout';
    case 'server_error':
      return 'server_error';
    default:
      return undefined;
  }
}

/** Anthropic's error types, from platform.claude.com/docs/en/api/errors. */
function anthropicKind(
  body: Record<string, unknown> | undefined,
  text: string
): LLMErrorKind | undefined {
  switch (stringOf(asRecord(body?.error)?.type)) {
    case 'invalid_request_error':
      return isContextOverflow(text) ? 'context_overflow' : 'invalid_request';
    case 'request_too_large':
      return 'invalid_request';
    case 'authentication_error':
      return 'authentication';
    case 'billing_error':
      return 'quota';
    case 'permission_error':
      return 'permission';
    case 'not_found_error':
      return 'not_found';
    case 'rate_limit_error':
      return QUOTA_PATTERNS.some((pattern) => pattern.test(text)) ? 'quota' : 'rate_limit';
    case 'api_error':
      return 'server_error';
    case 'timeout_error':
      return 'timeout';
    case 'overloaded_error':
      return 'overloaded';
    default:
      return undefined;
  }
}

/**
 * Gemini's statuses, from ai.google.dev/gemini-api/docs/generate-content/api-errors.
 * `RESOURCE_EXHAUSTED` is a rate limit at 429 unless a quota counted per day ran out, which
 * resets only at midnight Pacific time, and prepaid credits that ran out at 402.
 */
function geminiKind(
  status: number | undefined,
  body: Record<string, unknown> | undefined
): LLMErrorKind | undefined {
  const error = asRecord(body?.error);
  if (!error) return undefined;
  const details = Array.isArray(error.details) ? error.details.map(asRecord) : [];
  const reasons = details.map((detail) => stringOf(detail?.reason));
  if (reasons.some((reason) => reason === 'API_KEY_INVALID' || reason === 'API_KEY_EXPIRED')) {
    return 'authentication';
  }
  const code = typeof error.code === 'number' ? error.code : status;
  switch (stringOf(error.status)) {
    case 'RESOURCE_EXHAUSTED':
      return code === 402 || dailyQuotaRanOut(details) ? 'quota' : 'rate_limit';
    case 'INVALID_ARGUMENT':
      return isContextOverflow(stringOf(error.message)?.toLowerCase() ?? '')
        ? 'context_overflow'
        : 'invalid_request';
    case 'FAILED_PRECONDITION':
    case 'PERMISSION_DENIED':
      return 'permission';
    case 'UNAUTHENTICATED':
      return 'authentication';
    case 'NOT_FOUND':
      return 'not_found';
    case 'INTERNAL':
      return 'server_error';
    case 'UNAVAILABLE':
      return 'overloaded';
    case 'DEADLINE_EXCEEDED':
      return 'timeout';
    default:
      return undefined;
  }
}

/** Whether a `google.rpc.QuotaFailure` names a quota counted per day. */
function dailyQuotaRanOut(details: (Record<string, unknown> | undefined)[]): boolean {
  return details.some((detail) => {
    if (!stringOf(detail?.['@type'])?.endsWith('google.rpc.QuotaFailure')) return false;
    const violations = Array.isArray(detail?.violations) ? detail.violations : [];
    return violations.some((violation) => {
      const record = asRecord(violation);
      const names = `${stringOf(record?.quotaId) ?? ''} ${stringOf(record?.quotaMetric) ?? ''}`;
      return /perday/i.test(names);
    });
  });
}

/** What the HTTP status says, for an error the provider's codes do not explain. */
function kindOfStatus(status: number | undefined, text: string): LLMErrorKind {
  if (status === undefined) return 'server_error';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'quota';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 400 || status === 413 || status === 422) {
    if (isContextOverflow(text)) return 'context_overflow';
    if (
      (text.includes('safety') || text.includes('blocked')) &&
      !text.includes('invalid json') &&
      !text.includes('unknown name')
    ) {
      return 'content_filter';
    }
    return 'invalid_request';
  }
  if (status === 503 || status === 529) return 'overloaded';
  if (status === 504) return 'timeout';
  if (status >= 500) return 'server_error';
  return 'invalid_response';
}

export function isContextOverflow(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(lower));
}

function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  if (!body?.trim()) return undefined;
  try {
    const json: unknown = JSON.parse(body);
    return asRecord(Array.isArray(json) ? json[0] : json);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
