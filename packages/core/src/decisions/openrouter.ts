import { z } from 'zod';
import type { DecisionBackend, DecisionRequest, DecisionResponse } from '@cogitator-ai/types';
import {
  createLLMError,
  llmInvalidResponse,
  llmUnavailable,
  retryAfterFromHeaders,
  type LLMErrorContext,
} from '../llm/errors';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export interface OpenRouterDecisionConfig {
  apiKey: string;
  /**
   * The Decisions endpoint (default `https://openrouter.ai/api/alpha/decisions`);
   * an OpenRouter `baseUrl` ending in `/v1` points next to it.
   */
  url?: string;
  /** The fetch to call it with, for tests and proxies. */
  fetch?: typeof fetch;
}

const probabilities = z.record(z.string(), z.number()).optional();

const AnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().optional(),
    probabilities,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: z.number().optional(),
    probabilities,
    legend: z.record(z.string(), z.string()).optional(),
  }),
]);

const ResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cost: z.number().nullable().optional(),
  }),
});

/** The Decisions endpoint next to an OpenRouter API base. */
export function decisionsUrlFor(baseUrl: string | undefined): string {
  if (!baseUrl) return OPENROUTER_DECISIONS_URL;
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/alpha/decisions`;
}

/**
 * OpenRouter's Decisions API, where decision models such as TypeSafe's Jev
 * answer typed questions about a state with probabilities instead of
 * writing text. Chat completions refuse these models.
 */
export class OpenRouterDecisionBackend implements DecisionBackend {
  readonly provider = 'openrouter';
  private readonly url: string;

  constructor(private readonly config: OpenRouterDecisionConfig) {
    if (!config.apiKey) throw new Error('OpenRouter API key is required for decision models');
    this.url = config.url ?? OPENROUTER_DECISIONS_URL;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const context: LLMErrorContext = {
      provider: this.provider,
      model: request.model,
      endpoint: this.url,
    };
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          state: request.state,
          questions: request.questions,
          ...(request.sessionId && { session_id: request.sessionId }),
          ...(request.user && { user: request.user }),
        }),
        ...(request.signal && { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw llmUnavailable(
        context,
        'Failed to reach the OpenRouter Decisions API',
        error instanceof Error ? error : undefined
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw createLLMError(context, response.status, text, {
        retryAfterOverride: retryAfterFromHeaders(response.headers),
      });
    }
    let parsed: z.infer<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(JSON.parse(text));
    } catch (error) {
      throw llmInvalidResponse(
        context,
        `The Decisions API answered in an unexpected shape: ${text.slice(0, 300)}`,
        error instanceof Error ? error : undefined
      );
    }
    return {
      model: parsed.model,
      answers: parsed.answers,
      usage: {
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
        ...(typeof parsed.usage.cost === 'number' && { cost: parsed.usage.cost }),
      },
      ...(parsed.id && { id: parsed.id }),
      ...(parsed.provider && { provider: parsed.provider }),
    };
  }
}
