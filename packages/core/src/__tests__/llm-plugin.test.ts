import { describe, it, expect, afterEach } from 'vitest';
import type { LLMBackend } from '@cogitator-ai/types';
import {
  registerLLMBackend,
  unregisterLLMBackend,
  createLLMBackendFromPlugin,
  listLLMPlugins,
  hasLLMPlugin,
  defineBackend,
  llmPluginRegistry,
} from '../llm/plugin';

function makeFakeBackend(provider = 'openai'): LLMBackend {
  return {
    provider: provider as LLMBackend['provider'],
    chat: async () => ({
      id: 'test',
      content: '',
      finishReason: 'stop' as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    async *chatStream() {},
  };
}

let registeredProviders: string[] = [];

afterEach(() => {
  for (const p of registeredProviders) {
    llmPluginRegistry.unregister(p);
  }
  registeredProviders = [];
});

function registerWithCleanup(provider: string, factory?: () => LLMBackend) {
  registerLLMBackend({
    metadata: { name: provider },
    provider,
    factory: factory ?? (() => makeFakeBackend(provider)),
  });
  registeredProviders.push(provider);
}

describe('registerLLMBackend', () => {
  it('registers a new backend', () => {
    registerWithCleanup('custom-llm-1');
    expect(hasLLMPlugin('custom-llm-1')).toBe(true);
  });

  it('throws on duplicate name', () => {
    registerWithCleanup('custom-llm-2');
    expect(() => registerWithCleanup('custom-llm-2')).toThrow('already registered');
  });
});

describe('unregisterLLMBackend', () => {
  it('removes a registered backend', () => {
    registerWithCleanup('custom-llm-3');
    expect(hasLLMPlugin('custom-llm-3')).toBe(true);

    const result = unregisterLLMBackend('custom-llm-3');
    registeredProviders = registeredProviders.filter((p) => p !== 'custom-llm-3');

    expect(result).toBe(true);
    expect(hasLLMPlugin('custom-llm-3')).toBe(false);
  });

  it('returns false for non-existent provider', () => {
    expect(unregisterLLMBackend('nonexistent')).toBe(false);
  });
});

describe('createLLMBackendFromPlugin', () => {
  it('creates backend from registered plugin', () => {
    registerWithCleanup('custom-llm-4', () => makeFakeBackend('openai'));

    const backend = createLLMBackendFromPlugin('custom-llm-4', {});
    expect(backend.provider).toBe('openai');
  });

  it('throws for unknown plugin', () => {
    expect(() => createLLMBackendFromPlugin('unknown-provider', {})).toThrow(
      "No plugin registered for provider 'unknown-provider'"
    );
  });

  it('validates config when validateConfig is provided', () => {
    registerLLMBackend({
      metadata: { name: 'validated-llm' },
      provider: 'validated-llm',
      factory: (config: { apiKey: string }) => makeFakeBackend(config.apiKey ? 'openai' : 'ollama'),
      validateConfig: (c: unknown): c is { apiKey: string } =>
        typeof c === 'object' && c !== null && 'apiKey' in c,
    });
    registeredProviders.push('validated-llm');

    expect(() => createLLMBackendFromPlugin('validated-llm', {})).toThrow('Invalid configuration');
    const backend = createLLMBackendFromPlugin('validated-llm', { apiKey: 'test' });
    expect(backend).toBeDefined();
  });
});

describe('listLLMPlugins', () => {
  it('returns registered plugins', () => {
    registerWithCleanup('list-test-a');
    registerWithCleanup('list-test-b');

    const plugins = listLLMPlugins();
    const providers = plugins.map((p) => p.provider);
    expect(providers).toContain('list-test-a');
    expect(providers).toContain('list-test-b');

    const pluginA = plugins.find((p) => p.provider === 'list-test-a');
    expect(pluginA!.metadata.name).toBe('list-test-a');
  });

  it('returns empty array when no plugins registered', () => {
    llmPluginRegistry.clear();
    expect(listLLMPlugins()).toEqual([]);
  });
});

describe('hasLLMPlugin', () => {
  it('returns true for registered plugin', () => {
    registerWithCleanup('has-test-1');
    expect(hasLLMPlugin('has-test-1')).toBe(true);
  });

  it('returns false for unregistered plugin', () => {
    expect(hasLLMPlugin('does-not-exist')).toBe(false);
  });
});

describe('defineBackend', () => {
  it('returns a plugin definition object', () => {
    const plugin = defineBackend({
      metadata: { name: 'my-backend', version: '1.0.0', description: 'Test backend' },
      provider: 'my-provider',
      create: (config: { url: string }) => makeFakeBackend(config.url ? 'openai' : 'ollama'),
    });

    expect(plugin.metadata.name).toBe('my-backend');
    expect(plugin.metadata.version).toBe('1.0.0');
    expect(plugin.provider).toBe('my-provider');
    expect(typeof plugin.factory).toBe('function');
  });

  it('maps create to factory', () => {
    const createFn = () => makeFakeBackend();
    const plugin = defineBackend({
      metadata: { name: 'test' },
      provider: 'test-provider',
      create: createFn,
    });

    expect(plugin.factory).toBe(createFn);
  });

  it('passes through validateConfig', () => {
    const validator = (c: unknown): c is { key: string } => typeof c === 'object' && c !== null;
    const plugin = defineBackend({
      metadata: { name: 'test' },
      provider: 'test-provider',
      create: () => makeFakeBackend(),
      validateConfig: validator,
    });

    expect(plugin.validateConfig).toBe(validator);
  });
});
