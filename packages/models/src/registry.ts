import type { ModelInfo, ModelFilter, ModelPricing, RegistryOptions, ProviderInfo } from './types';
import { ModelCache } from './cache';
import { fetchLiteLLMData, normalizeProviderId, transformLiteLLMData } from './fetcher';
import { BUILTIN_MODELS, BUILTIN_PROVIDERS } from './providers/index';

/** Providers a bare model name prefers, first-party APIs and the major clouds first. */
const PREFERRED_PROVIDERS: readonly string[] = BUILTIN_PROVIDERS.map((provider) => provider.id);

function modelKey(model: Pick<ModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

function isFirstParty(model: ModelInfo): boolean {
  return !model.catalogId?.includes('/');
}

function providerRank(provider: string): number {
  const index = PREFERRED_PROVIDERS.indexOf(provider);
  return index === -1 ? PREFERRED_PROVIDERS.length : index;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders the models a name could mean, best first: active before deprecated,
 * a first-party listing (a built-in model or an unprefixed catalogue key)
 * before resellers, then {@link PREFERRED_PROVIDERS}, then a model named
 * exactly so before one it is the tail of, then the shorter id, then
 * alphabetically, so the answer never depends on the catalogue order.
 */
function compareCandidates(name: string, a: ModelInfo, b: ModelInfo): number {
  return (
    Number(a.deprecated ?? false) - Number(b.deprecated ?? false) ||
    Number(!isFirstParty(a)) - Number(!isFirstParty(b)) ||
    providerRank(a.provider) - providerRank(b.provider) ||
    Number(a.id.toLowerCase() !== name) - Number(b.id.toLowerCase() !== name) ||
    a.id.split('/').length - b.id.split('/').length ||
    compareText(a.provider, b.provider) ||
    compareText((a.catalogId ?? a.id).toLowerCase(), (b.catalogId ?? b.id).toLowerCase())
  );
}

export class ModelRegistry {
  private models = new Map<string, ModelInfo>();
  private keys = new Map<string, ModelInfo>();
  private aliases = new Map<string, ModelInfo>();
  private names = new Map<string, ModelInfo[]>();
  private providers = new Map<string, ProviderInfo>();
  private cache: ModelCache;
  private options: Required<RegistryOptions>;
  /** Whether `initialize()` has finished: the catalogue, its cache or the built-in fallback is loaded */
  private initialized = false;
  /** Whether any models are loaded, the built-in ones a lookup before `initialize()` falls back to included */
  private loaded = false;
  private initializing: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RegistryOptions = {}) {
    this.options = {
      cache: options.cache ?? { ttl: 24 * 60 * 60 * 1000, storage: 'memory' },
      autoRefresh: options.autoRefresh ?? false,
      refreshInterval: options.refreshInterval ?? 24 * 60 * 60 * 1000,
      fallbackToBuiltin: options.fallbackToBuiltin ?? true,
    };

    this.cache = new ModelCache(this.options.cache);
  }

  /**
   * Loads the model catalogue: from the cache when it is fresh, otherwise from LiteLLM, falling
   * back to the built-in models when both fail and `fallbackToBuiltin` is set. Lookups made
   * before it use the built-in models without counting as initialization, so calling it later
   * still loads the full catalogue. Overlapping calls share one load.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initializing ??= this.load().finally(() => {
      this.initializing = null;
    });
    await this.initializing;
  }

  private async load(): Promise<void> {
    try {
      const cached = await this.cache.get();

      if (cached && cached.length > 0) {
        this.loadModels(cached);
        this.initialized = true;

        this.refreshInBackground();
      } else {
        await this.refresh();
      }
    } catch (error) {
      if (this.options.fallbackToBuiltin) {
        this.loadModels(BUILTIN_MODELS);
        this.initialized = true;
      } else {
        throw error;
      }
    }

    if (this.options.autoRefresh) {
      this.startAutoRefresh();
    }
  }

  async refresh(): Promise<void> {
    try {
      const data = await fetchLiteLLMData();
      const models = transformLiteLLMData(data);

      const allModels = this.mergeWithBuiltin(models);

      await this.cache.set(allModels);
      this.loadModels(allModels);
      this.initialized = true;
    } catch (error) {
      const stale = await this.cache.getStale();
      if (stale && stale.length > 0) {
        this.loadModels(stale);
        this.initialized = true;
        return;
      }

      if (this.options.fallbackToBuiltin) {
        this.loadModels(BUILTIN_MODELS);
        this.initialized = true;
        return;
      }

      throw error;
    }
  }

  /**
   * The model an id names, case-insensitively. A provider-qualified id
   * (`openrouter/deepseek/deepseek-v4-pro`, `azure_ai/deepseek-v4-pro`,
   * `google/gemini-3.8-flash`) finds that provider's entry. A bare name, or a
   * prefix whose provider does not list the model, finds the best listing of
   * the model by fixed rules, the vendor's own first.
   */
  getModel(id: string): ModelInfo | null {
    this.ensureInitialized();
    return this.resolve(id.toLowerCase());
  }

  getPrice(id: string): { input: number; output: number } | null {
    const model = this.getModel(id);
    if (!model?.pricing) return null;
    return { input: model.pricing.input, output: model.pricing.output };
  }

  getPricing(id: string): ModelPricing | null {
    return this.getModel(id)?.pricing ?? null;
  }

  listModels(filter?: ModelFilter): ModelInfo[] {
    this.ensureInitialized();

    let models = Array.from(this.models.values());

    if (filter) {
      models = models.filter((model) => {
        if (filter.provider && model.provider !== filter.provider) {
          return false;
        }

        if (
          filter.supportsTools !== undefined &&
          (model.capabilities?.supportsTools ?? false) !== filter.supportsTools
        ) {
          return false;
        }

        if (
          filter.supportsVision !== undefined &&
          (model.capabilities?.supportsVision ?? false) !== filter.supportsVision
        ) {
          return false;
        }

        if (
          filter.minContextWindow !== undefined &&
          model.contextWindow < filter.minContextWindow
        ) {
          return false;
        }

        if (filter.maxPricePerMillion !== undefined) {
          const avgPrice = (model.pricing.input + model.pricing.output) / 2;
          if (avgPrice > filter.maxPricePerMillion) {
            return false;
          }
        }

        if (filter.excludeDeprecated && model.deprecated) {
          return false;
        }

        return true;
      });
    }

    return models;
  }

  listProviders(): ProviderInfo[] {
    this.ensureInitialized();
    return Array.from(this.providers.values());
  }

  getProvider(id: string): ProviderInfo | null {
    this.ensureInitialized();
    return this.providers.get(id) ?? null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getModelCount(): number {
    return this.models.size;
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private loadModels(models: ModelInfo[]): void {
    this.loaded = true;
    this.models.clear();
    this.keys.clear();
    this.aliases.clear();
    this.names.clear();
    this.providers.clear();

    const providerModels = new Map<string, string[]>();

    for (const model of models) {
      this.models.set(modelKey(model), model);
    }

    for (const [key, model] of this.models) {
      this.keys.set(key, model);

      const existing = providerModels.get(model.provider) ?? [];
      existing.push(model.id);
      providerModels.set(model.provider, existing);

      const segments = model.id.toLowerCase().split('/');
      for (let start = 0; start < segments.length; start++) {
        const name = segments.slice(start).join('/');
        const named = this.names.get(name) ?? [];
        named.push(model);
        this.names.set(name, named);
      }
    }

    for (const model of this.models.values()) {
      if (model.catalogId) this.setOnce(this.keys, model.catalogId, model);
      for (const alias of model.aliases ?? []) {
        this.setOnce(this.aliases, alias, model);
        this.setOnce(this.aliases, `${model.provider}/${alias}`, model);
      }
    }

    for (const provider of BUILTIN_PROVIDERS) {
      const models = providerModels.get(provider.id) ?? [];
      this.providers.set(provider.id, { ...provider, models });
    }

    for (const [providerId, modelIds] of providerModels) {
      if (!this.providers.has(providerId)) {
        this.providers.set(providerId, {
          id: providerId,
          name: this.formatProviderName(providerId),
          models: modelIds,
        });
      }
    }
  }

  private mergeWithBuiltin(fetched: ModelInfo[]): ModelInfo[] {
    const modelMap = new Map<string, ModelInfo>();

    for (const model of BUILTIN_MODELS) {
      modelMap.set(modelKey(model), model);
    }

    for (const model of fetched) {
      const key = modelKey(model);
      const existing = modelMap.get(key);
      if (existing) {
        const aliases = [...new Set([...(existing.aliases ?? []), ...(model.aliases ?? [])])];
        modelMap.set(key, {
          ...existing,
          ...(model.catalogId !== undefined && { catalogId: model.catalogId }),
          pricing: model.pricing,
          contextWindow: model.contextWindow ?? existing.contextWindow,
          maxOutputTokens: model.maxOutputTokens ?? existing.maxOutputTokens,
          capabilities: this.mergeCapabilities(existing.capabilities, model.capabilities),
          deprecated: existing.deprecated || model.deprecated || undefined,
          ...(aliases.length > 0 && { aliases }),
        });
      } else {
        modelMap.set(key, model);
      }
    }

    return Array.from(modelMap.values());
  }

  private mergeCapabilities(
    existing: ModelInfo['capabilities'],
    fetched: ModelInfo['capabilities']
  ): ModelInfo['capabilities'] {
    if (!existing && !fetched) return undefined;

    return {
      supportsVision: fetched?.supportsVision ?? existing?.supportsVision,
      supportsTools: fetched?.supportsTools ?? existing?.supportsTools,
      supportsFunctions: fetched?.supportsFunctions ?? existing?.supportsFunctions,
      supportsStreaming: fetched?.supportsStreaming ?? existing?.supportsStreaming,
      supportsJson: fetched?.supportsJson ?? existing?.supportsJson,
    };
  }

  private resolve(id: string): ModelInfo | null {
    const direct = this.keys.get(id) ?? this.aliases.get(id);
    if (direct) return direct;

    const slash = id.indexOf('/');
    if (slash !== -1) {
      const rest = id.slice(slash + 1);
      const provider = normalizeProviderId(id.slice(0, slash));
      const qualified = `${provider}/${rest}`;
      const listed =
        this.keys.get(qualified) ?? this.aliases.get(qualified) ?? this.best(rest, provider);
      if (listed) return listed;
    }

    const named = this.best(id);
    if (named) return named;

    return slash === -1 ? null : this.resolve(id.slice(slash + 1));
  }

  /** The best model whose id is `name` or ends in `/name`, at `provider` when one is given. */
  private best(name: string, provider?: string): ModelInfo | null {
    let best: ModelInfo | null = null;
    for (const model of this.names.get(name) ?? []) {
      if (provider !== undefined && model.provider !== provider) continue;
      if (!best || compareCandidates(name, model, best) < 0) best = model;
    }
    return best;
  }

  private setOnce(map: Map<string, ModelInfo>, key: string, model: ModelInfo): void {
    const normalized = key.toLowerCase();
    if (!map.has(normalized)) map.set(normalized, model);
  }

  private formatProviderName(id: string): string {
    return id
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private ensureInitialized(): void {
    if (!this.loaded) this.loadModels(BUILTIN_MODELS);
  }

  private refreshInBackground(): void {
    void fetchLiteLLMData()
      .then(async (data) => {
        const models = transformLiteLLMData(data);
        const allModels = this.mergeWithBuiltin(models);
        await this.cache.set(allModels);
        this.loadModels(allModels);
      })
      .catch((error) => {
        console.warn('[ModelRegistry] Background refresh failed:', error);
      });
  }

  private startAutoRefresh(): void {
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error) => {
        console.warn('[ModelRegistry] Auto-refresh failed:', error);
      });
    }, this.options.refreshInterval);
  }
}

