import type { LLMProvider, ProjectOptions } from '../types.js';

export const defaultModels: Record<LLMProvider, string> = {
  ollama: 'qwen3.5:9b',
  openai: 'gpt-6.1-sol',
  anthropic: 'claude-sonnet-5-5',
  google: 'gemini-3.8-flash',
};

/** The model the project's agents use: `options.model`, else the provider's default. */
export function modelFor(options: Pick<ProjectOptions, 'provider' | 'model'>): string {
  return options.model?.trim() || defaultModels[options.provider];
}

export function providerEnvKey(provider: LLMProvider): string {
  const map: Record<LLMProvider, string> = {
    ollama: 'OLLAMA_BASE_URL',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  };
  return map[provider];
}

/**
 * How generated code reads the provider's API key: `requireEnv` calls the
 * `requireEnv` helper of the generated `src/env.ts`, which fails at startup
 * with the name of the missing variable. `process-env` reads `process.env` and
 * leaves a missing key to the first request, for code a build imports without
 * the key, such as a Next.js route.
 */
export type ApiKeyAccess = 'requireEnv' | 'process-env';

function apiKeyExpression(envKey: string, access: ApiKeyAccess): string {
  return access === 'requireEnv' ? `requireEnv('${envKey}')` : `process.env.${envKey} ?? ''`;
}

/** The `llm` section of the generated `new Cogitator({...})` call. */
export function providerConfig(
  provider: LLMProvider,
  access: ApiKeyAccess = 'process-env'
): string {
  if (provider === 'ollama') {
    return [
      `  llm: {`,
      `    defaultProvider: 'ollama',`,
      `    providers: {`,
      `      ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },`,
      `    },`,
      `  },`,
    ].join('\n');
  }

  return [
    `  llm: {`,
    `    defaultProvider: '${provider}',`,
    `    providers: {`,
    `      ${provider}: { apiKey: ${apiKeyExpression(providerEnvKey(provider), access)} },`,
    `    },`,
    `  },`,
  ].join('\n');
}
