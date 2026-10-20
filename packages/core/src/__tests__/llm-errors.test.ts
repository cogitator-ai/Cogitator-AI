import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@cogitator-ai/types';
import { abortReason, createLLMError, providerErrorIn, wrapSDKError } from '../llm/errors';

const ctx = { provider: 'openai', model: 'gpt-5' };

describe('createLLMError for a 400', () => {
  it.each([
    [
      'OpenAI',
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }),
    ],
    ['Anthropic', 'prompt is too long: 210000 tokens > 200000 maximum'],
    [
      'Gemini',
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    ],
    ['Bedrock', 'Input is too long for requested model.'],
    [
      'Mistral',
      'Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length',
    ],
    ['Ollama', JSON.stringify({ error: 'input length exceeds the context length' })],
    [
      'llama.cpp',
      JSON.stringify({
        error: {
          code: 400,
          message: 'the request exceeds the available context size, try increasing it',
          type: 'exceed_context_size_error',
        },
      }),
    ],
    [
      'an OpenAI-compatible proxy',
      JSON.stringify({ error: 'context length exceeded, max 4096 tokens' }),
    ],
  ])('reads the %s context overflow as context length exceeded', (_provider, body) => {
    const error = createLLMError(ctx, 400, body);

    expect(error.code).toBe(ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED);
    expect(error.retryable).toBe(false);
  });

  it.each([
    "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    'max_tokens: 64001 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1',
    "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.",
    'Invalid prompt: your prompt length is fine but the tool schema is invalid',
  ])('keeps a bad request that only mentions tokens a bad request: %s', (body) => {
    const error = createLLMError(ctx, 400, body);

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.message).toContain(body.slice(0, 40));
  });

  it("puts the provider's own words into the message of a context overflow", () => {
    const error = createLLMError(
      ctx,
      400,
      JSON.stringify({
        error: {
          message: "This model's maximum context length is 128000 tokens.",
          code: 'context_length_exceeded',
        },
      })
    );

    expect(error.message).toContain("This model's maximum context length is 128000 tokens.");
    expect(error.message).not.toContain('{');
  });

  it("puts the provider's own words into the message of a content filter block", () => {
    const error = createLLMError(ctx, 400, 'The response was blocked by the safety system.');

    expect(error.code).toBe(ErrorCode.LLM_CONTENT_FILTERED);
    expect(error.message).toContain('blocked by the safety system');
  });
});

describe("createLLMError keeps the provider's message", () => {
  it.each([
    [401, 'Incorrect API key provided: sk-abc***.'],
    [403, 'Project does not have access to model gpt-5.'],
    [404, 'The model `gpt-9` does not exist or you do not have access to it.'],
    [429, 'You exceeded your current quota, please check your plan and billing details.'],
  ])('for a %i', (status, body) => {
    expect(createLLMError(ctx, status, body).message).toContain(body.slice(0, 30));
  });
});

