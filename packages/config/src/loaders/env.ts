/**
 * Environment variable configuration loader
 */

import type { LLMProvider as LLMProviderName } from '@cogitator-ai/types';
import { DeployTargetSchema, LLMProviderSchema, type CogitatorConfigInput } from '../schema';
import { resolveOllamaHost } from '../ollama';
import { PROVIDER_ENV, type ProviderEnvSetting } from '../provider-env';

const ENV_PREFIX = 'COGITATOR_';

/**
 * Load the configuration environment variables set over cogitator.yml.
 * `PROVIDER_ENV` lists the variables of every provider.
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
 * - COGITATOR_AZURE_API_KEY -> llm.providers.azure.apiKey
 * - COGITATOR_AZURE_ENDPOINT -> llm.providers.azure.endpoint
 * - COGITATOR_AZURE_API_VERSION -> llm.providers.azure.apiVersion
 * - COGITATOR_AZURE_DEPLOYMENT -> llm.providers.azure.deployment
 * - COGITATOR_BEDROCK_REGION -> llm.providers.bedrock.region
 * - COGITATOR_BEDROCK_ACCESS_KEY_ID -> llm.providers.bedrock.accessKeyId
 * - COGITATOR_BEDROCK_SECRET_ACCESS_KEY -> llm.providers.bedrock.secretAccessKey
 * - COGITATOR_BEDROCK_SESSION_TOKEN -> llm.providers.bedrock.sessionToken
 * - COGITATOR_BEDROCK_PROFILE -> llm.providers.bedrock.profile
 * - COGITATOR_MISTRAL_API_KEY -> llm.providers.mistral.apiKey
 * - COGITATOR_GROQ_API_KEY -> llm.providers.groq.apiKey
 * - COGITATOR_TOGETHER_API_KEY -> llm.providers.together.apiKey
 * - COGITATOR_DEEPSEEK_API_KEY -> llm.providers.deepseek.apiKey
 * - COGITATOR_LIMITS_MAX_CONCURRENT_RUNS -> limits.maxConcurrentRuns
 * - COGITATOR_LIMITS_DEFAULT_TIMEOUT -> limits.defaultTimeout
 * - COGITATOR_LIMITS_MAX_TOKENS_PER_RUN -> limits.maxTokensPerRun
 *
 * Also supports standard env vars:
 * - OPENAI_API_KEY -> llm.providers.openai.apiKey
 * - ANTHROPIC_API_KEY -> llm.providers.anthropic.apiKey
 * - OLLAMA_API_KEY -> llm.providers.ollama.apiKey (baseUrl defaults to https://ollama.com)
 * - GEMINI_API_KEY -> llm.providers.google.apiKey (alias of GOOGLE_API_KEY)
 * - AZURE_OPENAI_API_KEY -> llm.providers.azure.apiKey
 * - AZURE_OPENAI_ENDPOINT -> llm.providers.azure.endpoint
 * - AWS_REGION -> llm.providers.bedrock.region
 * - MISTRAL_API_KEY -> llm.providers.mistral.apiKey
 * - GROQ_API_KEY -> llm.providers.groq.apiKey
 * - TOGETHER_API_KEY -> llm.providers.together.apiKey
 * - DEEPSEEK_API_KEY -> llm.providers.deepseek.apiKey
 *
 * AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_SESSION_TOKEN`, `AWS_PROFILE`) are left to the AWS SDK, which keeps
 * temporary credentials whole: with any of them set, `llm.providers.bedrock`
 * is present so Bedrock counts as configured. The Ollama URL variables other
 * tools share (`OLLAMA_HOST`, `OLLAMA_URL`, `OLLAMA_BASE_URL`) only apply
 * under cogitator.yml, see {@link loadEnvDefaults}.
 */
type LLMProvider = NonNullable<NonNullable<CogitatorConfigInput['llm']>['defaultProvider']>;

function isValidProvider(value: string): value is LLMProvider {
  return LLMProviderSchema.safeParse(value).success;
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
    const parsedTarget = DeployTargetSchema.safeParse(deployTarget);
    config.deploy = {
      ...(parsedTarget.success ? { target: parsedTarget.data } : {}),
      ...(deployPort ? { port: deployPort } : {}),
      ...(deployRegistry ? { registry: deployRegistry } : {}),
    };
  }

  return config;
}

