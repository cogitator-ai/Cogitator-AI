/**
 * Agent types
 */

import type { Tool } from './tool.js';
import type { ZodType } from 'zod';

export interface AgentConfig {
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
  clone(overrides: Partial<AgentConfig>): Agent;
}
