import type {
  PermissionOptions,
  Agent as IAgent,
  AgentConfig,
  Tool,
  AgentSnapshot,
  DeserializeOptions,
  ResponseFormat,
  SerializedAgentConfig,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { isCodeSkill, mergeSkillsIntoAgent } from './skill';

const SNAPSHOT_VERSION = '1.0.0';

export class AgentDeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDeserializationError';
  }
}

const generatedIds = new WeakMap<Agent, string>();

/** The tools and instructions an agent was given, before its code skills were merged into them. */
const unmergedConfigs = new WeakMap<Agent, { tools?: Tool[]; instructions: string }>();

/**
 * Checks the entries of `skills`: a skill defined in code, a skill loader (`discover()`) or the
 * configuration of a `SkillRegistry`. An object that looks like a code skill but is not one
 * (no `version`, say) would be taken for a registry configuration, so it is refused here.
 */
function checkSkills(agentName: string, skills: readonly unknown[]): void {
  skills.forEach((skill, index) => {
    if (typeof skill !== 'object' || skill === null) {
      throw new TypeError(`Agent "${agentName}": skills[${index}] is not a skill`);
    }
    if (isCodeSkill(skill) || typeof (skill as { discover?: unknown }).discover === 'function') {
      return;
    }
    const looksLikeCodeSkill = ['tools', 'instructions', 'version', 'name'].some(
      (key) => key in skill
    );
    if (looksLikeCodeSkill) {
      throw new TypeError(
        `Agent "${agentName}": skills[${index}] is neither a skill made with defineSkill() (it needs name, version, description and tools) nor a SkillRegistry or its configuration`
      );
    }
  });
}

/**
 * AI agent that can execute tasks using LLM and tools.
 *
 * @example
 * ```ts
 * import { Agent, tool } from '@cogitator-ai/core';
 * import { z } from 'zod';
 *
 * const searchTool = tool({
 *   name: 'search',
 *   description: 'Search the web',
 *   parameters: z.object({ query: z.string() }),
 *   execute: async ({ query }) => ({ results: [] }),
 * });
 *
 * const agent = new Agent({
 *   name: 'researcher',
 *   model: 'anthropic/claude-sonnet-5-5',
 *   instructions: 'You are a research assistant.',
 *   tools: [searchTool],
 * });
 * ```
 *
 * `TDeps` is the type of the `deps` the agent's runs pass to its tools (`RunOptions.deps`). Set
 * it (`new Agent<AppDeps>(...)`) and `cogitator.run()` requires `deps`, and a tool whose deps
 * type is unrelated to `AppDeps` is refused. Declare every field the agent's tools read in it:
 * TypeScript compares tool methods loosely, so a tool reading a field `AppDeps` lacks still
 * compiles.
 */
export class Agent<TDeps = unknown> implements IAgent<TDeps> {
  /** Human-readable name of the agent */
  readonly name: string;
  /** Full configuration including model, instructions, tools, and parameters */
  readonly config: AgentConfig<TDeps>;

  /**
   * Create a new Agent instance.
   *
   * @param config - Agent configuration
   * @param config.name - Human-readable name for the agent
   * @param config.model - LLM model identifier (e.g., 'anthropic/claude-sonnet-5-5')
   * @param config.instructions - System prompt defining agent behavior
   * @param config.tools - Array of tools the agent can use
   * @param config.temperature - Sampling temperature (default: 0.7)
   * @param config.maxIterations - Maximum tool call iterations (default: 10)
   * @param config.timeout - Run timeout in milliseconds (default: 120000)
   */
  constructor(config: AgentConfig<TDeps>) {
    this.name = config.name;

    let finalConfig = { ...config };
    checkSkills(config.name, config.skills ?? []);
    const codeSkills = (config.skills ?? []).filter(isCodeSkill);
    if (codeSkills.length > 0) {
      unmergedConfigs.set(this, {
        ...(config.tools && { tools: config.tools as Tool[] }),
        instructions: config.instructions,
      });
      const merged = mergeSkillsIntoAgent(config.tools ?? [], config.instructions, codeSkills);
      finalConfig = { ...finalConfig, tools: merged.tools, instructions: merged.instructions };
    }

    this.config = {
      temperature: 0.7,
      maxIterations: 10,
      ...finalConfig,
    };
  }

  /**
   * Unique identifier for this agent instance: `config.id`, or one generated
   * on first read — not in the constructor, so agents can be created at module
   * scope where generating random values is not allowed (Cloudflare Workers).
   */
  get id(): string {
    if (this.config.id) return this.config.id;
    let id = generatedIds.get(this);
    if (!id) {
      id = `agent_${nanoid(12)}`;
      generatedIds.set(this, id);
    }
    return id;
  }

