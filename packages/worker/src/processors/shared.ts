import { Agent, Cogitator } from '@cogitator-ai/core';
import type { ReasoningConfig, ResponseFormat, Tool, ToolSchema } from '@cogitator-ai/types';
import { z } from 'zod';
import type { SerializedResponseFormat, WorkerRuntime } from '../types';

/**
 * Model string to run on `cogitator`, so a serialized agent routes like the same agent
 * would in-process. A model whose prefix names a provider, backend or plugin the Cogitator
 * routes to is used as-is. Otherwise `provider` is prepended, and without a provider the
 * model stays unchanged and runs on the Cogitator's `llm.defaultProvider`.
 *
 * @throws Error when `provider` is needed but the Cogitator cannot route to it
 */
export function resolveModelString(
  model: string,
  provider: string | undefined,
  cogitator: Cogitator
): string {
  const slash = model.indexOf('/');
  if (slash > 0 && cogitator.knowsProvider(model.slice(0, slash))) return model;
  if (!provider) return model;
  if (!cogitator.knowsProvider(provider)) {
    throw new Error(
      `Provider "${provider}" of model "${model}" is not available on this worker: ` +
        'it is not a built-in provider, a backend in llm.backends or a registered plugin of the worker Cogitator.'
    );
  }
  return `${provider}/${model}`;
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
  provider?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxIterations?: number;
  responseFormat?: SerializedResponseFormat;
  reasoning?: ReasoningConfig;
  tools: readonly ToolSchema[];
}

/**
 * The agent's response format back from its queue form: JSON Schema becomes a Zod schema, so the
 * runtime validates the structured output and asks for a repair as it does in-process.
 */
export function toResponseFormat(
  format: SerializedResponseFormat | undefined
): ResponseFormat | undefined {
  if (!format) return undefined;
  if (format.type !== 'json_schema') return format;
  return { type: 'json_schema', schema: z.fromJSONSchema(format.schema) };
}

/**
 * Worker runtime with the Cogitator settled, so the agents of a job are routed by the
 * same Cogitator that runs them.
 */
export interface ResolvedRuntime extends WorkerRuntime {
  cogitator: Cogitator;
}

export function resolveRuntime(runtime: WorkerRuntime): ResolvedRuntime {
  return { ...runtime, cogitator: runtime.cogitator ?? new Cogitator() };
}

export function createAgentFromConfig(
  config: SerializedAgentLike,
  runtime: ResolvedRuntime
): Agent {
  return new Agent({
    name: config.name,
    model: resolveModelString(config.model, config.provider, runtime.cogitator),
    instructions: config.instructions,
    temperature: config.temperature,
    topP: config.topP,
    maxTokens: config.maxTokens,
    maxIterations: config.maxIterations,
    responseFormat: toResponseFormat(config.responseFormat),
    reasoning: config.reasoning,
    tools: resolveTools(config.tools, runtime.tools ?? []),
  });
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
