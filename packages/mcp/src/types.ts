/**
 * MCP Integration Types
 */

import type { MCPToolAppRef } from './apps';
import type { IncomingMessage } from 'node:http';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import type { ToolContext, ToolInvoker } from '@cogitator-ai/types';

export type MCPTransportType = 'stdio' | 'http' | 'sse';

/**
 * How a client reaches a server: a {@link MCPTransportType} (`sse` being Streamable HTTP, as the
 * server serves it), or `legacy-sse` for a server of the older HTTP+SSE protocol, which opens an
 * event stream with a GET and takes messages in POSTs (`type: "sse"` of a `.mcp.json`)
 */
export type MCPClientTransportType = MCPTransportType | 'legacy-sse';

export interface MCPRetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial delay in ms before first retry (default: 1000) */
  initialDelay?: number;

  /** Maximum delay in ms between retries (default: 30000) */
  maxDelay?: number;

  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;

  /** Whether to retry on connection loss (default: true) */
  retryOnConnectionLoss?: boolean;
}

/**
 * Which MCP protocol revision a client speaks: `auto` asks the server with `server/discover` and
 * speaks 2026-07-28 to a server that answers, 2025-11-25 (`initialize`) to any other. `legacy`
 * always speaks 2025-11-25, `{ pin }` only the pinned 2026-era revision
 */
export type MCPProtocolMode = 'auto' | 'legacy' | { pin: string };

/** Which revision the client and the server agreed on: 2026-07-28 and later, or an earlier one */
export type MCPProtocolEra = 'modern' | 'legacy';

/** What the server needs a person at the client to open: a page outside MCP, such as a sign-in */
export interface MCPElicitUrlRequest {
  mode: 'url';
  message: string;
  url: string;
}

/** The server and tool an elicitation comes from */
export interface MCPElicitationSource {
  /** The server's name, `''` when it reports none */
  server: string;
  /** The tool whose call asks, when the request comes with a tool call */
  tool?: string;
}

/**
 * Answers a server's elicitation request when the call that asks has no run to pause, or when
 * a server of the 2025-11-25 revision asks on its own
 */
export type MCPElicitationHandler = (
  request: MCPElicitRequest | MCPElicitUrlRequest,
  source: MCPElicitationSource
) => Promise<MCPElicitResult>;

/** A task an MCP server runs for a tool call, as a client keeps it to come back to it */
export interface MCPClientTaskRecord {
  taskId: string;
  tool: string;
  /** When the client learned of the task, ISO 8601 */
  createdAt: string;
  /**
   * The elicitations of the call asked through its run so far, in order, so a call that runs
   * again reads their answers in the same order. `key` is the task's input request key, or
   * `call:<n>` for one the server asked before it made the task
   */
  asked: MCPAskedInput[];
}

/** An elicitation a call asked the person through its run */
export interface MCPAskedInput {
  key: string;
  request: MCPElicitRequest | MCPElicitUrlRequest;
}

/**
 * Where a client keeps the tasks of its tool calls, by tool call id, so a call that runs again
 * (a run resumed after a question) polls the task it started instead of starting another
 */
