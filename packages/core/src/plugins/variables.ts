/**
 * The variables a plugin's files may reference, as Claude Code substitutes them:
 * `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` (with Cogitator's
 * `COGITATOR_` names for the same values), and `${user_config.KEY}` for the plugin's options
 */

import type { PluginMcpServerConfig, PluginOptionValue } from '@cogitator-ai/types';

/** What a plugin's references resolve to */
export interface PluginVariables {
  /** The folder of the loaded version */
  root?: string;
  /**
   * The folder that lasts across updates, or a function that works it out when a reference or a
   * process first needs it (so a plugin that never uses it never asks where it lives)
   */
  data?: string | (() => string);
  /** The project root, for `${CLAUDE_PROJECT_DIR}` (left as written without one) */
  projectDir?: string;
  /** Option values that are not secrets */
  options: Readonly<Record<string, PluginOptionValue>>;
  /** Secret option values, by key */
  secrets: Readonly<Record<string, string>>;
}

/**
 * How `${user_config.KEY}` of a secret is put in: `value` (MCP configs, the arguments of an
 * exec-form hook), `placeholder` (text the model reads: skills, agents, commands), `refuse` (a
 * shell-form hook command, where the substituted value would be parsed again)
 */
export type SecretUse = 'value' | 'placeholder' | 'refuse';

const USER_CONFIG = /\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

const PATH_VARIABLES = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'PROJECT_DIR'] as const;

/** The data folder of `variables`, worked out now when it is given as a function */
export function dataFolder(variables: PluginVariables): string | undefined {
  return typeof variables.data === 'function' ? variables.data() : variables.data;
}

/** The value of one path variable (`CLAUDE_PLUGIN_DATA` or `COGITATOR_PLUGIN_DATA`, ...) */
function pathVariable(variables: PluginVariables, name: string): string | undefined {
  const match = /^(?:CLAUDE|COGITATOR)_(PLUGIN_ROOT|PLUGIN_DATA|PROJECT_DIR)$/.exec(name);
  switch (match?.[1]) {
    case 'PLUGIN_ROOT':
      return variables.root;
    case 'PLUGIN_DATA':
      return dataFolder(variables);
    case 'PROJECT_DIR':
      return variables.projectDir;
    default:
      return undefined;
  }
}

/** The path variables of `variables`, by name */
export function pathVariables(variables: PluginVariables): Record<string, string> {
  const values: Record<string, string> = {};
  for (const suffix of PATH_VARIABLES) {
    const value = pathVariable(variables, `CLAUDE_${suffix}`);
    if (value === undefined) continue;
    values[`CLAUDE_${suffix}`] = value;
    values[`COGITATOR_${suffix}`] = value;
  }
  return values;
}

/** An option value as text: a list joined with commas */
export function optionText(value: PluginOptionValue): string {
  return Array.isArray(value) ? value.join(',') : String(value);
}

/** Whether `text` references an option, `${user_config.KEY}` */
export function referencesOptions(text: string): boolean {
  return /\$\{user_config\.[A-Za-z_][A-Za-z0-9_]*\}/.test(text);
}

/**
 * `text` with the path variables and option references of `variables` put in. A reference to an
 * option that is not set stays as written. With `secrets: 'refuse'` a reference to a secret throws
 */
export function substitute(text: string, variables: PluginVariables, secrets: SecretUse): string {
  const withPaths = text.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}/g,
    (all, name: string) => pathVariable(variables, name) ?? all
  );
  return withPaths.replace(USER_CONFIG, (all, key: string) => {
    if (Object.hasOwn(variables.secrets, key)) {
      if (secrets === 'value') return variables.secrets[key] ?? all;
      if (secrets === 'placeholder') return `[sensitive option ${key}]`;
      throw new Error(
        `\${user_config.${key}} names a sensitive option, which a shell command cannot take: pass it in args or read CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`
      );
    }
    const value = Object.hasOwn(variables.options, key) ? variables.options[key] : undefined;
    return value === undefined ? all : optionText(value);
  });
}

/**
 * The environment a plugin's processes get on top of the host's: the path variables and, for
 * hooks, `CLAUDE_PLUGIN_OPTION_<KEY>` for every option, secrets included
 */
export function pluginEnvironment(
  variables: PluginVariables,
  withOptions: boolean
): Record<string, string> {
  const env = pathVariables({ ...variables, projectDir: undefined });
  if (!withOptions) return env;
  for (const [key, value] of Object.entries(variables.options)) {
    env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = optionText(value);
  }
  for (const [key, value] of Object.entries(variables.secrets)) {
    env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = value;
  }
  return env;
}

/**
 * An MCP server's config with the references put in: `command`, `args` and `env` of a stdio
 * server (which also gets the path variables in its environment), `url` and `headers` of a remote
 * one. Secrets go in as they are, the server needs them
 */
export function substituteServer(
  config: PluginMcpServerConfig,
  variables: PluginVariables
): Record<string, unknown> {
  const text = (value: unknown): unknown =>
    typeof value === 'string' ? substitute(value, variables, 'value') : value;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, text(entry)])
        )
      : undefined;
  const out: Record<string, unknown> = { ...config };
  if (typeof config.url === 'string') {
    out.url = text(config.url);
    const headers = record(config.headers);
    if (headers) out.headers = headers;
    return out;
  }
  out.command = text(config.command);
  if (Array.isArray(config.args)) out.args = config.args.map(text);
  out.env = { ...pluginEnvironment(variables, false), ...record(config.env) };
  if (typeof config.cwd === 'string') out.cwd = text(config.cwd);
  return out;
}
