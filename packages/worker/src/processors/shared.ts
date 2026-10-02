import { Agent, Cogitator, parseModel } from '@cogitator-ai/core';
import type { Tool, ToolSchema } from '@cogitator-ai/types';
import type { WorkerRuntime } from '../types';

/**
 * Model string to run: models with a provider prefix are used as-is, otherwise the
 * serialized provider is prepended.
 */
export function resolveModelString(model: string, provider: string): string {
  return parseModel(model).provider ? model : `${provider}/${model}`;
}

/**
 * Resolve serialized tool references against the worker's tool registry.
 * Fails when the agent needs tools this worker does not provide, instead of silently
 * running the agent with fake tools.
 */
export function resolveTools(schemas: readonly ToolSchema[], available: readonly Tool[]): Tool[] {
  if (schemas.length === 0) return [];

  const registry = new Map(available.map((t) => [t.name, t]));
  const missing = schemas.map((s) => s.name).filter((name) => !registry.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Tools not registered on this worker: ${missing.join(', ')}. ` +
        'Pass their implementations via the worker `tools` option.'
    );
  }

  return schemas.map((schema) => registry.get(schema.name)!);
}

export interface SerializedAgentLike {
  name: string;
  instructions: string;
  model: string;
  provider: string;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  tools: readonly ToolSchema[];
}

export function createAgentFromConfig(config: SerializedAgentLike, runtime: WorkerRuntime): Agent {
  return new Agent({
    name: config.name,
    model: resolveModelString(config.model, config.provider),
    instructions: config.instructions,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxIterations: config.maxIterations,
    tools: resolveTools(config.tools, runtime.tools ?? []),
  });
}

export function resolveCogitator(runtime: WorkerRuntime): Cogitator {
  return runtime.cogitator ?? new Cogitator();
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
