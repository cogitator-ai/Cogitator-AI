import { AsyncLocalStorage } from 'node:async_hooks';
import { OpenAIBackend } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  LLMBackend,
} from '@cogitator-ai/types';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Backend name the gauntlet registers OpenRouter under: models are `openrouter/<vendor>/<model>`. */
export const BACKEND = 'openrouter';

/**
 * The models the gauntlet runs on, from three vendors so multi-agent stages argue across
 * models rather than with one model in three hats. Override with `GAUNTLET_MODELS`
 * (comma-separated OpenRouter ids, primary first).
 */
export const DEFAULT_MODELS = [
  'deepseek/deepseek-v4-pro',
  'openai/gpt-6-luna',
  'z-ai/glm-5.3-flash',
] as const;

/**
 * Further popular models only the model matrix runs: a cheap way to check the runtime against
 * more vendors without making every multi-agent stage slower.
 */
export const MATRIX_EXTRA_MODELS = ['xiaomi/mimo-v2.6-flash', 'qwen/qwen3.8-flash'] as const;

export interface ModelPrice {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
}

/** Which stage a model call belongs to, so usage lands on the right stage. */
export const currentStage = new AsyncLocalStorage<string>();

/** One model call's tokens, and what the provider charged when it says so. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD the provider reported for the call (OpenRouter's `usage.cost`). */
  costUsd?: number;
}

export type UsageListener = (stageId: string | undefined, model: string, usage: CallUsage) => void;

/**
 * Wraps the OpenRouter backend and reports the token usage of every call, streamed or not,
 * to `onUsage` together with the stage it ran in.
 */
export class MeteredBackend implements LLMBackend {
  readonly provider = BACKEND;

  constructor(
    private readonly inner: LLMBackend,
    private readonly onUsage: UsageListener
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.inner.chat(request);
    this.report(request.model, response.usage);
    return response;
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    let usage: ChatUsage | undefined;
    for await (const chunk of this.inner.chatStream(request)) {
      if (chunk.usage) usage = chunk.usage;
      yield chunk;
    }
    this.report(request.model, usage);
  }

  private report(model: string, usage: ChatUsage | undefined): void {
    if (!usage) return;
    this.onUsage(currentStage.getStore(), model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cost !== undefined && { costUsd: usage.cost }),
    });
  }
}

export function createOpenRouterBackend(apiKey: string, onUsage: UsageListener): LLMBackend {
  return new MeteredBackend(
    new OpenAIBackend({ apiKey, baseUrl: OPENROUTER_BASE_URL, provider: BACKEND }),
    onUsage
  );
}

/** `openrouter/<id>`: the model string agents use. */
export function modelRef(id: string): string {
  return `${BACKEND}/${id}`;
}

interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** The cheapest and dearest provider prices of a model on OpenRouter. */
export interface PriceRange {
  low: ModelPrice;
  high: ModelPrice;
  providers: number;
}

/** Every provider's price for one model, from OpenRouter's endpoints API. */
export async function fetchPriceRange(id: string, signal?: AbortSignal): Promise<PriceRange> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models/${id}/endpoints`, { signal });
  if (!response.ok)
    throw new Error(`OpenRouter endpoints API answered ${response.status} for ${id}`);
  const { data } = (await response.json()) as {
    data: { endpoints: { pricing?: { prompt?: string; completion?: string } }[] };
  };
  const prices = data.endpoints.map((endpoint) => ({
    input: Number(endpoint.pricing?.prompt ?? 0),
    output: Number(endpoint.pricing?.completion ?? 0),
  }));
  if (prices.length === 0) throw new Error(`OpenRouter lists no provider for ${id}`);
  return {
    low: {
      input: Math.min(...prices.map((p) => p.input)),
      output: Math.min(...prices.map((p) => p.output)),
    },
    high: {
      input: Math.max(...prices.map((p) => p.input)),
      output: Math.max(...prices.map((p) => p.output)),
    },
    providers: prices.length,
  };
}

/**
 * Prices and capabilities of the given models from the public OpenRouter catalogue. Unknown
 * models are reported so a typo in `GAUNTLET_MODELS` fails fast.
 */
export async function fetchModelCatalogue(
  ids: readonly string[],
  signal?: AbortSignal
): Promise<{ prices: Map<string, ModelPrice>; missing: string[]; withoutTools: string[] }> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`, { signal });
  if (!response.ok) throw new Error(`OpenRouter models API answered ${response.status}`);
  const { data } = (await response.json()) as { data: OpenRouterModel[] };
  const byId = new Map(data.map((model) => [model.id, model]));

  const prices = new Map<string, ModelPrice>();
  const missing: string[] = [];
  const withoutTools: string[] = [];
  for (const id of ids) {
    const model = byId.get(id);
    if (!model) {
      missing.push(id);
      continue;
    }
    if (!model.supported_parameters?.includes('tools')) withoutTools.push(id);
    prices.set(id, {
      input: Number(model.pricing?.prompt ?? 0),
      output: Number(model.pricing?.completion ?? 0),
    });
  }
  return { prices, missing, withoutTools };
}

/**
 * USD for a call at the catalogue price, given the request's model string (`openrouter/<id>` or a
 * bare id). Only an estimate: OpenRouter routes a model across providers whose prices differ
 * several times over, so a reported cost beats it.
 */
export function costOf(
  prices: Map<string, ModelPrice>,
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number {
  const id = model.startsWith(`${BACKEND}/`) ? model.slice(BACKEND.length + 1) : model;
  const price = prices.get(id);
  if (!price) return 0;
  return usage.inputTokens * price.input + usage.outputTokens * price.output;
}
