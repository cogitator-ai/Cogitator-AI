import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import type { Tool, ToolSchema } from '@cogitator-ai/types';

export function jsonSchemaToZod(params: ToolSchema['parameters']): z.ZodType {
  const properties = params.properties;
  const required = params.required ?? [];

  if (Object.keys(properties).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodType> = {};
  for (const key of Object.keys(properties)) {
    shape[key] = required.includes(key) ? z.unknown() : z.unknown().optional();
  }

  return z.object(shape).passthrough();
}

export function recreateTools(schemas: ToolSchema[]): Tool[] {
  return schemas.map((schema) =>
    tool({
      name: schema.name,
      description: schema.description,
      parameters: jsonSchemaToZod(schema.parameters),
      execute: async (input) => {
        console.warn(`[worker] Tool "${schema.name}" called with input:`, JSON.stringify(input));
        return {
          warning: 'Tool executed in worker with stub implementation',
          input,
        };
      },
    })
  );
}
