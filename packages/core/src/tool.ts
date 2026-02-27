import type { Tool, ToolConfig, ToolSchema, ApprovalCheck } from '@cogitator-ai/types';
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
    requiresApproval:
      typeof config.requiresApproval === 'function'
        ? (config.requiresApproval as ApprovalCheck)
        : config.requiresApproval,
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
  const params = t.parameters as unknown as Record<string, unknown>;
  const isZodType = params && typeof params === 'object' && '_zod' in params;

  let properties: Record<string, unknown>;
  let required: string[] | undefined;

  if (!isZodType && params?.type === 'object') {
    properties = (params.properties ?? {}) as Record<string, unknown>;
    required = params.required as string[] | undefined;
  } else {
    let jsonSchema: Record<string, unknown>;
    try {
      jsonSchema = z.toJSONSchema(t.parameters as ZodType, {
        target: 'openapi-3.0',
        unrepresentable: 'any',
      }) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[toolToSchema] Failed to convert schema for "${t.name}":`,
        (err as Error).message
      );
      jsonSchema = { type: 'object', properties: {} };
    }
    properties = (jsonSchema.properties ?? {}) as Record<string, unknown>;
    required = jsonSchema.required as string[] | undefined;
  }

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
