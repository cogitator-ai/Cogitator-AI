import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { Workflow } from '@cogitator-ai/types';
import { REGISTRY_PATH } from '../registry.js';

/**
 * A package as the project resolves it, so the studio uses the very classes
 * the project's runtime was built with; the studio's own copy when the
 * project does not have it.
 */
export async function importFromProject<T>(projectDir: string, name: string): Promise<T> {
  let entry: string | undefined;
  try {
    entry = createRequire(join(projectDir, 'package.json')).resolve(name);
  } catch {
    entry = undefined;
  }
  return (await import(entry ? pathToFileURL(entry).href : name)) as T;
}

/** Whether the project can resolve `name`. */
export function projectHas(projectDir: string, name: string): boolean {
  try {
    createRequire(join(projectDir, 'package.json')).resolve(name);
    return true;
  } catch {
    return false;
  }
}

export interface LoadedProject {
  cogitator: Cogitator;
  agents: Map<string, Agent>;
  workflows: Map<string, Workflow>;
  module: Record<string, unknown>;
}

function isAgent(value: unknown): value is Agent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'config' in value &&
    typeof value.config === 'object' &&
    value.config !== null &&
    'instructions' in value.config &&
    typeof value.config.instructions === 'string'
  );
}

function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodes' in value &&
    value.nodes instanceof Map &&
    'entryPoint' in value &&
    typeof value.entryPoint === 'string'
  );
}

function isCogitator(value: unknown): value is Cogitator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run' in value &&
    typeof value.run === 'function' &&
    'observe' in value &&
    typeof value.observe === 'function'
  );
}

function entries<T>(group: unknown, guard: (value: unknown) => value is T): Map<string, T> {
  const found = new Map<string, T>();
  if (typeof group !== 'object' || group === null) return found;
  for (const [key, value] of Object.entries(group)) if (guard(value)) found.set(key, value);
  return found;
}

/**
 * Loads `.env` and the registry of the project: the runtime it exports as
 * `cogitator`, and its agents and workflows by key.
 */
export async function loadProject(projectDir: string): Promise<LoadedProject> {
  const envFile = join(projectDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const registryPath = join(projectDir, REGISTRY_PATH);
  if (!existsSync(registryPath)) {
    throw new Error(
      `${REGISTRY_PATH} not found: Cogitator Studio finds agents, workflows and swarms in the registry projects from create-cogitator-app have. Export your runtime as \`cogitator\` and your agents as \`agents\` from ${REGISTRY_PATH}.`
    );
  }
  const module = (await import(pathToFileURL(registryPath).href)) as Record<string, unknown>;
  if (!isCogitator(module.cogitator)) {
    throw new Error(
      `${REGISTRY_PATH} does not export the runtime as \`cogitator\` (a Cogitator from @cogitator-ai/core 0.34 or newer)`
    );
  }
  return {
    cogitator: module.cogitator,
    agents: entries(module.agents, isAgent),
    workflows: entries(module.workflows, isWorkflow),
    module,
  };
}
