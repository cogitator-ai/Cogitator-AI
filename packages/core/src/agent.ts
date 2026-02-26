import type {
  Agent as IAgent,
  AgentConfig,
  Tool,
  AgentSnapshot,
  DeserializeOptions,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

const SNAPSHOT_VERSION = '1.0.0';

export class AgentDeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDeserializationError';
  }
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
 *   model: 'anthropic/claude-sonnet-4-20250514',
 *   instructions: 'You are a research assistant.',
 *   tools: [searchTool],
 * });
 * ```
 */
export class Agent implements IAgent {
  /** Unique identifier for this agent instance */
  readonly id: string;
  /** Human-readable name of the agent */
  readonly name: string;
  /** Full configuration including model, instructions, tools, and parameters */
  readonly config: AgentConfig;

  /**
   * Create a new Agent instance.
   *
   * @param config - Agent configuration
   * @param config.name - Human-readable name for the agent
   * @param config.model - LLM model identifier (e.g., 'anthropic/claude-sonnet-4-20250514')
   * @param config.instructions - System prompt defining agent behavior
   * @param config.tools - Array of tools the agent can use
   * @param config.temperature - Sampling temperature (default: 0.7)
   * @param config.maxIterations - Maximum tool call iterations (default: 10)
   * @param config.timeout - Run timeout in milliseconds (default: 120000)
   */
  constructor(config: AgentConfig) {
    this.id = config.id ?? `agent_${nanoid(12)}`;
    this.name = config.name;
    this.config = {
      temperature: 0.7,
      maxIterations: 10,
      timeout: 120_000,
      ...config,
    };
  }

  /** LLM model identifier */
  get model(): string {
    return this.config.model;
  }

  /** System prompt defining agent behavior */
  get instructions(): string {
    return this.config.instructions;
  }

  /** Tools available to this agent */
  get tools(): Tool[] {
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
  clone(overrides: Partial<AgentConfig>): Agent {
    const { id: _id, ...rest } = this.config;
    return new Agent({
      ...rest,
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
        instructions: this.config.instructions,
        tools: this.tools.map((t) => t.name),
        description: this.config.description,
        temperature: this.config.temperature,
        topP: this.config.topP,
        maxTokens: this.config.maxTokens,
        stopSequences: this.config.stopSequences,
        maxIterations: this.config.maxIterations,
        timeout: this.config.timeout,
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
      instructions: snapshot.config.instructions,
      tools: resolvedTools,
      temperature: snapshot.config.temperature,
      topP: snapshot.config.topP,
      maxTokens: snapshot.config.maxTokens,
      stopSequences: snapshot.config.stopSequences,
      maxIterations: snapshot.config.maxIterations,
      timeout: snapshot.config.timeout,
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

    if (typeof s.version !== 'string') return false;
    if (typeof s.id !== 'string') return false;
    if (typeof s.name !== 'string') return false;
    if (!s.config || typeof s.config !== 'object') return false;

    const config = s.config as Record<string, unknown>;
    if (typeof config.model !== 'string') return false;
    if (typeof config.instructions !== 'string') return false;
    if (!Array.isArray(config.tools)) return false;

    return true;
  }
}
