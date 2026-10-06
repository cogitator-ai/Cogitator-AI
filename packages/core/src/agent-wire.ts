import { nanoid } from 'nanoid';
import { z } from 'zod';
import type {
  Agent as IAgent,
  AgentConfig,
  AgentWireAgent,
  AgentWireConfig,
  AgentWireHandoff,
  AgentWireResponseFormat,
  AgentWireRunResult,
  Handoff,
  ResponseFormat,
  RunResult,
  Tool,
  ToolSchema,
} from '@cogitator-ai/types';
import { Agent } from './agent';

/**
 * How each `AgentConfig` field travels in the agent wire format. Adding a field to
 * `AgentConfig` fails to compile until it is listed here, and the round-trip test checks that
 * every listed field arrives.
 */
export const AGENT_CONFIG_WIRE_FIELDS = {
  id: 'carried',
  name: 'carried',
  description: 'carried',
  provider: 'carried, and as the prefix of model so the route stays the same',
  model: 'carried, the sender resolving a missing one',
  instructions: 'carried',
  tools: 'carried as schemas, resolved by name on the receiving side',
  skills: 'merged into tools and instructions by the Agent constructor',
  temperature: 'carried',
  topP: 'carried',
  maxTokens: 'carried',
  stopSequences: 'carried',
  responseFormat: 'carried, a Zod schema as JSON Schema',
  reasoning: 'carried',
  handoffs: 'carried as a graph of named agents',
  maxIterations: 'carried',
  onIterationLimit: 'carried',
  timeout: 'carried',
} as const satisfies Record<keyof AgentConfig, string>;

/** Something wrong with an agent on the wire, or with what the receiving side can run. */
export class AgentWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentWireError';
  }
}

const toolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.looseObject({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});

const responseFormatSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text') }),
  z.strictObject({ type: z.literal('json') }),
  z.strictObject({
    type: z.literal('json_schema'),
    schema: z.record(z.string(), z.unknown()),
  }),
]);

const reasoningSchema = z.strictObject({
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  budgetTokens: z.number().int().nonnegative().optional(),
  summary: z.boolean().optional(),
});

const handoffSchema = z.strictObject({
  agent: z.string().min(1),
  toolName: z.string().min(1).optional(),
  description: z.string().optional(),
});

const agentShape = {
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string(),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
  responseFormat: responseFormatSchema.optional(),
  reasoning: reasoningSchema.optional(),
  maxIterations: z.number().int().positive().optional(),
  onIterationLimit: z.enum(['answer', 'stop']).optional(),
  timeout: z.number().positive().optional(),
  tools: z.array(toolSchemaSchema),
  handoffs: z.array(handoffSchema).optional(),
};

const agentWireAgentSchema = z.strictObject(agentShape);

/**
 * Zod schema of `AgentWireConfig`. Unknown keys are refused, so a sender newer than the
 * receiver fails loudly instead of running the agent without a setting it asked for.
 */
export const agentWireSchema = z.strictObject({
  ...agentShape,
  handoffAgents: z.record(z.string(), agentWireAgentSchema).optional(),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Check that `value` is an agent on the wire: its fields, and that every handoff names an
 * agent it carries.
 *
 * @throws AgentWireError naming what is wrong
 */
export function parseAgentWire(value: unknown): AgentWireConfig {
  const parsed = agentWireSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentWireError(`Invalid agent wire config: ${describeIssues(parsed.error)}`);
  }
  const wire: AgentWireConfig = parsed.data;
  const known = new Set([wire.name]);
  for (const [key, agent] of Object.entries(wire.handoffAgents ?? {})) {
    if (agent.name !== key) {
      throw new AgentWireError(
        `Invalid agent wire config: handoffAgents.${key} holds an agent named "${agent.name}"`
      );
    }
    if (key === wire.name) {
      throw new AgentWireError(
        `Invalid agent wire config: handoffAgents repeats the entry agent "${key}"`
      );
    }
    known.add(key);
  }
  for (const agent of [wire, ...Object.values(wire.handoffAgents ?? {})]) {
    for (const handoff of agent.handoffs ?? []) {
      if (!known.has(handoff.agent)) {
        throw new AgentWireError(
          `Invalid agent wire config: "${agent.name}" hands over to "${handoff.agent}", which the config does not carry`
        );
      }
    }
  }
  return wire;
}

/** Options of {@link toAgentWire}. */
export interface ToAgentWireOptions {
  /**
   * The model of an agent that sets none, e.g. `(agent) => cogitator.resolveModel(agent)`, so it
   * runs on the sender's default model wherever it lands
   */
  resolveModel?: (agent: IAgent) => string;
}

function toHandoff(entry: IAgent | Handoff): Handoff {
  return 'agent' in entry ? entry : { agent: entry };
}

/**
 * The agents `entry` can reach through handoffs, by name, without `entry`.
 *
 * @throws AgentWireError when two different agents of the graph share a name
 */
function collectHandoffAgents(entry: IAgent): Map<string, IAgent> {
  const byName = new Map<string, IAgent>([[entry.name, entry]]);
  const queue: IAgent[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of current.config.handoffs ?? []) {
      const target = toHandoff(next).agent;
      const known = byName.get(target.name);
      if (known === target) continue;
      if (known) {
        throw new AgentWireError(
          `Cannot send agent "${entry.name}": two different agents it can hand over to are named "${target.name}"`
        );
      }
      byName.set(target.name, target);
      queue.push(target);
    }
  }
  byName.delete(entry.name);
  return byName;
}

