/**
 * Tool Adapter
 *
 * Converts between Cogitator Tool format and MCP Tool format.
 * Enables bidirectional interoperability.
 */

import { z, type ZodTypeAny, type ZodObject } from 'zod';
import {
  normalizeToolName,
  normalizeToolNames,
  toToolParameters,
  toolContent,
  toolPartsToText,
  toolResultParts,
} from '@cogitator-ai/core';
import type { Tool, ToolSchema, ToolContext, ToolContentPart } from '@cogitator-ai/types';
import type {
  MCPObjectSchema,
  MCPToolDefinition,
  MCPToolContent,
  ToolAdapterOptions,
} from '../types';
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
 * Handles the keywords tool schemas use: types, enums, constants, unions, intersections, nested
 * objects and arrays, string and number bounds, and local `$ref`s to `$defs` / `definitions`
 * (or any `#/...` pointer), recursive ones included.
 */
export function jsonSchemaToZod(schema: {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  $defs?: Record<string, JsonSchemaProperty>;
  definitions?: Record<string, JsonSchemaProperty>;
}): ZodObject<Record<string, ZodTypeAny>, z.core.$ZodObjectConfig> {
  return objectSchemaToZod(schema, { root: schema, refs: new Map() });
}

/** The document local `$ref`s resolve against, and the schemas already built for them. */
interface RefContext {
  root: unknown;
  refs: Map<string, ZodTypeAny>;
}

function objectSchemaToZod(
  schema: {
    type?: string | string[];
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean | JsonSchemaProperty;
  },
  ctx: RefContext
): ZodObject<Record<string, ZodTypeAny>, z.core.$ZodObjectConfig> {
  if (schema.type !== 'object') {
    return z.object({});
  }

  if (!schema.properties) {
    return schema.additionalProperties === false ? z.object({}) : z.looseObject({});
  }

  const shape: Record<string, ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodType = jsonSchemaPropertyToZod(prop, ctx);

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
    return z.object(shape).catchall(jsonSchemaPropertyToZod(schema.additionalProperties, ctx));
  }
  return z.object(shape);
}

