/**
 * Agent types
 */

import type { Tool } from './tool';
import type { AgentSkillSource } from './skill';
import type { ZodType } from 'zod';
import type { ReasoningConfig } from './llm';
import type { RunMiddleware } from './middleware';
import type { Workspace } from './workspace';

/**
 * An agent's configuration. `TDeps` is the type of the `deps` its runs pass (`RunOptions.deps`):
 * with it set, runs must pass them and tools with an unrelated deps type are refused.
 */
export interface AgentConfig<TDeps = unknown> {
  id?: string;
  name: string;
  description?: string;
  /** Explicit provider override (e.g., 'openai' for OpenRouter) */
  provider?: string;
  /** `provider/model`. Falls back to `llm.defaultModel` of the Cogitator that runs the agent. */
  model?: string;
  /**
   * Models a turn moves to, in order, when `model` fails in a way another model may not: the
   * provider is down, overloaded or timing out once its retries are spent (`llm.retry`), the
   * account is out of quota, the key is rejected, the model is gone, the prompt does not fit
   * its context window, or its answer could not be read. A request the provider refuses as such
   * (`content_filter`, `invalid_request`) and an aborted run do not move. A model that keeps
   * failing is skipped for a while (`llm.modelCircuitBreaker`). Each turn starts again from
   * `model`, `RunOptions.onModelFallback` reports every move, and a run whose models all failed
   * ends with `LLM_UNAVAILABLE` (or the error code every model failed with), the failures in
   * `details.attempts`.
   */
  fallbackModels?: FallbackModel[];
  instructions: string;
  tools?: Tool<unknown, unknown, TDeps>[];
  /**
   * Skills of the agent. A skill defined in code (`defineSkill`) joins its tools and instructions
   * to the agent's. A source of `SKILL.md` skills (a `SkillRegistry`, or the configuration of one)
   * is searched when a run starts: the model sees each skill's name and description in the
   * system prompt and loads one with the built-in `use_skill` tool when a task needs it
   */
  skills?: AgentSkillSource[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: ResponseFormat;
  /** Reasoning effort and summaries for reasoning models */
  reasoning?: ReasoningConfig;
  /**
   * Agents this one can hand the conversation over to. Each becomes a
   * `transfer_to_<name>` tool; when the model calls it, the rest of the run
   * goes on as that agent, with the whole conversation.
   */
  handoffs?: Array<Agent | Handoff>;
  maxIterations?: number;
  /**
   * What happens when tool calls use up `maxIterations` before the model answers. `answer`
   * (default): the model gets one more turn, without tools, to answer with what it has, so the
   * run ends with an answer and structured output can still be parsed. `stop`: the run ends at
   * the last tool turn, with no answer. Either way `RunResult.iterationLimitReached` is set.
   */
  onIterationLimit?: 'answer' | 'stop';
  timeout?: number;
  /**
   * Gives the model the built-in `write_todos` tool, to plan a long task as a todo list and keep
   * it current: each call replaces the list, with at most one item in progress. The list is kept
   * in the thread's metadata (`todos`) across runs and compaction, reported with
   * `RunOptions.onTodos` and returned as `RunResult.todos` (default false)
   */
  todos?: boolean;
  /**
   * Hooks around this agent's model and tool calls, after the Cogitator's middleware and
   * before the run's (see `RunMiddleware`). After a handoff, the agent the run went on as
   * brings its own.
   */
  middleware?: RunMiddleware<TDeps>[];
  /**
   * The directory this agent's tools work in: they get it as `context.workspace`, and a tool
   * result too long for the model is saved there in full. `RunOptions.workspace` wins over it.
   * The agent only uses it: whoever created the workspace starts and disposes it
   */
  workspace?: Workspace;
}

/** A model to fall back to: `provider/model`, or a model name with the provider to run it on. */
export type FallbackModel = string | { model: string; provider?: string };

export interface Handoff {
  agent: Agent;
  /** Tool name instead of `transfer_to_<agent name>` */
  toolName?: string;
  /** When to hand over, for the model; defaults to the agent's description */
  description?: string;
}

export type ResponseFormat =
  { type: 'text' } | { type: 'json' } | { type: 'json_schema'; schema: ZodType };

export interface Agent<TDeps = unknown> {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig<TDeps>;
  /** Model accessor (shortcut to config.model) */
  readonly model: string | undefined;
  /** Instructions accessor (shortcut to config.instructions) */
  readonly instructions: string;
  /** Tools accessor (shortcut to config.tools) */
  readonly tools: Tool<unknown, unknown, TDeps>[];
  clone(overrides: Partial<AgentConfig<TDeps>>): Agent<TDeps>;
  serialize(): AgentSnapshot;
}

export interface AgentSnapshot {
  version: string;
  id: string;
  name: string;
  config: SerializedAgentConfig;
  metadata?: AgentSnapshotMetadata;
}

export interface AgentSnapshotMetadata {
  createdAt?: string;
  serializedAt: string;
  description?: string;
}

export interface SerializedAgentConfig {
  model?: string;
  provider?: string;
  fallbackModels?: FallbackModel[];
  instructions: string;
  tools: string[];
  description?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?:
    { type: 'text' } | { type: 'json' } | { type: 'json_schema'; schemaName: string };
  reasoning?: ReasoningConfig;
  maxIterations?: number;
  onIterationLimit?: 'answer' | 'stop';
  timeout?: number;
  todos?: boolean;
}

export interface DeserializeOptions {
  toolRegistry?: { get(name: string): Tool | undefined };
  tools?: Tool[];
  overrides?: Partial<AgentConfig>;
}
