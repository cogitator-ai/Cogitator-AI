import {
  JSON_RPC_ERROR_CODES,
  JsonRpcCallError,
  JsonRpcPeer,
  isJsonRpcResponse,
  toPendingApprovals,
  type JsonRpcHandlerContext,
  type JsonRpcId,
  type JsonRpcMessage,
} from '@cogitator-ai/server-shared';
import type { ToolApprovalDecision } from '@cogitator-ai/types';
import type { z } from 'zod';
import { APP_SERVER_ERROR_CODES } from '../protocol/errors.js';
import { APP_SERVER_METHODS, type AppServerMethod } from '../protocol/methods.js';
import { ApprovalRequestResultSchema } from '../protocol/session.js';
import type {
  AppServerNotification,
  ApprovalRequestParams,
  InitializeParams,
} from '../protocol/types.js';
import { describeAppServerError, invalidParams } from '../host/errors.js';
import type { ApprovalAsk, SessionHost, TurnStartOptions } from '../host/session-host.js';

/** Hands a message, or a batch of answers, to the client. Calls must go out in the order made */
export type AppServerSend = (message: JsonRpcMessage | JsonRpcMessage[]) => void | Promise<void>;

export interface AppServerOptions {
  /** Hears what went wrong outside a call, such as a message that could not be sent */
  onError?: (error: Error) => void;
}

type Params<M extends AppServerMethod> = z.output<(typeof APP_SERVER_METHODS)[M]['params']>;
type Result<M extends AppServerMethod> = z.input<(typeof APP_SERVER_METHODS)[M]['result']>;

const PERMISSION_OPTIONS: ApprovalRequestParams['options'] = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
];

/**
 * The app-server: JSON-RPC 2.0 over any transport that moves whole messages, dispatching to a
 * {@link SessionHost}. Each client gets a connection of its own with {@link connect}; one host
 * serves them all, and its notifications reach every initialized connection.
 */
export class AppServer {
  constructor(
    readonly host: SessionHost,
    private readonly options: AppServerOptions = {}
  ) {}

  /** A connection for one client, its messages going out through `send` */
  connect(send: AppServerSend): AppServerConnection {
    return new AppServerConnection(this.host, send, this.options);
  }
}

/** Creates an app-server over `host` */
export function createAppServer(host: SessionHost, options: AppServerOptions = {}): AppServer {
  return new AppServer(host, options);
}

/**
 * One client of the app-server. Pass every message it sends, already read from JSON, to
 * {@link receive}. Nothing but `initialize` is answered before the client initialized
 * (`-32010`). The answer to `turn/start` and `review/start` goes out before `turn/started`.
 */
