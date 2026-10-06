/**
 * The agent wire format: how an agent and the outcome of its run travel between processes
 * (queue jobs, workflow jobs, distributed swarm turns). One format, so every transport keeps
 * every setting of the agent and every part of its result.
 */

import type { LLMBackendProvider, ReasoningConfig } from './llm';
import type { ToolSchema } from './tool';
import type { HandoffEvent, RunBlockReason } from './runtime';

/**
 * An agent's response format on the wire: a Zod schema travels as JSON Schema, and the
 * receiving side turns it back into a schema that validates the structured answer.
 */
export type AgentWireResponseFormat =
  { type: 'text' } | { type: 'json' } | { type: 'json_schema'; schema: Record<string, unknown> };

/**
 * A handoff on the wire. The target is named, and its configuration is the entry agent itself or
 * an entry of `AgentWireConfig.handoffAgents`, so handoff graphs with cycles travel too.
 */
export interface AgentWireHandoff {
  /** Name of the agent the conversation goes to */
  agent: string;
  /** Tool name instead of `transfer_to_<agent name>` */
  toolName?: string;
  /** When to hand over, for the model */
  description?: string;
}

/**
 * One agent on the wire. Its fields are those of `AgentConfig`, except that tools travel as
 * schemas (the receiving side resolves them by name from its own registry), skills are already
 * merged into `tools` and `instructions`, and handoff targets are named.
 */
export interface AgentWireAgent {
  /** The agent's id, so a run on another process reports the same `agentId` */
  id?: string;
  name: string;
  description?: string;
  instructions: string;
  /**
   * Model string, routed like the same agent in-process: a prefix naming a built-in provider,
   * a backend in the receiving Cogitator's `llm.backends` or a registered plugin picks that
   * provider (e.g. 'openai/gpt-6.1-sol', 'openrouter/deepseek/deepseek-v4-pro'). An agent with an
   * explicit `provider` travels as `<provider>/<model>`, so the route stays the same
   */
  model: string;
  /**
   * Provider for a model whose prefix names none the receiving side routes to (e.g.
   * 'meta-llama/llama-4-scout' with `provider: 'openrouter'`). Without it such a model runs on
   * the receiving Cogitator's `llm.defaultProvider`, and a provider it cannot route to fails
   */
  provider?: LLMBackendProvider;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** Structured output: the run result carries `structured` when the answer fits */
  responseFormat?: AgentWireResponseFormat;
  /** Reasoning effort and summaries, as in `AgentConfig.reasoning` */
  reasoning?: ReasoningConfig;
  maxIterations?: number;
  /** What happens when tool calls use up `maxIterations`, as in `AgentConfig.onIterationLimit` */
  onIterationLimit?: 'answer' | 'stop';
  /** Run timeout in ms, as in `AgentConfig.timeout` */
  timeout?: number;
  /** Tool schemas; tools are resolved by name on the receiving side */
  tools: ToolSchema[];
  /** Agents this one can hand the conversation over to */
  handoffs?: AgentWireHandoff[];
}

/**
 * An agent on the wire, with every agent it can reach through handoffs.
 */
export interface AgentWireConfig extends AgentWireAgent {
  /** The agents reachable through `handoffs` other than this one, by name */
  handoffAgents?: Record<string, AgentWireAgent>;
}

/** What a run used and cost, as `RunResult.usage` reports it. */
export interface AgentWireUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** USD: what the provider reported, else the model registry's price, else 0 */
  cost: number;
  /** Run duration in ms */
  duration?: number;
  /** Hidden reasoning tokens; already counted in `outputTokens` */
  reasoningTokens?: number;
  /** Input tokens served from the prompt cache; already counted in `inputTokens` */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache; already counted in `inputTokens` */
  cacheWriteTokens?: number;
}

/** A tool call of a run on the wire, with what the tool returned. */
export interface AgentWireToolCall {
  /** The tool call's id, when the sender reports it */
  id?: string;
  name: string;
  input: unknown;
  output: unknown;
}

/**
 * The outcome of an agent run on the wire: the parts of `RunResult` a caller acts on, as plain
 * JSON. The conversation and trace stay with the process that ran the agent.
 */
export interface AgentWireRunResult {
  output: string;
  /** The validated answer of an agent with a JSON schema response format, when it fits */
  structured?: unknown;
  /** Why the answer does not match the response format, see `RunResult.structuredError` */
  structuredError?: string;
  /** The model's reasoning summary, when the agent asked for one */
  reasoning?: string;
  usage: AgentWireUsage;
  toolCalls: AgentWireToolCall[];
  /** The last answer stopped at the output token limit, see `RunResult.truncated` */
  truncated?: boolean;
  /** The last answer was withheld, see `RunResult.blocked` */
  blocked?: RunBlockReason;
  /** Tool calls used up `maxIterations`, see `RunResult.iterationLimitReached` */
  iterationLimitReached?: boolean;
  /** The model the run used, when cost routing picked another one */
  modelUsed?: string;
  /** Handoffs during the run, in order */
  handoffs?: HandoffEvent[];
  /** The agent that answered, when the run handed the conversation over */
  finalAgent?: string;
  runId?: string;
  threadId?: string;
}
