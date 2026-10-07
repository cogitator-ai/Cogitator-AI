/**
 * YAML configuration loader
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { CogitatorConfigInput } from '../schema';

/** The names a project's config file goes by, in the order they are looked for. */
export const CONFIG_FILE_NAMES = [
  'cogitator.yml',
  'cogitator.yaml',
  '.cogitator.yml',
  '.cogitator.yaml',
] as const;

/**
 * The config file of the project in `dir` (the working directory by default):
 * the first of {@link CONFIG_FILE_NAMES} that exists. `loadConfig`, `cogitator run`
 * and `cogitator deploy` all find it this way.
 */
export function findConfigFile(dir: string = process.cwd()): string | undefined {
  return CONFIG_FILE_NAMES.map((name) => join(dir, name)).find((path) => existsSync(path));
}

const ENV_REFERENCE_HEAD = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(\}|:?-)?)/g;

type Env = Record<string, string | undefined>;

/**
 * Substitute `${VAR}`, `${VAR:-default}` (default when unset or empty) and
 * `${VAR-default}` (default when unset) in a string. `$$` yields a literal `$`.
 */
export function interpolateEnvString(value: string, env: Env = process.env): string {
  let output = '';
  let cursor = 0;
  let closingBrace = -1;
  ENV_REFERENCE_HEAD.lastIndex = 0;
  for (let match = ENV_REFERENCE_HEAD.exec(value); match; match = ENV_REFERENCE_HEAD.exec(value)) {
    const [head, name, operator] = match;
    const headEnd = match.index + head.length;
    let replacement: string;
    let end = headEnd;
    if (head === '$$') {
      replacement = '$';
    } else if (operator === '}') {
      replacement = env[name] ?? '';
    } else if (operator) {
      if (closingBrace < headEnd) {
        const found = value.indexOf('}', headEnd);
        closingBrace = found === -1 ? value.length : found;
      }
      if (closingBrace === value.length) continue;
      const fallback = value.slice(headEnd, closingBrace);
      const current = env[name];
      replacement =
        operator === ':-' ? current || fallback : current !== undefined ? current : fallback;
      end = closingBrace + 1;
    } else {
      continue;
    }
    output += value.slice(cursor, match.index) + replacement;
    cursor = end;
    ENV_REFERENCE_HEAD.lastIndex = end;
  }
  return output + value.slice(cursor);
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

  const found = findConfigFile();
  return found ? parseYamlFile(found, env) : null;
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
      `Failed to parse config file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (parsed === null || parsed === undefined) return null;
  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${path} must contain a mapping at the top level`);
  }

  const interpolated = interpolateEnv(parsed, env);
  return isPlainObject(interpolated) ? interpolated : {};
}