export class AppServerConnection {
  private readonly peer: JsonRpcPeer;
  private readonly answered = new Map<JsonRpcId, () => void>();
  private readonly unsubscribe: () => void;
  private readonly asking = new AbortController();
  private client: InitializeParams | undefined;
  private optedOut = new Set<string>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly host: SessionHost,
    send: AppServerSend,
    private readonly options: AppServerOptions
  ) {
    this.peer = new JsonRpcPeer({
      send: (message) => {
        const sent = send(message);
        this.settleAnswered(message);
        return sent;
      },
      describeError: (error) => describeAppServerError(error, host.exposesErrors),
      ...(options.onError && { onError: options.onError }),
    });
    this.register();
    this.unsubscribe = host.subscribe((notification) => this.forward(notification));
  }

  /** Whether the client initialized */
  get initialized(): boolean {
    return this.client !== undefined;
  }

  /** What the client said of itself in `initialize` */
  get clientInfo(): InitializeParams['clientInfo'] | undefined {
    return this.client?.clientInfo;
  }

  get closed(): boolean {
    return this.peer.closed;
  }

  /** Handles a message, or a batch, the client sent. Resolves once it is answered */
  receive(value: unknown): Promise<void> {
    return this.peer.receive(value);
  }

  /** Answers a line that was not JSON with a parse error, as JSON-RPC asks */
  async receiveUnreadable(message: string): Promise<void> {
    if (this.peer.closed) return;
    await this.peer.respondError(null, { code: JSON_RPC_ERROR_CODES.parseError, message });
  }

  /**
   * Closes the connection: approvals it still waits on leave their turns paused, the turns it
   * started are interrupted and waited for (their `turn/completed` still goes out), then nothing
   * more is sent
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const settle of this.answered.values()) settle();
      this.answered.clear();
      this.asking.abort(new Error('The client went away'));
      await this.host.interruptOwned(this);
      this.unsubscribe();
      this.peer.close();
    })();
    return this.closing;
  }

  private register(): void {
    this.peer.onNotification('initialized', () => undefined);
    this.method('initialize', async (params) => {
      if (this.client) {
        throw new JsonRpcCallError({
          code: APP_SERVER_ERROR_CODES.alreadyInitialized,
          message: 'The client initialized already',
        });
      }
      this.client = params;
      this.optedOut = new Set(params.capabilities?.optOutNotifications ?? []);
      const described = await this.host.describe();
      return { protocolVersion: this.host.protocolVersion, ...described };
    });
    this.method('thread/start', async (params) => ({
      thread: await this.host.startThread(params),
    }));
    this.method('thread/resume', (params) => this.host.resumeThread(params.threadId));
    this.method('thread/fork', async (params) => ({
      thread: await this.host.forkThread(params),
    }));
    this.method('thread/list', (params) => this.host.listThreads(params));
    this.method('thread/archive', async (params) => ({
      thread: await this.host.archiveThread(params.threadId, true),
    }));
    this.method('thread/unarchive', async (params) => ({
      thread: await this.host.archiveThread(params.threadId, false),
    }));
    this.method('thread/setPermissionMode', async (params) => ({
      thread: await this.host.setPermissionMode(params.threadId, params.mode),
    }));
    this.method('turn/start', (params, context) =>
      this.afterAnswer(context, async (options) => ({
        turn: await this.host.startTurn(params, options),
      }))
    );
    this.method('turn/steer', (params) => this.host.steerTurn(params));
    this.method('turn/interrupt', (params) =>
      this.host.interruptTurn(params.threadId, params.turnId)
    );
    this.method('review/start', (params, context) =>
      this.afterAnswer(context, (options) => this.host.startReview(params, options))
    );
    this.method('_cogitator/memory/search', (params) => this.host.searchMemory(params));
    this.method('_cogitator/thread/rewind', (params) => this.host.rewindThread(params));
    if (this.host.runner('workflow')) {
      this.method('_cogitator/workflow/list', async () => ({
        items: [...(await this.host.runner('workflow')!.list())],
      }));
      this.method('_cogitator/workflow/run', (params) =>
        this.host.run('workflow', params.name, params.input)
      );
    }
    if (this.host.runner('swarm')) {
      this.method('_cogitator/swarm/list', async () => ({
        items: [...(await this.host.runner('swarm')!.list())],
      }));
      this.method('_cogitator/swarm/run', (params) =>
        this.host.run('swarm', params.name, params.input)
      );
    }
  }

  /** Answers `method`: its params checked against its schema, only once initialized */
  private method<M extends AppServerMethod>(
    method: M,
    handler: (params: Params<M>, context: JsonRpcHandlerContext) => Result<M> | Promise<Result<M>>
  ): void {
    const schema = APP_SERVER_METHODS[method].params;
    this.peer.onRequest(method, async (raw, context) => {
      if (method !== 'initialize' && !this.client) {
        throw new JsonRpcCallError({
          code: APP_SERVER_ERROR_CODES.notInitialized,
          message: 'The client has not initialized: send initialize first',
        });
      }
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) throw invalidParams(`Invalid params for ${method}`, parsed.error);
      return handler(parsed.data as Params<M>, context);
    });
  }

  /**
   * Runs a request that starts a turn, the turn held until its answer went out, or until the
   * request failed
   */
  private async afterAnswer<T>(
    context: JsonRpcHandlerContext,
    start: (options: TurnStartOptions) => Promise<T>
  ): Promise<T> {
    const id = context.id ?? null;
    let settle = () => undefined as void;
    const after = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.answered.set(id, settle);
    try {
      return await start({
        after,
        owner: this,
        ...(this.client?.capabilities?.approvals === 'request' && {
          onApproval: (ask: ApprovalAsk) => this.askApproval(ask),
        }),
      });
    } catch (error) {
      this.answered.delete(id);
      settle();
      throw error;
    }
  }

  private settleAnswered(message: JsonRpcMessage | JsonRpcMessage[]): void {
    for (const item of Array.isArray(message) ? message : [message]) {
      if (!isJsonRpcResponse(item)) continue;
      const settle = this.answered.get(item.id);
      if (!settle) continue;
      this.answered.delete(item.id);
      settle();
    }
  }

  private async askApproval(ask: ApprovalAsk): Promise<ToolApprovalDecision | 'pause'> {
    if (this.peer.closed || this.asking.signal.aborted) return 'pause';
    const [toolCall] = toPendingApprovals([ask.request]);
    const params: ApprovalRequestParams = {
      threadId: ask.threadId,
      turnId: ask.turnId,
      toolCall: {
        ...toolCall!,
        ...(ask.request.subagent !== undefined && { subagent: ask.request.subagent }),
      },
      options: PERMISSION_OPTIONS,
    };
    let answer: unknown;
    try {
      answer = await this.peer.request('approval/request', params, {
        signal: this.asking.signal,
      });
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return 'pause';
    }
    const parsed = ApprovalRequestResultSchema.safeParse(answer);
    if (!parsed.success || parsed.data.outcome.outcome === 'cancelled') return 'pause';
    switch (parsed.data.outcome.optionId) {
      case 'allow_once':
      case 'allow_always':
        return {
          approved: true,
          ...(parsed.data.updatedArguments && { updatedArguments: parsed.data.updatedArguments }),
          ...(parsed.data.outcome.optionId === 'allow_always' && { remember: true }),
        };
      case 'reject_once':
      case 'reject_always':
        return {
          approved: false,
          ...(parsed.data.reason !== undefined && { reason: parsed.data.reason }),
        };
    }
  }

  private forward(notification: AppServerNotification): void {
    if (!this.client || this.peer.closed || this.optedOut.has(notification.method)) return;
    this.peer.notify(notification.method, notification.params).catch((error: unknown) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }
}
