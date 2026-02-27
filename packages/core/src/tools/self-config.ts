import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { tool } from '../tool';
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

  return [configRead, configUpdate];
}