  /** LLM model identifier */
  get model(): string | undefined {
    return this.config.model;
  }

  /** System prompt defining agent behavior */
  get instructions(): string {
    return this.config.instructions;
  }

  /** Tools available to this agent */
  get tools(): Tool<unknown, unknown, TDeps>[] {
    return this.config.tools ?? [];
  }

  /**
   * Create a copy of this agent with configuration overrides.
   *
   * @param overrides - Configuration values to override
   * @returns New Agent instance with merged configuration
   *
   * @example
   * ```ts
   * const creativeAgent = agent.clone({ temperature: 0.9 });
   * const fastAgent = agent.clone({ model: 'anthropic/claude-haiku' });
   * ```
   */
  clone(overrides: Partial<AgentConfig<TDeps>>): Agent<TDeps> {
    const { id: _id, ...rest } = this.config;
    const unmerged = unmergedConfigs.get(this);
    return new Agent<TDeps>({
      ...rest,
      ...(unmerged && {
        tools: unmerged.tools as AgentConfig<TDeps>['tools'],
        instructions: unmerged.instructions,
      }),
      ...overrides,
    });
  }

  /**
   * Serialize the agent to a JSON-compatible snapshot.
   * Tools are stored by name only - use deserialize() with a ToolRegistry to restore.
   *
   * @returns AgentSnapshot that can be JSON.stringify'd and saved
   *
   * @example
   * ```ts
   * const snapshot = agent.serialize();
   * await fs.writeFile('agent.json', JSON.stringify(snapshot, null, 2));
   * ```
   */
  serialize(): AgentSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      id: this.id,
      name: this.name,
      config: {
        model: this.config.model,
        provider: this.config.provider,
        ...(this.config.fallbackModels?.length && {
          fallbackModels: this.config.fallbackModels.map((m) =>
            typeof m === 'string' ? m : { ...m }
          ),
        }),
        instructions: this.config.instructions,
        tools: this.tools.map((t) => t.name),
        description: this.config.description,
        temperature: this.config.temperature,
        topP: this.config.topP,
        maxTokens: this.config.maxTokens,
        stopSequences: this.config.stopSequences,
        responseFormat: serializeResponseFormat(this.config.responseFormat),
        ...(this.config.reasoning && { reasoning: this.config.reasoning }),
        maxIterations: this.config.maxIterations,
        ...(this.config.onIterationLimit && { onIterationLimit: this.config.onIterationLimit }),
        timeout: this.config.timeout,
        ...(this.config.timeouts && { timeouts: { ...this.config.timeouts } }),
        ...(this.config.todos !== undefined && { todos: this.config.todos }),
        ...(this.config.permissions && { permissions: copyPermissions(this.config.permissions) }),
        ...(this.config.budget && { budget: { ...this.config.budget } }),
      },
      metadata: {
        serializedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Restore an agent from a serialized snapshot.
   * Tools must be provided via toolRegistry or tools option.
   *
   * @param snapshot - Previously serialized AgentSnapshot
   * @param options - Deserialization options
   * @param options.toolRegistry - Registry to look up tools by name
   * @param options.tools - Array of tools to look up by name (alternative to registry)
   * @param options.overrides - Override any config values
   * @returns Restored Agent instance
   *
   * @example
   * ```ts
   * const snapshot = JSON.parse(await fs.readFile('agent.json', 'utf-8'));
   * const agent = Agent.deserialize(snapshot, { toolRegistry });
   * ```
   */
  static deserialize(snapshot: AgentSnapshot, options: DeserializeOptions = {}): Agent {
    if (!Agent.validateSnapshot(snapshot)) {
      throw new AgentDeserializationError('Invalid snapshot format');
    }

    const { toolRegistry, tools: directTools, overrides } = options;

    const resolvedTools: Tool[] = [];
    for (const toolName of snapshot.config.tools) {
      let tool: Tool | undefined;

      if (toolRegistry) {
        tool = toolRegistry.get(toolName);
      } else if (directTools) {
        tool = directTools.find((t) => t.name === toolName);
      }

      if (!tool) {
        throw new AgentDeserializationError(
          `Tool "${toolName}" not found. Provide it via toolRegistry or tools option.`
        );
      }

      resolvedTools.push(tool);
    }

    return new Agent({
      id: snapshot.id,
      name: snapshot.name,
      description: snapshot.config.description,
      model: snapshot.config.model,
      provider: snapshot.config.provider,
      ...(snapshot.config.fallbackModels && { fallbackModels: snapshot.config.fallbackModels }),
      instructions: snapshot.config.instructions,
      tools: resolvedTools,
      temperature: snapshot.config.temperature,
      topP: snapshot.config.topP,
      maxTokens: snapshot.config.maxTokens,
      stopSequences: snapshot.config.stopSequences,
      responseFormat: deserializeResponseFormat(snapshot, overrides?.responseFormat),
      ...(snapshot.config.reasoning && { reasoning: snapshot.config.reasoning }),
      maxIterations: snapshot.config.maxIterations,
      ...(snapshot.config.onIterationLimit && {
        onIterationLimit: snapshot.config.onIterationLimit,
      }),
      timeout: snapshot.config.timeout,
      ...(snapshot.config.timeouts && { timeouts: { ...snapshot.config.timeouts } }),
      ...(snapshot.config.todos !== undefined && { todos: snapshot.config.todos }),
      ...(snapshot.config.permissions && {
        permissions: copyPermissions(snapshot.config.permissions),
      }),
      ...(snapshot.config.budget && { budget: { ...snapshot.config.budget } }),
      ...overrides,
    });
  }

  /**
   * Validate that an object is a valid AgentSnapshot.
   *
   * @param snapshot - Object to validate
   * @returns true if the object is a valid AgentSnapshot
   */
  static validateSnapshot(snapshot: unknown): snapshot is AgentSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const s = snapshot as Record<string, unknown>;

    if (s.version !== SNAPSHOT_VERSION) return false;
    if (typeof s.id !== 'string') return false;
    if (typeof s.name !== 'string') return false;
    if (!s.config || typeof s.config !== 'object') return false;

    const config = s.config as Record<string, unknown>;
    if (config.model !== undefined && typeof config.model !== 'string') return false;
    if (config.provider !== undefined && typeof config.provider !== 'string') return false;
    if (typeof config.instructions !== 'string') return false;
    if (!Array.isArray(config.tools)) return false;
    if (!config.tools.every((toolName) => typeof toolName === 'string')) return false;
    if (config.fallbackModels !== undefined && !isFallbackList(config.fallbackModels)) return false;

    return true;
  }
}