/** A response format as it travels: a Zod schema becomes JSON Schema. */
export function toAgentWireResponseFormat(
  format: ResponseFormat | undefined
): AgentWireResponseFormat | undefined {
  if (format?.type !== 'json_schema') return format;
  const schema = z.toJSONSchema(format.schema, { unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return { type: 'json_schema', schema };
}

/** A response format back from its wire form: JSON Schema becomes a Zod schema. */
export function fromAgentWireResponseFormat(
  format: AgentWireResponseFormat | undefined
): ResponseFormat | undefined {
  if (format?.type !== 'json_schema') return format;
  return { type: 'json_schema', schema: z.fromJSONSchema(format.schema) };
}

function agentToWire(agent: IAgent, options: ToAgentWireOptions): AgentWireAgent {
  const { config } = agent;
  const model = config.model || options.resolveModel?.(agent);
  if (!model) {
    throw new AgentWireError(
      `Agent "${agent.name}" has no model; set one before sending it to another process`
    );
  }
  const provider = config.provider;
  const responseFormat = toAgentWireResponseFormat(config.responseFormat);
  const handoffs = (config.handoffs ?? []).map(toHandoff).map((handoff): AgentWireHandoff => ({
    agent: handoff.agent.name,
    ...(handoff.toolName !== undefined && { toolName: handoff.toolName }),
    ...(handoff.description !== undefined && { description: handoff.description }),
  }));

  return {
    id: agent.id,
    name: agent.name,
    ...(config.description !== undefined && { description: config.description }),
    instructions: config.instructions,
    model: provider ? `${provider}/${model}` : model,
    ...(provider && { provider }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.topP !== undefined && { topP: config.topP }),
    ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
    ...(config.stopSequences !== undefined && { stopSequences: [...config.stopSequences] }),
    ...(responseFormat && { responseFormat }),
    ...(config.reasoning !== undefined && { reasoning: { ...config.reasoning } }),
    ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
    ...(config.onIterationLimit !== undefined && { onIterationLimit: config.onIterationLimit }),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    tools: agent.tools.map((tool): ToolSchema => tool.toJSON()),
    ...(handoffs.length > 0 && { handoffs }),
  };
}

/**
 * An agent in the wire format, for a queue job, a workflow job or a distributed swarm turn: its
 * whole configuration (see {@link AGENT_CONFIG_WIRE_FIELDS}) as plain JSON, with every agent it
 * can hand over to. An explicit `provider` also prefixes the model, so the agent takes the same
 * route on the receiving side.
 *
 * @throws AgentWireError when the agent has no model and `resolveModel` gives none, or when two
 *   different agents of its handoff graph share a name
 */
export function toAgentWire(agent: IAgent, options: ToAgentWireOptions = {}): AgentWireConfig {
  const handoffAgents = collectHandoffAgents(agent);
  const entry = agentToWire(agent, options);
  if (handoffAgents.size === 0) return entry;
  return {
    ...entry,
    handoffAgents: Object.fromEntries(
      Array.from(handoffAgents, ([name, target]) => [name, agentToWire(target, options)])
    ),
  };
}

/** What {@link fromAgentWire} needs from the receiving process. */
export interface AgentWireRuntime {
  /** Routes the agent's model, see `Cogitator.knowsProvider` */
  cogitator: { knowsProvider(name: string): boolean };
  /** Tool implementations, matched to the agent's tool schemas by name */
  tools?: readonly Tool[];
}

/**
 * The model and provider an agent on the wire runs with, so it takes the route the same agent
 * takes in-process. A model whose prefix names a provider the receiving side routes to runs
 * there (with `provider` set when it names the same one). Otherwise `provider` routes it, and
 * without a provider the model runs on `llm.defaultProvider`.
 *
 * @throws AgentWireError when `provider` is needed but the receiving side cannot route to it
 */
export function routeAgentWireModel(
  model: string,
  provider: string | undefined,
  router: AgentWireRuntime['cogitator']
): { model: string; provider?: string } {
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    if (router.knowsProvider(prefix)) {
      return prefix === provider ? { model: model.slice(slash + 1), provider } : { model };
    }
  }
  if (!provider) return { model };
  if (!router.knowsProvider(provider)) {
    throw new AgentWireError(
      `Provider "${provider}" of model "${model}" is not available here: it is not a built-in ` +
        'provider, a backend in llm.backends or a registered plugin of the Cogitator that runs the agent.'
    );
  }
  return { model, provider };
}

function missingTools(agents: readonly AgentWireAgent[], available: readonly Tool[]): Set<string> {
  const registry = new Set(available.map((tool) => tool.name));
  const missing = new Set<string>();
  for (const agent of agents) {
    for (const schema of agent.tools) {
      if (!registry.has(schema.name)) missing.add(schema.name);
    }
  }
  return missing;
}

/**
 * The agent an {@link toAgentWire} payload describes, ready to run on this process: its model
 * routed by `runtime.cogitator`, its tools taken from `runtime.tools` by name, its JSON Schema
 * response format a Zod schema again, and its handoff graph rebuilt.
 *
 * @throws AgentWireError when the payload is not a valid agent on the wire, a tool it needs is
 *   not in `runtime.tools`, or its provider cannot be routed here
 */
export function fromAgentWire(value: unknown, runtime: AgentWireRuntime): Agent {
  const wire = parseAgentWire(value);
  const wireAgents: AgentWireAgent[] = [wire, ...Object.values(wire.handoffAgents ?? {})];

  const available = runtime.tools ?? [];
  const missing = missingTools(wireAgents, available);
  if (missing.size > 0) {
    throw new AgentWireError(
      `Agent "${wire.name}" needs tools that are not registered here: ${[...missing].join(', ')}. ` +
        'Pass their implementations to the process that runs it (the worker `tools` option).'
    );
  }
  const tools = new Map(available.map((tool) => [tool.name, tool]));

  const agents = new Map<string, Agent>();
  const handoffLists = new Map<string, (IAgent | Handoff)[]>();
  for (const item of wireAgents) {
    const route = routeAgentWireModel(item.model, item.provider, runtime.cogitator);
    const handoffs: (IAgent | Handoff)[] = [];
    if (item.handoffs) handoffLists.set(item.name, handoffs);
    agents.set(
      item.name,
      new Agent({
        ...(item.id !== undefined && { id: item.id }),
        name: item.name,
        ...(item.description !== undefined && { description: item.description }),
        instructions: item.instructions,
        model: route.model,
        ...(route.provider !== undefined && { provider: route.provider }),
        ...(item.temperature !== undefined && { temperature: item.temperature }),
        ...(item.topP !== undefined && { topP: item.topP }),
        ...(item.maxTokens !== undefined && { maxTokens: item.maxTokens }),
        ...(item.stopSequences !== undefined && { stopSequences: item.stopSequences }),
        ...(item.responseFormat !== undefined && {
          responseFormat: fromAgentWireResponseFormat(item.responseFormat),
        }),
        ...(item.reasoning !== undefined && { reasoning: item.reasoning }),
        ...(item.maxIterations !== undefined && { maxIterations: item.maxIterations }),
        ...(item.onIterationLimit !== undefined && { onIterationLimit: item.onIterationLimit }),
        ...(item.timeout !== undefined && { timeout: item.timeout }),
        tools: item.tools.map((schema) => tools.get(schema.name)!),
        ...(item.handoffs && { handoffs }),
      })
    );
  }

  for (const item of wireAgents) {
    const list = handoffLists.get(item.name);
    if (!list) continue;
    for (const handoff of item.handoffs ?? []) {
      const target = agents.get(handoff.agent)!;
      list.push(
        handoff.toolName !== undefined || handoff.description !== undefined
          ? {
              agent: target,
              ...(handoff.toolName !== undefined && { toolName: handoff.toolName }),
              ...(handoff.description !== undefined && { description: handoff.description }),
            }
          : target
      );
    }
  }

  return agents.get(wire.name)!;
}

interface ToolMessageLike {
  role: string;
  toolCallId?: string;
  content: unknown;
}

/** What a tool returned for `toolCallId`, read from the run's `tool` messages. */
export function findToolOutput(messages: readonly ToolMessageLike[], toolCallId: string): unknown {
  const message = messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
  if (!message) return undefined;
  if (typeof message.content !== 'string') return message.content;
  try {
    return JSON.parse(message.content) as unknown;
  } catch {
    return message.content;
  }
}

/**
 * A run's outcome in the wire format: what the caller acts on (answer, structured output,
 * usage with cost, tool calls and the flags that say the answer is cut off, withheld or past the
 * iteration limit) as plain JSON. A run paused for tool approvals keeps `status: 'paused'`, the
 * calls it waits on and the checkpoint to resume it from, so the receiving side can tell it from
 * an answer (see `isPausedRun`) and continue it on any process.
 */
export function toAgentWireRunResult(result: RunResult): AgentWireRunResult {
  const { usage } = result;
  return {
    output: result.output,
    ...(result.structured !== undefined && { structured: result.structured }),
    ...(result.structuredError !== undefined && { structuredError: result.structuredError }),
    ...(result.reasoning !== undefined && { reasoning: result.reasoning }),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cost: usage.cost,
      duration: usage.duration,
      ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
      ...(usage.cachedInputTokens !== undefined && {
        cachedInputTokens: usage.cachedInputTokens,
      }),
      ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
    },
    toolCalls: result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.arguments,
      output: findToolOutput(result.messages, call.id),
    })),
    ...(result.truncated !== undefined && { truncated: result.truncated }),
    ...(result.blocked !== undefined && { blocked: result.blocked }),
    ...(result.iterationLimitReached !== undefined && {
      iterationLimitReached: result.iterationLimitReached,
    }),
    ...(result.status !== undefined && { status: result.status }),
    ...(result.pendingApprovals !== undefined && {
      pendingApprovals: result.pendingApprovals.map((approval) => ({ ...approval })),
    }),
    ...(result.checkpoint !== undefined && { checkpoint: result.checkpoint }),
    ...(result.modelUsed !== undefined && { modelUsed: result.modelUsed }),
    ...(result.handoffs !== undefined && { handoffs: [...result.handoffs] }),
    ...(result.finalAgent !== undefined && { finalAgent: result.finalAgent }),
    runId: result.runId,
    threadId: result.threadId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `RunResult` from a run's wire form, for code that consumes runs of another process like
 * local ones. Its `messages` and trace spans are empty: they stayed with the process that ran
 * the agent.
 */
