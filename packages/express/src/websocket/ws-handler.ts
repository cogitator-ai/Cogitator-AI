import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Request } from 'express';
import { getLogger, type Agent } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import type {
  AgentResumeRequest,
  AuthContext,
  WebSocketMessage,
  WebSocketResponse,
  RouteContext,
  WebSocketConfig,
} from '../types.js';
import { isNonBlankString } from '@cogitator-ai/server-shared';
import { generateId } from '../streaming/helpers.js';
import { parseResumeBody, resolveError, withoutCheckpoint } from '../routes/utils.js';

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

interface ResumePayload extends AgentResumeRequest {
  name: string;
}

type AgentRunControls = Pick<
  RunOptions,
  'userId' | 'signal' | 'stream' | 'onToken' | 'onReasoning' | 'onToolCall' | 'onToolResult'
>;

/**
 * Run events fan out only to subscribers acting as the user who started the run,
 * so one user's prompts and results never reach another user's socket.
 */
class ChannelHub {
  private readonly channels = new Map<string, Map<WebSocketType, string | undefined>>();

  subscribe(ws: WebSocketType, channel: string, userId: string | undefined): void {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Map();
      this.channels.set(channel, members);
    }
    members.set(ws, userId);
  }

  unsubscribe(ws: WebSocketType, channel: string): void {
    const members = this.channels.get(channel);
    if (!members) return;
    members.delete(ws);
    if (members.size === 0) this.channels.delete(channel);
  }

  publish(
    channel: string,
    response: WebSocketResponse,
    origin: { ws: WebSocketType; userId: string | undefined }
  ): void {
    const members = this.channels.get(channel);
    if (!members) return;
    for (const [member, userId] of members) {
      if (member !== origin.ws && userId === origin.userId) {
        sendResponse(member, { ...response, channel });
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMessage(raw: string): WebSocketMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(data) || typeof data.type !== 'string' || !MESSAGE_TYPES.has(data.type)) {
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

function parseRunPayload(payload: unknown): RunPayload | null {
  if (!isPlainObject(payload)) return null;
  const { type, name, input, context, threadId } = payload;
  if (type !== 'agent' && type !== 'workflow' && type !== 'swarm') return null;
  if (typeof name !== 'string' || !name) return null;
  if (!isNonBlankString(input)) return null;
  if (context !== undefined && !isPlainObject(context)) return null;
  if (threadId !== undefined && typeof threadId !== 'string') return null;
  return { type, name, input, context, threadId };
}

function parseResumePayload(payload: unknown): ResumePayload | null {
  if (!isPlainObject(payload)) return null;
  const { name } = payload;
  if (typeof name !== 'string' || !name) return null;
  const parsed = parseResumeBody(payload);
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
 * auth function throws are rejected with 401. Returns `null` when the optional `ws`
 * package is not installed.
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
  const authResults = new WeakMap<IncomingMessage, AuthContext | undefined>();
  const hub = new ChannelHub();
  const path = config.path || `${ctx.config.basePath}/ws`;

  const wss = new wsModule.WebSocketServer({
    server,
    path,
    maxPayload: config.maxPayloadSize || 1024 * 1024,
    verifyClient: authFn
      ? (info, callback) => {
          Promise.resolve()
            .then(() => authFn(info.req as Request))
            .then((auth) => {
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
      void handleMessage(ws, message, ctx, clientState, hub);
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
      hub.subscribe(ws, channel, state.auth?.userId);
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
      await handleRun(ws, message, ctx, state, hub);
      break;

    case 'resume':
      await handleResume(ws, message, ctx, state, hub);
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
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  const payload = parseRunPayload(message.payload);

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

  await streamAgentRun(ws, message, ctx, state, hub, payload.name, (agent, options) =>
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
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  const payload = parseResumePayload(message.payload);

  if (!payload) {
    sendResponse(ws, { type: 'error', id: message.id, error: 'Invalid resume payload' });
    return;
  }

  await streamAgentRun(ws, message, ctx, state, hub, payload.name, (agent, options) =>
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
  state: ClientState,
  hub: ChannelHub,
  name: string,
  execute: (agent: Agent, options: AgentRunControls) => Promise<RunResult>
): Promise<void> {
  const agent = Object.hasOwn(ctx.agents, name) ? ctx.agents[name] : undefined;
  if (!agent) {
    sendResponse(ws, {
      type: 'error',
      id: message.id,
      error: `Agent '${name}' not found`,
    });
    return;
  }

  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;

  const channel = `agent:${name}`;
  const emit = (eventPayload: Record<string, unknown>) => {
    const response: WebSocketResponse = { type: 'event', id: message.id, payload: eventPayload };
    sendResponse(ws, response);
    hub.publish(channel, response, { ws, userId: state.auth?.userId });
  };

  try {
    const result = await execute(agent, {
      userId: state.auth?.userId,
      signal: controller.signal,
      stream: true,
      onToken: (token) => {
        emit({ type: 'token', delta: token });
      },
      onReasoning: (delta) => {
        emit({ type: 'reasoning', delta });
      },
      onToolCall: (toolCall) => {
        emit({ type: 'tool-call', ...toolCall });
      },
      onToolResult: (toolResult) => {
        emit({ type: 'tool-result', ...toolResult });
      },
    });

    emit({ type: 'complete', result: withoutCheckpoint(result) });
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
