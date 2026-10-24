import type {
  ApprovalCheck,
  BaseToolContext,
  Tool,
  ToolConfig,
  ToolSchema,
} from '@cogitator-ai/types';
import { z, type ZodType } from 'zod';
import { toToolParameters } from './tool-schema';
import { assertToolName } from './tool-name';
import { toolResultLengthError } from './tool-content';

/**
 * Create a type-safe tool for agent use.
 *
 * Tools enable agents to interact with external systems, APIs, databases,
 * or perform computations. Parameters are validated using Zod schemas.
 *
 * The name must be one every LLM provider accepts: letters, digits, `_` and `-`, starting with a
 * letter or `_`, at most 64 characters. Any other name throws here, instead of failing later as a
 * provider error, and `normalizeToolName()` turns a name such as `weather.get` into one that fits.
 *
 * @typeParam TParams - Type of parameters the tool accepts
 * @typeParam TResult - Type of result the tool returns
 * @typeParam TDeps - Type of the run's `deps` the tool reads, from its `context` annotation
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
 *
 * @example A tool that uses the run's deps
 * ```ts
 * interface AppDeps { db: Database; userId: string }
 *
 * const listOrders = tool({
 *   name: 'list_orders',
 *   description: 'List the signed-in user\'s orders',
 *   parameters: z.object({ limit: z.number().default(10) }),
 *   execute: async ({ limit }, { deps }: ToolContext<AppDeps>) =>
 *     deps.db.orders.findMany({ where: { userId: deps.userId }, take: limit }),
 * });
 *
 * const agent = new Agent<AppDeps>({ name: 'support', instructions: '...', tools: [listOrders] });
 * await cog.run(agent, { input: 'Where is my order?', deps: { db, userId: session.userId } });
 * ```
 */
export function tool<TParams, TResult, TDeps = unknown>(
  config: ToolConfig<TParams, TResult, TDeps>
): Tool<TParams, TResult, TDeps> {
  assertToolName(config.name);
  const lengthError = toolResultLengthError(
    config.maxResultLength,
    `maxResultLength of tool "${config.name}"`
  );
  if (lengthError) throw new TypeError(lengthError);
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    category: config.category,
    tags: config.tags,
    parameters: config.parameters,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    execute: config.execute as (
      params: TParams,
      context: BaseToolContext<TDeps>
    ) => Promise<TResult>,
    sideEffects: config.sideEffects,
    requiresApproval:
      typeof config.requiresApproval === 'function'
        ? (config.requiresApproval as ApprovalCheck)
        : config.requiresApproval,
    timeout: config.timeout,
    sandbox: config.sandbox,
    maxResultLength: config.maxResultLength,
    ...(config.providerTypes && { providerTypes: config.providerTypes }),
    ...(config.deferred && { deferred: true }),
    ...(config.isConcurrencySafe !== undefined && { isConcurrencySafe: config.isConcurrencySafe }),
    ...(config.lockKeys && {
      lockKeys: config.lockKeys as (
        params: TParams,
        context: BaseToolContext<TDeps>
      ) => readonly string[] | Promise<readonly string[]>,
    }),
    ...(config.presentation !== undefined && { presentation: config.presentation }),
    ...(config.onInputStart && { onInputStart: config.onInputStart }),
    ...(config.onInputDelta && { onInputDelta: config.onInputDelta }),
    ...(config.onInputAvailable && { onInputAvailable: config.onInputAvailable }),
    ...(config.onInputAbandoned && { onInputAbandoned: config.onInputAbandoned }),
    toJSON(): ToolSchema {
      return toolToSchema(this);
    },
  };
}

/**
 * The fields of `tool` that decide how its calls are scheduled and shown, to keep on a tool that
 * wraps it: concurrency, lock keys, presentation and input hooks.
 */
export function executionFieldsOf<TParams, TResult, TDeps>(
  tool: Tool<TParams, TResult, TDeps>
): Pick<
  Tool<TParams, TResult, TDeps>,
  | 'isConcurrencySafe'
  | 'lockKeys'
  | 'presentation'
  | 'onInputStart'
  | 'onInputDelta'
  | 'onInputAvailable'
  | 'onInputAbandoned'