export function fromAgentWireRunResult(
  wire: AgentWireRunResult,
  context: { agentId: string; threadId?: string }
): RunResult {
  return {
    output: wire.output,
    ...(wire.structured !== undefined && { structured: wire.structured }),
    ...(wire.structuredError !== undefined && { structuredError: wire.structuredError }),
    ...(wire.reasoning !== undefined && { reasoning: wire.reasoning }),
    runId: wire.runId ?? `run_${nanoid(12)}`,
    agentId: context.agentId,
    threadId: wire.threadId ?? context.threadId ?? '',
    ...(wire.modelUsed !== undefined && { modelUsed: wire.modelUsed }),
    usage: {
      inputTokens: wire.usage.inputTokens,
      outputTokens: wire.usage.outputTokens,
      totalTokens: wire.usage.totalTokens,
      cost: wire.usage.cost,
      duration: wire.usage.duration ?? 0,
      ...(wire.usage.reasoningTokens !== undefined && {
        reasoningTokens: wire.usage.reasoningTokens,
      }),
      ...(wire.usage.cachedInputTokens !== undefined && {
        cachedInputTokens: wire.usage.cachedInputTokens,
      }),
      ...(wire.usage.cacheWriteTokens !== undefined && {
        cacheWriteTokens: wire.usage.cacheWriteTokens,
      }),
    },
    ...(wire.truncated !== undefined && { truncated: wire.truncated }),
    ...(wire.blocked !== undefined && { blocked: wire.blocked }),
    ...(wire.iterationLimitReached !== undefined && {
      iterationLimitReached: wire.iterationLimitReached,
    }),
    ...(wire.status !== undefined && { status: wire.status }),
    ...(wire.pendingApprovals !== undefined && { pendingApprovals: wire.pendingApprovals }),
    ...(wire.checkpoint !== undefined && { checkpoint: wire.checkpoint }),
    ...(wire.handoffs !== undefined && { handoffs: wire.handoffs }),
    ...(wire.finalAgent !== undefined && { finalAgent: wire.finalAgent }),
    toolCalls: wire.toolCalls.map((call) => ({
      id: call.id ?? `call_${nanoid(8)}`,
      name: call.name,
      arguments: isRecord(call.input) ? call.input : {},
    })),
    messages: [],
    trace: { traceId: `trace_${nanoid(12)}`, spans: [] },
  };
}