/** Most fallback models a snapshot or an agent on the wire may name: each can cost a call per turn. */
export const MAX_FALLBACK_MODELS = 16;

function isFallbackList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_FALLBACK_MODELS &&
    value.every((entry: unknown) => {
      if (typeof entry === 'string') return entry.length > 0;
      if (typeof entry !== 'object' || entry === null) return false;
      const { model, provider, ...rest } = entry as Record<string, unknown>;
      return (
        typeof model === 'string' &&
        model.length > 0 &&
        (provider === undefined || (typeof provider === 'string' && provider.length > 0)) &&
        Object.keys(rest).length === 0
      );
    })
  );
}

function serializeResponseFormat(
  format: ResponseFormat | undefined
): SerializedAgentConfig['responseFormat'] {
  if (format?.type !== 'json_schema') return format;
  const name = format.schema.description;
  return { type: 'json_schema', schemaName: name || 'response' };
}

function deserializeResponseFormat(
  snapshot: AgentSnapshot,
  override: ResponseFormat | undefined
): ResponseFormat | undefined {
  const format = snapshot.config.responseFormat;
  if (override || !format) return override;
  if (format.type !== 'json_schema') return format;
  throw new Error(
    `Agent "${snapshot.name}" was serialized with the JSON schema "${format.schemaName}". ` +
      'Pass the Zod schema back as overrides.responseFormat to deserialize it.'
  );
}

/**
 * The id `agent`'s long-term memory (memory items) is kept under: its configured `id`, else its
 * `name`. A generated id changes with every instance, a name does not, so the memory of an agent
 * created again, in another process or for another request, is found again.
 */
export function memoryAgentId(agent: {
  readonly config: { id?: string };
  readonly name: string;
}): string {
  return agent.config.id ?? agent.name;
}

/** A copy of permission options, their rule lists copied too */
function copyPermissions(options: PermissionOptions): PermissionOptions {
  return {
    ...(options.mode !== undefined && { mode: options.mode }),
    ...(options.allow && { allow: [...options.allow] }),
    ...(options.ask && { ask: [...options.ask] }),
    ...(options.deny && { deny: [...options.deny] }),
    ...(options.inherited && {
      inherited: options.inherited.map((entry) => ({
        root: entry.root,
        cwd: entry.cwd,
        ...(entry.allow && { allow: [...entry.allow] }),
        ...(entry.ask && { ask: [...entry.ask] }),
        ...(entry.deny && { deny: [...entry.deny] }),
      })),
    }),
  };
}
