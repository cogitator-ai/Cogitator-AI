/**
 * Tool types for agent capabilities
 */

import type { ZodType } from 'zod';
import type { SandboxConfig } from './sandbox';
import type { Workspace } from './workspace';
import type { InterruptRequest } from './run-control';
import type { ToolPermissionsView } from './permissions';
import type { ToolDelegationContext } from './subagents';

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
   * Schema of the tool's result, the `content` of a `toolOutput()` result. Nothing checks it in a
   * run, it describes what the model reads: an MCP server advertises it and returns that as
   * `structuredContent`, tools imported from an MCP server get the server's output schema here
   */
  outputSchema?: ZodType<ToolOutputContent<TResult>>;
  /** How the tool behaves, as MCP tool annotations describe it */
  annotations?: ToolAnnotations;
  /**
   * Runs the tool. Annotate `context` as `ToolContext<YourDeps>` to read the run's `deps`, typed:
   * the agent then accepts the tool only when its own deps type provides them
   */
  execute: (params: TParams, context: ToolContext<TDeps>) => Promise<TResult>;
  sideEffects?: SideEffectType[];
  requiresApproval?: boolean | ((params: TParams) => boolean);
  /**
   * What a call reads, edits or runs, for permission rules and modes: `Read(src/**)` and
   * `Edit(src/**)` rules match the paths of `read` and `edit` tools, `Bash(git push *)` rules the
   * command of `command` tools, `acceptEdits` mode lets edits inside the workspace run and `plan`
   * mode refuses edits. A tool without it is matched by name only
   */
  access?: ToolAccess<TParams>;
  /** The MCP server tool this tool calls, so `mcp__<server>__<tool>` rules match it */
  mcp?: ToolMcpOrigin;
  /**
   * The interactive app (an MCP App) a host shows for this tool's calls: an MCP server serves it
   * with the tool, and a tool from an MCP server that has one carries it here
   */
  app?: ToolApp;
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
   * one after another in the order they asked. A call run inside a call that holds a key, such as
   * a tool of an agent the tool runs, takes that key again without waiting. The keys are let go
   * once the tool's own promise settles, also after it timed out
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
  /** A call of this tool the model began to write will not run, in a run with `stream: true` */
  onInputAbandoned?: (event: ToolInputAbandoned) => void;
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
   * Schema of the tool's result, the `content` of a `toolOutput()` result. Nothing checks it in a
   * run, it describes what the model reads: an MCP server advertises it and returns that as
   * `structuredContent`, tools imported from an MCP server get the server's output schema here
   */
  outputSchema?: ZodType<ToolOutputContent<TResult>>;
  /** How the tool behaves, as MCP tool annotations describe it */
  annotations?: ToolAnnotations;
  execute(params: TParams, context: BaseToolContext<TDeps>): Promise<TResult>;
  sideEffects?: SideEffectType[];
  requiresApproval?: boolean | ApprovalCheck;
  /** What a call reads, edits or runs, see `ToolConfig.access` */
  access?: ToolAccess<TParams>;
  /** The MCP server tool this tool calls, see `ToolConfig.mcp` */
  mcp?: ToolMcpOrigin;
  /** The interactive app a host shows for this tool's calls, see `ToolConfig.app` */
  app?: ToolApp;
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
  isConcurrencySafe?: boolean | ToolCallCheck<TParams>;
  /** Keys of what a call changes, see `ToolConfig.lockKeys` */
  lockKeys?(
    params: TParams,
    context: BaseToolContext<TDeps>
  ): readonly string[] | Promise<readonly string[]>;
  /** How clients show a call of the tool, see `ToolConfig.presentation` */
  presentation?: ToolPresentation | ToolPresenter<TParams>;
  onInputStart?(event: ToolInputStart): void;
  onInputDelta?(event: ToolInputDelta): void;
  onInputAvailable?(event: ToolInputAvailable): void;
  onInputAbandoned?(event: ToolInputAbandoned): void;
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

/**
 * What a tool's calls touch, for permission rules:
 * - `read` tools read the paths `paths` gives, `edit` tools change them (paths as the call names
 *   them: relative to the workspace root, or absolute)
 * - `command` tools run the shell command `command` gives, in the directory `cwd` gives (relative
 *   to the workspace root, default its current directory) with the variables `env` gives
 * - `fetch` tools fetch the URL `url` gives (`WebFetch(domain:...)` rules), `search` tools search
 *   the web (`WebSearch`), `agent` tools hand a task to the agent named `agent` (`Agent(...)`)
 *
 * The functions get the arguments as the tool's schema read them
 */
export interface ToolAccess<TParams = unknown> {
  kind: 'read' | 'edit' | 'command' | 'fetch' | 'search' | 'agent';
  paths?(params: TParams): readonly string[];
  /**
   * Whether the call reads or changes everything under its paths (a recursive delete or
   * listing), so a path rule for anything inside them applies to the call
   */
  subtree?(params: TParams): boolean;
  command?(params: TParams): string | undefined;
  cwd?(params: TParams): string | undefined;
  env?(params: TParams): Readonly<Record<string, string>> | undefined;
  url?(params: TParams): string | undefined;
  /**
   * The name of the agent an `agent` tool hands its task to, or how to read it from the call, for
   * a tool that delegates to the agent its arguments name, so an `Agent(name)` rule matches
   */
  agent?: string | ToolAgentOf<TParams>;
}

/** Reads the name of the agent a call delegates to from its arguments, see `ToolAccess.agent` */
export type ToolAgentOf<TParams = unknown> = {
  agentOf(params: TParams): string | undefined;
}['agentOf'];

/** Who may call a tool that has an app: the agent (`model`), its app (`app`) */
export type ToolAppVisibility = 'model' | 'app';

