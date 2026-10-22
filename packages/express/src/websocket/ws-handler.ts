import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Request } from 'express';
import { getLogger, type Agent } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import type {
  AuthContext,
  WebSocketMessage,
  WebSocketResponse,
  RouteContext,
  WebSocketConfig,
} from '../types.js';
import {
  admitCaller,
  authorizeThreadAccess,
  isJsonObject,
  type AuthorizeThread,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
  toAgentToolCall,
  type ContextPolicy,
  type ResumeRequestBody,
} from '@cogitator-ai/server-shared';
import { generateId } from '../streaming/helpers.js';
import { resolveError } from '../routes/utils.js';

type WebSocketType = import('ws').WebSocket;
type WebSocketServerType = import('ws').WebSocketServer;

const WS_OPEN = 1;
const MAX_SUBSCRIPTIONS = 64;
const MAX_CHANNEL_LENGTH = 256;
const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'subscribe',
  'unsubscribe',
  'run',
  'resume',
  'stop',
  'ping',
]);

interface ClientState {
  id: string;
  /** The upgrade request, which `websocket.deps` builds a run's deps from */
  request: IncomingMessage;
  auth?: AuthContext;
  subscriptions: Set<string>;
  abortController?: AbortController;
}

interface RunPayload {
  type: 'agent' | 'workflow' | 'swarm';
  name: string;
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
}

interface ResumePayload extends ResumeRequestBody {
  name: string;
}

type AgentRunControls = Pick<
  RunOptions,
  | 'userId'
  | 'signal'
  | 'stream'
  | 'onToken'
  | 'onReasoning'
  | 'onToolCall'
  | 'onToolResult'
  | 'onRunStart'
  | 'deps'
>;

/**
 * The subscribers of each channel, with what authentication returned for them. A run's events
 * reach a subscriber only when it acts as the user who started the run and `authorizeThread`
 * lets it on the run's thread, so a caller never sees the prompts and results of a run it
 * could not open itself.
 */
class ChannelHub {
  private readonly channels = new Map<string, Map<WebSocketType, AuthContext | undefined>>();

  constructor(private readonly authorizeThread: AuthorizeThread<AuthContext> | undefined) {}

  subscribe(ws: WebSocketType, channel: string, auth: AuthContext | undefined): void {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Map();
      this.channels.set(channel, members);
    }
    members.set(ws, auth);
  }

  unsubscribe(ws: WebSocketType, channel: string): void {
    const members = this.channels.get(channel);
    if (!members) return;
    members.delete(ws);
    if (members.size === 0) this.channels.delete(channel);
  }

  /** The fan-out of one run's events to the subscribers of `channel` */
  broadcast(
    channel: string,
    origin: { ws: WebSocketType; auth: AuthContext | undefined }
  ): RunBroadcast {
    return new RunBroadcast(
      () => this.channels.get(channel),
      channel,
      origin,
      this.authorizeThread
    );
  }
}

/**
 * Sends one run's events to the subscribers allowed to see them. Whether a subscriber may is
 * asked of `authorizeThread` once per run, with the run's thread, and its events wait for the
 * answer in the order they were published. A subscriber the authorizer refuses, or throws for,
 * gets none of them, and with an authorizer set a run whose thread is not known yet is shown
 * to nobody.
 */
class RunBroadcast {
  private threadId: string | undefined;
  private readonly deliveries = new Map<WebSocketType, Promise<boolean>>();

  constructor(
    private readonly members: () => ReadonlyMap<WebSocketType, AuthContext | undefined> | undefined,
    private readonly channel: string,
    private readonly origin: { ws: WebSocketType; auth: AuthContext | undefined },
    private readonly authorizeThread: AuthorizeThread<AuthContext> | undefined
  ) {}

  /** Names the thread the run is on, once it is known */
  onThread(threadId: string): void {
    this.threadId = threadId;
  }

  publish(response: WebSocketResponse): void {
    const members = this.members();
    if (!members) return;
    for (const [member, auth] of members) {
      if (member === this.origin.ws || auth?.userId !== this.origin.auth?.userId) continue;
      const admitted = this.deliveries.get(member) ?? this.admit(auth);
      this.deliveries.set(
        member,
        admitted.then((allowed) => {
          if (allowed) sendResponse(member, { ...response, channel: this.channel });
          return allowed;
        })
      );
    }
  }

  private async admit(auth: AuthContext | undefined): Promise<boolean> {
    if (!this.authorizeThread) return true;
    if (this.threadId === undefined) return false;
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => resolve(false), SUBSCRIBER_AUTHORIZATION_MS);
        authorizeThreadAccess(this.authorizeThread, auth, this.threadId)
          .then((refusal) => resolve(refusal === undefined), reject)
          .finally(() => clearTimeout(timer));
      });
    } catch (error) {
      console.error('[CogitatorServer] authorizeThread failed for a WebSocket subscriber:', error);
      return false;
    }
  }
}

