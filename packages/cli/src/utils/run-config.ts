import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONFIG_FILE_NAMES, loadConfig } from '@cogitator-ai/config';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { loadDotenvInto } from './env.js';
import { detectConfigKind, type ProjectConfigKind } from './project-config.js';

const RUN_CONFIG_FILE_NAMES = [...CONFIG_FILE_NAMES, 'cogitator.json'];

export function findConfig(
  explicitPath?: string,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd()
): string | null {
  if (explicitPath) {
    const full = resolve(cwd, explicitPath);
    return existsSync(full) ? full : null;
  }

  const envConfig = env.COGITATOR_CONFIG;
  if (envConfig) {
    const full = resolve(cwd, envConfig);
    return existsSync(full) ? full : null;
  }

  for (const name of RUN_CONFIG_FILE_NAMES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export interface RunConfig {
  config: CogitatorConfig;
  /** What the config file configures, undefined without one */
  kind?: ProjectConfigKind;
  /** `provider/model` of an assistant config, which has no `llm.defaultModel` */
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `llm.provider` and `llm.model` of an assistant config as one model string. */
function assistantModel(document: unknown): string | undefined {
  const llm = isRecord(document) ? document.llm : undefined;
  if (!isRecord(llm) || typeof llm.model !== 'string' || !llm.model.trim()) return undefined;
  const model = llm.model.trim();
  if (model.includes('/') || typeof llm.provider !== 'string') return model;
  return `${llm.provider}/${model}`;
}

/**
 * The runtime config `cogitator run` uses. The `.env` next to the config file
 * (or in `cwd` without one) is loaded first, without overriding variables
 * already set, so API keys reach the env loader. An assistant config from
 * `cogitator wizard` is not a runtime config: only its model is taken, and
 * the rest comes from the environment.
 */
export function loadRunConfig(configPath: string | null, cwd: string = process.cwd()): RunConfig {
  loadDotenvInto(join(configPath ? dirname(configPath) : cwd, '.env'), process.env);
  if (!configPath) return { config: loadConfig({ skipYaml: true }) };

  let document: unknown;
  try {
    document = parseYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    document = undefined;
  }
  if (document !== undefined && detectConfigKind(document) === 'assistant') {
    return {
      config: loadConfig({ skipYaml: true }),
      kind: 'assistant',
      model: assistantModel(document),
    };
  }

  return { config: loadConfig({ configPath }), kind: 'runtime' };
}
