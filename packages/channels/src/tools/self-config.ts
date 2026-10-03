import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Tool, ToolContext } from '@cogitator-ai/types';

export interface SelfConfigCaller {
  userId?: string;
  channelType?: string;
}

export interface SelfConfigToolsOptions {
  configPath: string;
  parseYaml: (s: string) => unknown;
  stringifyYaml: (o: unknown) => string;
  validateConfig: (o: unknown) => unknown;
  onConfigUpdated?: () => void;
  /**
   * Decides whether the user behind a tool call may read or change configuration.
   * When omitted every caller is allowed.
   */
  authorize?: (caller: SelfConfigCaller) => boolean;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNAUTHORIZED = {
  success: false,
  error: 'Not authorized: only the assistant owner can manage configuration.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_\-.:/@+,=]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

export function createSelfConfigTools(opts: SelfConfigToolsOptions): Tool[] {
  const { configPath, parseYaml, stringifyYaml, validateConfig, onConfigUpdated, authorize } = opts;

  const allowed = (context?: ToolContext): boolean =>
    authorize ? authorize({ userId: context?.userId, channelType: context?.channelType }) : true;

  const configRead = tool({
    name: 'config_read',
    description: 'Read the current assistant configuration (cogitator.yml)',
    parameters: z.object({}),
    execute: async (_params, context) => {
      if (!allowed(context)) return UNAUTHORIZED;
      const raw = readFileSync(configPath, 'utf-8');
      return { config: parseYaml(raw) };
    },
  });

  const configUpdate = tool({
    name: 'config_update',
    description:
      'Update assistant configuration. Provide a partial config object that will be deep-merged with the current config. Changes are validated before saving. The assistant will restart automatically after a successful update.',
    parameters: z.object({
      updates: z
        .record(z.string(), z.unknown())
        .describe('Partial config to deep-merge with current config'),
    }),
    execute: async ({ updates }, context) => {
      if (!allowed(context)) return UNAUTHORIZED;
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw);
      const merged = deepMerge(isRecord(parsed) ? parsed : {}, updates);

      try {
        validateConfig(merged);
      } catch (err) {
        return {
          success: false,
          error: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      writeFileSync(configPath, stringifyYaml(merged));
      onConfigUpdated?.();
      return { success: true, message: 'Config updated. Restarting...' };
    },
  });

  const envPath = join(dirname(configPath), '.env');

  const KNOWN_VARS = [
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OLLAMA_URL',
    'OLLAMA_API_KEY',
    'GITHUB_TOKEN',
    'TG_TOKEN',
    'DISCORD_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
    'SLACK_APP_TOKEN',
    'SLACK_PORT',
    'DEEPGRAM_API_KEY',
    'GROQ_API_KEY',
  ];

  const envCheck = tool({
    name: 'env_check',
    description:
      'Check which environment variables are set. Returns true/false for each known variable (never exposes values). Use this before switching LLM providers to verify required keys are configured.',
    parameters: z.object({
      vars: z
        .array(z.string())
        .optional()
        .describe('Specific vars to check. If omitted, checks all known vars.'),
    }),
    execute: async ({ vars }, context) => {
      if (!allowed(context)) return UNAUTHORIZED;
      const toCheck = vars?.length ? vars : KNOWN_VARS;
      const result: Record<string, boolean> = {};
      for (const v of toCheck) {
        result[v] = !!process.env[v];
      }
      return result;
    },
  });

  const envSet = tool({
    name: 'env_set',
    description:
      'Write environment variables to the .env file. Merges with existing vars. The assistant will restart automatically to pick up new values.',
    parameters: z.object({
      vars: z.record(z.string(), z.string()).describe('Key-value pairs to write to .env'),
    }),
    execute: async ({ vars }, context) => {
      if (!allowed(context)) return UNAUTHORIZED;

      for (const [key, value] of Object.entries(vars)) {
        if (!ENV_KEY_RE.test(key)) {
          return { success: false, error: `Invalid environment variable name: ${key}` };
        }
        if (/[\r\n\0]/.test(value)) {
          return { success: false, error: `Value for ${key} must be a single line` };
        }
      }

      const lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      const pending = new Map(Object.entries(vars));
      const updated = lines.map((line) => {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!match) return line;
        const value = pending.get(match[1]);
        if (value === undefined) return line;
        pending.delete(match[1]);
        return `${match[1]}=${formatEnvValue(value)}`;
      });
      for (const [key, value] of pending) {
        updated.push(`${key}=${formatEnvValue(value)}`);
      }

      writeFileSync(envPath, updated.join('\n') + '\n', { mode: 0o600 });
      onConfigUpdated?.();
      return {
        success: true,
        message: `Set ${Object.keys(vars).join(', ')} in .env. Restarting...`,
      };
    },
  });

  return [configRead, configUpdate, envCheck, envSet];
}
