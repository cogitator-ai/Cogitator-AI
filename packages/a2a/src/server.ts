import { MAX_RUN_TIMEOUT_MS, resolveSseHeartbeatMs } from '@cogitator-ai/server-shared';
import type { Agent as IAgent } from '@cogitator-ai/types';
import type {
  A2AServerConfig,
  AgentCard,
  AgentExtension,
  AgentProvider,
  A2ATask,
  MessageSendConfiguration,
  MessageSendParams,
  PushNotificationConfig,
  TaskFilter,
  CogitatorLike,
  PushNotificationStore,
  TaskPushNotificationConfig,
  A2AAuthConfig,
  A2ACaller,
  LegacyCardSigningConfig,
  AgentCardSigningConfig,
  Part,
} from './types.js';
import type { JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';
import { parseJsonRpcRequest, createSuccessResponse, createErrorResponse } from './json-rpc.js';
import { TaskManager, type TaskEvent } from './task-manager.js';
import {
  buildAgentCardModel,
  cardModelFromLegacy,
  signAgentCard,
  toLegacyCard,
  toV1Card,
  type AgentCardInterface,
  type AgentCardModel,
} from './agent-card.js';
import { AgentCardSigner, type JsonWebKeySet } from './card-signing.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { InMemoryTaskStore } from './task-store.js';
import {
  InMemoryPushNotificationStore,
  PushNotificationSender,
  publicPushConfig,
  validateWebhookUrl,
} from './push-notifications.js';
import { isStreamFinalState, isTerminalState } from './types.js';
import { isTaskOfAgent, isTaskVisibleTo, publicTask } from './ownership.js';
import {
  parseDeletePushNotificationConfigParams,
  parseGetPushNotificationConfigParams,
  parseListTasksParams,
  parseMessageSendParams,
  parseTaskIdParams,
  parseTaskPushNotificationConfig,
  parseTaskQueryParams,
} from './protocol.js';
import { trimTrailingSlashes } from './url.js';
import { SUPPORTED_PROTOCOL_VERSIONS, type A2AProtocolVersion } from './version.js';
import { COGITATOR_AGENT_EXTENSIONS, missingRequiredExtensions } from './extensions.js';
import { paginateTasks, type ListTasksPage, type ListTasksPageQuery } from './list-tasks.js';
import type { A2AOperations, CallContext } from './operations.js';
import { dispatchV1, streamV1, V1_STREAMING_METHODS } from './v1/json-rpc.js';
import { toV1JsonRpcError } from './v1/errors.js';
import type { V1AgentCard } from './v1/types.js';
import { handleRestRequest, type A2ARestRequest, type A2ARestResponse } from './rest.js';

type HeaderGetter = (name: string) => string | null | undefined;

const MAX_LIST_LIMIT = 1000;

/** The run time limit a client may ask for when neither the agent nor the server sets one: the Cogitator run default. */
const DEFAULT_MAX_RUN_TIMEOUT_MS = 120_000;

/** JSON-RPC methods answered with a stream of events (A2A v0.3, sections 7.2 and 7.9). */
export const STREAMING_METHODS: readonly string[] = ['message/stream', 'tasks/resubscribe'];

/** Options of one request, set by the framework adapters. */
export interface A2AHandleOptions {
  /** The agent the request is addressed to by its endpoint; it wins over an `agentName` param */
  agentName?: string;
  /**
   * The protocol version the request speaks (default: '0.3'), which the adapters read from the
   * `A2A-Version` header. '1.0' takes the PascalCase methods of A2A 1.0 and answers in its form.
   */
  protocolVersion?: A2AProtocolVersion;
  /** The extension URIs the client asked for in `A2A-Extensions` (`X-A2A-Extensions` in 0.3) */
  extensions?: readonly string[];
  /** Absolute URL the framework adapter is mounted at, for the cards a request returns */
  baseUrl?: string;
}

/** Options for building an Agent Card. */
export interface AgentCardRequestOptions {
  /**
   * Absolute URL the framework adapter is mounted at (origin plus mount path). The card's `url`
   * is derived from it when the server has no `cardUrl`.
   */
  baseUrl?: string;
}

type RequestId = string | number | null;

function requestIdOf(body: unknown): RequestId {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

/** The MIME type a part is delivered as, for `acceptedOutputModes`. */
function partMimeType(part: Part): string {
  switch (part.kind) {
    case 'text':
      return 'text/plain';
    case 'data':
      return 'application/json';
    case 'file':
      return part.file.mimeType ?? 'application/octet-stream';
  }
}

function isLegacySigning(
  config: AgentCardSigningConfig | LegacyCardSigningConfig
): config is LegacyCardSigningConfig {
  return 'secret' in config;
}

/** The events of one task, queued until the stream that relays them takes them. */
class TaskEventQueue {
  private queue: TaskEvent[] = [];
  private wake: (() => void) | null = null;
  private readonly listener = (event: TaskEvent) => {
    if (this.taskId !== null && event.taskId === this.taskId) {
      this.queue.push(event);
      this.notify();
    }
  };

  constructor(
    private readonly manager: TaskManager,
    public taskId: string | null
  ) {
    manager.on('event', this.listener);
  }

  notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  shift(): TaskEvent | undefined {
    return this.queue.shift();
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  close(): void {
    this.manager.removeListener('event', this.listener);
    this.notify();
  }
}

export class A2AServer {
  private agents: Record<string, IAgent>;
  private defaultAgentName: string;
  private cogitator: CogitatorLike;
  private taskManager: TaskManager;
  /** The path the framework adapters serve JSON-RPC on, and the cards advertise without `cardUrl`. */
  readonly basePath: string;
  /** The path the framework adapters serve the A2A 1.0 HTTP+JSON binding on; null when it is off */
  readonly restPath: string | null;
  /** The protocol versions the server speaks */
  readonly protocolVersions: readonly A2AProtocolVersion[];
  /** How often the framework adapters write a heartbeat on an open stream; `0` for never */
  readonly sseHeartbeatMs: number;
  private cardUrl?: string;
  private agentVersion?: string;
  private provider?: AgentProvider;
  private maxRunTimeoutMs: number;
  private pushNotificationStore: PushNotificationStore;
  private pushSender: PushNotificationSender;
  private legacySigning?: LegacyCardSigningConfig;
  private signer?: AgentCardSigner;
  private extendedCardGenerator?: (agentName: string) => AgentCard;
  private allowPrivateUrls: boolean;
  private auth?: A2AAuthConfig;
  private extensions: readonly AgentExtension[];
  private readonly operations: A2AOperations;

  constructor(config: A2AServerConfig) {
    const agentNames = Object.keys(config.agents);
    if (agentNames.length === 0) {
      throw new Error('A2AServer requires at least one agent');
    }

    this.agents = config.agents;
    this.defaultAgentName = agentNames[0];
    this.cogitator = config.cogitator;
    this.basePath = config.basePath ?? '/a2a';
    if (!this.basePath.startsWith('/')) {
      throw new Error(
        `A2AServer basePath must be a path starting with "/", got "${this.basePath}"`
      );
    }
    this.protocolVersions = resolveProtocolVersions(config.protocolVersions);
    this.restPath = this.resolveRestPath(config.restPath, agentNames);
    const maxRunTimeoutMs = config.maxRunTimeoutMs ?? DEFAULT_MAX_RUN_TIMEOUT_MS;
    if (
      !Number.isInteger(maxRunTimeoutMs) ||
      maxRunTimeoutMs <= 0 ||
      maxRunTimeoutMs > MAX_RUN_TIMEOUT_MS
    ) {
      throw new Error(
        `A2AServer maxRunTimeoutMs must be a positive integer of at most ${MAX_RUN_TIMEOUT_MS}, got ${maxRunTimeoutMs}`
      );
    }
    this.maxRunTimeoutMs = maxRunTimeoutMs;
    this.sseHeartbeatMs = resolveSseHeartbeatMs(config.sseHeartbeatMs);
    this.cardUrl = config.cardUrl ? trimTrailingSlashes(config.cardUrl) : undefined;
    this.agentVersion = config.agentVersion;
    this.provider = config.provider;
    if (config.cardSigning) {
      if (isLegacySigning(config.cardSigning)) this.legacySigning = config.cardSigning;
      else this.signer = new AgentCardSigner(config.cardSigning);
    }
    this.extendedCardGenerator = config.extendedCardGenerator;
    this.allowPrivateUrls = config.allowPrivateUrls ?? false;
    this.auth = config.auth;
    this.extensions = mergeExtensions(COGITATOR_AGENT_EXTENSIONS, config.extensions ?? []);

    this.pushNotificationStore =
      config.pushNotificationStore ?? new InMemoryPushNotificationStore();
    this.pushSender = new PushNotificationSender(this.pushNotificationStore, this.allowPrivateUrls);

    this.taskManager = new TaskManager({
      taskStore: config.taskStore ?? new InMemoryTaskStore(),
    });

    this.taskManager.on('event', (event: TaskEvent) => {
      if (event.kind !== 'status-update') return;
      this.taskManager
        .getTask(event.taskId)
        .then((task) => this.pushSender.notify(publicTask(task)))
        .catch(() => {});
    });

    this.operations = {
      hasAgent: (name) => this.hasAgent(name),
      authenticate: (token) => this.authenticate(token),
      agentFor: (endpointAgent, tenant) => this.agentFor(endpointAgent, tenant),
      sendMessage: (params, context) => this.sendMessage(params, context),
      streamMessage: (params, context, signal) => this.streamMessage(params, context, signal),
      getTask: (taskId, historyLength, context) => this.getTask(taskId, historyLength, context),
      cancelTask: (taskId, context) => this.cancelTask(taskId, context),
      subscribe: (taskId, context, signal) => this.subscribe(taskId, context, signal),
      listTasksPage: (query, context) => this.listTasksPage(query, context),
      createPushConfig: (taskId, pushConfig, context) =>
        this.createPushConfig(taskId, pushConfig, context),
      getPushConfig: (taskId, configId, context) => this.getPushConfig(taskId, configId, context),
      listPushConfigs: (taskId, context) => this.listPushConfigs(taskId, context),
      deletePushConfig: (taskId, configId, context) =>
        this.deletePushConfig(taskId, configId, context),
      extendedCard: (context) => this.v1ExtendedCard(context),
    };
  }

  private resolveRestPath(
    restPath: string | false | undefined,
    agentNames: readonly string[]
  ): string | null {
    if (restPath === false || !this.protocolVersions.includes('1.0')) return null;
    const path = trimTrailingSlashes(restPath ?? `${trimTrailingSlashes(this.basePath)}/rest`);
    if (!path.startsWith('/') || path === '') {
      throw new Error(`A2AServer restPath must be a path starting with "/", got "${restPath}"`);
    }
    if (path === trimTrailingSlashes(this.basePath)) {
      throw new Error('A2AServer restPath must differ from basePath');
    }
    const base = trimTrailingSlashes(this.basePath);
    const clash = agentNames.find((name) => `${base}/${encodeURIComponent(name)}` === path);
    if (clash && restPath !== undefined) {
      throw new Error(
        `A2AServer restPath "${path}" is the endpoint of agent "${clash}": set another restPath`
      );
    }
    if (clash) {
      console.warn(
        `[a2a] The default restPath "${path}" is the endpoint of agent "${clash}", so the HTTP+JSON binding is off. Set restPath to serve it elsewhere.`
      );
      return null;
    }
    return path;
  }

  /**
   * Extract the credential configured by `auth` from request headers:
   * the token of an `Authorization: Bearer` header, or the API key header.
   * Framework adapters call this and pass the result to handleJsonRpc / handleJsonRpcStream.
   */
  getAuthToken(getHeader: HeaderGetter): string | undefined {
    if (!this.auth) return undefined;
    if (this.auth.type === 'bearer') {
      const header = getHeader('authorization');
      const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
      return match ? match[1].trim() : undefined;
    }
    const key = getHeader(this.auth.headerName ?? 'x-api-key');
    return key ? key.trim() || undefined : undefined;
  }

  /** The `WWW-Authenticate` challenge of a 401 response, when the auth scheme has one. */
  get authChallenge(): string | undefined {
    return this.auth?.type === 'bearer' ? 'Bearer realm="a2a"' : undefined;
  }

  /** Whether the server hosts an agent under this name. */
  hasAgent(agentName: string): boolean {
    return Object.hasOwn(this.agents, agentName);
  }

  /** The extensions an agent declares in its card: the Cogitator ones and `extensions`. */
  getAgentExtensions(): readonly AgentExtension[] {
    return this.extensions;
  }

  /**
   * The Agent Card of an agent (the first one by default) for a client that speaks A2A 0.3 or
   * names no version. Its `url` is the agent's JSON-RPC endpoint: `cardUrl`, or `baseUrl` plus
   * `basePath`, and `/<agent name>` after it for every agent but the first. When the server
   * speaks A2A 1.0 too, `supportedInterfaces` lists every interface of both versions.
   *
   * With a signing key the card carries the signature of its A2A 1.0 form, which covers its 0.3
   * fields too. A server that speaks only A2A 1.0 has no 0.3 endpoint such a signature could
   * cover, so this form of its card is unsigned (its 1.0 card is signed).
   */
  getAgentCard(agentName?: string, options?: AgentCardRequestOptions): AgentCard {
    const model = this.cardModel(agentName, options?.baseUrl);
    const card = toLegacyCard(model, { embedInterfaces: this.protocolVersions.includes('1.0') });
    if (this.legacySigning) return signAgentCard(card, this.legacySigning);
    if (this.signer && this.protocolVersions.includes('0.3')) {
      return { ...card, signatures: [this.signer.signature(card)] };
    }
    return card;
  }

  /** The A2A 1.0 Agent Card of an agent (the first one by default). */
  getV1AgentCard(agentName?: string, options?: AgentCardRequestOptions): V1AgentCard {
    return this.signedV1(toV1Card(this.cardModel(agentName, options?.baseUrl)));
  }

  /** The cards of every agent, in the order they were registered. */
  getAgentCards(options?: AgentCardRequestOptions): AgentCard[] {
    return Object.keys(this.agents).map((name) => this.getAgentCard(name, options));
  }

  /**
   * The JWKS with the public key the cards are signed with, when `cardSigning` signs with a
   * private key and `publishJwks` is set; the adapters serve it at `/.well-known/jwks.json`.
   */
  getJwks(): JsonWebKeySet | undefined {
    return this.signer?.publishesJwks ? this.signer.jwks() : undefined;
  }

  private signedV1(card: V1AgentCard): V1AgentCard {
    if (this.legacySigning) return signAgentCard(card, this.legacySigning);
    if (this.signer) return { ...card, signatures: [this.signer.signature(card)] };
    return card;
  }

  private cardModel(agentName: string | undefined, baseUrl: string | undefined): AgentCardModel {
    const name = agentName ?? this.defaultAgentName;
    if (!this.hasAgent(name)) throw new A2AError(errors.agentNotFound(name));
    const model = buildAgentCardModel(this.agents[name], {
      interfaces: this.interfaces(name, baseUrl),
      version: this.agentVersion,
      provider: this.provider,
      capabilities: {
        streaming: true,
        pushNotifications: true,
        stateTransitionHistory: false,
        extensions: this.extensions.map((extension) => ({ ...extension })),
        ...(this.extendedCardGenerator && { extendedAgentCard: true }),
      },
    });
    if (this.auth) {
      const schemeName = this.auth.type === 'bearer' ? 'bearer' : 'apiKey';
      model.securitySchemes = {
        [schemeName]:
          this.auth.type === 'bearer'
            ? { type: 'http', scheme: 'bearer' }
            : { type: 'apiKey', in: 'header', name: this.auth.headerName ?? 'x-api-key' },
      };
      model.security = [{ [schemeName]: [] }];
    }
    return model;
  }

  /**
   * Where an agent is served, in the order clients should prefer: JSON-RPC 1.0, HTTP+JSON 1.0,
   * JSON-RPC 0.3, each version only when the server speaks it. The 1.0 interfaces carry the
   * agent's name as their tenant.
   */
  private interfaces(agentName: string, baseUrl: string | undefined): AgentCardInterface[] {
    const rpcUrl = this.agentEndpoint(agentName, baseUrl);
    const interfaces: AgentCardInterface[] = [];
    if (this.protocolVersions.includes('1.0')) {
      interfaces.push({
        url: rpcUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: agentName,
      });
      const restUrl = this.restEndpoint(baseUrl);
      if (restUrl) {
        interfaces.push({
          url: restUrl,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
          tenant: agentName,
        });
      }
    }
    if (this.protocolVersions.includes('0.3')) {
      interfaces.push({ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '0.3' });
    }
    return interfaces;
  }

  private agentEndpoint(agentName: string, baseUrl?: string): string {
    const shared = this.cardUrl ?? `${trimTrailingSlashes(baseUrl ?? '')}${this.basePath}`;
    return agentName === this.defaultAgentName
      ? shared
      : `${trimTrailingSlashes(shared)}/${encodeURIComponent(agentName)}`;
  }

  /**
   * The URL of the HTTP+JSON binding: next to `cardUrl` as `restPath` is next to `basePath`, or
   * `baseUrl` plus `restPath`.
   */
  private restEndpoint(baseUrl?: string): string | null {
    if (!this.restPath) return null;
    const base = trimTrailingSlashes(this.basePath);
    if (this.cardUrl && this.restPath.startsWith(`${base}/`)) {
      return `${this.cardUrl}${this.restPath.slice(base.length)}`;
    }
    if (this.cardUrl && baseUrl === undefined) {
      return `${new URL(this.cardUrl).origin}${this.restPath}`;
    }
    return `${trimTrailingSlashes(baseUrl ?? '')}${this.restPath}`;
  }

  /**
   * Answer a JSON-RPC request that is not streamed. Returns null for a notification (a request
   * without `id`). With `protocolVersion: '1.0'` it takes the A2A 1.0 methods and answers in
   * their form, with `google.rpc` details in the `data` of errors.
   */
  async handleJsonRpc(
    body: unknown,
    authToken?: string,
    options?: A2AHandleOptions
  ): Promise<JsonRpcResponse | null> {
    const v1 = options?.protocolVersion === '1.0';
    const toError = (error: unknown, context: string) =>
      v1 ? toV1JsonRpcError(error, context) : errors.clientJsonRpcError(error, context);
    let request: JsonRpcRequest;
    try {
      request = this.parseRequest(body);
    } catch (e) {
      return createErrorResponse(requestIdOf(body), toError(e, 'parse'));
    }

    let caller: A2ACaller | undefined;
    try {
      caller = await this.authenticate(authToken);
    } catch (e) {
      if (request.id === undefined) return null;
      return createErrorResponse(request.id, toError(e, 'Authentication error'));
    }

    try {
      const result = v1
        ? await dispatchV1(this.operations, request.method, request.params, {
            caller,
            extensions: options?.extensions ?? [],
            ...(options?.baseUrl && { baseUrl: options.baseUrl }),
            ...(options?.agentName !== undefined && { endpointAgent: options.agentName }),
          })
        : await this.routeMethod(request.method, request.params, caller, options);
      if (request.id === undefined) return null;
      return createSuccessResponse(request.id, result);
    } catch (e) {
      if (request.id === undefined) return null;
      return createErrorResponse(request.id, toError(e, `${request.method} failed`));
    }
  }

  /**
   * Answer a JSON-RPC request with a stream of JSON-RPC responses, each the data of one SSE
   * event: for `message/stream` and `tasks/resubscribe` (A2A 1.0: `SendStreamingMessage` and
   * `SubscribeToTask`) the task, then its status and artifact updates until the task ends or
   * waits on the client; a failure ends the stream with an error response. Any other method
   * yields its single response.
   */
  async *handleJsonRpcStream(
    body: unknown,
    authToken?: string,
    signal?: AbortSignal,
    options?: A2AHandleOptions
  ): AsyncGenerator<JsonRpcResponse> {
    const v1 = options?.protocolVersion === '1.0';
    const toError = (error: unknown, context: string) =>
      v1 ? toV1JsonRpcError(error, context) : errors.clientJsonRpcError(error, context);
    let request: JsonRpcRequest;
    try {
      request = this.parseRequest(body);
    } catch (e) {
      yield createErrorResponse(requestIdOf(body), toError(e, 'parse'));
      return;
    }
    const id: RequestId = request.id ?? null;

    let caller: A2ACaller | undefined;
    try {
      caller = await this.authenticate(authToken);
    } catch (e) {
      yield createErrorResponse(id, toError(e, 'Authentication error'));
      return;
    }

    const streaming = v1 ? V1_STREAMING_METHODS : STREAMING_METHODS;
    if (!streaming.includes(request.method)) {
      const response = await this.handleJsonRpc(body, authToken, options);
      if (response) yield response;
      return;
    }

    try {
      if (v1) {
        const events = streamV1(
          this.operations,
          request.method,
          request.params,
          {
            caller,
            extensions: options?.extensions ?? [],
            ...(options?.baseUrl && { baseUrl: options.baseUrl }),
            ...(options?.agentName !== undefined && { endpointAgent: options.agentName }),
          },
          signal
        );
        for await (const event of events) yield createSuccessResponse(id, event);
        return;
      }
      const context = this.legacyContext(caller, options, undefined);
      const events =
        request.method === 'message/stream'
          ? this.streamLegacyMessage(request.params, context, options, signal)
          : this.subscribe(parseTaskIdParams(request.params).id, context, signal);
      for await (const event of events) {
        yield createSuccessResponse(id, event);
      }
    } catch (e) {
      if (signal?.aborted) return;
      yield createErrorResponse(id, toError(e, `${request.method} failed`));
    }
  }

  /**
   * Answer a request of the A2A 1.0 HTTP+JSON binding: `path` is relative to `restPath`, e.g.
   * `/message:send`, `/tasks/<id>` or `/<tenant>/tasks`. The framework adapters call it for
   * every request under `restPath`.
   */
  handleRest(request: A2ARestRequest): Promise<A2ARestResponse> {
    return handleRestRequest(this.operations, request);
  }

  private async *streamLegacyMessage(
    rawParams: unknown,
    context: CallContext,
    options: A2AHandleOptions | undefined,
    signal: AbortSignal | undefined
  ): AsyncGenerator<A2ATask | TaskEvent> {
    const params = parseMessageSendParams(rawParams);
    const agentName = this.legacyAgentName(params, options);
    yield* this.streamMessage(params, { ...context, agentName }, signal);
  }

  private parseRequest(body: unknown): JsonRpcRequest {
    const parsed = parseJsonRpcRequest(body);
    if (Array.isArray(parsed)) {
      throw new A2AError(errors.invalidRequest('Batch requests are not supported'));
    }
    return parsed;
  }

  /**
   * The events of a streamed message: the task as it starts, then its updates until the status
   * update that ends the interaction.
   */
  private async *streamMessage(
    params: MessageSendParams,
    context: CallContext,
    signal: AbortSignal | undefined
  ): AsyncGenerator<A2ATask | TaskEvent> {
    const agent = this.agentOf(context);
    const { message, configuration } = params;
    this.assertRequiredExtensions(context);
    this.validateInitialPushConfig(configuration);
    if (signal?.aborted) return;

    const queue = new TaskEventQueue(this.taskManager, message.taskId ?? null);
    let executingTaskId: string | null = null;
    let executionPromise: Promise<unknown> | null = null;
    const onAbort = () => {
      if (executingTaskId) this.taskManager.abortExecution(executingTaskId);
      queue.notify();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const task = await this.startTask(params, context);
      queue.taskId = task.id;

      let executionDone = false;
      let executionError: unknown;
      executingTaskId = task.id;
      executionPromise = this.taskManager
        .executeTask(task, this.cogitator, agent, message, {
          stream: true,
          timeout: this.runTimeout(agent, configuration?.timeout),
          ...(context.caller && { userId: context.caller.userId }),
        })
        .then(
          () => {
            executionDone = true;
            queue.notify();
          },
          (error: unknown) => {
            executionError = error;
            executionDone = true;
            queue.notify();
          }
        );

      yield this.shapeTask(task, configuration);

      while (!signal?.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
          if (event.kind === 'status-update' && event.final) return;
          continue;
        }
        if (executionDone) {
          if (executionError !== undefined) throw executionError;
          throw new A2AError(
            errors.internalError(
              `Task ${task.id} of ${context.agentName} ended without a final status`
            )
          );
        }
        await queue.wait();
      }
    } finally {
      queue.close();
      signal?.removeEventListener('abort', onAbort);
      if (executingTaskId) this.taskManager.abortExecution(executingTaskId);
      if (executionPromise) await executionPromise;
    }
  }

  /**
   * The events of a subscription to a task: the task as it is now, then, while it still runs in
   * this process, its updates until the status update that ends the interaction. A2A 1.0 refuses
   * a task that already ended (`UnsupportedOperationError`); A2A 0.3 answers with the task alone.
   */
  private async *subscribe(
    taskId: string,
    context: CallContext,
    signal: AbortSignal | undefined
  ): AsyncGenerator<A2ATask | TaskEvent> {
    const queue = new TaskEventQueue(this.taskManager, taskId);
    const onAbort = () => queue.notify();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const task = await this.visibleTask(taskId, context);
      if (context.version === '1.0' && isTerminalState(task.status.state)) {
        throw new A2AError(
          errors.unsupportedOperation(
            `SubscribeToTask: task ${taskId} already ended (${task.status.state})`
          )
        );
      }
      yield this.shapeTask(task);
      if (isStreamFinalState(task.status.state)) return;

      while (!signal?.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
          if (event.kind === 'status-update' && event.final) return;
          continue;
        }
        if (!this.taskManager.isExecuting(taskId)) return;
        await queue.wait();
      }
    } finally {
      queue.close();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The caller of a request: undefined when there is no auth or `validate`
   * admitted it without a user. Throws `unauthorized` otherwise.
   */
  private async authenticate(authToken?: string): Promise<A2ACaller | undefined> {
    if (!this.auth) return undefined;
    if (!authToken) {
      throw new A2AError(errors.unauthorized('Authentication required'));
    }
    const verdict = await this.auth.validate(authToken);
    if (!verdict) {
      throw new A2AError(errors.unauthorized('Invalid credentials'));
    }
    return verdict === true ? undefined : verdict;
  }

  private agentFor(endpointAgent: string | undefined, tenant: string | undefined): string {
    const requested = tenant || undefined;
    if (endpointAgent !== undefined) {
      if (requested !== undefined && requested !== endpointAgent) {
        const description = `is "${requested}", but this endpoint serves agent "${endpointAgent}"`;
        throw new A2AError(errors.invalidParams(`tenant: ${description}`), {
          fieldViolations: [{ field: 'tenant', description }],
        });
      }
      if (!this.hasAgent(endpointAgent)) throw new A2AError(errors.agentNotFound(endpointAgent));
      return endpointAgent;
    }
    const name = requested ?? this.defaultAgentName;
    if (!this.hasAgent(name)) throw new A2AError(errors.agentNotFound(name));
    return name;
  }

  private agentOf(context: CallContext): IAgent {
    if (!this.hasAgent(context.agentName)) {
      throw new A2AError(errors.agentNotFound(context.agentName));
    }
    return this.agents[context.agentName];
  }

  /**
   * A task the caller may see; another user's task is reported as not found, and so is a task
   * bound to another agent (one created over A2A 1.0), whatever the version of the request.
   */
  private async visibleTask(taskId: string, context: CallContext): Promise<A2ATask> {
    const task = await this.taskManager.getTask(taskId);
    if (!isTaskVisibleTo(task, context.caller?.userId) || !isTaskOfAgent(task, context.agentName)) {
      throw new A2AError(errors.taskNotFound(taskId));
    }
    return task;
  }

  /**
   * Rejects joining a context that holds tasks the caller may not see: another user's, or tasks
   * bound to another agent (created over A2A 1.0). A new task reads the transcripts of its
   * context and ends the paused runs of its tasks, so neither may reach across users or agents.
   * Contexts of unbound A2A 0.3 tasks stay open to every agent, as before.
   */
  private async assertContextAvailable(
    contextId: string | undefined,
    context: CallContext
  ): Promise<void> {
    if (!contextId) return;
    const tasks = await this.taskManager.listTasks({ contextId });
    if (
      tasks.some(
        (task) =>
          !isTaskVisibleTo(task, context.caller?.userId) || !isTaskOfAgent(task, context.agentName)
      )
    ) {
      throw new A2AError(errors.invalidParams(`Unknown contextId: ${contextId}`));
    }
  }

  /** Refuses a message that does not ask for an extension the agent requires. */
  private assertRequiredExtensions(context: CallContext): void {
    const missing = missingRequiredExtensions(this.extensions, context.extensions);
    if (missing.length > 0) throw new A2AError(errors.extensionSupportRequired(missing));
  }

  /** The agent of an A2A 0.3 request: its endpoint's, else its `agentName` param, else the first. */
  private legacyAgentName(
    params: Pick<MessageSendParams, 'agentName'>,
    options?: A2AHandleOptions
  ): string {
    const agentName = options?.agentName ?? params.agentName ?? this.defaultAgentName;
    if (!this.hasAgent(agentName)) throw new A2AError(errors.agentNotFound(agentName));
    return agentName;
  }

  private legacyContext(
    caller: A2ACaller | undefined,
    options: A2AHandleOptions | undefined,
    agentName: string | undefined
  ): CallContext {
    return {
      caller,
      agentName: agentName ?? options?.agentName ?? this.defaultAgentName,
      version: '0.3',
      extensions: options?.extensions ?? [],
      ...(options?.baseUrl && { baseUrl: options.baseUrl }),
    };
  }

  /**
   * The run time limit for a task: none of its own unless the client asks for one, and what the
   * client asks for never beyond the agent's `timeout`, or `maxRunTimeoutMs` for an agent
   * without one. A client can shorten a run, never lift or remove the operator's limit.
   */
  private runTimeout(agent: IAgent, requested: number | undefined): number | undefined {
    if (requested === undefined) return undefined;
    const agentTimeout = agent.config?.timeout;
    const ceiling =
      agentTimeout !== undefined && agentTimeout > 0
        ? Math.min(agentTimeout, MAX_RUN_TIMEOUT_MS)
        : this.maxRunTimeoutMs;
    return Math.min(requested, ceiling);
  }

  /** A new task for the message, or the task it continues, ready to execute. */
  private async startTask(params: MessageSendParams, context: CallContext): Promise<A2ATask> {
    const { message, configuration } = params;
    if (message.taskId) {
      const existing = await this.visibleTask(message.taskId, context);
      if (message.contextId && message.contextId !== existing.contextId) {
        throw new A2AError(
          errors.invalidParams(`contextId does not match the context of task ${existing.id}`)
        );
      }
      return this.taskManager.continueTask(message.taskId, message);
    }
    await this.assertContextAvailable(message.contextId, context);
    const task = await this.taskManager.createTask(message, message.contextId, {
      ownerId: context.caller?.userId,
      ...(context.version === '1.0' && { agentName: context.agentName }),
    });
    await this.registerInitialPushConfig(task.id, configuration);
    return task;
  }

  private async routeMethod(
    method: string,
    params: unknown,
    caller: A2ACaller | undefined,
    options: A2AHandleOptions | undefined
  ): Promise<unknown> {
    const context = this.legacyContext(caller, options, undefined);
    switch (method) {
      case 'message/send': {
        const parsed = parseMessageSendParams(params);
        const agentName = this.legacyAgentName(parsed, options);
        return this.sendMessage(parsed, { ...context, agentName });
      }
      case 'message/stream':
      case 'tasks/resubscribe':
        throw new A2AError(
          errors.unsupportedOperation(`${method} streams: use handleJsonRpcStream`)
        );
      case 'tasks/get': {
        const { id, historyLength } = parseTaskQueryParams(params);
        return this.getTask(id, historyLength, context);
      }
      case 'tasks/cancel':
        return this.cancelTask(parseTaskIdParams(params).id, context);
      case 'tasks/list':
        return this.handleLegacyListTasks(params, context);
      case 'tasks/pushNotificationConfig/set': {
        const { taskId, pushNotificationConfig } = parseTaskPushNotificationConfig(params);
        const stored = await this.createPushConfig(taskId, pushNotificationConfig, context);
        return { taskId, pushNotificationConfig: stored } satisfies TaskPushNotificationConfig;
      }
      case 'tasks/pushNotificationConfig/get': {
        const { id, pushNotificationConfigId } = parseGetPushNotificationConfigParams(params);
        const config = await this.getPushConfig(id, pushNotificationConfigId, context);
        return { taskId: id, pushNotificationConfig: config } satisfies TaskPushNotificationConfig;
      }
      case 'tasks/pushNotificationConfig/list': {
        const { id } = parseTaskIdParams(params);
        const configs = await this.listPushConfigs(id, context);
        return configs.map((pushNotificationConfig): TaskPushNotificationConfig => ({
          taskId: id,
          pushNotificationConfig,
        }));
      }
      case 'tasks/pushNotificationConfig/delete': {
        const { id, pushNotificationConfigId } = parseDeletePushNotificationConfigParams(params);
        await this.deletePushConfig(id, pushNotificationConfigId, context);
        return null;
      }
      case 'agent/getAuthenticatedExtendedCard':
        return this.legacyExtendedCard(params, options);
      default:
        throw new A2AError(errors.methodNotFound(method));
    }
  }

  private async sendMessage(params: MessageSendParams, context: CallContext): Promise<A2ATask> {
    const agent = this.agentOf(context);
    const { message, configuration } = params;
    this.assertRequiredExtensions(context);
    this.validateInitialPushConfig(configuration);

    const task = await this.startTask(params, context);
    const execution = this.taskManager.executeTask(task, this.cogitator, agent, message, {
      timeout: this.runTimeout(agent, configuration?.timeout),
      ...(context.caller && { userId: context.caller.userId }),
    });

    if (configuration?.blocking === false) {
      execution.catch((error: unknown) => {
        console.error(`[a2a] Background task ${task.id} failed:`, error);
      });
      return this.shapeTask(task, configuration);
    }

    return this.shapeTask(await execution, configuration);
  }

  private validateInitialPushConfig(configuration?: MessageSendConfiguration): void {
    const pushConfig = configuration?.pushNotificationConfig;
    if (pushConfig) this.assertWebhookAllowed(pushConfig.url);
  }

  private async registerInitialPushConfig(
    taskId: string,
    configuration?: MessageSendConfiguration
  ): Promise<void> {
    const pushConfig = configuration?.pushNotificationConfig;
    if (!pushConfig) return;
    try {
      await this.pushNotificationStore.create(taskId, pushConfig);
    } catch (error) {
      await this.taskManager.failTask(taskId, 'Failed to register push notification');
      throw error;
    }
  }

  private assertWebhookAllowed(webhookUrl: string): void {
    if (this.allowPrivateUrls) return;
    try {
      validateWebhookUrl(webhookUrl);
    } catch (e) {
      throw new A2AError(errors.invalidParams(e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * The task as the client receives it, with `historyLength` and `acceptedOutputModes` applied.
   */
  private shapeTask(
    task: A2ATask,
    configuration?: Pick<MessageSendConfiguration, 'historyLength' | 'acceptedOutputModes'>
  ): A2ATask {
    let shaped = publicTask(task);
    const historyLength = configuration?.historyLength;
    if (historyLength !== undefined) {
      const history = shaped.history ?? [];
      shaped = { ...shaped, history: historyLength === 0 ? [] : history.slice(-historyLength) };
    }
    const accepted = configuration?.acceptedOutputModes;
    if (accepted && accepted.length > 0) {
      shaped = {
        ...shaped,
        artifacts: (shaped.artifacts ?? []).filter((artifact) =>
          artifact.parts.some((part) => accepted.includes(partMimeType(part)))
        ),
      };
    }
    return shaped;
  }

  private async getTask(
    taskId: string,
    historyLength: number | undefined,
    context: CallContext
  ): Promise<A2ATask> {
    return this.shapeTask(await this.visibleTask(taskId, context), { historyLength });
  }

  private async cancelTask(taskId: string, context: CallContext): Promise<A2ATask> {
    await this.visibleTask(taskId, context);
    return publicTask(await this.taskManager.cancelTask(taskId));
  }

  /**
   * Cogitator extension `tasks/list` of A2A 0.3: the caller's tasks, newest first, without the
   * tasks bound to another agent.
   */
  private async handleLegacyListTasks(
    params: unknown,
    context: CallContext
  ): Promise<{ tasks: A2ATask[] }> {
    const raw = parseListTasksParams(params);
    const filter: TaskFilter = {
      contextId: raw.contextId,
      state: raw.state,
      visibleTo: context.caller?.userId ?? null,
    };
    const offset = raw.offset ?? 0;
    const limit = Math.min(raw.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT);
    const tasks = (await this.taskManager.listTasks(filter))
      .filter((task) => isTaskOfAgent(task, context.agentName))
      .slice(offset, offset + limit);
    return { tasks: tasks.map(publicTask) };
  }

  /**
   * A2A 1.0 `ListTasks`: the caller's tasks of the agent, the most recently updated first, a page
   * at a time behind a keyset cursor.
   */
  private async listTasksPage(
    query: ListTasksPageQuery,
    context: CallContext
  ): Promise<ListTasksPage> {
    const matching = (
      await this.taskManager.listTasks({
        ...(query.contextId && { contextId: query.contextId }),
        ...(query.state && { state: query.state }),
        visibleTo: context.caller?.userId ?? null,
      })
    ).filter((task) => isTaskOfAgent(task, context.agentName));
    const page = paginateTasks(matching, query);
    return {
      ...page,
      tasks: page.tasks.map((task) => {
        const shaped = this.shapeTask(task, { historyLength: query.historyLength });
        if (query.includeArtifacts) return shaped;
        const { artifacts: _artifacts, ...rest } = shaped;
        return rest;
      }),
    };
  }

  private async createPushConfig(
    taskId: string,
    config: PushNotificationConfig,
    context: CallContext
  ): Promise<PushNotificationConfig> {
    this.assertWebhookAllowed(config.url);
    await this.visibleTask(taskId, context);
    return publicPushConfig(await this.pushNotificationStore.create(taskId, config));
  }

  private async getPushConfig(
    taskId: string,
    configId: string | undefined,
    context: CallContext
  ): Promise<PushNotificationConfig> {
    await this.visibleTask(taskId, context);
    const config = configId
      ? await this.pushNotificationStore.get(taskId, configId)
      : ((await this.pushNotificationStore.list(taskId))[0] ?? null);
    if (!config) {
      throw new A2AError(errors.pushNotificationConfigNotFound(taskId, configId ?? taskId));
    }
    return publicPushConfig(config);
  }

  private async listPushConfigs(
    taskId: string,
    context: CallContext
  ): Promise<PushNotificationConfig[]> {
    await this.visibleTask(taskId, context);
    return (await this.pushNotificationStore.list(taskId)).map(publicPushConfig);
  }

  private async deletePushConfig(
    taskId: string,
    configId: string,
    context: CallContext
  ): Promise<void> {
    await this.visibleTask(taskId, context);
    await this.pushNotificationStore.delete(taskId, configId);
  }

  private legacyExtendedCard(params: unknown, options: A2AHandleOptions | undefined): AgentCard {
    if (!this.extendedCardGenerator) {
      throw new A2AError(errors.authenticatedExtendedCardNotConfigured());
    }
    const requested =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as { agentName?: unknown }).agentName
        : undefined;
    const name =
      options?.agentName ?? (typeof requested === 'string' ? requested : this.defaultAgentName);
    if (!this.hasAgent(name)) throw new A2AError(errors.agentNotFound(name));
    const card = this.extendedCardGenerator(name);
    if (this.legacySigning) return signAgentCard(card, this.legacySigning);
    if (this.signer) return { ...card, signatures: [this.signer.signature(card)] };
    return card;
  }

  /**
   * A2A 1.0 `GetExtendedAgentCard`: the card `extendedCardGenerator` returns, in its 1.0 form.
   * It keeps the interfaces it lists in `supportedInterfaces`, else gets the agent's own.
   */
  private v1ExtendedCard(context: CallContext): V1AgentCard {
    if (!this.extendedCardGenerator) {
      throw new A2AError(
        errors.unsupportedOperation(
          'GetExtendedAgentCard (the agent declares no extended Agent Card)'
        )
      );
    }
    const card = this.extendedCardGenerator(context.agentName);
    const model = cardModelFromLegacy(card);
    if (!card.supportedInterfaces?.length) {
      model.interfaces = this.interfaces(context.agentName, context.baseUrl);
    }
    model.capabilities = { ...model.capabilities, extendedAgentCard: true };
    return this.signedV1(toV1Card(model));
  }
}

function resolveProtocolVersions(
  versions: readonly A2AProtocolVersion[] | undefined
): readonly A2AProtocolVersion[] {
  if (versions === undefined) return SUPPORTED_PROTOCOL_VERSIONS;
  const unknown = versions.filter((version) => !SUPPORTED_PROTOCOL_VERSIONS.includes(version));
  if (versions.length === 0 || unknown.length > 0) {
    throw new Error(
      `A2AServer protocolVersions must list some of ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}${
        unknown.length > 0 ? `, got ${unknown.join(', ')}` : ''
      }`
    );
  }
  return SUPPORTED_PROTOCOL_VERSIONS.filter((version) => versions.includes(version));
}

/** The built-in extensions, then the configured ones; a configured URI replaces a built-in one. */
function mergeExtensions(
  builtIn: readonly AgentExtension[],
  configured: readonly AgentExtension[]
): readonly AgentExtension[] {
  const configuredUris = new Set(configured.map((extension) => extension.uri));
  return [
    ...builtIn.filter((extension) => !configuredUris.has(extension.uri)),
    ...configured.map((extension) => ({ ...extension })),
  ];
}
