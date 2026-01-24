import type { Tool, ToolConfig, ToolSchema } from '@cogitator-ai/types';
import { z, type ZodType } from 'zod';

/**
 * Create a type-safe tool for agent use.
 *
 * Tools enable agents to interact with external systems, APIs, databases,
 * or perform computations. Parameters are validated using Zod schemas.
 *
 * @typeParam TParams - Type of parameters the tool accepts
 * @typeParam TResult - Type of result the tool returns
 * @param config - Tool configuration
 * @returns A Tool instance ready for agent use
 *
 * @example
 * ```ts
 * import { tool } from '@cogitator-ai/core';
 * import { z } from 'zod';
 *
 * const weatherTool = tool({
 *   name: 'get_weather',
 *   description: 'Get current weather for a city',
 *   parameters: z.object({
 *     city: z.string().describe('City name'),
 *     units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
 *   }),
 *   execute: async ({ city, units }) => {
 *     const response = await fetch(`https://api.weather.com/${city}`);
 *     return response.json();
 *   },
 * });
 * ```
 *
 * @example Sandboxed tool execution
 * ```ts
 * const shellTool = tool({
 *   name: 'run_command',
 *   description: 'Execute a shell command safely',
 *   parameters: z.object({ command: z.string() }),
 *   execute: async ({ command }) => ({ command }),
 *   sandbox: { type: 'docker', image: 'alpine:latest' },
 * });
 * ```
 */
export function tool<TParams, TResult>(
  config: ToolConfig<TParams, TResult>
): Tool<TParams, TResult> {
  return {
    name: config.name,
    description: config.description,
    category: config.category,
    tags: config.tags,
    parameters: config.parameters,
    execute: config.execute,
    sideEffects: config.sideEffects,
    requiresApproval: config.requiresApproval,
    timeout: config.timeout,
    sandbox: config.sandbox,
    toJSON(): ToolSchema {
      return toolToSchema(this);
    },
  };
}

/**
 * Convert a tool to JSON Schema format for LLM function calling.
 *
 * Transforms Zod schema to OpenAPI 3.0 compatible JSON Schema
 * that can be sent to LLM providers for function calling.
 *
 * @typeParam TParams - Type of tool parameters
 * @typeParam TResult - Type of tool result
 * @param t - Tool to convert
 * @returns JSON Schema representation of the tool
 */
export function toolToSchema<TParams, TResult>(t: Tool<TParams, TResult>): ToolSchema {
  const jsonSchema = z.toJSONSchema(t.parameters as ZodType, {
    target: 'openapi-3.0',
    unrepresentable: 'any',
  });

  const schema = jsonSchema as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = schema.required as string[] | undefined;

  return {
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties,
      required,
    },
  };
}
