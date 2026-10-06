import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@cogitator-ai/types';
import { createLLMError } from '../llm/errors';

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
