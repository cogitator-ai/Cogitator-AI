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

export interface ToolConfig<TParams = unknown, TResult = unknown, TDeps = unknown> {
  name: string;
  /** Name of the tool for people, such as an MCP client shows (the model sees `name`) */
  title?: string;
  description: string;
  category?: ToolCategory;
  tags?: string[];
  parameters: ZodType<TParams>;
  /**
   * Schema of the tool's result. Nothing checks it in a run, it describes the result: an MCP
   * server advertises it and returns the result as `structuredContent`, tools imported from an
   * MCP server get the server's output schema here
   */
  outputSchema?: ZodType<TResult>;
  /** How the tool behaves, as MCP tool annotations describe it */
  annotations?: ToolAnnotations;
  /**
   * Runs the tool. Annotate `context` as `ToolContext<YourDeps>` to read the run's `deps`, typed:
   * the agent then accepts the tool only when its own deps type provides them
   */
  execute: (params: TParams, context: ToolContext<TDeps>) => Promise<TResult>;
  sideEffects?: SideEffectType[];
  requiresApproval?: boolean | ((params: TParams) => boolean);
  timeout?: number;
  sandbox?: SandboxConfig;
  /**
   * Most characters of this tool's result the model reads, overriding
   * `limits.maxToolResultLength` (default 100 000). A longer result is cut in the middle, with a
   * note of how much was left out. `onToolResult` still gets the whole result.
   */
  maxResultLength?: number;
  /**
   * The tool's type in a provider's own catalog, sent to that provider instead of the tool's
   * schema, such as `{ anthropic: 'memory_20250818' }`: the model knows the tool from its
   * training, and every other provider gets the schema as usual
   */
  providerTypes?: ProviderToolTypes;
}

export interface Tool<TParams = unknown, TResult = unknown, TDeps = unknown> {
  name: string;
  /** Name of the tool for people, such as an MCP client shows (the model sees `name`) */
  title?: string;
  description: string;
  category?: ToolCategory;
  tags?: string[];
  parameters: ZodType<TParams>;
  /**
   * Schema of the tool's result. Nothing checks it in a run, it describes the result: an MCP
   * server advertises it and returns the result as `structuredContent`, tools imported from an
   * MCP server get the server's output schema here
   */
  outputSchema?: ZodType<TResult>;
  /** How the tool behaves, as MCP tool annotations describe it */
  annotations?: ToolAnnotations;
  execute(params: TParams, context: BaseToolContext<TDeps>): Promise<TResult>;
  sideEffects?: SideEffectType[];
  requiresApproval?: boolean | ApprovalCheck;
  timeout?: number;
  sandbox?: SandboxConfig;
  /**
   * Most characters of this tool's result the model reads, overriding
   * `limits.maxToolResultLength` (default 100 000). A longer result is cut in the middle, with a
   * note of how much was left out. `onToolResult` still gets the whole result.
   */
  maxResultLength?: number;
  /**
   * The tool's type in a provider's own catalog, sent to that provider instead of the tool's
   * schema, such as `{ anthropic: 'memory_20250818' }`: the model knows the tool from its
   * training, and every other provider gets the schema as usual
   */
  providerTypes?: ProviderToolTypes;
  toJSON(): ToolSchema;
}

/** Types a tool has in providers' own tool catalogs, by provider */
export interface ProviderToolTypes {
  /** An Anthropic tool type, such as `memory_20250818` */
  anthropic?: string;
}

/**
 * Hints about how a tool behaves, the MCP `ToolAnnotations` without `title` (see `Tool.title`).
 * An MCP server exports them with the tool, and tools imported from an MCP server carry the
 * server's hints, which are only as trustworthy as the server.
 */
export interface ToolAnnotations {
  /** The tool does not change its environment (default false) */
  readOnlyHint?: boolean;
  /**
   * The tool may make destructive updates, not only additive ones. Meaningful only when
   * `readOnlyHint` is false (MCP default: true)
   */
  destructiveHint?: boolean;
  /** Calling the tool again with the same arguments has no further effect (default false) */
  idempotentHint?: boolean;
  /** The tool reaches an open world of external entities, such as the web (default true) */
  openWorldHint?: boolean;
}

export type ApprovalCheck = (params: Record<string, unknown>) => boolean;

/** What a tool call runs with, whether or not the tool reads the run's `deps`. */
export interface BaseToolContext<TDeps = unknown> {
  agentId: string;
  runId: string;
  signal: AbortSignal;
  /** Id of the tool call being executed, when the runtime runs it (a run or `invokeTool`) */
  toolCallId?: string;
  threadId?: string;
  userId?: string;
  channelType?: string;
  channelId?: string;
  /** The topic of the chat the run serves (`ChannelMessage.topicId`) */
  topicId?: string;
  /** The conversation the run serves (`ChannelMessage.conversationId`) */
  conversationId?: string;
  /**
   * The run's `deps` (`RunOptions.deps`): your own values, such as a database client or the
   * signed-in user, for tools to use. They never reach the model, the run checkpoint, spans or
   * memory, so a resumed run passes them again
   */
  deps?: TDeps;
}

/**
 * The context a tool runs with. `ToolContext<Deps>` has the run's `deps` typed and present: a
 * tool that reads them annotates its `context` so, and agents typed with their deps
 * (`new Agent<Deps>(...)`) only accept tools whose deps they provide.
 */
export type ToolContext<TDeps = unknown> = unknown extends TDeps
  ? BaseToolContext
  : BaseToolContext<TDeps> & { deps: TDeps };

export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  /** The tool's type in a provider's own catalog, sent to that provider instead of `parameters` */
  providerTypes?: ProviderToolTypes;
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
 * image part, so a vision model sees it instead of its base64 text. `json` parts reach it as JSON
 * text and `resource` parts as their text, or a line naming the resource. `file` parts (audio,
 * PDFs and other binary data) and binary resources stay with the result for the application, in
 * `onToolResult`, and reach the model only as a short description, so their bytes never fill the
 * context.
 */
export interface ToolContentResult {
  type: 'tool-content';
  content: ToolContentPart[];
}

export type ToolContentPart =
  ToolTextPart | ToolImagePart | ToolFilePart | ToolJsonPart | ToolResourcePart;

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

/** Structured data: the application gets the value as it is, the model reads it as JSON. */
export interface ToolJsonPart {
  type: 'json';
  /** A JSON-serializable value */
  value: unknown;
}

/**
 * A resource the tool read or points to, named by its URI: a file, a document, a web page. With
 * `text` the model reads the contents, with `data` (binary contents) it reads a description and
 * the application gets the bytes, with neither it reads a line naming the resource. At most one
 * of `text` and `data` is set.
 */
export interface ToolResourcePart {
  type: 'resource';
  /** URI of the resource, such as `file:///repo/README.md` or `https://example.com/report` */
  uri: string;
  /** Name for people, such as `README.md` */
  name?: string;
  /** What the resource is, shown to the model next to its URI */
  description?: string;
  /** IANA media type, such as `text/markdown` */
  mediaType?: string;
  /** Text contents */
  text?: string;
  /** Base64 binary contents, without a `data:` URL prefix */
  data?: string;
}
