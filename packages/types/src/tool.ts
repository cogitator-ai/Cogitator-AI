/**
 * Tool types for agent capabilities
 */

import type { ZodType } from 'zod';
import type { SandboxConfig } from './sandbox';

export type ToolCategory =
  | 'math'
  | 'text'
  | 'file'
  | 'network'
  | 'system'
  | 'utility'
  | 'web'
  | 'database'
  | 'communication'
  | 'development';

export type SideEffectType = 'filesystem' | 'network' | 'database' | 'process' | 'external';

export interface ToolConfig<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  category?: ToolCategory;
  tags?: string[];
  parameters: ZodType<TParams>;
  execute: (params: TParams, context: ToolContext) => Promise<TResult>;
  sideEffects?: SideEffectType[];
  requiresApproval?: boolean | ((params: TParams) => boolean);
  timeout?: number;
  sandbox?: SandboxConfig;
}

export interface Tool<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  category?: ToolCategory;
  tags?: string[];
  parameters: ZodType<TParams>;
  execute(params: TParams, context: ToolContext): Promise<TResult>;
  sideEffects?: SideEffectType[];
  requiresApproval?: boolean | ApprovalCheck;
  timeout?: number;
  sandbox?: SandboxConfig;
  toJSON(): ToolSchema;
}

export type ApprovalCheck = (params: Record<string, unknown>) => boolean;

export interface ToolContext {
  agentId: string;
  runId: string;
  signal: AbortSignal;
  /** Id of the tool call being executed, when the runtime runs it (a run or `invokeTool`) */
  toolCallId?: string;
  threadId?: string;
  userId?: string;
  channelType?: string;
  channelId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

/**
 * The JSON Schema of a tool's parameters: an object schema, self-contained. Definitions that
 * recursive `$ref`s point to travel in `$defs` (refs as `#/$defs/<name>`), other refs are inlined.
 * Other JSON Schema keywords of the object (`additionalProperties`, `description`...) are kept.
 */
export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  $defs?: Record<string, unknown>;
  [keyword: string]: unknown;
}
