/**
 * Tool types for agent capabilities
 */

import type { ZodType } from 'zod';
import type { SandboxConfig } from './sandbox';
import type { Workspace } from './workspace';
import type { InterruptRequest } from './run-control';

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
  /**
   * Keep the tool's schema out of the model's requests until the model finds it with the built-in
   * `tool_search` tool, which a run offers while it has deferred tools. Found tools are sent from
   * the next model turn on. For agents with many tools, most of them rarely needed: their schemas
   * cost no context until used. A call to a deferred tool that was not loaded yet still runs
   */
  deferred?: boolean;
  /**
   * Whether a call of the tool may run at the same time as other such calls of its step, when the
   * run schedules them (`RunOptions.parallelToolCalls: true`): `true`, or a check of the call's
   * arguments. A call that is not safe waits for every call before it and runs alone, the calls
   * after it wait for it. Default: `annotations.readOnlyHint`, so a tool that declares neither runs
   * alone. A check that throws counts as not safe
   */
  isConcurrencySafe?: boolean | ((params: TParams) => boolean);
  /**
   * Keys of what a call changes, such as `await fileLockKey(path)` for a file it writes: calls
   * whose keys meet never run at the same time, in this run or any other of the process, and go
   * one after another in the order they asked. A tool that runs another agent must not hold a key
   * that agent's tools take, or the two wait on each other
   */
  lockKeys?: (
    params: TParams,
    context: ToolContext<TDeps>
  ) => readonly string[] | Promise<readonly string[]>;
  /**
   * How clients show a call of the tool, saved with its result so a client draws the row without
   * the tool's code: a value, or one made from the call's arguments. A result made with
   * `toolOutput({ presentation })` wins over it
   */
  presentation?: ToolPresentation | ((params: TParams) => ToolPresentation);
  /** The model began to write a call of this tool, in a run with `stream: true` */
  onInputStart?: (event: ToolInputStart) => void;
  /** The next piece of the JSON arguments of a call the model writes, in a run with `stream: true` */
  onInputDelta?: (event: ToolInputDelta) => void;
  /** The model finished a call of this tool and its arguments are read, in a run with `stream: true` */
  onInputAvailable?: (event: ToolInputAvailable) => void;
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
  /**
   * Keep the tool's schema out of the model's requests until the model finds it with the built-in
   * `tool_search` tool, which a run offers while it has deferred tools. Found tools are sent from
   * the next model turn on. For agents with many tools, most of them rarely needed: their schemas
   * cost no context until used. A call to a deferred tool that was not loaded yet still runs
   */
  deferred?: boolean;
  /** Whether a call may run beside other safe calls of its step, see `ToolConfig.isConcurrencySafe` */
  isConcurrencySafe?: boolean | ToolCallCheck;
  /** Keys of what a call changes, see `ToolConfig.lockKeys` */
  lockKeys?(
    params: TParams,
    context: BaseToolContext<TDeps>
  ): readonly string[] | Promise<readonly string[]>;
  /** How clients show a call of the tool, see `ToolConfig.presentation` */
  presentation?: ToolPresentation | ToolPresenter;
  onInputStart?(event: ToolInputStart): void;
  onInputDelta?(event: ToolInputDelta): void;
  onInputAvailable?(event: ToolInputAvailable): void;
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

/** A check of a call's arguments, as the model sent them */
export type ToolCallCheck = (params: Record<string, unknown>) => boolean;

/** The presentation of a call, from its arguments as the model sent them */
export type ToolPresenter = (params: Record<string, unknown>) => ToolPresentation;

/**
 * How a client shows a tool call in a list of steps, without the tool's code: a label, an icon
 * and one line about the call. A run saves it with the call's result (`metadata.presentation` of
 * the `tool_result` entry) and reports it in `onToolResult` and `onToolUpdate`.
 */
export interface ToolPresentation {
  /** What the call does, for people, such as `Edit file` */
  label: string;
  /** Name of an icon the client knows, such as `file-pen` (Lucide names by convention) */
  icon?: string;
  /** One line about this call, such as the path it edits */
  detail?: string;
}

/**
 * A tool result whose parts go to different readers, built with `toolOutput()` from
 * `@cogitator-ai/core`: the model reads `content`, the application and its UI get `details` and
 * `presentation` too. A run saves `details` and `presentation` in the metadata of the call's
 * `tool_result` entry, never in what the model reads.
 */
export interface ToolOutputResult<TContent = unknown, TDetails = unknown> {
  type: 'tool-output';
  /** What the model reads: any JSON value, or a `toolContent()` result */
  content: TContent;
  /** Data for the application only, such as a diff or a row count: never sent to the model */
  details?: TDetails;
  /** How to show this call, instead of the tool's `presentation` */
  presentation?: ToolPresentation;
}

/** What a running tool has so far, reported with `context.update()` */
export interface ToolProgress {
  /** The result so far, in the shape of `content` */
  content?: unknown;
  details?: unknown;
  presentation?: ToolPresentation;
}

/** The model began to write a tool call */
export interface ToolInputStart {
  toolCallId: string;
  toolName: string;
}

/** The next piece of the JSON arguments of a tool call the model writes */
export interface ToolInputDelta {
  toolCallId: string;
  toolName: string;
  /** The text that follows what came before, not valid JSON on its own */
  delta: string;
}

/** The model finished a tool call and its arguments are read */
export interface ToolInputAvailable {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

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
  /**
   * The workspace of the run (`RunOptions.workspace`, else the agent's `workspace`), for tools
   * that read, write or run commands in it, see `workspaceTools()`
   */
  workspace?: Workspace;
  /**
   * Pauses the run to ask a person, the way an approval does: the run returns with
   * `status: 'paused'` and the question in `interrupts`, and goes on once `cogitator.resume()`
   * answers it (`responses`). The tool then runs again from its start, and this call returns the
   * answer, parsed by a Zod `responseSchema`. So keep what the tool does before asking safe to
   * do twice. A tool may ask several times, each answer comes back in order. Present in a run,
   * not in `invokeTool()` or a sandboxed tool
   */
  interrupt?: <T = unknown>(request: InterruptRequest<T>) => Promise<T>;
  /**
   * Reports what the tool has so far while it runs, such as lines of a command's output or the
   * rows found: the run hands it to `onToolUpdate` and a server streams it as `tool-update`.
   * Nothing of it reaches the model or memory, the tool's result does. Present in a run and in
   * `invokeTool()`
   */
  update?: (progress: ToolProgress) => void;
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