> {
  return {
    ...(tool.isConcurrencySafe !== undefined && { isConcurrencySafe: tool.isConcurrencySafe }),
    ...(tool.lockKeys && { lockKeys: (params, context) => tool.lockKeys!(params, context) }),
    ...(tool.presentation !== undefined && { presentation: tool.presentation }),
    ...(tool.onInputStart && { onInputStart: (event) => tool.onInputStart!(event) }),
    ...(tool.onInputDelta && { onInputDelta: (event) => tool.onInputDelta!(event) }),
    ...(tool.onInputAvailable && { onInputAvailable: (event) => tool.onInputAvailable!(event) }),
    ...(tool.onInputAbandoned && { onInputAbandoned: (event) => tool.onInputAbandoned!(event) }),
  };
}

/**
 * The tool with its arguments taken as they come, for running through `invokeTool` a call whose
 * arguments were already parsed with the tool's own schema, such as by the MCP SDK or the AI SDK.
 * Everything that decides how the call runs (approval, sandbox, timeout, side effects, result
 * limit) stays, and the schema's transforms apply once instead of twice.
 */
export function withParsedArguments<TParams, TResult>(
  tool: Tool<TParams, TResult>
): Tool<TParams, TResult> {
  return {
    name: tool.name,
    ...(tool.title !== undefined && { title: tool.title }),
    description: tool.description,
    ...(tool.category !== undefined && { category: tool.category }),
    ...(tool.tags !== undefined && { tags: tool.tags }),
    parameters: z.custom<TParams>(() => true),
    ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema }),
    ...(tool.annotations !== undefined && { annotations: tool.annotations }),
    execute: (params, context) => tool.execute(params, context),
    ...(tool.sideEffects !== undefined && { sideEffects: tool.sideEffects }),
    ...(tool.requiresApproval !== undefined && { requiresApproval: tool.requiresApproval }),
    ...(tool.timeout !== undefined && { timeout: tool.timeout }),
    ...(tool.sandbox !== undefined && { sandbox: tool.sandbox }),
    ...(tool.maxResultLength !== undefined && { maxResultLength: tool.maxResultLength }),
    ...(tool.providerTypes && { providerTypes: tool.providerTypes }),
    ...(tool.deferred && { deferred: true }),
    ...executionFieldsOf(tool),
    toJSON: () => tool.toJSON(),
  };
}

/**
 * Convert a tool to JSON Schema format for LLM function calling.
 *
 * A Zod schema is converted to OpenAPI 3.0 compatible JSON Schema, a JSON Schema is taken as is.
 * Either way the result is made self-contained by `toToolParameters`: definitions that
 * recursive schemas (`z.lazy`) refer to travel along in `$defs`, other refs are inlined.
 *
 * @typeParam TParams - Type of tool parameters
 * @typeParam TResult - Type of tool result
 * @param t - Tool to convert
 * @returns JSON Schema representation of the tool
 */
export function toolToSchema<TParams, TResult>(t: Tool<TParams, TResult>): ToolSchema {
  const params = t.parameters as unknown as Record<string, unknown>;
  const isZodType = params && typeof params === 'object' && '_zod' in params;

  let jsonSchema: Record<string, unknown>;
  if (!isZodType && params?.type === 'object') {
    jsonSchema = params;
  } else {
    try {
      jsonSchema = z.toJSONSchema(t.parameters as ZodType, {
        target: 'openapi-3.0',
        unrepresentable: 'any',
        io: 'input',
      }) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[toolToSchema] Failed to convert schema for "${t.name}":`,
        (err as Error).message
      );
      jsonSchema = { type: 'object', properties: {} };
    }
  }

  return {
    name: t.name,
    description: t.description,
    parameters: toToolParameters(jsonSchema),
    ...(t.providerTypes && { providerTypes: t.providerTypes }),
  };
}

/**
 * Tools as a tuple: still an array of `Tool`s an agent accepts, but each
 * keeps its own parameter and result types, so
 * `const [search, read] = createMyTools()` calls `search.execute` with
 * search's parameters.
 */
export function toolset<T extends Tool[]>(...tools: T): T {
  return tools;
}
