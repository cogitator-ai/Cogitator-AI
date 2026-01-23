/**
 * LLM Backend Plugin System
 *
 * Allows registration and discovery of custom LLM backends.
 */

import type { LLMBackend } from '@cogitator-ai/types';

export type LLMBackendFactory<TConfig = unknown> = (config: TConfig) => LLMBackend;

export interface LLMPluginMetadata {
  name: string;
  version?: string;
  description?: string;
  author?: string;
}

export interface LLMPlugin<TConfig = unknown> {
  metadata: LLMPluginMetadata;
  provider: string;
  factory: LLMBackendFactory<TConfig>;
  validateConfig?: (config: unknown) => config is TConfig;
}

type RegisteredPlugin = {
  metadata: LLMPluginMetadata;
  factory: LLMBackendFactory;
  validateConfig?: (config: unknown) => boolean;
};

class LLMPluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  register<TConfig>(plugin: LLMPlugin<TConfig>): void {
    if (this.plugins.has(plugin.provider)) {
      throw new Error(`Plugin for provider '${plugin.provider}' is already registered`);
    }

    this.plugins.set(plugin.provider, {
      metadata: plugin.metadata,
      factory: plugin.factory as LLMBackendFactory,
      validateConfig: plugin.validateConfig as ((config: unknown) => boolean) | undefined,
    });
  }

  unregister(provider: string): boolean {
    return this.plugins.delete(provider);
  }

  has(provider: string): boolean {
    return this.plugins.has(provider);
  }

  get(provider: string): RegisteredPlugin | undefined {
    return this.plugins.get(provider);
  }

  create(provider: string, config: unknown): LLMBackend {
    const plugin = this.plugins.get(provider);
    if (!plugin) {
      throw new Error(`No plugin registered for provider '${provider}'`);
    }

    if (plugin.validateConfig && !plugin.validateConfig(config)) {
      throw new Error(`Invalid configuration for provider '${provider}'`);
    }

    return plugin.factory(config);
  }

  list(): Array<{ provider: string; metadata: LLMPluginMetadata }> {
    return Array.from(this.plugins.entries()).map(([provider, plugin]) => ({
      provider,
      metadata: plugin.metadata,
    }));
  }

  clear(): void {
    this.plugins.clear();
  }
}

export const llmPluginRegistry = new LLMPluginRegistry();

export function registerLLMBackend<TConfig>(plugin: LLMPlugin<TConfig>): void {
  llmPluginRegistry.register(plugin);
}

export function unregisterLLMBackend(provider: string): boolean {
  return llmPluginRegistry.unregister(provider);
}

export function createLLMBackendFromPlugin(provider: string, config: unknown): LLMBackend {
  return llmPluginRegistry.create(provider, config);
}

export function listLLMPlugins(): Array<{ provider: string; metadata: LLMPluginMetadata }> {
  return llmPluginRegistry.list();
}

export function hasLLMPlugin(provider: string): boolean {
  return llmPluginRegistry.has(provider);
}

export function defineBackend<TConfig>(
  options: Omit<LLMPlugin<TConfig>, 'factory'> & {
    create: LLMBackendFactory<TConfig>;
  }
): LLMPlugin<TConfig> {
  return {
    metadata: options.metadata,
    provider: options.provider,
    factory: options.create,
    validateConfig: options.validateConfig,
  };
}