export interface MCPClientTaskStore {
  get(key: string): Promise<MCPClientTaskRecord | undefined>;
  set(key: string, record: MCPClientTaskRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * A round of a tool call that waits on the person, kept while the call's run is paused on the
 * question, so the resumed call answers that round instead of calling the tool anew
 */
export interface MCPClientRoundRecord {
  tool: string;
  /** Digest of the call's tool and arguments */
  digest: string;
  /** The server's state of the round, sent back unchanged with the answers */
  requestState?: string;
  /** The round's input requests: their key in the round and in `asked` */
  round: Array<{ key: string; asked: string }>;
  /** The questions the call asked so far, in order */
  asked: MCPAskedInput[];
  /** When the round is forgotten, ms since the epoch */
  expiresAt: number;
}

/** Where a client keeps the rounds its paused calls wait on, by tool call id */
export interface MCPClientRoundStore {
  get(key: string): Promise<MCPClientRoundRecord | undefined>;
  set(key: string, record: MCPClientRoundRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MCPClientRoundOptions {
  /** Where rounds are kept by tool call id. Default: in the client's memory */
  store?: MCPClientRoundStore;
  /** How long a round is kept for the paused run to come back, in ms. Default: 3600000 (an hour) */
  ttlMs?: number;
}

export interface MCPClientTaskOptions {
  /** Where tasks are kept by tool call id. Default: in the client's memory */
  store?: MCPClientTaskStore;
  /** The longest wait between two polls of a task, in ms, whatever the server suggests. Default: 30000 */
  maxPollIntervalMs?: number;
}

/** Where OAuth state of an MCP client is kept: client registrations and tokens by issuer */
export interface MCPOAuthStore {
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * OAuth 2.1 for a remote MCP server. The client registers with the server's authorization server
 * by a pre-registered `clientId`, else by its Client ID Metadata Document (`clientMetadataUrl`)
 * when the authorization server supports those, else by Dynamic Client Registration
 */
export interface MCPOAuthConfig {
  /** Where the authorization server sends the browser back with the code */
  redirectUrl: string;
  /**
   * The HTTPS URL of the client's metadata document (`client_id`, `client_name`,
   * `redirect_uris`), which the client hosts itself. It is its `client_id`
   */
  clientMetadataUrl?: string;
  /** A client id registered with the authorization server beforehand */
  clientId?: string;
  /** The secret of a pre-registered confidential client */
  clientSecret?: string;
  /** Name shown on the consent page when the client registers dynamically. Default: the client's name */
  clientName?: string;
  /** Scopes to ask for, space separated. Default: what the server asks for */
  scope?: string;
  /** Where registrations and tokens are kept. Default: in memory */
  store?: MCPOAuthStore;
  /**
   * Sends the person to `url` (opens the browser) and resolves with the URL the authorization
   * server redirected back to, or its query
   */
  authorize: (url: URL) => Promise<URL | URLSearchParams | string>;
}

export interface MCPClientConfig {
  /** Transport type */
  transport: MCPClientTransportType;

  /** Protocol revision to speak (default: `auto`) */
  protocol?: MCPProtocolMode;

  /**
   * Answers elicitation requests that no run can answer. A tool call of a run asks the person
   * through the run (`context.interrupt()`), the run pausing until they answer. `false` tells
   * servers the client cannot answer at all. Without a handler such a request is declined
   */
  elicitation?: false | MCPElicitationHandler;

  /**
   * MCP tasks: a server may answer a long tool call with a task, which the client polls until
   * it ends. `false` tells servers the client takes no tasks. Default: true
   */
  tasks?: boolean | MCPClientTaskOptions;

  /**
   * OAuth for a remote server: an SDK `OAuthClientProvider`, or a config the client builds one
   * from (`createMCPOAuthProvider`)
   */
  auth?: OAuthClientProvider | MCPOAuthConfig;

  /** How many rounds of input requests one call may take before it fails. Default: 10 */
  maxInputRounds?: number;

  /**
   * The rounds of calls whose runs paused on a server's question: kept by tool call id, so the
   * resumed call sends the answers to the round the server asked in, without calling anew
   */
  rounds?: MCPClientRoundOptions;

  /**
   * MCP Apps (extension `io.modelcontextprotocol/ui`): tells servers the client takes apps, so
   * they list their tools' `ui://` apps. `getToolApp()` and the `app` of a wrapped tool read them,
   * a host renders them. Default: true
   */
  apps?: boolean;

  /** For stdio transport: command to spawn */
  command?: string;

  /** For stdio transport: command arguments */
  args?: string[];

  /** For stdio transport: environment variables */
  env?: Record<string, string>;

  /** For stdio transport: working directory of the spawned command */
  cwd?: string;

  /** For HTTP transport: server URL */
  url?: string;

  /** For HTTP transport: custom headers sent with each request */
  headers?: Record<string, string>;

  /** Connection timeout in ms */
  timeout?: number;

  /** Client name for identification */
  clientName?: string;

  /** Client version */
  clientVersion?: string;

  /** Retry configuration for failed operations */
  retry?: MCPRetryConfig;

  /** Auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;

  /** Callback when reconnection attempt starts */
  onReconnecting?: (attempt: number) => void;

  /** Callback when reconnected successfully */
  onReconnected?: () => void;

  /** Callback when reconnection fails permanently */
  onReconnectFailed?: (error: Error) => void;
}

/** The change notifications a client asks a server for */
export interface MCPSubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** The resources whose updates to hear of, by URI */
  resourceSubscriptions?: string[];
}

/** What a subscription calls when the server reports a change */
export interface MCPSubscriptionHandlers {
  onToolsChanged?: () => void;
  onPromptsChanged?: () => void;
  onResourcesChanged?: () => void;
  onResourceUpdated?: (uri: string) => void;
}

/** A subscription to a server's change notifications */
export interface MCPSubscription {
  /** What the server agreed to report, a part of what was asked */
  readonly filter: MCPSubscriptionFilter;
  /**
   * Resolves once the subscription ended: `local` when it was closed, `graceful` when the server
   * ended it, `remote` when the connection dropped (subscribe again to hear of more changes)
   */
  readonly closed: Promise<'local' | 'graceful' | 'remote'>;
  close(): Promise<void>;
}

/** What a server says of itself, from `server/discover` or the `initialize` handshake */
export interface MCPServerDiscovery {
  /** The protocol revision the connection speaks */
  protocolVersion: string;
  era: MCPProtocolEra;
  /** The revisions the server supports, known on the 2026-07-28 revision */
  supportedVersions?: string[];
  capabilities: Record<string, unknown>;
  instructions?: string;
  serverInfo?: { name: string; version: string };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** What the server attaches to the resource, such as `ui` for an MCP App */
  _meta?: Record<string, unknown>;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  /** What the server attaches to the content, such as `ui` for an MCP App */
  _meta?: Record<string, unknown>;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
  };
}

/** What a resource's `read` returns; `uri` defaults to the URI that was read. */
export type MCPResourceReadContent = Omit<MCPResourceContent, 'uri'> & { uri?: string };

export interface MCPResourceConfig {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** `caller` is who `auth` established for the request, on the HTTP transport */
  read: (
    params: Record<string, string>,
    caller?: MCPCaller
  ) => Promise<MCPResourceReadContent | MCPResourceReadContent[]>;
}

export interface MCPPromptArgumentConfig {
  name: string;
  description?: string;
  required?: boolean;
}

/** A message a prompt's `get` returns; string content is plain text. */
export interface MCPPromptReplyMessage {
  role: MCPPromptMessage['role'];
  content: string | MCPPromptMessage['content'];
}

export interface MCPPromptResult {
  messages: MCPPromptReplyMessage[];
  description?: string;
}

export interface MCPPromptConfig {
  name: string;
  title?: string;
  description?: string;
  arguments?: MCPPromptArgumentConfig[];
  /** `caller` is who `auth` established for the request, on the HTTP transport */
  get: (
    args: Record<string, string>,
    caller?: MCPCaller
  ) => Promise<MCPPromptResult> | MCPPromptResult;
}

/** An option of an elicitation choice with the label the form shows for it */
export interface MCPElicitOption {
  const: string;
  title: string;
}

/**
 * A field of an elicitation form: the primitives MCP `requestedSchema` allows (protocol
 * 2025-11-25), a string with its length and format, a single choice (`enum`, or `oneOf` with
 * labels), a number in a range, a boolean, or a multiple choice (`type: 'array'`)
 */
export type MCPElicitField =
  | {
      type: 'string';
      title?: string;
      description?: string;
      enum?: string[];
      oneOf?: MCPElicitOption[];
      minLength?: number;
      maxLength?: number;
      format?: 'email' | 'uri' | 'date' | 'date-time';
      default?: string;
    }
  | {
      type: 'number' | 'integer';
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | { type: 'boolean'; title?: string; description?: string; default?: boolean }
  | (MCPElicitMultiSelect & { items: { type: 'string'; enum: string[] } })
  | (MCPElicitMultiSelect & { items: { anyOf: MCPElicitOption[] } });

/** What a multiple choice field of an elicitation form has besides its options */
export interface MCPElicitMultiSelect {
  type: 'array';
  title?: string;
  description?: string;
  minItems?: number;
  maxItems?: number;
  default?: string[];
}

export interface MCPElicitRequest {
  mode?: 'form';
  message: string;
  schema: { type: 'object'; properties: Record<string, MCPElicitField>; required?: string[] };
}

export type MCPElicitResult =
  { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' | 'cancel' };

/**
 * The context a tool gets when an MCP server runs it: the usual tool context,
 * plus `elicit` to ask the person at the client a question while the call waits.
 */
export interface MCPToolContext extends ToolContext {
  /**
   * `undefined` (as a result) when the client cannot answer elicitation requests. The call keeps
   * running while it waits: on the 2026-07-28 revision the server answers the client's request
   * with the question and goes on when the client sends the answer, so every round of one call
   * has to reach the same server process
   */
  elicit?: (request: MCPElicitRequest) => Promise<MCPElicitResult | undefined>;
  /**
   * Asking without waiting (protocol 2026-07-28 multi round-trip requests): the call ends its
   * round with questions and the client calls again with the answers and the state the call
   * kept, which may reach any server process with the same `requestStateKey`. Present when the
   * client can answer elicitation requests
   */
  input?: MCPToolInput;
}

/** What a call asked in its last round and what it kept, see {@link MCPToolContext.input} */
export interface MCPToolInput {
  /** The answers to what the call asked in its last round, by the keys it gave them */
  readonly responses: Readonly<Record<string, MCPElicitResult>>;
  /**
   * What the call kept with its questions, as it gave it. Undefined in the first round, and when
   * the state the client brought back expired or does not verify (`stateRejected`)
   */
  readonly state: unknown;
  /** Whether the client came back with a state that expired or another server signed */
  readonly stateRejected: boolean;
  /**
   * Ends the round with `requests`: return what it returns from the tool. The client asks them
   * and calls the tool again with the answers (`responses`) and `state`, a JSON value signed so
   * it comes back unchanged
   */
  ask(requests: Record<string, MCPElicitRequest>, state: unknown): MCPInputPending;
}

/** What a tool returns when it ends its round asking, see {@link MCPToolInput.ask} */
export interface MCPInputPending {
  readonly status: 'input_required';
}

/**
 * Who is calling an MCP server over HTTP, as its `auth` function established it.
 * `userId` reaches tools as `context.userId`.
 */
export interface MCPCaller {
  userId?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Establishes the caller of an HTTP request, typically from its
 * `Authorization` header. Return `undefined` (or throw) to answer 401.
 */
export type MCPAuthFunction = (
  request: IncomingMessage
) => MCPCaller | undefined | Promise<MCPCaller | undefined>;

/** What an MCP server tells clients of the OAuth that protects it */
export interface MCPProtectedResourceConfig {
  /** The issuers of the authorization servers whose tokens the server takes */
  authorizationServers: string[];
  /** The server's canonical URL, the `resource` of its tokens. Default: the URL clients called */
  resource?: string;
  scopesSupported?: string[];
  /** Name of the server for people, shown on consent pages */
  resourceName?: string;
}

export interface MCPServerConfig {
  /** Server name */
  name: string;

  /** Server version */
  version: string;

  /** Transport type */
  transport: MCPTransportType;

  /** For HTTP transport: port to listen on */
  port?: number;

  /** For HTTP transport: host to bind to */
  host?: string;

  /** For HTTP transport: maximum request body size in bytes (default: 10 MB) */
  maxBodySize?: number;

  /** For HTTP transport: value of the Access-Control-Allow-Origin header (default: '*') */
  corsOrigin?: string;

  /**
   * For HTTP transport: establishes the caller of every request; requests it
   * returns `undefined` for are answered 401. Without it the server is open
   * to anyone who can reach it. Tasks, waiting calls and round states belong to
   * the caller's `userId`, else to the request's credential (`Authorization` or
   * `Cookie` header): a caller with neither is answered 401 too.
   */
  auth?: MCPAuthFunction;

  /**
   * For HTTP transport with `auth` checking OAuth access tokens: the server's OAuth Protected
   * Resource Metadata (RFC 9728), served at `/.well-known/oauth-protected-resource/mcp` and named
   * in the `WWW-Authenticate` header of a 401, so clients find the authorization server
   */
  protectedResource?: MCPProtectedResourceConfig;

  /**
   * For HTTP transport: keep a session per client of the 2025-11-25 revision (`mcp-session-id`)
   * instead of serving every request on its own. Such clients need it for elicitation, which
   * reaches them as a request from the server; each session belongs to the caller that started
   * it. Clients of the 2026-07-28 revision have no sessions and elicit without them
   */
  sessions?: boolean;

  /**
   * How long a request to the client's user through elicitation (an approval, a question of an
   * agent's tool, `context.elicit()`) waits for the answer, in ms. On the 2026-07-28 revision it
   * is how long the client may take to send the answer back. One nobody answers in time counts
   * as dismissed (`cancel`). `0` waits as long as the tool call lasts. Default: 600000 (10 minutes)
   */
  elicitationTimeoutMs?: number;

  /**
   * Key that signs the state the server gives the client between rounds of a call that asks the
   * user (`requestState`), at least 32 bytes. Every process serving the same clients needs the
   * same key. Default: a random key of the process, so a round that reaches another process (or
   * the server after a restart) starts over
   */
  requestStateKey?: string | Uint8Array;

  /** MCP tasks: long tool calls answered with a task the client polls. `false` turns them off */
  tasks?: false | MCPServerTaskOptions;

  /** Serve clients of the 2025-11-25 revision and earlier as well (default: true) */
  legacyClients?: boolean;

  /**
   * For HTTP transport: the origins browsers may call the server from. A request with another
   * `Origin` is refused with 403, one without `Origin` passes. Default: `corsOrigin` when it is
   * not `*`, else only loopback origins for a server on a loopback host, else any origin
   */
  allowedOrigins?: string[];

  /** Enable logging */
  logging?: boolean;

  /**
   * Runs the server's tool calls the way an agent run executes them: schema validation,
   * approval, the guardrails, the sandbox for sandboxed tools and `tool.timeout`. Pass your
   * `Cogitator` so its sandbox and guardrails apply. Default: a Cogitator of the server's own
   * without configuration, closed by `stop()`
   */
  toolInvoker?: ToolInvoker;
}

export interface MCPToolDefinition {
  name: string;
  /** Name of the tool for people */
  title?: string;
  description: string;
  /** JSON Schema of the arguments, with any `$defs` / `definitions` its refs point to */
  inputSchema: MCPObjectSchema;
  /** JSON Schema of the tool's `structuredContent`, which the server promises to follow */
  outputSchema?: MCPJsonSchema;
  /** Hints the server gives about the tool's behavior */
  annotations?: MCPToolAnnotations;
  /** The MCP App the tool points at (`_meta.ui.resourceUri`), and who may call the tool */
  app?: MCPToolAppRef;
}

/** A JSON Schema of any shape, as MCP takes for tool output since 2026-07-28 */
export type MCPJsonSchema = Record<string, unknown>;

/** A JSON Schema whose root is an object, as MCP takes for tool input */
export interface MCPObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [keyword: string]: unknown;
}

/**
 * Hints an MCP server gives about a tool (MCP `ToolAnnotations`). They are not guarantees, but
 * a tool marked `readOnlyHint` or `idempotentHint` can safely be called again after a timeout,
 * and one marked `destructiveHint` needs approval by default (`ToolAdapterOptions.requiresApproval`).
 */
export interface MCPToolAnnotations {
  title?: string;
  /** The tool does not modify its environment */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates */
  destructiveHint?: boolean;
  /** Calling the tool again with the same arguments has no additional effect */
  idempotentHint?: boolean;
  /** The tool interacts with an open world of external entities */
  openWorldHint?: boolean;
}

export interface MCPToolCallResult {
  content: MCPToolContent[];
  /** The tool's result as JSON, any JSON value, following its `outputSchema` */
  structuredContent?: unknown;
  isError?: boolean;
}

export type MCPToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: MCPResourceContent };

export interface MCPCallToolOptions {
  /** Abort signal that cancels the in-flight tool call */
  signal?: AbortSignal;

  /** Per-call request timeout in ms (defaults to the MCP SDK timeout) */
  timeout?: number;

  /**
   * Whether calling the tool twice is harmless (a read-only or idempotent tool). Only such calls
   * are sent again after a timeout or a lost connection, since the server may still be running
   * (or may have finished) the first one. Default: false, the failure is reported instead.
   * Tools from `getTools()` / `wrapMCPTools()` set it from the server's tool annotations.
   */
  idempotent?: boolean;

  /**
   * The run's tool call id: the task a server started for it is found again when the call runs
   * again after a pause
   */
  toolCallId?: string;

  /**
   * Pauses the run to ask the person (`ToolContext.interrupt`): a server's elicitation requests
   * of the call are asked this way, the call going on once the run resumes with the answer
   */
  interrupt?: ToolContext['interrupt'];

  /** Reports progress, such as the status message of a server's task (`ToolContext.update`) */
  update?: ToolContext['update'];
}

/** How long a task lives and how often clients poll it */
export interface MCPServerTaskOptions {
  /** Where tasks are kept. Default: in the server's memory */
  store?: MCPTaskStore;
  /**
   * A call still running after this many ms becomes a task, for clients that take tasks.
   * `0` makes every such call a task at once. Default: 2000
   */
  promoteAfterMs?: number;
  /** How long a task is kept after it was created, in ms. Default: 3600000 (an hour) */
  ttlMs?: number;
  /** How often clients are asked to poll, in ms. Default: 1000 */
  pollIntervalMs?: number;
}

/** The state of a task of an MCP server */
export type MCPTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** A task as the server keeps it */
export interface MCPTaskRecord {
  taskId: string;
  status: MCPTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  /** Who started the task: only they may see or change it */
  owner: string;
  /** What the server asks the client, while `input_required` */
  inputRequests?: Record<string, MCPTaskInputRequest>;
  /** The tool's result, once `completed` */
  result?: Record<string, unknown>;
  /** The JSON-RPC error, once `failed` */
  error?: { code: number; message: string; data?: unknown };
}

/** A request for input a task waits on, an elicitation form */
export interface MCPTaskInputRequest {
  method: 'elicitation/create';
  params: Record<string, unknown>;
}

/** Where an MCP server keeps its tasks */
export interface MCPTaskStore {
  create(record: MCPTaskRecord): Promise<void>;
  get(taskId: string): Promise<MCPTaskRecord | undefined>;
  update(
    taskId: string,
    patch: Partial<Omit<MCPTaskRecord, 'taskId' | 'owner'>>
  ): Promise<MCPTaskRecord | undefined>;
  delete(taskId: string): Promise<void>;
}

export interface ToolAdapterOptions {
  /**
   * Prefix to add to converted tool names, such as `github_` to tell the tools of several servers
   * apart. The prefixed name is normalized like any other (see `normalizeMCPToolName`).
   */
  namePrefix?: string;

  /** Transform tool description */
  descriptionTransform?: (description: string) => string;

  /**
   * Which of the server's tools need approval before they run (`Tool.requiresApproval`).
   * Default: the tools the server marks destructive, `destructiveHint: true` without
   * `readOnlyHint: true` (see `isDestructiveMCPTool`). `false` lets every tool run without
   * approval, `true` asks for every call
   */
  requiresApproval?: boolean | ((tool: MCPToolDefinition) => boolean);

  /**
   * The server's name in permission rules: each tool gets `mcp: { server, tool }` (`Tool.mcp`), so
   * `mcp__<server>__<tool>` rules match it under its original MCP name whatever `namePrefix` is.
   * Default: the name the server reports when it connects (`MCPClient.serverName`). A server
   * without a name gives `''`: its tools still carry their `mcp` origin, so the permissions never
   * trust what the server says of them (`readOnlyHint`), but only rules on their Cogitator names
   * match them
   */
  server?: string;
}
