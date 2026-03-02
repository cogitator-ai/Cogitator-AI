import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';

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

export function createSelfConfigTools(opts: {
  configPath: string;
  parseYaml: (s: string) => unknown;
  stringifyYaml: (o: unknown) => string;
  validateConfig: (o: unknown) => unknown;
  onConfigUpdated?: () => void;
}): Tool[] {
  const { configPath, parseYaml, stringifyYaml, validateConfig, onConfigUpdated } = opts;

  const configRead = tool({
    name: 'config_read',
    description: 'Read the current assistant configuration (cogitator.yml)',
    parameters: z.object({}),
    execute: async () => {
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
    execute: async ({ updates }) => {
      const raw = readFileSync(configPath, 'utf-8');
      const current = parseYaml(raw) as Record<string, unknown>;
      const merged = deepMerge(current, updates);

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
    execute: async ({ vars }) => {
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
    execute: async ({ vars }) => {
      const existing = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      const map = new Map<string, string>();

      for (const line of existing.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) map.set(line.slice(0, eq), line);
      }

      for (const [key, value] of Object.entries(vars)) {
        map.set(key, `${key}=${value}`);
      }

      writeFileSync(envPath, [...map.values()].join('\n') + '\n');
      onConfigUpdated?.();
      return {
        success: true,
        message: `Set ${Object.keys(vars).join(', ')} in .env. Restarting...`,
      };
    },
  });

  return [configRead, configUpdate, envCheck, envSet];
}
