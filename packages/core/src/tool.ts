/**
 * Tool factory and implementation
 */

import type { Tool, ToolConfig, ToolSchema } from '@cogitator/types';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';

/**
 * Create a type-safe tool
 */
export function tool<TParams, TResult>(
  config: ToolConfig<TParams, TResult>
): Tool<TParams, TResult> {
  return {
    name: config.name,
    description: config.description,
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
 * Convert a tool to JSON Schema format for LLM
 */
export function toolToSchema<TParams, TResult>(t: Tool<TParams, TResult>): ToolSchema {
  const jsonSchema = zodToJsonSchema(t.parameters as ZodType, {
    target: 'openApi3',
    $refStrategy: 'none',
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
