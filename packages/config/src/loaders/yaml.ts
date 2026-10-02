/**
 * YAML configuration loader
 */

import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import type { CogitatorConfigInput } from '../schema';

const DEFAULT_CONFIG_NAMES = [
  'cogitator.yaml',
  'cogitator.yml',
  '.cogitator.yaml',
  '.cogitator.yml',
];

const ENV_REFERENCE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}/g;

type Env = Record<string, string | undefined>;

/**
 * Substitute `${VAR}`, `${VAR:-default}` (default when unset or empty) and
 * `${VAR-default}` (default when unset) in a string. `$$` yields a literal `$`.
 */
export function interpolateEnvString(value: string, env: Env = process.env): string {
  return value.replace(
    ENV_REFERENCE,
    (
      match,
      name: string | undefined,
      operator: string | undefined,
      fallback: string | undefined
    ) => {
      if (match === '$$') return '$';
      const current = name ? env[name] : undefined;
      if (operator === ':-') return current ? current : (fallback ?? '');
      if (operator === '-') return current !== undefined ? current : (fallback ?? '');
      return current ?? '';
    }
  );
}

/**
 * Recursively interpolate environment references in every string of a parsed config.
 */
export function interpolateEnv(value: unknown, env: Env = process.env): unknown {
  if (typeof value === 'string') return interpolateEnvString(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env)])
    );
  }
  return value;
}

export function loadYamlConfig(
  configPath?: string,
  env: Env = process.env
): CogitatorConfigInput | null {
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return parseYamlFile(configPath, env);
  }

  for (const name of DEFAULT_CONFIG_NAMES) {
    if (existsSync(name)) {
      return parseYamlFile(name, env);
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseYamlFile(path: string, env: Env): CogitatorConfigInput | null {
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Failed to parse config file ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (parsed === null || parsed === undefined) return null;
  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${path} must contain a mapping at the top level`);
  }

  const interpolated = interpolateEnv(parsed, env);
  return isPlainObject(interpolated) ? interpolated : {};
}
