/**
 * Tool Adapter
 *
 * Converts between Cogitator Tool format and MCP Tool format.
 * Enables bidirectional interoperability.
 */

import { z, type ZodTypeAny, type ZodObject, type ZodRawShape } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaLib } from 'zod-to-json-schema';
import type { Tool, ToolSchema, ToolContext } from '@cogitator/types';
import type { MCPToolDefinition, MCPToolContent, ToolAdapterOptions } from '../types.js';
import type { MCPClient } from '../client/mcp-client.js';


/**
 * Convert a Zod schema to JSON Schema
 */
export function zodToJsonSchema(schema: ZodTypeAny): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
} {
  const jsonSchema = zodToJsonSchemaLib(schema, {
    $refStrategy: 'none',
    target: 'openApi3',
  });

  const result = jsonSchema as Record<string, unknown>;
  delete result.$schema;

  return result as {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Convert JSON Schema to a Zod schema
 *
 * Note: This is a simplified conversion that handles common cases.
 * Complex schemas may need manual adjustment.
 */
export function jsonSchemaToZod(schema: {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}): ZodObject<ZodRawShape> {
  if (schema.type !== 'object' || !schema.properties) {
    return z.object({});
  }

  const shape: ZodRawShape = {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodType = jsonSchemaPropertyToZod(prop);

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (!required.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
}

function jsonSchemaPropertyToZod(prop: JsonSchemaProperty): ZodTypeAny {
  if (prop.enum && Array.isArray(prop.enum)) {
    if (prop.enum.length >= 2 && prop.enum.every((v) => typeof v === 'string')) {
      return z.enum(prop.enum as [string, ...string[]]);
    }
    if (prop.enum.length >= 2) {
      const literals = prop.enum.map((v) => z.literal(v as string | number | boolean));
      return z.union([literals[0], literals[1], ...literals.slice(2)]);
    }
    if (prop.enum.length === 1) {
      return z.literal(prop.enum[0] as string | number | boolean);
    }
  }

  switch (prop.type) {
    case 'string': {
      let schema = z.string();
      if (prop.minLength !== undefined) {
        schema = schema.min(prop.minLength);
      }
      if (prop.maxLength !== undefined) {
        schema = schema.max(prop.maxLength);
      }
      if (prop.pattern) {
        schema = schema.regex(new RegExp(prop.pattern));
      }
      if (prop.format === 'email') {
        schema = schema.email();
      }
      if (prop.format === 'uri' || prop.format === 'url') {
        schema = schema.url();
      }
      return schema;
    }

    case 'number':
    case 'integer': {
      let schema = prop.type === 'integer' ? z.number().int() : z.number();
      if (prop.minimum !== undefined) {
        schema = schema.min(prop.minimum);
      }
      if (prop.maximum !== undefined) {
        schema = schema.max(prop.maximum);
      }
      return schema;
    }

    case 'boolean':
      return z.boolean();

    case 'array': {
      const itemSchema = prop.items ? jsonSchemaPropertyToZod(prop.items) : z.unknown();
      return z.array(itemSchema);
    }

    case 'object': {
      if (prop.properties) {
        return jsonSchemaToZod({
          type: 'object',
          properties: prop.properties,
          required: prop.required,
        });
      }
      return z.record(z.unknown());
    }

    case 'null':
      return z.null();

    default:
      return z.unknown();
  }
}


/**
 * Convert a Cogitator Tool to MCP tool definition format
 */
export function cogitatorToMCP(tool: Tool): MCPToolDefinition {
  const schema = tool.toJSON();

  return {
    name: schema.name,
    description: schema.description,
    inputSchema: {
      type: 'object',
      properties: schema.parameters.properties,
      required: schema.parameters.required,
    },
  };
}

/**
 * Convert a Cogitator ToolSchema to MCP tool definition format
 */
export function toolSchemaToMCP(schema: ToolSchema): MCPToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: {
      type: 'object',
      properties: schema.parameters.properties,
      required: schema.parameters.required,
    },
  };
}


/**
 * Convert an MCP tool definition to a Cogitator Tool
 *
 * The resulting tool will execute calls through the provided MCPClient.
 */
export function mcpToCogitator(
  mcpTool: MCPToolDefinition,
  client: MCPClient,
  options?: ToolAdapterOptions
): Tool {
  const name = options?.namePrefix ? `${options.namePrefix}${mcpTool.name}` : mcpTool.name;

  const description = options?.descriptionTransform
    ? options.descriptionTransform(mcpTool.description)
    : mcpTool.description;

  const inputSchema = {
    type: 'object',
    properties: mcpTool.inputSchema.properties as Record<string, JsonSchemaProperty>,
    required: mcpTool.inputSchema.required,
  };
  const parameters = jsonSchemaToZod(inputSchema);

  const tool: Tool = {
    name,
    description,
    parameters,

    execute: async (params: unknown, _context: ToolContext): Promise<unknown> => {
      return client.callTool(mcpTool.name, params as Record<string, unknown>);
    },

    toJSON: (): ToolSchema => ({
      name,
      description,
      parameters: {
        type: 'object',
        properties: mcpTool.inputSchema.properties,
        required: mcpTool.inputSchema.required,
      },
    }),
  };

  return tool;
}

/**
 * Wrap all tools from an MCP client as Cogitator tools
 *
 * @example
 * ```typescript
 * const client = await MCPClient.connect({ ... });
 * const tools = await wrapMCPTools(client);
 *
 * const agent = new Agent({
 *   tools: [...tools, ...otherTools],
 * });
 * ```
 */
export async function wrapMCPTools(
  client: MCPClient,
  options?: ToolAdapterOptions
): Promise<Tool[]> {
  const definitions = await client.listToolDefinitions();
  return definitions.map((def) => mcpToCogitator(def, client, options));
}


/**
 * Convert a tool execution result to MCP content format
 */
export function resultToMCPContent(result: unknown): MCPToolContent[] {
  if (result === null || result === undefined) {
    return [{ type: 'text', text: '' }];
  }

  if (typeof result === 'string') {
    return [{ type: 'text', text: result }];
  }

  if (typeof result === 'object') {
    if (
      Array.isArray(result) &&
      result.every((item) => typeof item === 'object' && 'type' in item)
    ) {
      return result as MCPToolContent[];
    }

    return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  }

  return [{ type: 'text', text: String(result) }];
}

/**
 * Convert MCP content to a simple result value
 */
export function mcpContentToResult(content: MCPToolContent[]): unknown {
  if (!content || content.length === 0) {
    return null;
  }

  if (content.length === 1 && content[0].type === 'text') {
    const text = content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return content.map((item) => {
    if (item.type === 'text') {
      try {
        return JSON.parse(item.text);
      } catch {
        return item.text;
      }
    }
    return item;
  });
}