/**
 * Configuration from environment variables that apply only when
 * cogitator.yml leaves the setting unset. Other tools own these variables
 * too: `OLLAMA_HOST` is often `0.0.0.0` so `ollama serve` listens on every
 * interface, which must not replace a `baseUrl` written in the config.
 *
 * - OLLAMA_BASE_URL / OLLAMA_URL / OLLAMA_HOST -> llm.providers.ollama.baseUrl,
 *   read the way Ollama reads OLLAMA_HOST (port 11434 when none is given,
 *   `0.0.0.0` reached as localhost)
 */
export function loadEnvDefaults(): CogitatorConfigInput {
  const baseUrl = resolveOllamaHost(firstSet(settingOf('ollama', 'baseUrl').fallbackEnv));
  return baseUrl ? { llm: { providers: { ollama: { baseUrl } } } } : {};
}

type ProvidersConfig = NonNullable<NonNullable<CogitatorConfigInput['llm']>['providers']>;
type LimitsConfig = NonNullable<CogitatorConfigInput['limits']>;
type ProviderValues = Record<string, string | undefined>;

function settingOf(provider: LLMProviderName, field: string): ProviderEnvSetting {
  const setting = PROVIDER_ENV[provider].find((s) => s.field === field);
  if (!setting) throw new Error(`PROVIDER_ENV has no ${provider}.${field} setting`);
  return setting;
}

function firstSet(names: readonly string[] | undefined): string | undefined {
  for (const name of names ?? []) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/** `provider`'s settings from the variables set over cogitator.yml. */
function readProvider(provider: LLMProviderName): ProviderValues {
  const values: ProviderValues = {};
  for (const setting of PROVIDER_ENV[provider]) {
    values[setting.field] = firstSet(setting.env);
  }
  return values;
}

function definedValues(values: ProviderValues): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function loadProviderConfigs(): ProvidersConfig {
  const providers: ProvidersConfig = {};

  const ollama = readProvider('ollama');
  const ollamaBaseUrl = resolveOllamaHost(ollama.baseUrl);
  if (ollamaBaseUrl || ollama.apiKey) {
    providers.ollama = {
      ...(ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {}),
      ...(ollama.apiKey ? { apiKey: ollama.apiKey } : {}),
    };
  }

  const openai = readProvider('openai');
  if (openai.apiKey) {
    providers.openai = { apiKey: openai.apiKey, baseUrl: openai.baseUrl };
  }

  const anthropic = readProvider('anthropic').apiKey;
  if (anthropic) providers.anthropic = { apiKey: anthropic };

  const google = readProvider('google').apiKey;
  if (google) providers.google = { apiKey: google };

  const vllm = readProvider('vllm').baseUrl;
  if (vllm) providers.vllm = { baseUrl: vllm };

  const azure = readProvider('azure');
  if (azure.apiKey && azure.endpoint) {
    providers.azure = {
      apiKey: azure.apiKey,
      endpoint: azure.endpoint,
      ...(azure.apiVersion ? { apiVersion: azure.apiVersion } : {}),
      ...(azure.deployment ? { deployment: azure.deployment } : {}),
    };
  }

  const bedrock = definedValues(readProvider('bedrock'));
  const sdkCredentials = PROVIDER_ENV.bedrock.some((s) => firstSet(s.sdkEnv) !== undefined);
  if (Object.keys(bedrock).length > 0 || sdkCredentials) {
    providers.bedrock = bedrock;
  }

  const mistral = readProvider('mistral').apiKey;
  if (mistral) providers.mistral = { apiKey: mistral };

  const groq = readProvider('groq').apiKey;
  if (groq) providers.groq = { apiKey: groq };

  const together = readProvider('together').apiKey;
  if (together) providers.together = { apiKey: together };

  const deepseek = readProvider('deepseek').apiKey;
  if (deepseek) providers.deepseek = { apiKey: deepseek };

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
