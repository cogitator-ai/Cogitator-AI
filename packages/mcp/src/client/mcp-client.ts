/**
 * MCP Client
 *
 * Connects to external MCP servers and provides access to their tools,
 * resources, and prompts. Speaks protocol 2026-07-28 to servers that do and
 * 2025-11-25 to older ones.
 */

import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  UnauthorizedError,
  isCallToolResult,
  isInputRequiredResult,
  type CallToolResult,
  type ClientCapabilities,
  type OAuthClientProvider,
  type PriorDiscovery,
  type StreamableHTTPClientTransport,
  type SSEClientTransport,
  type Transport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { Tool } from '@cogitator-ai/types';
import { createStdioTransport, createHttpTransport, createSseTransport } from './transports';
import type {
  MCPClientConfig,
  MCPClientRoundStore,
  MCPClientTaskStore,
  MCPElicitationHandler,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptMessage,
  MCPProtocolEra,
  MCPServerDiscovery,
  MCPSubscription,
  MCPSubscriptionFilter,
  MCPSubscriptionHandlers,
  MCPToolCallResult,
  MCPToolDefinition,
  MCPToolContent,
  MCPRetryConfig,
  MCPCallToolOptions,
  ToolAdapterOptions,
} from '../types';
import { wrapMCPTools, mcpContentToResult } from '../adapter/tool-adapter';
import { RawDispatcher } from './raw-dispatch';
import { mcpParamHeaders } from './param-headers';
import {
  answerElicitation,
  answerInputRequests,
  answerPlanned,
  planInputRequests,
  toElicitRequest,
  type InputAnswerer,
} from './input';
import { DEFAULT_ROUND_TTL_MS, InMemoryMCPClientRoundStore } from './rounds';
import { callDigest } from '../digest';
import {
  DEFAULT_MAX_POLL_INTERVAL_MS,
  InMemoryMCPClientTaskStore,
  TASKS_EXTENSION,
  TaskSchema,
  settleTask,
  type ClientTask,
  type TaskHost,
} from './tasks';
import { createMCPOAuthProvider, type MCPOAuthProvider } from './oauth';

const DEFAULT_RETRY_CONFIG: Required<MCPRetryConfig> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryOnConnectionLoss: true,
};

const DEFAULT_MAX_INPUT_ROUNDS = 10;
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error raised when an MCP server reports a tool failure (`isError: true`).
 * Tool failures are deterministic results, so they are never retried.
 */
export class MCPToolError extends Error {
  readonly toolName: string;
  readonly content: MCPToolContent[];

  constructor(toolName: string, content: MCPToolContent[]) {
    const text = content
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    super(text || `MCP tool "${toolName}" failed`);
    this.name = 'MCPToolError';
    this.toolName = toolName;
    this.content = content;
  }
}

/**
 * Error raised when a call of a tool that is not marked idempotent or read-only times out or
 * loses its connection. The call is not sent again: the server may still be running it, or may
 * have finished it, and a second call could repeat its effect (a deploy, an email).
 */
export class MCPToolInterruptedError extends Error {
  readonly toolName: string;
  readonly reason: 'timeout' | 'connection-lost' | 'task-lost';

  constructor(
    toolName: string,
    reason: 'timeout' | 'connection-lost' | 'task-lost',
    cause: unknown
  ) {
    const what =
      reason === 'timeout'
        ? `MCP tool "${toolName}" timed out${timeoutOf(cause)}`
        : reason === 'task-lost'
          ? `The server no longer knows the task an earlier run of a call of tool "${toolName}" started (it may have expired)`
          : `The connection to the MCP server was lost during a call of tool "${toolName}"`;
    super(
      `${what}. It was not called again, since the server may have run it and the tool is ` +
        'not marked idempotent or read-only.',
      { cause }
    );
    this.name = 'MCPToolInterruptedError';
    this.toolName = toolName;
    this.reason = reason;
  }
}

function timeoutOf(error: unknown): string {
  if (!(error instanceof SdkError) || typeof error.data !== 'object' || error.data === null) {
    return '';
  }
  const timeout = (error.data as { timeout?: unknown }).timeout;
  return typeof timeout === 'number' ? ` after ${timeout}ms` : '';
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
}

/**
 * Whether `error` is the signal `context.interrupt()` throws to pause the calling run (core's
 * `ToolInterruptSignal`, recognized by shape so the client does not load core). It must reach the
 * run unchanged: its message is the question, which may well say "connection" or "closed"
 */
function isRunInterrupt(error: unknown): boolean {
  return error instanceof Error && error.name === 'ToolInterruptSignal' && 'interrupt' in error;
}

function isConnectionError(error: unknown): boolean {
  if (isRunInterrupt(error)) return false;
  if (error instanceof SdkError) {
    return (
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.NotConnected ||
      error.code === SdkErrorCode.SendFailed
    );
  }
  if (error instanceof ProtocolError) return false;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('connection') ||
      msg.includes('disconnected') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('epipe') ||
      msg.includes('closed')
    );
  }
  return false;
}

