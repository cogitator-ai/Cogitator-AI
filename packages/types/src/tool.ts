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

/**
 * A tool result that carries media, built with `toolContent()` from `@cogitator-ai/core`.
 *
 * `text` and `image` parts reach the model as the content of the tool message, an image as an
 * image part, so a vision model sees it instead of its base64 text. `file` parts (audio, PDFs and
 * other binary data) stay with the result for the application, in `onToolResult` and
 * `RunResult`, and reach the model only as a short description, so their bytes never fill the
 * context.
 */
export interface ToolContentResult {
  type: 'tool-content';
  content: ToolContentPart[];
}

export type ToolContentPart = ToolTextPart | ToolImagePart | ToolFilePart;

export interface ToolTextPart {
  type: 'text';
  text: string;
}

export interface ToolImagePart {
  type: 'image';
  /** Base64 data, without a `data:` URL prefix */
  data: string;
  /** IANA media type, such as `image/png` */
  mediaType: string;
}

export interface ToolFilePart {
  type: 'file';
  /** Base64 data, without a `data:` URL prefix */
  data: string;
  /** IANA media type, such as `audio/mpeg` */
  mediaType: string;
  filename?: string;
}
