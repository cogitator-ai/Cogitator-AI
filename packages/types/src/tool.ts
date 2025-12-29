/**
 * Tool types for agent capabilities
 */

import type { ZodType } from 'zod';

export interface ToolConfig<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: ZodType<TParams>;
  execute: (params: TParams, context: ToolContext) => Promise<TResult>;
  sideEffects?: Array<'filesystem' | 'network' | 'database' | 'process'>;
  requiresApproval?: boolean | ((params: TParams) => boolean);
  timeout?: number;
}

export interface Tool<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: ZodType<TParams>;
  execute: (params: TParams, context: ToolContext) => Promise<TResult>;
  sideEffects?: Array<'filesystem' | 'network' | 'database' | 'process'>;
  requiresApproval?: boolean | ((params: TParams) => boolean);
  timeout?: number;
  toJSON: () => ToolSchema;
}

export interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
