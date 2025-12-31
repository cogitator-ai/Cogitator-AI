import type { ModelInfo, ModelFilter, RegistryOptions, ProviderInfo } from './types';
import { ModelCache } from './cache';
import { fetchLiteLLMData, transformLiteLLMData } from './fetcher';
import { BUILTIN_MODELS, BUILTIN_PROVIDERS } from './providers/index';

export class ModelRegistry {
  private models = new Map<string, ModelInfo>();
  private aliases = new Map<string, string>();
  private providers = new Map<string, ProviderInfo>();
  private cache: ModelCache;
  private options: Required<RegistryOptions>;
  private initialized = false;
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

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const cached = await this.cache.get();

      if (cached && cached.length > 0) {
        this.loadModels(cached);
        this.initialized = true;

        this.refreshInBackground();
        return;
      }

      await this.refresh();
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

  getModel(id: string): ModelInfo | null {
    this.ensureInitialized();

    const normalized = this.normalizeModelId(id);

    const direct = this.models.get(normalized);
    if (direct) return direct;

    const aliasTarget = this.aliases.get(normalized);
    if (aliasTarget) {
      return this.models.get(aliasTarget) ?? null;
    }

    return null;
  }

  getPrice(id: string): { input: number; output: number } | null {
    const model = this.getModel(id);
    if (!model?.pricing) return null;
    return { input: model.pricing.input, output: model.pricing.output };
  }

  listModels(filter?: ModelFilter): ModelInfo[] {
    this.ensureInitialized();

    let models = Array.from(this.models.values());

    if (filter) {
      models = models.filter((model) => {
        if (filter.provider && model.provider !== filter.provider) {
          return false;
        }

        if (filter.supportsTools && !model.capabilities?.supportsTools) {
          return false;
        }

        if (filter.supportsVision && !model.capabilities?.supportsVision) {
          return false;
        }

        if (filter.minContextWindow && model.contextWindow < filter.minContextWindow) {
          return false;
        }

        if (filter.maxPricePerMillion) {
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
    this.models.clear();
    this.aliases.clear();
    this.providers.clear();

    const providerModels = new Map<string, string[]>();

    for (const model of models) {
      this.models.set(model.id, model);

      if (model.aliases) {
        for (const alias of model.aliases) {
          this.aliases.set(alias.toLowerCase(), model.id);
        }
      }

      const existing = providerModels.get(model.provider) ?? [];
      existing.push(model.id);
      providerModels.set(model.provider, existing);
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
      modelMap.set(model.id, model);
    }

    for (const model of fetched) {
      const existing = modelMap.get(model.id);
      if (existing) {
        modelMap.set(model.id, {
          ...existing,
          pricing: model.pricing,
          contextWindow: model.contextWindow || existing.contextWindow,
          maxOutputTokens: model.maxOutputTokens || existing.maxOutputTokens,
          deprecated: model.deprecated,
        });
      } else {
        modelMap.set(model.id, model);
      }
    }

    return Array.from(modelMap.values());
  }

  private normalizeModelId(id: string): string {
    let normalized = id.toLowerCase();

    if (normalized.includes('/')) {
      normalized = normalized.split('/').pop() ?? normalized;
    }

    return normalized;
  }

  private formatProviderName(id: string): string {
    return id
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.loadModels(BUILTIN_MODELS);
      this.initialized = true;
    }
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

export function getModel(modelId: string): ModelInfo | null {
  return getModelRegistry().getModel(modelId);
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
