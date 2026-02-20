/**
 * Environment variable configuration loader
 */

import type { CogitatorConfigInput } from '../schema';

const ENV_PREFIX = 'COGITATOR_';

/**
 * Load configuration from environment variables
 *
 * Environment variable mapping:
 * - COGITATOR_LLM_DEFAULT_PROVIDER -> llm.defaultProvider
 * - COGITATOR_LLM_DEFAULT_MODEL -> llm.defaultModel
 * - COGITATOR_OLLAMA_BASE_URL -> llm.providers.ollama.baseUrl
 * - COGITATOR_OPENAI_API_KEY -> llm.providers.openai.apiKey
 * - COGITATOR_OPENAI_BASE_URL -> llm.providers.openai.baseUrl
 * - COGITATOR_ANTHROPIC_API_KEY -> llm.providers.anthropic.apiKey
 * - COGITATOR_GOOGLE_API_KEY -> llm.providers.google.apiKey
 * - COGITATOR_VLLM_BASE_URL -> llm.providers.vllm.baseUrl
 * - COGITATOR_LIMITS_MAX_CONCURRENT_RUNS -> limits.maxConcurrentRuns
 * - COGITATOR_LIMITS_DEFAULT_TIMEOUT -> limits.defaultTimeout
 * - COGITATOR_LIMITS_MAX_TOKENS_PER_RUN -> limits.maxTokensPerRun
 *
 * Also supports standard env vars:
 * - OPENAI_API_KEY -> llm.providers.openai.apiKey
 * - ANTHROPIC_API_KEY -> llm.providers.anthropic.apiKey
 * - OLLAMA_HOST -> llm.providers.ollama.baseUrl
 */
const VALID_PROVIDERS = ['ollama', 'openai', 'anthropic', 'google', 'vllm'] as const;
type LLMProvider = (typeof VALID_PROVIDERS)[number];

function isValidProvider(value: string): value is LLMProvider {
  return VALID_PROVIDERS.includes(value as LLMProvider);
}

export function loadEnvConfig(): CogitatorConfigInput {
  const config: CogitatorConfigInput = {};

  const defaultProvider = getEnv('LLM_DEFAULT_PROVIDER');
  const defaultModel = getEnv('LLM_DEFAULT_MODEL');

  if (defaultProvider || defaultModel) {
    config.llm = {
      ...config.llm,
      defaultProvider:
        defaultProvider && isValidProvider(defaultProvider) ? defaultProvider : undefined,
      defaultModel,
    };
  }

  const providers = loadProviderConfigs();
  if (Object.keys(providers).length > 0) {
    config.llm = { ...config.llm, providers };
  }

  const limits = loadLimitsConfig();
  if (Object.keys(limits).length > 0) {
    config.limits = limits;
  }

  const deployTarget = getEnv('DEPLOY_TARGET');
  const deployPort = getEnvNumber('DEPLOY_PORT');
  const deployRegistry = getEnv('DEPLOY_REGISTRY');
  if (deployTarget || deployPort || deployRegistry) {
    (config as Record<string, unknown>).deploy = {
      ...(deployTarget ? { target: deployTarget } : {}),
      ...(deployPort ? { port: deployPort } : {}),
      ...(deployRegistry ? { registry: deployRegistry } : {}),
    };
  }

  return config;
}

type ProvidersConfig = NonNullable<NonNullable<CogitatorConfigInput['llm']>['providers']>;
type LimitsConfig = NonNullable<CogitatorConfigInput['limits']>;

function loadProviderConfigs(): ProvidersConfig {
  const providers: ProvidersConfig = {};

  const ollamaBaseUrl = getEnv('OLLAMA_BASE_URL') ?? process.env.OLLAMA_HOST;
  const ollamaApiKey = getEnv('OLLAMA_API_KEY') ?? process.env.OLLAMA_API_KEY;
  if (ollamaBaseUrl || ollamaApiKey) {
    providers.ollama = {
      baseUrl:
        ollamaBaseUrl ?? (ollamaApiKey ? 'https://api.ollama.com' : 'http://localhost:11434'),
      ...(ollamaApiKey ? { apiKey: ollamaApiKey } : {}),
    };
  }

  const openaiApiKey = getEnv('OPENAI_API_KEY') ?? process.env.OPENAI_API_KEY;
  const openaiBaseUrl = getEnv('OPENAI_BASE_URL') ?? process.env.OPENAI_BASE_URL;
  if (openaiApiKey) {
    providers.openai = { apiKey: openaiApiKey, baseUrl: openaiBaseUrl };
  }

  const anthropicApiKey = getEnv('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY;
  if (anthropicApiKey) {
    providers.anthropic = { apiKey: anthropicApiKey };
  }

  const googleApiKey = getEnv('GOOGLE_API_KEY') ?? process.env.GOOGLE_API_KEY;
  if (googleApiKey) {
    providers.google = { apiKey: googleApiKey };
  }

  const vllmBaseUrl = getEnv('VLLM_BASE_URL');
  if (vllmBaseUrl) {
    providers.vllm = { baseUrl: vllmBaseUrl };
  }

  return providers;
}

function loadLimitsConfig(): LimitsConfig {
  const limits: LimitsConfig = {};

  const maxConcurrentRuns = getEnvNumber('LIMITS_MAX_CONCURRENT_RUNS');
  const defaultTimeout = getEnvNumber('LIMITS_DEFAULT_TIMEOUT');
  const maxTokensPerRun = getEnvNumber('LIMITS_MAX_TOKENS_PER_RUN');

  if (maxConcurrentRuns !== undefined) limits.maxConcurrentRuns = maxConcurrentRuns;
  if (defaultTimeout !== undefined) limits.defaultTimeout = defaultTimeout;
  if (maxTokensPerRun !== undefined) limits.maxTokensPerRun = maxTokensPerRun;

  return limits;
}

function getEnv(key: string): string | undefined {
  return process.env[`${ENV_PREFIX}${key}`];
}

function getEnvNumber(key: string): number | undefined {
  const value = getEnv(key);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  return parseInt(value, 10);
}