describe('provider error tables', () => {
  const openai = { provider: 'openai', model: 'gpt-5' };
  const anthropic = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
  const google = { provider: 'google', model: 'gemini-3.8-flash' };
  const body = (error: Record<string, unknown>) => JSON.stringify({ error });

  it.each([
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])('does not retry an OpenAI 429 with code %s, the quota is gone', (code) => {
    const error = createLLMError(openai, 429, body({ message: 'No credits', code }), {
      retryAfterOverride: 20_000,
    });

    expect(error.code).toBe(ErrorCode.LLM_QUOTA_EXCEEDED);
    expect(error.kind).toBe('quota');
    expect(error.details?.kind).toBe('quota');
    expect(error.retryable).toBe(false);
    expect(error.retryAfter).toBeUndefined();
  });

  it('reads the old insufficient_quota type of an OpenAI-compatible server as quota', () => {
    const error = createLLMError(
      { provider: 'deepseek' },
      429,
      body({ message: 'Balance too low', type: 'insufficient_quota' })
    );
    expect(error.kind).toBe('quota');
  });

  it('retries an OpenAI rate limit after the wait it asks for', () => {
    const error = createLLMError(
      openai,
      429,
      body({ message: 'Rate limit reached for requests', type: 'requests' }),
      { retryAfterOverride: 1500 }
    );

    expect(error.code).toBe(ErrorCode.LLM_RATE_LIMITED);
    expect(error.kind).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.retryAfter).toBe(1500);
  });

  it('retries an overloaded OpenAI server', () => {
    const error = createLLMError(
      openai,
      503,
      body({ type: 'service_unavailable_error', code: 'server_is_overloaded', message: 'Busy' })
    );
    expect(error).toMatchObject({ kind: 'overloaded', retryable: true });
  });

  it.each([
    ['billing_error', 402, 'quota', false, ErrorCode.LLM_QUOTA_EXCEEDED],
    ['authentication_error', 401, 'authentication', false, ErrorCode.LLM_UNAVAILABLE],
    ['permission_error', 403, 'permission', false, ErrorCode.LLM_UNAVAILABLE],
    ['not_found_error', 404, 'not_found', false, ErrorCode.LLM_UNAVAILABLE],
    ['rate_limit_error', 429, 'rate_limit', true, ErrorCode.LLM_RATE_LIMITED],
    ['api_error', 500, 'server_error', true, ErrorCode.LLM_UNAVAILABLE],
    ['timeout_error', 504, 'timeout', true, ErrorCode.LLM_TIMEOUT],
    ['overloaded_error', 529, 'overloaded', true, ErrorCode.LLM_UNAVAILABLE],
  ])('reads the Anthropic %s', (type, status, kind, retryable, code) => {
    const error = createLLMError(
      anthropic,
      status,
      JSON.stringify({ type: 'error', error: { type, message: 'Something' } })
    );
    expect(error).toMatchObject({ kind, retryable, code });
  });

  it('reads an Anthropic 429 for a reached spend limit as quota', () => {
    const error = createLLMError(
      anthropic,
      429,
      JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'You have reached your specified API usage limits.',
        },
      })
    );
    expect(error).toMatchObject({ kind: 'quota', retryable: false });
  });

  const quotaFailure = (quotaId: string) =>
    body({
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota.',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId,
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '55s' },
      ],
    });

  it('retries a Gemini per-minute rate limit after its retryDelay', () => {
    const error = createLLMError(
      google,
      429,
      quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')
    );
    expect(error).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfter: 55_000 });
  });

  it('does not retry a Gemini quota counted per day, whatever its retryDelay', () => {
    const error = createLLMError(
      google,
      429,
      quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier')
    );
    expect(error).toMatchObject({
      kind: 'quota',
      code: ErrorCode.LLM_QUOTA_EXCEEDED,
      retryable: false,
    });
  });

  it('reads Gemini prepaid credits that ran out as quota', () => {
    const error = createLLMError(
      google,
      402,
      body({ code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Credits depleted' })
    );
    expect(error.kind).toBe('quota');
  });

  it('reads an invalid Gemini API key as an authentication failure', () => {
    const error = createLLMError(
      google,
      400,
      body({
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'API key not valid. Please pass a valid API key.',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ],
      })
    );
    expect(error).toMatchObject({ kind: 'authentication', retryable: false });
  });

  it('reads an overloaded Gemini as retryable', () => {
    const error = createLLMError(
      google,
      503,
      body({ code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' })
    );
    expect(error).toMatchObject({ kind: 'overloaded', retryable: true });
  });
});

describe('errors an SDK raises from a stream that began', () => {
  class APIError extends Error {
    constructor(
      readonly status: number | undefined,
      readonly error: unknown
    ) {
      super(JSON.stringify(error));
    }
  }

  it('classifies an Anthropic stream error event by its type', () => {
    const error = wrapSDKError(
      new APIError(undefined, {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
      { provider: 'anthropic' }
    );

    expect(error).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(error.message).toContain('Overloaded');
    expect(error.message).not.toContain('{');
  });

  it('classifies an OpenAI stream error chunk by its code', () => {
    const error = wrapSDKError(
      new APIError(undefined, { message: 'Out of credits', code: 'credit_balance_exhausted' }),
      { provider: 'openai' }
    );
    expect(error).toMatchObject({ kind: 'quota', retryable: false });
  });

  it('reads an error in a response body by the provider codes', () => {
    expect(
      providerErrorIn({ error: { code: 'insufficient_quota', message: 'No credits' } }, ctx)
    ).toMatchObject({ kind: 'quota', retryable: false });
    expect(providerErrorIn({ error: { code: 503, message: 'Upstream down' } }, ctx)).toMatchObject({
      kind: 'overloaded',
      retryable: true,
    });
    expect(providerErrorIn({ error: { message: 'Something broke' } }, ctx)).toMatchObject({
      kind: 'server_error',
      retryable: true,
      details: { statusCode: 502 },
    });
  });
});

describe('abortReason', () => {
  it('is the reason the caller aborted with', () => {
    const controller = new AbortController();
    const reason = new Error('Stopped by the user');
    expect(abortReason(controller.signal)).toBeUndefined();

    controller.abort(reason);
    expect(abortReason(controller.signal)).toBe(reason);
  });

  it('is an AbortError when the reason is not an Error', () => {
    const controller = new AbortController();
    controller.abort('user left');
    expect(abortReason(controller.signal)).toMatchObject({
      name: 'AbortError',
      message: 'user left',
    });
  });
});

describe('review regressions', () => {
  class APIError extends Error {
    constructor(
      readonly status: number | undefined,
      readonly error: unknown
    ) {
      super(JSON.stringify(error));
    }
  }

  it.each([
    [429, 'rate_limit', true],
    [400, 'invalid_request', false],
    [401, 'authentication', false],
    [402, 'quota', false],
  ])('reads a numeric code %i of an OpenRouter error inside a stream', (code, kind, retryable) => {
    const error = wrapSDKError(new APIError(undefined, { code, message: 'Upstream said no' }), {
      provider: 'openrouter',
    });
    expect(error).toMatchObject({ kind, retryable, details: { statusCode: code } });
  });

  it('keeps a Gemini per-minute rate limit retryable behind an OpenAI-compatible endpoint', () => {
    const error = createLLMError(
      { provider: 'openai' },
      429,
      JSON.stringify([
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'You exceeded your current quota, please check your plan and billing details.',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
              },
            ],
          },
        },
      ])
    );
    expect(error).toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('reads a Gemini error list the OpenAI SDK keeps whole by the Gemini rules', () => {
    const body = (quotaId: string) => [
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'You exceeded your current quota.',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
          ],
        },
      },
    ];
    const daily = wrapSDKError(
      new APIError(429, body('GenerateRequestsPerDayPerProjectPerModel-FreeTier')),
      { provider: 'openai' }
    );
    const perMinute = wrapSDKError(
      new APIError(429, body('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')),
      { provider: 'openai' }
    );

    expect(daily).toMatchObject({ kind: 'quota', retryable: false });
    expect(perMinute).toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('reads an Anthropic balance too low, sent as invalid_request_error, as quota', () => {
    const error = createLLMError(
      { provider: 'anthropic' },
      400,
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      })
    );
    expect(error).toMatchObject({ kind: 'quota', code: ErrorCode.LLM_QUOTA_EXCEEDED });
  });

  it('answers HTTP clients with 402 for an exhausted quota, which they do not retry', () => {
    expect(
      createLLMError(
        { provider: 'openai' },
        429,
        JSON.stringify({ error: { code: 'insufficient_quota' } })
      ).statusCode
    ).toBe(402);
  });
});