let defaultRegistry: ModelRegistry | null = null;

export function getModelRegistry(): ModelRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ModelRegistry({
      cache: { ttl: 24 * 60 * 60 * 1000, storage: 'file' },
      fallbackToBuiltin: true,
    });
  }
  return defaultRegistry;
}

export async function initializeModels(): Promise<ModelRegistry> {
  const registry = getModelRegistry();
  await registry.initialize();
  return registry;
}

export function getPrice(modelId: string): { input: number; output: number } | null {
  return getModelRegistry().getPrice(modelId);
}

export function getPricing(modelId: string): ModelPricing | null {
  return getModelRegistry().getPricing(modelId);
}

export interface TokenUsageForCost {
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` served from the prompt cache */
  cachedInputTokens?: number;
  /** Part of `inputTokens` written to the prompt cache */
  cacheWriteTokens?: number;
  /** Part of `cacheWriteTokens` written with the 1-hour TTL */
  cacheWrite1hTokens?: number;
}

/**
 * Cost in USD of a model's tokens: cache reads and writes at the model's
 * cache prices where it has them (1-hour cache writes at their own price),
 * the rest of the input at the input price. `null` when the model's price is
 * unknown.
 */
export function calculateCost(modelId: string, usage: TokenUsageForCost): number | null {
  const pricing = getPricing(modelId);
  if (!pricing) return null;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const written = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - cached);
  const writtenFor1h = Math.min(usage.cacheWrite1hTokens ?? 0, written);
  const uncached = usage.inputTokens - cached - written;
  const writePrice = pricing.inputCacheWrite ?? pricing.input;
  return (
    (uncached * pricing.input +
      cached * (pricing.inputCached ?? pricing.input) +
      (written - writtenFor1h) * writePrice +
      writtenFor1h * (pricing.inputCacheWrite1h ?? writePrice) +
      usage.outputTokens * pricing.output) /
    1_000_000
  );
}

export function getModel(modelId: string): ModelInfo | null {
  return getModelRegistry().getModel(modelId);
}

/** Whether `modelId` is a decision model, which answers through `cog.decide()` instead of chat. */
export function isDecisionModel(modelId: string): boolean {
  return getModel(modelId)?.kind === 'decision';
}

export function listModels(filter?: ModelFilter): ModelInfo[] {
  return getModelRegistry().listModels(filter);
}

export function shutdownModels(): void {
  if (defaultRegistry) {
    defaultRegistry.shutdown();
    defaultRegistry = null;
  }
}