function isRetryableError(error: unknown): boolean {
  if (isRunInterrupt(error)) return false;
  if (error instanceof MCPToolError || error instanceof ProtocolError) return false;
  if (error instanceof SdkError) {
    return isConnectionError(error) || error.code === SdkErrorCode.RequestTimeout;
  }
  return !(error instanceof Error && error.name === 'MCPTaskEndedError');
}

/** What a server answered a request of a call with, before it is the call's result */
type CallReply =
  | { kind: 'complete'; result: MCPToolCallResult & { toolResult?: unknown } }
  | { kind: 'input_required'; inputRequests: Record<string, unknown>; requestState?: string }
  | { kind: 'task'; task: ClientTask };

/**
 * MCP Client for connecting to external MCP servers
 *
 * @example
 * ```typescript
 * // Connect to a filesystem MCP server
 * const client = await MCPClient.connect({
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@anthropic/mcp-server-filesystem', '/allowed/path'],
 * });
 *
 * // Get available tools as Cogitator tools
 * const tools = await client.getTools();
 *
 * // Use them with an agent
 * const agent = new Agent({
 *   tools: [...tools],
 *   ...
 * });
 *
 * // Don't forget to disconnect
 * await client.close();
 * ```
 */
export class MCPClient {
  private client: Client;
  private transport: Transport;
  private connected = false;
  private closed = false;
  private reconnectPromise: Promise<void> | null = null;
  private config: MCPClientConfig;
  private retryConfig: Required<MCPRetryConfig>;
  private serverCapabilities: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  } = {};
  private readonly authProvider: OAuthClientProvider | undefined;
  private readonly dispatcher: RawDispatcher;
  private readonly taskStore: MCPClientTaskStore;
  private readonly roundStore: MCPClientRoundStore;
  private readonly toolDefinitions = new Map<string, MCPToolDefinition>();
  private readonly listeners = new Set<{
    filter: MCPSubscriptionFilter;
    handlers: MCPSubscriptionHandlers;
  }>();
  private readonly connectionWatchers = new Set<() => void>();
  /**
   * How many open legacy subscriptions follow each resource: the server keeps one subscription
   * per connection and URI, so it is unsubscribed only once the last of them closes
   */
  private readonly resourceRefs = new Map<string, number>();
  private readonly validator = new AjvJsonSchemaValidator();
  private prior: PriorDiscovery | undefined;
  private negotiatedVersion: string | undefined;
  private serverTakesTasks = false;

  private constructor(config: MCPClientConfig) {
    this.config = config;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };
    this.authProvider =
      config.auth === undefined
        ? undefined
        : isOAuthClientProvider(config.auth)
          ? config.auth
          : createMCPOAuthProvider(config.auth, {
              resource: config.url ?? 'mcp://unknown',
              clientName: config.clientName ?? 'cogitator-mcp-client',
            });
    this.dispatcher = new RawDispatcher(() => this.requestMeta());
    const tasks = typeof config.tasks === 'object' ? config.tasks : undefined;
    this.taskStore = tasks?.store ?? new InMemoryMCPClientTaskStore();
    this.roundStore = config.rounds?.store ?? new InMemoryMCPClientRoundStore();
    this.client = this.createSdkClient();
    this.transport = this.createTransport();
  }

  /**
   * Connect to an MCP server
   */
  static async connect(config: MCPClientConfig): Promise<MCPClient> {
    const mcpClient = new MCPClient(config);
    await mcpClient.initialize(config.timeout);
    return mcpClient;
  }

  private createSdkClient(): Client {
    const elicitation = this.config.elicitation;
    const capabilities: ClientCapabilities =
      typeof elicitation === 'function' ? { elicitation: { form: {}, url: {} } } : {};
    const client = new Client(
      {
        name: this.config.clientName ?? 'cogitator-mcp-client',
        version: this.config.clientVersion ?? '1.0.0',
      },
      {
        capabilities,
        versionNegotiation: {
          mode: negotiationMode(this.config),
          probe: { timeoutMs: this.config.timeout ?? DEFAULT_PROBE_TIMEOUT_MS },
        },
        inputRequired: { autoFulfill: false },
      }
    );
    if (typeof elicitation === 'function') {
      const handler = elicitation;
      client.setRequestHandler('elicitation/create', async (request) => {
        const answerer: InputAnswerer = {
          source: { server: this.serverName ?? '' },
          handler,
          ledger: [],
          consumed: new Set(),
        };
        const answer = await answerElicitation(toElicitRequest(request.params), answerer);
        return answer.action === 'accept'
          ? { action: 'accept', content: answer.content as Record<string, string> }
          : { action: answer.action };
      });
    }
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      this.toolDefinitions.clear();
      this.notify('toolsListChanged', (handlers) => handlers.onToolsChanged?.());
    });
    client.setNotificationHandler('notifications/prompts/list_changed', () => {
      this.notify('promptsListChanged', (handlers) => handlers.onPromptsChanged?.());
    });
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      this.notify('resourcesListChanged', (handlers) => handlers.onResourcesChanged?.());
    });
    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      const uri = notification.params.uri;
      for (const { filter, handlers } of this.listeners) {
        if (filter.resourceSubscriptions?.includes(uri)) handlers.onResourceUpdated?.(uri);
      }
    });
    client.onclose = () => {
      this.connected = false;
      const watchers = [...this.connectionWatchers];
      this.connectionWatchers.clear();
      for (const watcher of watchers) watcher();
    };
    return client;
  }

  /**
   * Create transport based on configuration
   */
  private createTransport(): Transport {
    const config = this.config;
    switch (config.transport) {
      case 'stdio':
        if (!config.command) {
          throw new Error('Command is required for stdio transport');
        }
        return createStdioTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        });

      case 'http':
      case 'sse':
        if (!config.url) {
          throw new Error('URL is required for HTTP transport');
        }
        return createHttpTransport({
          url: config.url,
          headers: config.headers,
          ...(this.authProvider && { authProvider: this.authProvider }),
        });

      case 'legacy-sse':
        if (!config.url) {
          throw new Error('URL is required for the legacy SSE transport');
        }
        return createSseTransport({
          url: config.url,
          headers: config.headers,
          ...(this.authProvider && { authProvider: this.authProvider }),
        });

      default:
        throw new Error(`Unknown transport type: ${String(config.transport)}`);
    }
  }

  /**
   * Initialize connection and capabilities. A server that asks for OAuth sends the person to
   * authorize once (`auth.authorize`), then the client connects again
   */
  private async initialize(timeout?: number): Promise<void> {
    try {
      await this.connectOnce(timeout);
    } catch (error) {
      const provider = this.authProvider;
      if (!(error instanceof UnauthorizedError) || !isMCPOAuthProvider(provider)) throw error;
      const callback = await provider.completeAuthorization();
      if (!callback) throw error;
      const transport = this.transport as StreamableHTTPClientTransport | SSEClientTransport;
      await transport.finishAuth(callback);
      this.client = this.createSdkClient();
      this.transport = this.createTransport();
      await this.connectOnce(timeout);
    }
  }

  private async connectOnce(timeout?: number): Promise<void> {
    const connectPromise = this.client.connect(this.transport, {
      ...(this.prior && { prior: this.prior }),
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (timeout) {
        await Promise.race([
          connectPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
          }),
        ]);
      } else {
        await connectPromise;
      }
    } catch (error) {
      await this.client.close().catch(() => {});
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    this.connected = true;
    this.dispatcher.attach(this.transport);
    this.negotiatedVersion = this.client.getNegotiatedProtocolVersion();
    const discover = this.client.getDiscoverResult();
    this.prior = discover ? { kind: 'modern', discover } : { kind: 'legacy' };

    const serverInfo = this.client.getServerCapabilities();
    this.serverCapabilities = {
      tools: !!serverInfo?.tools,
      resources: !!serverInfo?.resources,
      prompts: !!serverInfo?.prompts,
    };
    this.serverTakesTasks =
      discover !== undefined && serverInfo?.extensions?.[TASKS_EXTENSION] !== undefined;
  }

  /**
   * Check if connected to server
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get server capabilities
   */
  getCapabilities(): typeof this.serverCapabilities {
    return { ...this.serverCapabilities };
  }

  /** The protocol revision the connection speaks, such as `2026-07-28` */
  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  /** `modern` for protocol 2026-07-28 and later, `legacy` for a server of an earlier revision */
  get era(): MCPProtocolEra {
    return this.client.getDiscoverResult() ? 'modern' : 'legacy';
  }

  /** What the server tells the model about using it, if anything */
  get instructions(): string | undefined {
    return this.client.getInstructions();
  }

  /** What the server says of itself: revision, capabilities, instructions and name */
  discover(): MCPServerDiscovery {
    const discover = this.client.getDiscoverResult();
    const version = this.client.getServerVersion();
    const instructions = this.client.getInstructions();
    return {
      protocolVersion: this.negotiatedVersion ?? '',
      era: discover ? 'modern' : 'legacy',
      ...(discover && { supportedVersions: [...discover.supportedVersions] }),
      capabilities: { ...(this.client.getServerCapabilities() ?? {}) },
      ...(instructions !== undefined && { instructions }),
      ...(version && { serverInfo: { name: version.name, version: version.version } }),
    };
  }

  /**
   * Check if currently reconnecting
   */
  isReconnecting(): boolean {
    return this.reconnectPromise !== null;
  }

  /**
   * Attempt to reconnect to the server.
   *
   * Concurrent callers share the same in-flight reconnection, so parallel
   * operations that all observe a dropped connection wait for one reconnect
   * instead of failing. The revision found on the first connect is kept, so a
   * reconnect does not ask the server again.
   */
  reconnect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('MCP client has been closed'));
    }
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.performReconnect().finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
  }

  private async performReconnect(): Promise<void> {
    let lastError: Error | undefined;
    this.connected = false;

    const maxAttempts = Math.max(1, this.retryConfig.maxRetries);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.closed) {
        throw new Error('MCP client has been closed');
      }
      this.config.onReconnecting?.(attempt);

      try {
        this.dispatcher.detach();
        await this.client.close().catch(() => {});

        this.client = this.createSdkClient();
        this.transport = this.createTransport();

        await this.initialize(this.config.timeout);
        if (this.closed) {
          this.connected = false;
          await this.client.close().catch(() => {});
          throw new Error('MCP client has been closed');
        }
        this.config.onReconnected?.();
        return;
      } catch (error) {
        if (isRunInterrupt(error)) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        this.prior = undefined;

        if (this.closed) {
          throw lastError;
        }

        if (attempt < maxAttempts) {
          const delay = Math.min(
            this.retryConfig.initialDelay *
              Math.pow(this.retryConfig.backoffMultiplier, attempt - 1),
            this.retryConfig.maxDelay
          );
          await sleep(delay);
        }
      }
    }

    const failure = lastError ?? new Error('Reconnection failed');
    this.config.onReconnectFailed?.(failure);
    throw failure;
  }

  /**
   * Execute an operation with retry logic
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      if (this.closed) {
        throw new Error(`${operationName} failed: MCP client has been closed`);
      }
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (signal?.aborted || this.closed || !isRetryableError(error)) {
          throw lastError;
        }

        const shouldRetry = attempt < this.retryConfig.maxRetries;
        const isConnError = isConnectionError(error);

        if (isConnError) {
          this.connected = false;
        }

        if (
          isConnError &&
          this.retryConfig.retryOnConnectionLoss &&
          this.config.autoReconnect !== false
        ) {
          if (shouldRetry) {
            try {
              await this.reconnect();
              continue;
            } catch {
              throw lastError;
            }
          }
        }

        if (shouldRetry && !isConnError) {
          const delay = Math.min(
            this.retryConfig.initialDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
            this.retryConfig.maxDelay
          );
          await sleep(delay);
          if (signal?.aborted) {
            throw lastError;
          }
          continue;
        }

        throw lastError;
      }
    }

    throw (
      lastError ?? new Error(`${operationName} failed after ${this.retryConfig.maxRetries} retries`)
    );
  }

  /**
   * List available tools from the MCP server
   */
  async listToolDefinitions(): Promise<MCPToolDefinition[]> {
    if (!this.serverCapabilities.tools) {
      return [];
    }

    return this.withRetry(async () => {
      const result = await this.client.listTools();
      const tools = result.tools.map((tool): MCPToolDefinition => ({
        name: tool.name,
        ...(tool.title !== undefined && { title: tool.title }),
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as MCPToolDefinition['inputSchema'],
        ...(tool.outputSchema && {
          outputSchema: tool.outputSchema as MCPToolDefinition['outputSchema'],
        }),
        ...(tool.annotations && { annotations: tool.annotations }),
      }));
      this.toolDefinitions.clear();
      for (const tool of tools) this.toolDefinitions.set(tool.name, tool);
      return tools;
    }, 'listToolDefinitions');
  }

  /** The name the server reported when it connected (`serverInfo.name`), if it reported one */
  get serverName(): string | undefined {
    const name = this.client.getServerVersion()?.name;
    return name && name.trim() !== '' ? name : undefined;
  }

  /**
   * Get MCP tools as Cogitator Tool instances
   *
   * These tools can be directly used with Cogitator agents.
   */
  async getTools(options?: ToolAdapterOptions): Promise<Tool[]> {
    return wrapMCPTools(this, options);
  }

  /**
   * Call a tool on the MCP server.
   *
   * Returns `structuredContent` when the server provides it (and no media), the text/JSON
   * value(s) of text content, or a `toolContent()` result when the content holds images, audio
   * or binary resources. Throws {@link MCPToolError} when the server reports `isError: true`.
   *
   * A server may ask for input during the call (elicitation): it is asked through the run of
   * the call (`options.interrupt`), else from the `elicitation` handler, else declined. A server
   * may answer with a task, which is polled until it ends, and cancelled when `signal` aborts.
   *
   * A call is sent once. Only with `idempotent: true` (a read-only or idempotent tool) is it sent
   * again after a timeout or a lost connection, otherwise those throw
   * {@link MCPToolInterruptedError}, since the server may have run the call. A connection that was
   * already lost is restored before the call is sent. A task survives a lost connection: its
   * polling goes on once the connection is back.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: MCPCallToolOptions
  ): Promise<unknown> {
    const call = async (): Promise<unknown> =>
      toolResultValue(name, await this.callToolResult(name, args, options));

    if (options?.idempotent === true) {
      return this.withRetry(call, `callTool:${name}`, options.signal);
    }
    return this.callOnce(call, name);
  }

  /**
   * Call a tool and return the server's result as it is: content, `structuredContent` and
   * `isError`. Input requests and tasks are handled as for {@link callTool}
   */
  async callToolResult(
    name: string,
    args: Record<string, unknown>,
    options: MCPCallToolOptions = {}
  ): Promise<MCPToolCallResult> {
    const answerer = this.answererFor(name, options);
    const reattached = await this.reattachTask(name, answerer, options);
    if (reattached) return reattached;

    const maxRounds = this.config.maxInputRounds ?? DEFAULT_MAX_INPUT_ROUNDS;
    const roundKey = answerer.interrupt ? options.toolCallId : undefined;
    const digest = callDigest(name, args);
    let inputResponses: Record<string, unknown> | undefined;
    let requestState: string | undefined;

    const pending = roundKey ? await this.roundStore.get(roundKey) : undefined;
    if (pending?.tool === name && pending.digest === digest) {
      answerer.ledger.push(...pending.asked);
      inputResponses = await answerPlanned(pending.round, answerer);
      requestState = pending.requestState;
    }

    for (let round = 0; ; round++) {
      let reply: CallReply;
      try {
        reply = await this.sendToolCall(name, args, inputResponses, requestState, options);
      } catch (error) {
        if (roundKey) await this.roundStore.delete(roundKey);
        throw error;
      }
      if (reply.kind !== 'input_required') {
        if (roundKey) await this.roundStore.delete(roundKey);
        if (reply.kind === 'complete') return reply.result;
        return this.toolResultOf(name, await this.settle(reply.task, name, answerer, options));
      }
      if (round >= maxRounds) {
        if (roundKey) await this.roundStore.delete(roundKey);
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `MCP tool "${name}" kept asking for input: ${maxRounds} rounds without a result`
        );
      }
      const planned = planInputRequests(reply.inputRequests, answerer);
      if (roundKey) {
        await this.roundStore.set(roundKey, {
          tool: name,
          digest,
          ...(reply.requestState !== undefined && { requestState: reply.requestState }),
          round: planned.map(({ key, asked }) => ({ key, asked })),
          asked: [...answerer.ledger],
          expiresAt: Date.now() + (this.config.rounds?.ttlMs ?? DEFAULT_ROUND_TTL_MS),
        });
      }
      inputResponses = await answerPlanned(planned, answerer);
      requestState = reply.requestState;
    }
  }

  private answererFor(name: string, options: MCPCallToolOptions): InputAnswerer {
    const handler: MCPElicitationHandler | undefined =
      typeof this.config.elicitation === 'function' ? this.config.elicitation : undefined;
    return {
      source: { server: this.serverName ?? '', tool: name },
      ...(this.config.elicitation !== false &&
        options.interrupt && { interrupt: options.interrupt }),
      ...(handler && { handler }),
      ledger: [],
      consumed: new Set(),
    };
  }

  /** The task an earlier run of the same tool call started, polled again, if there is one */
  private async reattachTask(
    name: string,
    answerer: InputAnswerer,
    options: MCPCallToolOptions
  ): Promise<MCPToolCallResult | undefined> {
    const key = options.toolCallId;
    if (!key || !this.takesTasks()) return undefined;
    const record = await this.taskStore.get(key);
    if (record?.tool !== name) return undefined;
    let task: ClientTask;
    try {
      task = TaskSchema.parse(
        await this.dispatcher.request(
          'tasks/get',
          { taskId: record.taskId },
          { signal: options.signal }
        )
      );
    } catch (error) {
      if (error instanceof ProtocolError) {
        await this.taskStore.delete(key);
        if (options.idempotent === true) return undefined;
        throw new MCPToolInterruptedError(name, 'task-lost', error);
      }
      throw error;
    }
    answerer.ledger.push(...record.asked);
    return this.toolResultOf(name, await this.settle(task, name, answerer, options));
  }

  private settle(
    task: ClientTask,
    name: string,
    answerer: InputAnswerer,
    options: MCPCallToolOptions
  ): Promise<Record<string, unknown>> {
    const tasks = typeof this.config.tasks === 'object' ? this.config.tasks : undefined;
    const host: TaskHost = {
      request: (method, params, signal) =>
        this.dispatcher.request(method, params, signal ? { signal } : {}),
      restore: async (error) => {
        if (!isConnectionError(error) || this.config.autoReconnect === false) return false;
        await this.reconnect();
        return true;
      },
    };
    const update = options.update;
    return settleTask(task, {
      host,
      toolName: name,
      answerer,
      store: this.taskStore,
      ...(options.toolCallId && { storeKey: options.toolCallId }),
      maxPollIntervalMs: tasks?.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
      ...(options.signal && { signal: options.signal }),
      ...(update && {
        update: (statusMessage: string) => update({ details: { statusMessage } }),
      }),
    });
  }

  /** Whether calls go out with the tasks extension: the server takes tasks and the client does */
  private takesTasks(): boolean {
    return this.config.tasks !== false && this.serverTakesTasks;
  }

  private async sendToolCall(
    name: string,
    args: Record<string, unknown>,
    inputResponses: Record<string, unknown> | undefined,
    requestState: string | undefined,
    options: MCPCallToolOptions
  ): Promise<CallReply> {
    const canAnswer = this.canAnswer(options);
    const params = {
      name,
      arguments: args,
      ...(inputResponses && { inputResponses }),
      ...(requestState !== undefined && { requestState }),
    };
    if (this.takesTasks()) return this.sendRawToolCall(params, options, canAnswer);

    const call =
      this.era === 'modern'
        ? { ...params, _meta: { [CLIENT_CAPABILITIES_KEY]: this.capabilities(canAnswer) } }
        : params;
    const result = await this.client.callTool(call as Parameters<Client['callTool']>[0], {
      ...(options.signal && { signal: options.signal }),
      ...(options.timeout !== undefined && { timeout: options.timeout }),
      allowInputRequired: true,
    });
    if (isInputRequiredResult(result)) {
      return {
        kind: 'input_required',
        inputRequests: { ...(result.inputRequests ?? {}) },
        ...(result.requestState !== undefined && { requestState: result.requestState }),
      };
    }
    return { kind: 'complete', result: toCallResult(result) };
  }

  /**
   * `tools/call` sent past the SDK client, which cannot read a task: with the tasks extension
   * in the request's capabilities and the `Mcp-Param-*` headers of the tool's arguments
   */
  private async sendRawToolCall(
    params: { name: string; arguments: Record<string, unknown> } & Record<string, unknown>,
    options: MCPCallToolOptions,
    canAnswer: boolean
  ): Promise<CallReply> {
    const tool = await this.toolDefinition(params.name);
    const headers = tool ? mcpParamHeaders(tool.inputSchema, params.arguments) : {};
    const framed = {
      ...params,
      _meta: { [CLIENT_CAPABILITIES_KEY]: this.capabilities(canAnswer) },
    };
    const result = await this.dispatcher.request('tools/call', framed, {
      ...(options.signal && { signal: options.signal }),
      ...(options.timeout !== undefined && { timeout: options.timeout }),
      ...(Object.keys(headers).length > 0 && { headers }),
    });
    if (result.resultType === 'task') return { kind: 'task', task: TaskSchema.parse(result) };
    if (isInputRequiredResult(result)) {
      return {
        kind: 'input_required',
        inputRequests: { ...(result.inputRequests ?? {}) },
        ...(result.requestState !== undefined && { requestState: result.requestState }),
      };
    }
    return { kind: 'complete', result: this.toolResultOf(params.name, result) };
  }

  /** A tool result as the server sent it, checked against the tool's output schema */
  private toolResultOf(name: string, result: Record<string, unknown>): MCPToolCallResult {
    if (!isCallToolResult(result)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `MCP tool "${name}" answered with something that is no tool result`
      );
    }
    const call = toCallResult(result);
    const schema = this.toolDefinitions.get(name)?.outputSchema;
    if (schema && !call.isError && call.structuredContent !== undefined) {
      const check = this.validator.getValidator(schema)(call.structuredContent);
      if (!check.valid) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Structured content of MCP tool "${name}" does not match its output schema: ${check.errorMessage}`
        );
      }
    }
    return call;
  }

  private async toolDefinition(name: string): Promise<MCPToolDefinition | undefined> {
    if (!this.toolDefinitions.has(name)) await this.listToolDefinitions().catch(() => []);
    return this.toolDefinitions.get(name);
  }

  /** Whether someone can answer the elicitation requests of a call: its run or the handler */
  private canAnswer(options: MCPCallToolOptions): boolean {
    const elicitation = this.config.elicitation;
    if (elicitation === false) return false;
    return typeof elicitation === 'function' || options.interrupt !== undefined;
  }

  /**
   * The capabilities a request declares (protocol 2026-07-28 declares them per request):
   * elicitation when someone can answer, and the tasks extension when the client takes tasks
   */
  private capabilities(canAnswer: boolean): ClientCapabilities {
    return {
      ...(canAnswer && { elicitation: { form: {}, url: {} } }),
      ...(this.takesTasks() && { extensions: { [TASKS_EXTENSION]: {} } }),
    };
  }

  /** The `_meta` of a request sent past the SDK client */
  private requestMeta(): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': this.negotiatedVersion,
      'io.modelcontextprotocol/clientInfo': {
        name: this.config.clientName ?? 'cogitator-mcp-client',
        version: this.config.clientVersion ?? '1.0.0',
      },
      [CLIENT_CAPABILITIES_KEY]: this.capabilities(typeof this.config.elicitation === 'function'),
    };
  }

  /** A call that must not run twice: sent once, on a connection restored beforehand if needed. */
  private async callOnce<T>(operation: () => Promise<T>, toolName: string): Promise<T> {
    if (this.closed) {
      throw new Error(`callTool:${toolName} failed: MCP client has been closed`);
    }
    if (
      !this.connected &&
      this.config.autoReconnect !== false &&
      this.retryConfig.retryOnConnectionLoss
    ) {
      await this.reconnect();
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MCPToolError || isRunInterrupt(error)) throw error;
      if (isConnectionError(error)) {
        this.connected = false;
        throw new MCPToolInterruptedError(toolName, 'connection-lost', error);
      }
      if (isRequestTimeout(error)) {
        throw new MCPToolInterruptedError(toolName, 'timeout', error);
      }
      throw error;
    }
  }

  /**
   * Hear of the server's changes: its tool, prompt or resource lists, or updates of resources.
   * On protocol 2026-07-28 this opens a `subscriptions/listen` stream, on earlier revisions the
   * server sends list changes on its own and resources are subscribed one by one. The filter of
   * the subscription is what the server agreed to
   */
  async subscribe(
    filter: MCPSubscriptionFilter,
    handlers: MCPSubscriptionHandlers
  ): Promise<MCPSubscription> {
    if (this.era === 'modern') {
      const subscription = await this.client.listen(filter);
      const honored = { ...subscription.honoredFilter };
      const listener = { filter: honored, handlers };
      this.listeners.add(listener);
      return {
        filter: honored,
        closed: subscription.closed.then((how) => {
          this.listeners.delete(listener);
          return how;
        }),
        close: () => subscription.close(),
      };
    }

    const capabilities = this.client.getServerCapabilities();
    const uris = capabilities?.resources?.subscribe
      ? [...new Set(filter.resourceSubscriptions ?? [])]
      : [];
    for (const uri of uris) {
      const refs = this.resourceRefs.get(uri) ?? 0;
      if (refs === 0) await this.client.subscribeResource({ uri });
      this.resourceRefs.set(uri, refs + 1);
    }
    const release = (): string[] => {
      const last: string[] = [];
      for (const uri of uris) {
        const refs = (this.resourceRefs.get(uri) ?? 1) - 1;
        if (refs > 0) {
          this.resourceRefs.set(uri, refs);
        } else {
          this.resourceRefs.delete(uri);
          last.push(uri);
        }
      }
      return last;
    };
    const honored: MCPSubscriptionFilter = {
      ...(filter.toolsListChanged &&
        capabilities?.tools?.listChanged && { toolsListChanged: true }),
      ...(filter.promptsListChanged &&
        capabilities?.prompts?.listChanged && { promptsListChanged: true }),
      ...(filter.resourcesListChanged &&
        capabilities?.resources?.listChanged && { resourcesListChanged: true }),
      ...(uris.length > 0 && { resourceSubscriptions: [...uris] }),
    };
    const listener = { filter: honored, handlers };
    this.listeners.add(listener);
    let end: (how: 'local' | 'remote') => void = () => {};
    const closed = new Promise<'local' | 'remote'>((resolve) => {
      end = (how) => {
        this.listeners.delete(listener);
        this.connectionWatchers.delete(onDrop);
        resolve(how);
      };
    });
    const onDrop = (): void => {
      release();
      end('remote');
    };
    this.connectionWatchers.add(onDrop);
    return {
      filter: honored,
      closed,
      close: async () => {
        if (!this.listeners.has(listener)) return;
        end('local');
        for (const uri of release()) {
          await this.client.unsubscribeResource({ uri }).catch(() => undefined);
        }
      },
    };
  }

  private notify(
    kind: 'toolsListChanged' | 'promptsListChanged' | 'resourcesListChanged',
    call: (handlers: MCPSubscriptionHandlers) => void
  ): void {
    for (const { filter, handlers } of this.listeners) {
      if (filter[kind]) call(handlers);
    }
  }

  /**
   * List available resources from the MCP server with automatic retry
   */
  async listResources(): Promise<MCPResource[]> {
    if (!this.serverCapabilities.resources) {
      return [];
    }

    return this.withRetry(async () => {
      const result = await this.client.listResources();
      return result.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    }, 'listResources');
  }

  /**
   * Read a resource from the MCP server with automatic retry.
   * Returns the first content entry; use {@link readResourceContents} for all of them.
   */
  async readResource(uri: string): Promise<MCPResourceContent> {
    const contents = await this.readResourceContents(uri);
    return contents[0] ?? { uri };
  }

  /**
   * Read every content entry of a resource (e.g. multi-part or templated resources)
   */
  async readResourceContents(uri: string): Promise<MCPResourceContent[]> {
    return this.withRetry(async () => {
      const result = await this.withInput(`resource ${uri}`, (input) =>
        this.client.readResource({ uri, ...input } as Parameters<Client['readResource']>[0], {
          allowInputRequired: true,
        })
      );
      return (result.contents ?? []).map((content) => ({
        uri: content.uri,
        mimeType: content.mimeType,
        text: 'text' in content ? content.text : undefined,
        blob: 'blob' in content ? content.blob : undefined,
      }));
    }, `readResource:${uri}`);
  }

  /**
   * List available prompts from the MCP server with automatic retry
   */
  async listPrompts(): Promise<MCPPrompt[]> {
    if (!this.serverCapabilities.prompts) {
      return [];
    }

    return this.withRetry(async () => {
      const result = await this.client.listPrompts();
      return result.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((arg) => ({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      }));
    }, 'listPrompts');
  }

  /**
   * Get a prompt from the MCP server with automatic retry
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]> {
    return this.withRetry(async () => {
      const result = await this.withInput(`prompt ${name}`, (input) =>
        this.client.getPrompt(
          { name, arguments: args ?? {}, ...input } as Parameters<Client['getPrompt']>[0],
          { allowInputRequired: true }
        )
      );

      return result.messages.map((msg) => {
        const content = msg.content;
        return {
          role: msg.role,
          content: toPromptContent(content),
        };
      });
    }, `getPrompt:${name}`);
  }

  /**
   * A request that a server of protocol 2026-07-28 may answer with input requests, sent again
   * with the answers of the elicitation handler until it completes
   */
  private async withInput<T>(
    what: string,
    send: (input: { inputResponses?: Record<string, unknown>; requestState?: string }) => Promise<T>
  ): Promise<T> {
    const maxRounds = this.config.maxInputRounds ?? DEFAULT_MAX_INPUT_ROUNDS;
    const answerer = this.answererFor(what, {});
    let input: { inputResponses?: Record<string, unknown>; requestState?: string } = {};
    for (let round = 0; ; round++) {
      const result = await send(input);
      if (!isInputRequiredResult(result)) return result;
      if (round >= maxRounds) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `The MCP server kept asking for input for ${what}: ${maxRounds} rounds without a result`
        );
      }
      input = {
        inputResponses: await answerInputRequests({ ...(result.inputRequests ?? {}) }, answerer),
        ...(result.requestState !== undefined && { requestState: result.requestState }),
      };
    }
  }

  /**
   * Close the connection to the MCP server
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.dispatcher.detach();
      await this.client.close();
    } finally {
      this.connected = false;
    }
  }
}

function negotiationMode(config: MCPClientConfig): VersionNegotiationMode {
  const protocol = config.protocol ?? 'auto';
  if (config.transport === 'legacy-sse') return 'legacy';
  return protocol;
}

function isOAuthClientProvider(value: MCPClientConfig['auth']): value is OAuthClientProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tokens' in value &&
    typeof value.tokens === 'function'
  );
}

function isMCPOAuthProvider(value: OAuthClientProvider | undefined): value is MCPOAuthProvider {
  return value !== undefined && 'completeAuthorization' in value;
}

type SDKToolContent = CallToolResult['content'][number];

function toCallResult(result: CallToolResult): MCPToolCallResult & { toolResult?: unknown } {
  const content = toToolContent(Array.isArray(result.content) ? result.content : []);
  return {
    content,
    ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
    ...(result.isError === true && { isError: true }),
    ...('toolResult' in result && { toolResult: result.toolResult }),
  };
}

/** What `callTool` returns for a tool result */
function toolResultValue(
  name: string,
  result: MCPToolCallResult & { toolResult?: unknown }
): unknown {
  const content = result.content;
  if (result.isError) {
    throw new MCPToolError(name, content);
  }
  if (content.length > 0 && hasMedia(content)) {
    return mcpContentToResult(content);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (content.length > 0) {
    return mcpContentToResult(content);
  }
  if (result.toolResult !== undefined) {
    return result.toolResult;
  }
  return null;
}

/** The content blocks of a tool result; a link to a resource becomes a line of text. */
function toToolContent(content: readonly SDKToolContent[]): MCPToolContent[] {
  return content.map((block): MCPToolContent => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
      case 'audio':
        return { type: block.type, data: block.data, mimeType: block.mimeType };
      case 'resource':
        return {
          type: 'resource',
          resource: {
            uri: block.resource.uri,
            mimeType: block.resource.mimeType,
            text: 'text' in block.resource ? block.resource.text : undefined,
            blob: 'blob' in block.resource ? block.resource.blob : undefined,
          },
        };
      case 'resource_link':
        return {
          type: 'text',
          text: `Resource: ${block.uri}${block.name ? ` (${block.name})` : ''}${block.mimeType ? `, ${block.mimeType}` : ''}`,
        };
    }
  });
}

function hasMedia(content: readonly MCPToolContent[]): boolean {
  return content.some(
    (block) =>
      block.type === 'image' ||
      block.type === 'audio' ||
      (block.type === 'resource' && typeof block.resource.blob === 'string')
  );
}

type SDKPromptContent = Awaited<ReturnType<Client['getPrompt']>>['messages'][number]['content'];

function toPromptContent(content: SDKPromptContent): MCPPromptMessage['content'] {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'image':
    case 'audio':
      return { type: content.type, data: content.data, mimeType: content.mimeType };
    case 'resource':
      return {
        type: 'resource',
        resource: {
          uri: content.resource.uri,
          mimeType: content.resource.mimeType,
          text: 'text' in content.resource ? content.resource.text : undefined,
          blob: 'blob' in content.resource ? content.resource.blob : undefined,
        },
      };
    case 'resource_link':
      return {
        type: 'resource_link',
        mimeType: content.mimeType,
        resource: { uri: content.uri, mimeType: content.mimeType },
      };
  }
}

/**
 * Helper function to connect to an MCP server and get tools in one step
 *
 * @example
 * ```typescript
 * const { tools, cleanup } = await connectMCPServer({
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@anthropic/mcp-server-filesystem', '/path'],
 * });
 *
 * const agent = new Agent({ tools });
 *
 * // When done
 * await cleanup();
 * ```
 */
export async function connectMCPServer(config: MCPClientConfig): Promise<{
  client: MCPClient;
  tools: Tool[];
  cleanup: () => Promise<void>;
}> {
  const client = await MCPClient.connect(config);
  const tools = await client.getTools();

  return {
    client,
    tools,
    cleanup: () => client.close(),
  };
}
