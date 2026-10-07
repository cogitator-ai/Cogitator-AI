/**
 * Configuration loading and merging
 */

import { z } from 'zod';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { CogitatorConfigSchema, type CogitatorConfigInput } from './schema';
import { loadYamlConfig } from './loaders/yaml';
import { loadEnvConfig, loadEnvDefaults } from './loaders/env';

export interface LoadConfigOptions {
  /** Path to YAML config file */
  configPath?: string;
  /** Skip loading from environment variables */
  skipEnv?: boolean;
  /** Skip loading from YAML file */
  skipYaml?: boolean;
  /** Override config values */
  overrides?: CogitatorConfigInput;
}

/**
 * Load and merge configuration from multiple sources
 *
 * Priority (highest to lowest):
 * 1. Overrides passed in options
 * 2. Environment variables
 * 3. YAML config file (`configPath`, else the first of `CONFIG_FILE_NAMES` in the working directory)
 * 4. Environment variables other tools share, such as `OLLAMA_HOST` (see `loadEnvDefaults`)
 * 5. Defaults
 */
export function loadConfig(options: LoadConfigOptions = {}): CogitatorConfig {
  const configs: CogitatorConfigInput[] = [];

  if (!options.skipEnv) {
    configs.push(loadEnvDefaults());
  }

  if (!options.skipYaml) {
    const yamlConfig = loadYamlConfig(options.configPath);
    if (yamlConfig) {
      configs.push(yamlConfig);
    }
  }

  if (!options.skipEnv) {
    const envConfig = loadEnvConfig();
    configs.push(envConfig);
  }

  if (options.overrides) {
    configs.push(options.overrides);
  }

  const merged = mergeConfigs(configs);

  const result = CogitatorConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}

/**
 * Deep merge multiple config objects
 */
function mergeConfigs(configs: CogitatorConfigInput[]): CogitatorConfigInput {
  const result: CogitatorConfigInput = {};

  for (const config of configs) {
    deepMerge(result, config);
  }

  return result;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue === undefined) {
      continue;
    }

    if (isObject(sourceValue) && isObject(targetValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Create a config builder for fluent configuration
 */
export function defineConfig(config: CogitatorConfigInput): CogitatorConfig {
  const result = CogitatorConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