/**
 * The origins an app may reach, as the MCP Apps extension declares them (`_meta.ui.csp`). A host
 * builds the Content Security Policy of the app from them, and reaches nothing else
 */
export interface ToolAppCsp {
  /** Origins of `fetch`, XHR and WebSocket (`connect-src`) */
  connectDomains?: string[];
  /** Origins of scripts, styles, images, fonts and media */
  resourceDomains?: string[];
  /** Origins of frames the app nests (`frame-src`), none when left out */
  frameDomains?: string[];
  /** Origins the app's `<base>` may name (`base-uri`) */
  baseUriDomains?: string[];
}

/** The browser features an app asks for, a host may grant (`_meta.ui.permissions`) */
export interface ToolAppPermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

/** An app as a host renders it: its HTML and what it asks of the host */
export interface ToolAppResource {
  /** The `ui://` URI of the app */
  uri: string;
  /** `text/html;profile=mcp-app` */
  mimeType: string;
  html: string;
  csp?: ToolAppCsp;
  permissions?: ToolAppPermissions;
  /** A dedicated origin the app asks for, as its host understands it */
  domain?: string;
  /** Whether the app wants the host to draw a border and background around it */
  prefersBorder?: boolean;
}

/** What a tool call an app made returned, as an MCP `CallToolResult` */
export interface ToolAppCallResult {
  content: Array<{ type: string } & Record<string, unknown>>;
  /** The tool's structured result: an object, or `{ result: value }` for any other JSON value */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * The interactive app of a tool (an MCP App, extension `io.modelcontextprotocol/ui`): an HTML page
 * a host shows in a sandboxed frame for the tool's calls, given the call's arguments and result
 */
export interface ToolApp {
  /** The `ui://` resource of the app */
  resourceUri: string;
  /** Who may call the tool, both by default. A tool visible to `app` only is not offered to the model */
  visibility?: readonly ToolAppVisibility[];
  /** Reads the app: its HTML, and the origins and features it asks for */
  read(): Promise<ToolAppResource>;
  /**
   * Calls a tool for the app, on the server the app came from: only a tool visible to apps.
   * Absent when the app may call no tools
   */
  callTool?(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<ToolAppCallResult>;
  /** Whether a tool the app calls needs a person's approval before it runs, such as a destructive one */
  requiresApproval?(name: string): Promise<boolean>;
}

/** An MCP server's tool, by the server's name and the tool's name there */
export interface ToolMcpOrigin {
  /** The server's name, `''` for a server that reports none */
  server: string;
  tool: string;
}

/**
 * What the model reads of a tool's result `TResult`: the `content` of a `toolOutput()` result,
 * any other result as it is. A tool's `outputSchema` describes this
 */
export type ToolOutputContent<TResult> =
  TResult extends ToolOutputResult<infer TContent, unknown> ? TContent : TResult;

/** A check of a call's arguments, as the tool's schema read them */
export type ToolCallCheck<TParams = unknown> = {
  check(params: TParams): boolean;
}['check'];

/** The presentation of a call, from its arguments as the tool's schema read them */
export type ToolPresenter<TParams = unknown> = {
  present(params: TParams): ToolPresentation;
}['present'];

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

/**
 * Structured data a tool sends its run's client with `context.data()`, for the client to render as
 * a widget of its own, such as a chart or a status card
 */
export interface DataPart {
  /**
   * Names the part: a part sent again with the same id replaces the one sent before, so a tool
   * updates a widget in place. A new id when left out
   */
  id?: string;
  /** What kind of data it is, such as `weather`, for the client to pick how it renders it */
  name: string;
  /** The data, any JSON value */
  data: unknown;
  /** Shown while the run streams only: never kept with the messages of the conversation */
  transient?: boolean;
}

/** A data part as the run reports it to `RunOptions.onData`: with its id and the call that sent it */
export interface RunDataPart extends DataPart {
  id: string;
  toolCallId?: string;
  toolName?: string;
}

/** The run's state, as a tool reads and replaces it, see `RunOptions.state` */
export interface RunStateAccess {
  /** A copy of the state: change it and `set()` it to change the run's */
  get(): unknown;
  /** Replaces the state with a copy of `state`: the run reports it to `RunOptions.onState` */
  set(state: unknown): void;
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

/**
 * A tool call the model began to write that will not run: `incomplete` when its arguments never
 * came complete, `discarded` when they did and the turn did not keep the call
 */
export interface ToolInputAbandoned {
  toolCallId: string;
  toolName: string;
  reason: 'incomplete' | 'discarded';
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
  /**
   * Sends the run's client a data part: structured data it renders as a widget of its own. Send
   * it again with the id this returns to replace it in place. The run hands it to `onData` and a
   * server streams it as `data`. Nothing of it reaches the model or memory. Present in a run
   */
  data?: (part: DataPart) => string;
  /**
   * The run's state, shared with its client (`RunOptions.state`): a tool reads it with `get()`
   * and replaces it with `set()`, the run hands each change to `onState` and a server streams it
   * as a JSON Patch. Present in a run
   */
  state?: RunStateAccess;
  /**
   * The run's permission mode and `session` rules, when the run has permissions set up, so a tool
   * that starts a run of its own (an agent as a tool) holds it to the same rules
   */
  permissions?: ToolPermissionsView;
  /**
   * What a tool that runs another agent needs from its run: the conversation, the run's approval
   * decider and, when the run resumes, the delegate the call left paused. Present in a run
   */
  delegation?: ToolDelegationContext;
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
  /**
   * JSON Schema of the tool's result (`Tool.outputSchema`), any shape. Gemini takes it as the
   * function's `responseJsonSchema`, other providers have no place for it and do not get it
   * unless `llm.toolOutputSchemas` is `description`
   */
  outputSchema?: Record<string, unknown>;
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
