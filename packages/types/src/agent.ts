/**
 * Agent types
 */

import type { Tool } from './tool';
import type { ZodType } from 'zod';

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  /** Explicit provider override (e.g., 'openai' for OpenRouter) */
  provider?: string;
  model: string;
  instructions: string;
  tools?: Tool[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: ResponseFormat;
  maxIterations?: number;
  timeout?: number;
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; schema: ZodType };

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;
  /** Model accessor (shortcut to config.model) */
  readonly model: string;
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
  model: string;
  provider?: string;
  instructions: string;
  tools: string[];
  description?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  maxIterations?: number;
  timeout?: number;
}

export interface DeserializeOptions {
  toolRegistry?: { get(name: string): Tool | undefined };
  tools?: Tool[];
  overrides?: Partial<AgentConfig>;
}
