import { toolToSchema } from '@cogitator-ai/core';
import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { isRecord } from './json.js';
import type {
  AISDKJSONSchemaConverterOptions,
  AISDKSchema,
  AISDKSchemaValidation,
  AISDKTool,
  AISDKToolExecutionOptions,
  AISDKToolLike,
  AISDKValidationIssue,
  AISDKValidationResult,
} from './types.js';

const AI_SDK_SCHEMA = Symbol.for('vercel.ai.schema');
const AI_SDK_VALIDATOR = Symbol.for('vercel.ai.validator');
const JSON_SCHEMA_DRAFT_07 = 'draft-07';

type SchemaValidator = (
  value: unknown
) => AISDKSchemaValidation<unknown> | PromiseLike<AISDKSchemaValidation<unknown>>;

interface StandardSchemaProps {
  readonly vendor: string;
  validate(
    value: unknown
  ): AISDKValidationResult<unknown> | Promise<AISDKValidationResult<unknown>>;
  readonly jsonSchema?: {
    input(options: AISDKJSONSchemaConverterOptions): Record<string, unknown>;
  };
}

interface ResolvedSchema {
  jsonSchema: Record<string, unknown>;
  validate?: SchemaValidator;
}

interface ObjectJSONSchema extends Record<string, unknown> {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

function standardProps(schema: unknown): StandardSchemaProps | undefined {
  if (!isRecord(schema) && typeof schema !== 'function') return undefined;
  const props = (schema as { '~standard'?: unknown })['~standard'];
  if (
    !isRecord(props) ||
    typeof props.validate !== 'function' ||
    typeof props.vendor !== 'string'
  ) {
    return undefined;
  }
  return props as unknown as StandardSchemaProps;
}

function isZod4Schema(schema: unknown): schema is Tool['parameters'] {
  return isRecord(schema) && '_zod' in schema && typeof schema.safeParse === 'function';
}

function isAISDKSchema(
  schema: unknown
): schema is { jsonSchema: unknown; validate?: SchemaValidator } {
  return (
    isRecord(schema) &&
    (schema as Record<symbol, unknown>)[AI_SDK_SCHEMA] === true &&
    'jsonSchema' in schema
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (isRecord(value) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function issuesToError(issues: ReadonlyArray<AISDKValidationIssue>): Error {
  const message = issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return new Error(message || 'Invalid tool input');
}

function standardResultToValidation(
  result: AISDKValidationResult<unknown>
): AISDKSchemaValidation<unknown> {
  return result.issues
    ? { success: false, error: issuesToError(result.issues) }
    : { success: true, value: result.value };
}

function standardValidator(props: StandardSchemaProps): SchemaValidator {
  return (value) => {
    const result = props.validate(value);
    return isThenable(result)
      ? Promise.resolve(result).then(standardResultToValidation)
      : standardResultToValidation(result);
  };
}

function standardJSONSchema(props: StandardSchemaProps): Record<string, unknown> | undefined {
  return props.jsonSchema?.input({
    target: JSON_SCHEMA_DRAFT_07,
    libraryOptions: props.vendor === 'zod' ? { unrepresentable: 'any' } : undefined,
  });
}

function resolveAISDKSchema(schema: unknown, toolName: string): ResolvedSchema {
  const resolved =
    typeof schema === 'function' && !standardProps(schema) ? (schema as () => unknown)() : schema;

  if (isAISDKSchema(resolved)) {
    const jsonSchema = resolved.jsonSchema;
    if (isThenable(jsonSchema) || !isRecord(jsonSchema)) {
      throw new Error(
        `AI SDK tool "${toolName}" has an asynchronous JSON schema, which is not supported`
      );
    }
    return { jsonSchema, validate: resolved.validate?.bind(resolved) };
  }

  const props = standardProps(resolved);
  if (props) {
    const jsonSchema = standardJSONSchema(props);
    if (!jsonSchema) {
      throw new Error(
        `AI SDK tool "${toolName}" uses a ${props.vendor} schema without JSON Schema support; ` +
          `use zod 4 or wrap it with jsonSchema() / zodSchema() from "ai"`
      );
    }
    return { jsonSchema, validate: standardValidator(props) };
  }

  if (isRecord(resolved) && (resolved.type === 'object' || 'properties' in resolved)) {
    return { jsonSchema: resolved };
  }

  throw new Error(
    `AI SDK tool "${toolName}" has an unsupported input schema; ` +
      `use zod 4, a Standard JSON Schema, or jsonSchema() / zodSchema() from "ai"`
  );
}

function toObjectJSONSchema(jsonSchema: Record<string, unknown>): ObjectJSONSchema {
  const { $schema: _schema, ...rest } = jsonSchema;
  return {
    ...rest,
    type: 'object',
    properties: isRecord(rest.properties) ? rest.properties : {},
    required: Array.isArray(rest.required)
      ? rest.required.filter((key): key is string => typeof key === 'string')
      : undefined,
  };
}

async function lastValue<T>(result: AsyncIterable<T> | PromiseLike<T> | T): Promise<T | undefined> {
  if (isRecord(result) && Symbol.asyncIterator in result) {
    let last: T | undefined;
    for await (const value of result as AsyncIterable<T>) {
      last = value;
    }
    return last;
  }
  return await (result as PromiseLike<T> | T);
}

function aiSDKContext(context: ToolContext): Record<string, string> {
  const entries = Object.entries({
    agentId: context.agentId,
    runId: context.runId,
    threadId: context.threadId,
    userId: context.userId,
    channelType: context.channelType,
    channelId: context.channelId,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

function resolveDescription(aiTool: AISDKToolLike): string {
  if (typeof aiTool.description === 'string') return aiTool.description;
  if (typeof aiTool.description === 'function') return aiTool.description({ context: {} });
  return 'AI SDK tool';
}

/**
 * Convert an AI SDK tool (ai@4 – ai@7) into a Cogitator tool.
 *
 * Reads `inputSchema` (ai@5+) or `parameters` (ai@4). Zod 4 schemas are kept as-is; other
 * schemas are converted to JSON Schema and validated before `execute` runs.
 */
export function fromAISDKTool<TParams = unknown, TResult = unknown>(
  aiTool: AISDKToolLike,
  toolName?: string
): Tool<TParams, TResult> {
  const name = toolName ?? aiTool.name ?? 'unnamed_tool';
  const schema = aiTool.inputSchema ?? aiTool.parameters;
  if (schema === undefined || schema === null) {
    throw new Error('AI SDK tool must have parameters defined (inputSchema or parameters)');
  }

  const zodSchema = isZod4Schema(schema) ? schema : undefined;
  const resolved = zodSchema ? undefined : resolveAISDKSchema(schema, name);
  const objectSchema = resolved ? toObjectJSONSchema(resolved.jsonSchema) : undefined;

  const execute = async (params: TParams, context: ToolContext): Promise<TResult> => {
    if (!aiTool.execute) {
      throw new Error(`Tool "${name}" has no execute function`);
    }

    let input: unknown = params;
    if (resolved?.validate) {
      const validation = await resolved.validate(params);
      if (!validation.success) {
        throw new Error(`Invalid arguments for tool "${name}": ${validation.error.message}`);
      }
      input = validation.value;
    }

    const toolContext = aiSDKContext(context);
    const options: AISDKToolExecutionOptions = {
      toolCallId: context.runId,
      messages: [],
      abortSignal: context.signal,
      context: toolContext,
      experimental_context: toolContext,
    };
    return (await lastValue(aiTool.execute(input, options))) as TResult;
  };

  const cogTool: Tool<TParams, TResult> = {
    name,
    description: resolveDescription(aiTool),
    parameters: (zodSchema ?? objectSchema) as Tool<TParams, TResult>['parameters'],
    execute,
    toJSON(): ToolSchema {
      if (objectSchema) {
        return {
          name: this.name,
          description: this.description,
          parameters: {
            type: 'object',
            properties: objectSchema.properties,
            required: objectSchema.required,
          },
        };
      }
      return toolToSchema(this);
    },
  };
  return cogTool;
}

function cogitatorJSONSchema(cogTool: Tool): Record<string, unknown> {
  const props = standardProps(cogTool.parameters);
  const jsonSchema = props ? standardJSONSchema(props) : undefined;
  return jsonSchema ?? cogTool.toJSON().parameters;
}

function cogitatorValidator<T>(cogTool: Tool<T>): (value: unknown) => AISDKSchemaValidation<T> {
  const props = standardProps(cogTool.parameters);
  return (value) => {
    if (!props) return { success: true, value: value as T };
    const result = props.validate(value);
    if (isThenable(result)) {
      return {
        success: false,
        error: new Error(
          `Tool "${cogTool.name}" uses an asynchronous schema; validate it inside execute`
        ),
      };
    }
    return result.issues
      ? { success: false, error: issuesToError(result.issues) }
      : { success: true, value: result.value as T };
  };
}

function createAISDKSchema<T>(cogTool: Tool<T>): AISDKSchema<T> {
  let jsonSchema: Record<string, unknown> | undefined;
  const getJSONSchema = () => (jsonSchema ??= cogitatorJSONSchema(cogTool));
  const validate = cogitatorValidator(cogTool);

  const schema: AISDKSchema<T> = {
    get jsonSchema() {
      return getJSONSchema();
    },
    validate,
    '~standard': {
      version: 1,
      vendor: 'cogitator',
      validate: (value) => {
        const result = validate(value);
        return result.success
          ? { value: result.value }
          : { issues: [{ message: result.error.message }] };
      },
      jsonSchema: {
        input: () => getJSONSchema(),
        output: () => getJSONSchema(),
      },
    },
  };

  return Object.assign(schema, {
    [AI_SDK_SCHEMA]: true,
    [AI_SDK_VALIDATOR]: true,
    _type: undefined,
  });
}

function cogitatorContext(options: AISDKToolExecutionOptions): ToolContext {
  const context = options.context ?? options.experimental_context;
  const pick = (key: string): string | undefined => {
    const value = isRecord(context) ? context[key] : undefined;
    return typeof value === 'string' ? value : undefined;
  };

  return {
    agentId: pick('agentId') ?? 'ai-sdk',
    runId: pick('runId') ?? options.toolCallId,
    signal: options.abortSignal ?? new AbortController().signal,
    threadId: pick('threadId'),
    userId: pick('userId'),
    channelType: pick('channelType'),
    channelId: pick('channelId'),
  };
}

/**
 * Convert a Cogitator tool into an AI SDK tool usable with ai@4 – ai@7.
 *
 * The tool exposes the same schema as `inputSchema` (ai@5+) and `parameters` (ai@4). String
 * fields of the AI SDK tool context (`agentId`, `runId`, `threadId`, `userId`, `channelType`,
 * `channelId`) are forwarded to the Cogitator `ToolContext`.
 */
export function toAISDKTool<TParams = unknown, TResult = unknown>(
  cogTool: Tool<TParams, TResult>
): AISDKTool<TParams, TResult> {
  const schema = createAISDKSchema(cogTool);
  return {
    description: cogTool.description,
    inputSchema: isZod4Schema(cogTool.parameters)
      ? cogTool.parameters
      : (schema as unknown as Tool<TParams, TResult>['parameters']),
    parameters: schema,
    execute: (input, options) => cogTool.execute(input, cogitatorContext(options)),
  };
}

export function convertToolsFromAISDK(aiTools: Record<string, AISDKToolLike>): Tool[] {
  return Object.entries(aiTools).map(([name, aiTool]) => fromAISDKTool(aiTool, name));
}

export function convertToolsToAISDK(cogTools: Tool[]): Record<string, AISDKTool> {
  const result: Record<string, AISDKTool> = {};
  for (const tool of cogTools) {
    result[tool.name] = toAISDKTool(tool);
  }
  return result;
}
