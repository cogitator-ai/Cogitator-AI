/**
 * Agent types
 */

import type { Tool } from './tool';
import type { ZodType } from 'zod';

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
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
}