interface JsonSchemaProperty {
  $ref?: string;
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

function jsonSchemaPropertyToZod(prop: JsonSchemaProperty, ctx: RefContext): ZodTypeAny {
  const schema = jsonSchemaPropertyToZodInner(prop, ctx);
  return prop.nullable === true ? schema.nullable() : schema;
}

/**
 * The schema a local `$ref` points to. It is built once per ref and wrapped in `z.lazy`, so a
 * definition that refers to itself (a tree, a linked list) validates to any depth.
 */
function refToZod(ref: string, ctx: RefContext): ZodTypeAny {
  const cached = ctx.refs.get(ref);
  if (cached) return cached;

  const target = resolvePointer(ctx.root, ref);
  if (target === undefined) return z.unknown();

  let built: ZodTypeAny | undefined;
  const lazy = z.lazy(() => built ?? z.unknown());
  ctx.refs.set(ref, lazy);
  built = jsonSchemaPropertyToZod(target, ctx);
  return lazy;
}

function resolvePointer(root: unknown, ref: string): JsonSchemaProperty | undefined {
  if (!ref.startsWith('#')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null || !(segment in node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'object' && node !== null ? (node as JsonSchemaProperty) : undefined;
}

function jsonSchemaPropertyToZodInner(prop: JsonSchemaProperty, ctx: RefContext): ZodTypeAny {
  if (typeof prop.$ref === 'string') {
    return refToZod(prop.$ref, ctx);
  }

  if (Array.isArray(prop.type)) {
    const variants = prop.type.map((type) => jsonSchemaPropertyToZodInner({ ...prop, type }, ctx));
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
    const schemas = prop.allOf.map((variant) => jsonSchemaPropertyToZod(variant, ctx));
    return schemas.reduce((acc, schema) => z.intersection(acc, schema));
  }

  const unionVariants = prop.oneOf ?? prop.anyOf;
  if (unionVariants && unionVariants.length > 0) {
    const schemas = unionVariants.map((variant) => jsonSchemaPropertyToZod(variant, ctx));
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
      const itemSchema = prop.items ? jsonSchemaPropertyToZod(prop.items, ctx) : z.unknown();
      return z.array(itemSchema);
    }

    case 'object': {
      if (prop.properties) {
        return objectSchemaToZod(
          {
            type: 'object',
            properties: prop.properties,
            required: prop.required,
            additionalProperties: prop.additionalProperties,
          },
          ctx
        );
      }
      if (typeof prop.additionalProperties === 'object' && prop.additionalProperties !== null) {
        return z.record(z.string(), jsonSchemaPropertyToZod(prop.additionalProperties, ctx));
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
 * Convert a Cogitator Tool to MCP tool definition format, with its `title`, `annotations` and
 * `outputSchema`. Only a `z.object()` output schema is kept, the one an MCP server can advertise
 * (see `mcpOutputSchema`).
 */
export function cogitatorToMCP(tool: Tool): MCPToolDefinition {
  const objectSchema = mcpOutputSchema(tool);
  const outputSchema = objectSchema && outputSchemaToMCP(objectSchema);
  return {
    ...toolSchemaToMCP(tool.toJSON()),
    ...(tool.title !== undefined && { title: tool.title }),
    ...(outputSchema && { outputSchema }),
    ...(tool.annotations && { annotations: { ...tool.annotations } }),
  };
}

/**
 * The output schema of a tool that MCP can carry: a `z.object()` schema (`z.strictObject`,
 * `z.looseObject` included). MCP output schemas must have an object root, and the MCP SDK takes
 * them only as zod object schemas, so a record, a union or a pipe is left out, even one whose
 * values are objects.
 */
export function mcpOutputSchema(tool: Tool): ZodObject | undefined {
  const schema: unknown = tool.outputSchema;
  return schema instanceof z.ZodObject ? schema : undefined;
}

/** The JSON Schema of an object output schema for MCP. */
function outputSchemaToMCP(schema: ZodTypeAny): MCPObjectSchema | undefined {
  const jsonSchema: Record<string, unknown> = zodToJsonSchema(schema);
  return jsonSchema.type === 'object' ? toToolParameters(jsonSchema) : undefined;
}

/**
 * Convert a Cogitator ToolSchema to MCP tool definition format. The input schema keeps every
 * keyword, `$defs` included, made self-contained by `toToolParameters`.
 */
export function toolSchemaToMCP(schema: ToolSchema): MCPToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: toToolParameters(schema.parameters),
  };
}

/**
 * A tool name every LLM provider accepts, the same as `normalizeToolName` from
 * `@cogitator-ai/core`: letters, digits, `_` and `-`, starting with a letter or `_`, at most 64
 * characters. A valid name is kept as it is. Other characters, such as the dots of
 * `admin.list_users`, become `_`, and a name too long is cut and ends with a hash of the full
 * name, so different names stay different.
 */
export function normalizeMCPToolName(name: string): string {
  return normalizeToolName(name);
}

/**
 * The provider-safe names of a server's tools. Two tools whose names normalize to the same one
 * (`a.b` and `a_b`) are told apart by a hash of the original name on the one that was changed.
 */
function toolNames(definitions: readonly MCPToolDefinition[], prefix: string): Map<string, string> {
  const names = normalizeToolNames(definitions.map((def) => `${prefix}${def.name}`));
  return new Map(definitions.map((def, index) => [def.name, names[index]!]));
}

/**
 * Convert an MCP tool definition to a Cogitator Tool
 *
 * The resulting tool will execute calls through the provided MCPClient, under the tool's original
 * name. The Cogitator name is `namePrefix` plus the MCP name, normalized for LLM providers (see
 * `normalizeMCPToolName`). Calls are retried after a timeout only when the server marks the tool
 * read-only or idempotent. The tool keeps the server's `title`, `outputSchema` and annotations,
 * and needs approval when the server marks it destructive (see `requiresApproval`). It names the
 * server tool it calls in `mcp` (`ToolAdapterOptions.server`, else the name the server reports),
 * which `mcp__<server>__<tool>` permission rules match.
 */
export function mcpToCogitator(
  mcpTool: MCPToolDefinition,
  client: MCPClient,
  options?: ToolAdapterOptions & {
    /** The Cogitator name to use instead of the normalized one */
    name?: string;
  }
): Tool {
  const name = options?.name ?? normalizeMCPToolName(`${options?.namePrefix ?? ''}${mcpTool.name}`);

  const description = options?.descriptionTransform
    ? options.descriptionTransform(mcpTool.description)
    : mcpTool.description;

  const inputSchema = mcpTool.inputSchema as Parameters<typeof jsonSchemaToZod>[0];
  const parameters = jsonSchemaToZod({ ...inputSchema, type: 'object' });
  const outputSchema =
    mcpTool.outputSchema &&
    jsonSchemaToZod({
      ...(mcpTool.outputSchema as Parameters<typeof jsonSchemaToZod>[0]),
      type: 'object',
    });
  const { title: annotationTitle, ...hints } = mcpTool.annotations ?? {};
  const title = mcpTool.title ?? annotationTitle;
  const annotations = Object.keys(hints).length > 0 ? hints : undefined;
  const idempotent = hints.readOnlyHint === true || hints.idempotentHint === true;
  const requiresApproval = approvalOf(mcpTool, options?.requiresApproval);
  const server = options?.server ?? client.serverName;

  const tool: Tool = {
    name,
    ...(title !== undefined && { title }),
    description,
    parameters,
    ...(outputSchema && { outputSchema }),
    ...(annotations && { annotations }),
    ...(requiresApproval && { requiresApproval }),
    ...(server !== undefined && { mcp: { server, tool: mcpTool.name } }),

    execute: async (params: unknown, context: ToolContext): Promise<unknown> => {
      return client.callTool(mcpTool.name, (params ?? {}) as Record<string, unknown>, {
        signal: context?.signal,
        idempotent,
      });
    },

    toJSON: (): ToolSchema => ({
      name,
      description,
      parameters: toToolParameters(mcpTool.inputSchema),
    }),
  };

  return tool;
}

/**
 * Whether an MCP server marks a tool destructive: `destructiveHint: true` on a tool that is not
 * `readOnlyHint: true`. Tools from `getTools()` / `wrapMCPTools()` that are need approval by
 * default (`ToolAdapterOptions.requiresApproval`). A tool without the hint is not taken as
 * destructive, though MCP's own default for a missing hint is `true`: that would ask approval for
 * every tool of most servers.
 */
export function isDestructiveMCPTool(tool: MCPToolDefinition): boolean {
  return tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint === true;
}

function approvalOf(
  tool: MCPToolDefinition,
  requiresApproval: ToolAdapterOptions['requiresApproval'] = isDestructiveMCPTool
): boolean {
  return typeof requiresApproval === 'function' ? requiresApproval(tool) : requiresApproval;
}

/**
 * Wrap all tools from an MCP client as Cogitator tools
 *
 * Names are normalized for LLM providers and kept distinct. Give each server its own
 * `namePrefix` when an agent uses several servers whose tools could share names.
 *
 * @example
 * ```typescript
 * const client = await MCPClient.connect({ ... });
 * const tools = await wrapMCPTools(client, { namePrefix: 'github_' });
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
  const names = toolNames(definitions, options?.namePrefix ?? '');
  const server = options?.server ?? client.serverName;
  return definitions.map((def) =>
    mcpToCogitator(def, client, {
      ...options,
      ...(server !== undefined && { server }),
      name: names.get(def.name),
    })
  );
}

/**
 * Convert a tool execution result to MCP content format. A result with media (`toolContent()`,
 * or an object with a base64 `image` such as a browser screenshot) becomes text, image, audio
 * and resource blocks instead of JSON text.
 */
export function resultToMCPContent(result: unknown): MCPToolContent[] {
  if (result === null || result === undefined) {
    return [{ type: 'text', text: '' }];
  }

  if (typeof result === 'string') {
    return [{ type: 'text', text: result }];
  }

  const parts = toolResultParts(result);
  if (parts) {
    return parts.map(partToMCPContent);
  }

  if (typeof result === 'object') {
    if (Array.isArray(result) && result.length > 0 && result.every(isMCPToolContent)) {
      return result;
    }

    return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
  }

  return [{ type: 'text', text: String(result) }];
}

function partToMCPContent(part: ToolContentPart, index: number): MCPToolContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image', data: part.data, mimeType: part.mediaType };
    case 'file':
      return part.mediaType.startsWith('audio/')
        ? { type: 'audio', data: part.data, mimeType: part.mediaType }
        : {
            type: 'resource',
            resource: {
              uri: `attachment:///${encodeURIComponent(part.filename ?? `file-${index + 1}`)}`,
              mimeType: part.mediaType,
              blob: part.data,
            },
          };
    case 'json':
      return { type: 'text', text: toolPartsToText([part]) };
    case 'resource':
      if (part.text !== undefined || part.data !== undefined) {
        return {
          type: 'resource',
          resource: {
            uri: part.uri,
            ...(part.mediaType !== undefined && { mimeType: part.mediaType }),
            ...(part.text !== undefined ? { text: part.text } : { blob: part.data }),
          },
        };
      }
      return { type: 'text', text: toolPartsToText([part]) };
  }
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
 * Convert MCP content to a simple result value: the text (parsed as JSON when it is JSON) of a
 * single block, an array of values for several text blocks, and a `toolContent()` result when
 * there are images, audio or binary resources, so they reach the model as media instead of
 * base64 text.
 */
export function mcpContentToResult(content: MCPToolContent[]): unknown {
  if (!content || content.length === 0) {
    return null;
  }

  if (
    content.some((item) => item.type !== 'text' && item.type !== 'resource') ||
    content.some(isBlobResource)
  ) {
    return toolContent(...content.map(mcpContentToPart));
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

function isBlobResource(item: MCPToolContent): boolean {
  return item.type === 'resource' && typeof item.resource.blob === 'string';
}

function mcpContentToPart(item: MCPToolContent): ToolContentPart {
  switch (item.type) {
    case 'text':
      return { type: 'text', text: item.text };
    case 'image':
      return { type: 'image', data: item.data, mediaType: item.mimeType };
    case 'audio':
      return { type: 'file', data: item.data, mediaType: item.mimeType };
    case 'resource':
      if (typeof item.resource.blob === 'string') {
        const mediaType = item.resource.mimeType ?? 'application/octet-stream';
        return mediaType.startsWith('image/')
          ? { type: 'image', data: item.resource.blob, mediaType }
          : { type: 'file', data: item.resource.blob, mediaType, filename: item.resource.uri };
      }
      return {
        type: 'resource',
        uri: item.resource.uri,
        ...(item.resource.mimeType !== undefined && { mediaType: item.resource.mimeType }),
        text: item.resource.text ?? '',
      };
  }
}
