import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AssistantConfigSchema } from '@cogitator-ai/channels';
import { CogitatorConfigSchema } from '@cogitator-ai/config';

export const PROJECT_CONFIG_FILES = ['cogitator.yml', 'cogitator.yaml'];

/**
 * What a `cogitator.yml` configures:
 * - `assistant`: a config-driven assistant (`cogitator wizard`), run by `cogitator up`
 * - `runtime`: the Cogitator runtime of a code-first project (`@cogitator-ai/config`,
 *   e.g. from create-cogitator-app), loaded by the project's own code
 */
export type ProjectConfigKind = 'assistant' | 'runtime';

const RUNTIME_KEYS = new Set(Object.keys(CogitatorConfigSchema.shape));
const ASSISTANT_ONLY_KEYS = Object.keys(AssistantConfigSchema.shape).filter(
  (key) => !RUNTIME_KEYS.has(key)
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tells the two kinds of `cogitator.yml` apart by their keys. A document with anything
 * only an assistant config has (`name`, `channels`, `llm.model`, …) is an assistant
 * config, so an incomplete one still gets the assistant validation errors; a document
 * made of runtime config keys only is a runtime config. Anything else (an empty file,
 * unknown keys) counts as an assistant config.
 */
export function detectConfigKind(document: unknown): ProjectConfigKind {
  if (!isRecord(document)) return 'assistant';

  if (ASSISTANT_ONLY_KEYS.some((key) => key in document)) return 'assistant';

  const llm = document.llm;
  if (isRecord(llm) && ('provider' in llm || 'model' in llm)) return 'assistant';

  return Object.keys(document).some((key) => RUNTIME_KEYS.has(key)) ? 'runtime' : 'assistant';
}

/** The kind of the config file at `path`; YAML that does not parse counts as an assistant config. */
export function readConfigKind(path: string): ProjectConfigKind {
  let document: unknown;
  try {
    document = parseYaml(readFileSync(path, 'utf-8'));
  } catch {
    return 'assistant';
  }
  return detectConfigKind(document);
}

/** `cogitator.yml` or `cogitator.yaml` in `cwd`, whatever it configures. */
export function findProjectConfig(cwd: string = process.cwd()): string | null {
  for (const name of PROJECT_CONFIG_FILES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export function runtimeConfigMessage(path: string): string {
  return (
    `${path} is a runtime config for @cogitator-ai/config, loaded by your project's code — ` +
    'not an assistant config. Start the project itself (e.g. "pnpm dev"); ' +
    '"cogitator up" runs assistants created by "cogitator wizard" and Docker Compose services.'
  );
}
