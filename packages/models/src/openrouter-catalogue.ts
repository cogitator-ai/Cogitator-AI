import { z } from 'zod';
import type { ModelInfo, ModelPricing } from './types';

/** OpenRouter's public model list, served without an API key. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const FETCH_TIMEOUT = 10_000;
/** Pages followed through `links.next` before the list counts as broken */
const MAX_PAGES = 20;

/** A price in USD per token as OpenRouter writes it, a decimal string. `-1` means the price varies by route. */
const PriceSchema = z.string();

/** The fields of an OpenRouter model the registry reads, see https://openrouter.ai/docs/api-reference/models */
export const OpenRouterModelEntrySchema = z.object({
  /** The model's name at OpenRouter, `deepseek/deepseek-v4-pro` or `~openai/gpt-sol-latest` */
  id: z.string().min(1),
  name: z.string().optional(),
  context_length: z.number().nullish(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  pricing: z.object({
    prompt: PriceSchema,
    completion: PriceSchema,
    input_cache_read: PriceSchema.optional(),
    input_cache_write: PriceSchema.optional(),
    input_cache_write_1h: PriceSchema.optional(),
  }),
  top_provider: z
    .object({
      context_length: z.number().nullish(),
      max_completion_tokens: z.number().nullish(),
    })
    .nullish(),
  supported_parameters: z.array(z.string()).optional(),
  /** The day OpenRouter stops serving the model, `YYYY-MM-DD` */
  expiration_date: z.string().nullish(),
});

export type OpenRouterModelEntry = z.infer<typeof OpenRouterModelEntrySchema>;

const PageSchema = z.object({
  data: z.array(z.unknown()),
  links: z.object({ next: z.string().nullish() }).optional(),
});

/** The parameters of `supported_parameters` the registry reads capabilities from */
export const OPENROUTER_CAPABILITY_PARAMETERS: readonly string[] = [
  'tools',
  'response_format',
  'structured_outputs',
];

/**
 * The models of a page of OpenRouter's list, the ones that do not match the schema left out, so
 * one odd entry does not cost the rest. Throws when the page is not a model list at all.
 */
export function parseOpenRouterModels(page: unknown): {
  models: OpenRouterModelEntry[];
  next?: string;
} {
  const parsed = PageSchema.safeParse(page);
  if (!parsed.success)
    throw new Error('OpenRouter answered with something other than a model list');
  const models: OpenRouterModelEntry[] = [];
  for (const entry of parsed.data.data) {
    const model = OpenRouterModelEntrySchema.safeParse(entry);
    if (model.success) models.push(model.data);
  }
  const next = parsed.data.links?.next ?? undefined;
  return { models, ...(next && { next }) };
}

/** OpenRouter's model list from `url`, every page of it. */
export async function fetchOpenRouterData(
  url: string = OPENROUTER_MODELS_URL
): Promise<OpenRouterModelEntry[]> {
  const models: OpenRouterModelEntry[] = [];
  const seen = new Set<string>();
  let pageUrl: string | undefined = url;
  for (let page = 0; pageUrl !== undefined; page++) {
    if (page === MAX_PAGES || seen.has(pageUrl)) {
      throw new Error(`OpenRouter's model list did not end after ${page} pages`);
    }
    seen.add(pageUrl);
    const result = parseOpenRouterModels(await fetchPage(pageUrl));
    models.push(...result.models);
    pageUrl = result.next === undefined ? undefined : new URL(result.next, pageUrl).toString();
  }
  return models;
}

async function fetchPage(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Cogitator/1.0' },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch OpenRouter models: ${response.status} ${response.statusText}`
      );
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * USD per million tokens of a per-token decimal string, without floating point noise, or
 * `undefined` for anything but a non-negative number (OpenRouter's `-1` of routers whose price
 * depends on the model they pick).
 */
function perMillion(price: string | undefined): number | undefined {
  if (price === undefined || price.trim() === '') return undefined;
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Number((value * 1_000_000).toPrecision(12));
}

/** Whether OpenRouter gives the model a price: a non-negative prompt and completion price. */
export function isOpenRouterPriced(entry: OpenRouterModelEntry): boolean {
  return (
    perMillion(entry.pricing.prompt) !== undefined &&
    perMillion(entry.pricing.completion) !== undefined
  );
}

/** Whether the model answers in text, the ones the registry prices. Unknown modalities count as text. */
export function answersInText(entry: OpenRouterModelEntry): boolean {
  const output = entry.architecture?.output_modalities;
  return output === undefined || output.includes('text');
}

function pricingOf(entry: OpenRouterModelEntry): ModelPricing {
  const cached = perMillion(entry.pricing.input_cache_read);
  const cacheWrite = perMillion(entry.pricing.input_cache_write);
  const cacheWrite1h = perMillion(entry.pricing.input_cache_write_1h);
  return {
    input: perMillion(entry.pricing.prompt) ?? 0,
    output: perMillion(entry.pricing.completion) ?? 0,
    ...(cached !== undefined && { inputCached: cached }),
    ...(cacheWrite !== undefined && { inputCacheWrite: cacheWrite }),
    ...(cacheWrite1h !== undefined && { inputCacheWrite1h: cacheWrite1h }),
  };
}

function capabilitiesOf(entry: OpenRouterModelEntry): ModelInfo['capabilities'] {
  const parameters = entry.supported_parameters;
  const inputs = entry.architecture?.input_modalities;
  if (parameters === undefined && inputs === undefined) return undefined;
  const tools = parameters?.includes('tools');
  return {
    ...(tools !== undefined && { supportsTools: tools, supportsFunctions: tools }),
    ...(inputs !== undefined && { supportsVision: inputs.includes('image') }),
    ...(parameters !== undefined && {
      supportsJson:
        parameters.includes('response_format') || parameters.includes('structured_outputs'),
    }),
  };
}

function isExpired(date: string | null | undefined, now: Date): boolean {
  if (!date) return false;
  const time = Date.parse(date);
  return Number.isFinite(time) && time < now.getTime();
}

/**
 * Turns OpenRouter's model list into registry models of provider `openrouter`, each with
 * OpenRouter's own price and `catalogId` `openrouter/<id>`, so `openrouter/deepseek/deepseek-v4-pro`
 * is priced as OpenRouter bills it and not as DeepSeek does. Routers without a fixed price carry
 * `priceUnknown`, models past their `expiration_date` are deprecated, models that do not answer
 * in text are left out.
 */
export function transformOpenRouterData(
  entries: readonly OpenRouterModelEntry[],
  now: Date = new Date()
): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const entry of entries) {
    if (!answersInText(entry)) continue;
    const key = entry.id.toLowerCase();
    if (byId.has(key)) continue;
    const contextWindow = entry.context_length ?? entry.top_provider?.context_length ?? undefined;
    const maxOutputTokens = entry.top_provider?.max_completion_tokens ?? undefined;
    const capabilities = capabilitiesOf(entry);
    byId.set(key, {
      id: entry.id,
      provider: 'openrouter',
      catalogId: `openrouter/${entry.id}`,
      displayName: entry.name ?? entry.id,
      pricing: pricingOf(entry),
      contextWindow: contextWindow ?? 4096,
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(capabilities && { capabilities }),
      deprecated: isExpired(entry.expiration_date, now),
      ...(!isOpenRouterPriced(entry) && { priceUnknown: true }),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