/**
 * How long `authorizeThread` may take to answer for a subscriber before it counts as a refusal,
 * so a hook that hangs never holds the run's events for the subscriber in memory
 */
const SUBSCRIBER_AUTHORIZATION_MS = 5000;

function parseMessage(raw: string): WebSocketMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(data) || typeof data.type !== 'string' || !MESSAGE_TYPES.has(data.type)) {
    return null;
  }
  if (data.id !== undefined && typeof data.id !== 'string') return null;
  if (data.channel !== undefined && typeof data.channel !== 'string') return null;
  return {
    type: data.type as WebSocketMessage['type'],
    id: data.id,
    channel: data.channel,
    payload: data.payload,
  };
}

function parseRunPayload(payload: unknown, acceptContext: ContextPolicy): RunPayload | null {
  if (!isJsonObject(payload)) return null;
  const { type, name } = payload;
  if (type !== 'agent' && type !== 'workflow' && type !== 'swarm') return null;
  if (typeof name !== 'string' || !name) return null;
  const parsed = parseRunRequest(payload, { acceptContext });
  return parsed.ok ? { type, name, ...parsed.value } : null;
}

function parseResumePayload(payload: unknown): ResumePayload | null {
  if (!isJsonObject(payload)) return null;
  const { name } = payload;
  if (typeof name !== 'string' || !name) return null;
  const parsed = parseResumeRequest(payload);
  return parsed.ok ? { name, ...parsed.value } : null;
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
  );
}

/**
 * Attach the Cogitator WebSocket protocol to an HTTP server.
 *
 * When `ctx.config.auth` is set it is called with the upgrade request; connections whose
 * auth function throws, or that carry no user id under `anonymous: 'deny'`, are rejected
 * with 401. Returns `null` when the optional `ws` package is not installed.
 */
