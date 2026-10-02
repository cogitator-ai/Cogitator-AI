/**
 * Tool Adapter
 *
 * Converts between Cogitator Tool format and MCP Tool format.
 * Enables bidirectional interoperability.
 */

import { z, type ZodTypeAny, type ZodObject } from 'zod';
import type { Tool, ToolSchema, ToolContext } from '@cogitator-ai/types';
import type { MCPToolDefinition, MCPToolContent, ToolAdapterOptions } from '../types';
import type { MCPClient } from '../client/mcp-client';

/**
 * Convert a Zod schema to JSON Schema
 */
export function zodToJsonSchema(schema: ZodTypeAny): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
} {
  const jsonSchema = z.toJSONSchema(schema, {
    unrepresentable: 'any',
    io: 'output',
    target: 'openapi-3.0',
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
  additionalProperties?: boolean | JsonSchemaProperty;
}): ZodObject<Record<string, ZodTypeAny>, z.core.$ZodObjectConfig> {
  if (schema.type !== 'object') {
    return z.object({});
  }

  if (!schema.properties) {
    return schema.additionalProperties === false ? z.object({}) : z.looseObject({});
  }

  const shape: Record<string, ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodType = jsonSchemaPropertyToZod(prop);

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (prop.default !== undefined) {
      zodType = zodType.default(prop.default as never);
    } else if (!required.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  if (schema.additionalProperties === true) {
    return z.looseObject(shape);
  }
  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    return z.object(shape).catchall(jsonSchemaPropertyToZod(schema.additionalProperties));
  }
  return z.object(shape);
}

interface JsonSchemaProperty {
  type?: string | string[];
  const?: unknown;
  nullable?: boolean;
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
  additionalProperties?: boolean | JsonSchemaProperty;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
}

type JsonLiteral = string | number | boolean | null;

function isJsonLiteral(value: unknown): value is JsonLiteral {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function jsonSchemaPropertyToZod(prop: JsonSchemaProperty): ZodTypeAny {
  const schema = jsonSchemaPropertyToZodInner(prop);
  return prop.nullable === true ? schema.nullable() : schema;
}

function jsonSchemaPropertyToZodInner(prop: JsonSchemaProperty): ZodTypeAny {
  if (Array.isArray(prop.type)) {
    const variants = prop.type.map((type) => jsonSchemaPropertyToZodInner({ ...prop, type }));
    if (variants.length === 0) {
      return z.unknown();
    }
    if (variants.length === 1) {
      return variants[0];
    }
    return z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  if (prop.const !== undefined && isJsonLiteral(prop.const)) {
    return z.literal(prop.const);
  }

  if (prop.allOf && prop.allOf.length > 0) {
    const schemas = prop.allOf.map((variant) => jsonSchemaPropertyToZod(variant));
    return schemas.reduce((acc, schema) => z.intersection(acc, schema));
  }

  const unionVariants = prop.oneOf ?? prop.anyOf;
  if (unionVariants && unionVariants.length > 0) {
    const schemas = unionVariants.map((variant) => jsonSchemaPropertyToZod(variant));
    if (schemas.length === 1) {
      return schemas[0];
    }
    return z.union(schemas as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }

  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every(isJsonLiteral)) {
    const values = prop.enum;
    if (values.length >= 2 && values.every((v): v is string => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]]);
    }
    const literals = values.map((v) => z.literal(v));
    if (literals.length === 1) {
      return literals[0];
    }
    return z.union([literals[0], literals[1], ...literals.slice(2)]);
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
        const pattern = compilePattern(prop.pattern);
        if (pattern) {
          schema = schema.regex(pattern);
        }
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
          additionalProperties: prop.additionalProperties,
        });
      }
      if (typeof prop.additionalProperties === 'object' && prop.additionalProperties !== null) {
        return z.record(z.string(), jsonSchemaPropertyToZod(prop.additionalProperties));
      }
      return z.record(z.string(), z.unknown());
    }

    case 'null':
      return z.null();

    default:
      return z.unknown();
  }
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return undefined;
    }
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

  const rawInputSchema = mcpTool.inputSchema as MCPToolDefinition['inputSchema'] & {
    additionalProperties?: boolean | JsonSchemaProperty;
  };
  const inputSchema = {
    type: 'object',
    properties: rawInputSchema.properties as Record<string, JsonSchemaProperty> | undefined,
    required: rawInputSchema.required,
    additionalProperties: rawInputSchema.additionalProperties,
  };
  const parameters = jsonSchemaToZod(inputSchema);

  const tool: Tool = {
    name,
    description,
    parameters,

    execute: async (params: unknown, context: ToolContext): Promise<unknown> => {
      return client.callTool(mcpTool.name, (params ?? {}) as Record<string, unknown>, {
        signal: context?.signal,
      });
    },

    toJSON: (): ToolSchema => ({
      name,
      description,
      parameters: {
        type: 'object',
        properties: mcpTool.inputSchema.properties ?? {},
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
    if (Array.isArray(result) && result.length > 0 && result.every(isMCPToolContent)) {
      return result;
    }

    return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  }

  return [{ type: 'text', text: String(result) }];
}

/**
 * Check whether a value is a well-formed MCP tool content block
 */
function isMCPToolContent(value: unknown): value is MCPToolContent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case 'text':
      return typeof item.text === 'string';
    case 'image':
    case 'audio':
      return typeof item.data === 'string' && typeof item.mimeType === 'string';
    case 'resource': {
      const resource = item.resource as Record<string, unknown> | null | undefined;
      return (
        typeof resource === 'object' &&
        resource !== null &&
        typeof resource.uri === 'string' &&
        (typeof resource.text === 'string' || typeof resource.blob === 'string')
      );
    }
    default:
      return false;
  }
}

/**
 * Convert MCP content to a simple result value
 */
export function mcpContentToResult(content: MCPToolContent[]): unknown {
  if (!content || content.length === 0) {
    return null;
  }

  const values = content.map((item) => {
    if (item.type === 'text') {
      try {
        return JSON.parse(item.text) as unknown;
      } catch {
        return item.text;
      }
    }
    return item;
  });

  return values.length === 1 ? values[0] : values;
}
