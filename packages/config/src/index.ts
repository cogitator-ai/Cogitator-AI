/**
 * @cogitator-ai/config
 *
 * Configuration loading for Cogitator (YAML, env)
 */

export { loadConfig, defineConfig, type LoadConfigOptions } from './config';
export {
  CogitatorConfigSchema,
  LLMConfigSchema,
  LimitsConfigSchema,
  ProvidersConfigSchema,
  LLMProviderSchema,
  type CogitatorConfigInput,
  type CogitatorConfigOutput,
} from './schema';
export { loadYamlConfig } from './loaders/yaml';
export { loadEnvConfig } from './loaders/env';