export async function setupWebSocket(
  server: HttpServer,
  ctx: RouteContext,
  config: WebSocketConfig = {}
): Promise<WebSocketServerType | null> {
  let wsModule: typeof import('ws');
  try {
    wsModule = await import('ws');
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    console.warn('[CogitatorServer] WebSocket setup failed (ws package not installed)');
    return null;
  }

  const authFn = ctx.config.auth;
  const anonymous = ctx.config.anonymous;
  const authResults = new WeakMap<IncomingMessage, AuthContext | undefined>();
  const hub = new ChannelHub(ctx.config.authorizeThread);
  const path = config.path || `${ctx.config.basePath}/ws`;

  const wss = new wsModule.WebSocketServer({
    server,
    path,
    maxPayload: config.maxPayloadSize || 1024 * 1024,
    verifyClient:
      authFn || anonymous === 'deny'
        ? (info, callback) => {
            Promise.resolve()
              .then(() => authFn?.(info.req as Request))
              .then((auth) => {
                if (admitCaller(auth?.userId, anonymous)) {
                  callback(false, 401, 'Unauthorized');
                  return;
                }
                authResults.set(info.req, auth);
                callback(true);
              })
              .catch(() => callback(false, 401, 'Unauthorized'));
          }
        : undefined,
  });

  const pingInterval = config.pingInterval || 30000;

  wss.on('connection', (ws: WebSocketType, req: IncomingMessage) => {
    const clientState: ClientState = {
      id: generateId('ws'),
      request: req,
      auth: authResults.get(req),
      subscriptions: new Set(),
    };

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, pingInterval);

    ws.on('pong', () => {
      alive = true;
    });

    ws.on('message', (data: Buffer) => {
      const message = parseMessage(data.toString());
      if (!message) {
        sendResponse(ws, { type: 'error', error: 'Invalid message' });
        return;
      }
      void handleMessage(ws, message, ctx, config, clientState, hub);
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      clientState.abortController?.abort();
      clientState.abortController = undefined;
      for (const channel of clientState.subscriptions) hub.unsubscribe(ws, channel);
      clientState.subscriptions.clear();
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  wss.on('close', () => {
    for (const client of wss.clients) client.terminate();
  });

  getLogger().debug('[CogitatorServer] WebSocket enabled', { path });
  return wss;
}

async function handleMessage(
  ws: WebSocketType,
  message: WebSocketMessage,
  ctx: RouteContext,
  config: WebSocketConfig,
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  switch (message.type) {
    case 'ping':
      sendResponse(ws, { type: 'pong', id: message.id });
      break;

    case 'subscribe': {
      const channel = message.channel;
      if (!channel || channel.length > MAX_CHANNEL_LENGTH) {
        sendResponse(ws, { type: 'error', id: message.id, error: 'Invalid channel' });
        break;
      }
      if (!state.subscriptions.has(channel) && state.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        sendResponse(ws, {
          type: 'error',
          id: message.id,
          error: `Subscription limit reached (max ${MAX_SUBSCRIPTIONS})`,
        });
        break;
      }
      state.subscriptions.add(channel);
      hub.subscribe(ws, channel, state.auth);
      sendResponse(ws, { type: 'subscribed', id: message.id, channel });
      break;
    }

    case 'unsubscribe':
      if (message.channel) {
        state.subscriptions.delete(message.channel);
        hub.unsubscribe(ws, message.channel);
        sendResponse(ws, { type: 'unsubscribed', id: message.id, channel: message.channel });
      }
      break;

    case 'run':
      await handleRun(ws, message, ctx, config, state, hub);
      break;

    case 'resume':
      await handleResume(ws, message, ctx, config, state, hub);
      break;

    case 'stop':
      state.abortController?.abort();
      state.abortController = undefined;
      break;
  }
}

async function handleRun(
  ws: WebSocketType,
  message: WebSocketMessage,
  ctx: RouteContext,
  config: WebSocketConfig,
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  const payload = parseRunPayload(message.payload, ctx.config.acceptContext);

  if (!payload) {
    sendResponse(ws, { type: 'error', id: message.id, error: 'Invalid run payload' });
    return;
  }

  if (payload.type !== 'agent') {
    sendResponse(ws, {
      type: 'error',
      id: message.id,
      error: `Run type '${payload.type}' is not supported over WebSocket`,
    });
    return;
  }

  await streamAgentRun(ws, message, ctx, config, state, hub, payload, (agent, options) =>
    ctx.cogitator.run(agent, {
      ...options,
      input: payload.input,
      context: payload.context,
      threadId: payload.threadId,
    })
  );
}

async function handleResume(
  ws: WebSocketType,
  message: WebSocketMessage,
  ctx: RouteContext,
  config: WebSocketConfig,
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  const payload = parseResumePayload(message.payload);

  if (!payload) {
    sendResponse(ws, { type: 'error', id: message.id, error: 'Invalid resume payload' });
    return;
  }

  await streamAgentRun(ws, message, ctx, config, state, hub, payload, (agent, options) =>
    ctx.cogitator.resume(agent, payload.threadId, {
      ...options,
      decisions: payload.decisions,
      defaultDecision: payload.defaultDecision,
    })
  );
}

async function streamAgentRun(
  ws: WebSocketType,
  message: WebSocketMessage,
  ctx: RouteContext,
  config: WebSocketConfig,
  state: ClientState,
  hub: ChannelHub,
  target: { name: string; threadId?: string },
  execute: (agent: Agent, options: AgentRunControls) => Promise<RunResult>
): Promise<void> {
  const { name } = target;
  const agent = Object.hasOwn(ctx.agents, name) ? ctx.agents[name] : undefined;
  if (!agent) {
    sendResponse(ws, {
      type: 'error',
      id: message.id,
      error: `Agent '${name}' not found`,
    });
    return;
  }

  let deps: { deps?: unknown };
  try {
    const refusal = await authorizeThreadAccess(
      ctx.config.authorizeThread,
      state.auth,
      target.threadId
    );
    if (refusal) {
      sendResponse(ws, { type: 'error', id: message.id, error: refusal.message });
      return;
    }
    deps = config.deps ? { deps: await config.deps(state.request) } : {};
  } catch (error) {
    sendResponse(ws, {
      type: 'error',
      id: message.id,
      error: resolveError(error, 'WebSocket run').message,
    });
    return;
  }

  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;

  const broadcast = hub.broadcast(`agent:${name}`, { ws, auth: state.auth });
  if (target.threadId !== undefined) broadcast.onThread(target.threadId);
  const emit = (eventPayload: Record<string, unknown>) => {
    const response: WebSocketResponse = { type: 'event', id: message.id, payload: eventPayload };
    sendResponse(ws, response);
    broadcast.publish(response);
  };

  try {
    const result = await execute(agent, {
      userId: state.auth?.userId,
      signal: controller.signal,
      stream: true,
      ...deps,
      onRunStart: ({ threadId }) => {
        broadcast.onThread(threadId);
      },
      onToken: (token) => {
        emit({ type: 'token', delta: token });
      },
      onReasoning: (delta) => {
        emit({ type: 'reasoning', delta });
      },
      onToolCall: (toolCall) => {
        emit({ type: 'tool-call', ...toAgentToolCall(toolCall) });
      },
      onToolResult: (toolResult) => {
        emit({ type: 'tool-result', ...toolResult });
      },
    });

    emit({ type: 'complete', result: toAgentRunResponse(result) });
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'cancelled' });
    } else {
      sendResponse(ws, {
        type: 'error',
        id: message.id,
        error: resolveError(error, 'WebSocket run').message,
      });
    }
  } finally {
    if (state.abortController === controller) state.abortController = undefined;
  }
}

function sendResponse(ws: WebSocketType, response: WebSocketResponse): void {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify(response));
  } catch {}
}
