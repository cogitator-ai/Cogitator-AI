/**
 * Agent types
 */

import type { Tool } from './tool';
import type { Skill } from './skill';
import type { ZodType } from 'zod';
import type { ReasoningConfig } from './llm';

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  /** Explicit provider override (e.g., 'openai' for OpenRouter) */
  provider?: string;
  /** `provider/model`. Falls back to `llm.defaultModel` of the Cogitator that runs the agent. */
  model?: string;
  instructions: string;
  tools?: Tool[];
  skills?: Skill[];
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
}

export interface Handoff {
  agent: Agent;
  /** Tool name instead of `transfer_to_<agent name>` */
  toolName?: string;
  /** When to hand over, for the model; defaults to the agent's description */
  description?: string;
}

export type ResponseFormat =
  { type: 'text' } | { type: 'json' } | { type: 'json_schema'; schema: ZodType };

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;
  /** Model accessor (shortcut to config.model) */
  readonly model: string | undefined;
  /** Instructions accessor (shortcut to config.instructions) */
  readonly instructions: string;
  /** Tools accessor (shortcut to config.tools) */
  readonly tools: Tool[];
  clone(overrides: Partial<AgentConfig>): Agent;
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
}

export interface DeserializeOptions {
  toolRegistry?: { get(name: string): Tool | undefined };
  tools?: Tool[];
  overrides?: Partial<AgentConfig>;
}
