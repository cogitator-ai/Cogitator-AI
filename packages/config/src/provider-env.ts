import type { LLMProvider } from '@cogitator-ai/types';

/**
 * One setting of a built-in provider that comes from the environment.
 *
 * `loadConfig` reads `env` over cogitator.yml and `fallbackEnv` only when
 * cogitator.yml leaves the setting unset. `sdkEnv` are variables the
 * provider's own SDK reads at runtime, never copied into the config.
 */
export interface ProviderEnvSetting {
  /** Field of `llm.providers.<provider>` the setting fills */
  field: string;
  /** Variables read over cogitator.yml, highest precedence first */
  env: readonly string[];
  /** Variables read only when cogitator.yml leaves the field unset, highest precedence first */
  fallbackEnv?: readonly string[];
  /** Variables the provider SDK reads by itself */
  sdkEnv?: readonly string[];
  /** The provider cannot serve a request without it */
  required?: boolean;
  /** Meaningful on this machine only (a profile in ~/.aws, a local URL), never forwarded to a deployment */
  local?: boolean;
}

/**
 * The environment of every built-in provider: what `loadConfig` reads, what
 * the provider SDKs read, and what a deployment must provide. The one table
 * the env loader and `cogitator deploy` share.
 */
export const PROVIDER_ENV: Readonly<Record<LLMProvider, readonly ProviderEnvSetting[]>> = {
  ollama: [
    {
      field: 'baseUrl',
      env: ['COGITATOR_OLLAMA_BASE_URL'],
      fallbackEnv: ['OLLAMA_BASE_URL', 'OLLAMA_URL', 'OLLAMA_HOST'],
      local: true,
    },
    { field: 'apiKey', env: ['COGITATOR_OLLAMA_API_KEY', 'OLLAMA_API_KEY'] },
  ],
  openai: [
    { field: 'apiKey', env: ['COGITATOR_OPENAI_API_KEY', 'OPENAI_API_KEY'], required: true },
    { field: 'baseUrl', env: ['COGITATOR_OPENAI_BASE_URL', 'OPENAI_BASE_URL'] },
  ],
  anthropic: [
    { field: 'apiKey', env: ['COGITATOR_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'], required: true },
  ],
  google: [
    {
      field: 'apiKey',
      env: ['COGITATOR_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
      required: true,
    },
  ],
  azure: [
    { field: 'apiKey', env: ['COGITATOR_AZURE_API_KEY', 'AZURE_OPENAI_API_KEY'], required: true },
    {
      field: 'endpoint',
      env: ['COGITATOR_AZURE_ENDPOINT', 'AZURE_OPENAI_ENDPOINT'],
      required: true,
    },
    { field: 'apiVersion', env: ['COGITATOR_AZURE_API_VERSION'] },
    { field: 'deployment', env: ['COGITATOR_AZURE_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT'] },
  ],
  bedrock: [
    { field: 'region', env: ['COGITATOR_BEDROCK_REGION', 'AWS_REGION'], required: true },
    {
      field: 'accessKeyId',
      env: ['COGITATOR_BEDROCK_ACCESS_KEY_ID'],
      sdkEnv: ['AWS_ACCESS_KEY_ID'],
      required: true,
    },
    {
      field: 'secretAccessKey',
      env: ['COGITATOR_BEDROCK_SECRET_ACCESS_KEY'],
      sdkEnv: ['AWS_SECRET_ACCESS_KEY'],
      required: true,
    },
    {
      field: 'sessionToken',
      env: ['COGITATOR_BEDROCK_SESSION_TOKEN'],
      sdkEnv: ['AWS_SESSION_TOKEN'],
    },
    { field: 'profile', env: ['COGITATOR_BEDROCK_PROFILE'], sdkEnv: ['AWS_PROFILE'], local: true },
  ],
  vllm: [{ field: 'baseUrl', env: ['COGITATOR_VLLM_BASE_URL'], required: true }],
  mistral: [
    { field: 'apiKey', env: ['COGITATOR_MISTRAL_API_KEY', 'MISTRAL_API_KEY'], required: true },
  ],
  groq: [{ field: 'apiKey', env: ['COGITATOR_GROQ_API_KEY', 'GROQ_API_KEY'], required: true }],
  together: [
    { field: 'apiKey', env: ['COGITATOR_TOGETHER_API_KEY', 'TOGETHER_API_KEY'], required: true },
  ],
  deepseek: [
    { field: 'apiKey', env: ['COGITATOR_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'], required: true },
  ],
};

/** Every variable that provides `setting`, in the order they take precedence. */
export function providerEnvNames(setting: ProviderEnvSetting): string[] {
  return [...setting.env, ...(setting.fallbackEnv ?? []), ...(setting.sdkEnv ?? [])];
}

/** The variable to suggest for `setting`: the provider's own name rather than the `COGITATOR_` alias. */
export function preferredEnvName(setting: ProviderEnvSetting): string {
  const names = [...(setting.sdkEnv ?? []), ...setting.env, ...(setting.fallbackEnv ?? [])];
  return names.find((name) => !name.startsWith('COGITATOR_')) ?? names[0];
}
