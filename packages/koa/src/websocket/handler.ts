import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import type {
  AuthContext,
  RouteContext,
  WebSocketAuthFunction,
  WebSocketConfig,
  WebSocketResponse,
  WebSocketRunPayload,
} from '../types.js';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { isModuleNotFoundError, resolveError } from '../utils/errors.js';
import { toSwarmRunResponse, toWorkflowRunResponse } from '../utils/results.js';
import { isRecord } from '../utils/validation.js';

type WebSocketType = import('ws').WebSocket;
type WebSocketServerType = import('ws').WebSocketServer;
type RawData = import('ws').RawData;

interface ClientState {
  auth?: AuthContext;
  abortController?: AbortController;
}

type AuthorizeOutcome = { ok: true; auth: AuthContext | undefined } | { ok: false; status: number };

type ParsedMessage =
  | { type: 'ping'; id?: string }
  | { type: 'stop'; id?: string }
  | { type: 'run'; id?: string; payload: unknown };

const WS_OPEN = 1;
const DEFAULT_PATH = '/ws';
const DEFAULT_PING_INTERVAL = 30_000;
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const RUN_TYPES: readonly WebSocketRunPayload['type'][] = ['agent', 'workflow', 'swarm'];

function isRunType(value: unknown): value is WebSocketRunPayload['type'] {
  return RUN_TYPES.some((runType) => runType === value);
}

class ClientFacingError extends Error {}

export async function setupWebSocket(
  server: HttpServer,
  ctx: RouteContext,
  config: WebSocketConfig = {}
): Promise<WebSocketServerType | null> {
  let wsModule: typeof import('ws');
  try {
    wsModule = await import('ws');
  } catch (error) {
    if (!isModuleNotFoundError(error)) throw error;
    console.warn('[CogitatorKoa] WebSocket setup skipped: the "ws" package is not installed');
    return null;
  }

  const path = config.path ?? DEFAULT_PATH;
  const pingInterval = config.pingInterval ?? DEFAULT_PING_INTERVAL;
  const pingTimeout = config.pingTimeout ?? pingInterval;
  const wss = new wsModule.WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD,
  });
  const authResults = new WeakMap<IncomingMessage, AuthContext | undefined>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (getPathname(req) !== path) {
      if (server.listenerCount('upgrade') === 1) rejectUpgrade(socket, 404);
      return;
    }

    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);

    void authorize(config.auth, req).then((outcome) => {
      if (!outcome.ok) {
        rejectUpgrade(socket, outcome.status);
        return;
      }
      if (socket.destroyed) return;
      socket.off('error', onSocketError);
      authResults.set(req, outcome.auth);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  };

  server.on('upgrade', onUpgrade);
  wss.on('close', () => {
    server.off('upgrade', onUpgrade);
  });

  wss.on('connection', (ws: WebSocketType, req: IncomingMessage) => {
    handleConnection(ws, ctx, authResults.get(req), pingInterval, pingTimeout);
  });

  return wss;
}

function getPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
}

async function authorize(
  auth: WebSocketAuthFunction | undefined,
  req: IncomingMessage
): Promise<AuthorizeOutcome> {
  if (!auth) return { ok: true, auth: undefined };
  try {
    return { ok: true, auth: await auth(req) };
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status !== undefined && status >= 500) {
      console.error('[CogitatorKoa] WebSocket auth error:', error);
      return { ok: false, status: 500 };
    }
    return { ok: false, status: 401 };
  }
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.writable) {
    const message = STATUS_CODES[status] ?? 'Error';
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain\r\n' +
        `Content-Length: ${Buffer.byteLength(message)}\r\n` +
        `\r\n${message}`
    );
  }
  socket.destroy();
}

function handleConnection(
  ws: WebSocketType,
  ctx: RouteContext,
  auth: AuthContext | undefined,
  pingInterval: number,
  pingTimeout: number
): void {
  const state: ClientState = { ...(auth && { auth }) };
  let pongTimer: NodeJS.Timeout | undefined;

  const heartbeat = setInterval(() => {
    if (pongTimer) return;
    ws.ping();
    pongTimer = setTimeout(() => ws.terminate(), pingTimeout);
  }, pingInterval);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(pongTimer);
    pongTimer = undefined;
    state.abortController?.abort();
  };

  ws.on('pong', () => {
    clearTimeout(pongTimer);
    pongTimer = undefined;
  });

  ws.on('message', (data: RawData) => {
    void handleRawMessage(ws, data, ctx, state);
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

async function handleRawMessage(
  ws: WebSocketType,
  data: RawData,
  ctx: RouteContext,
  state: ClientState
): Promise<void> {
  const message = parseMessage(data);
  if (!message.ok) {
    sendResponse(ws, { type: 'error', error: message.error });
    return;
  }

  switch (message.value.type) {
    case 'ping':
      sendResponse(ws, { type: 'pong', id: message.value.id });
      return;
    case 'stop':
      state.abortController?.abort();
      return;
    case 'run':
      await handleRun(ws, message.value.id, message.value.payload, ctx, state);
      return;
  }
}

function parseMessage(
  data: RawData
): { ok: true; value: ParsedMessage } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(rawDataToString(data));
  } catch {
    return { ok: false, error: 'Invalid JSON message' };
  }

  if (!isRecord(raw)) return { ok: false, error: 'Message must be a JSON object' };
  if (raw.id !== undefined && typeof raw.id !== 'string') {
    return { ok: false, error: 'Message "id" must be a string' };
  }

  const id = raw.id;
  switch (raw.type) {
    case 'ping':
    case 'stop':
      return { ok: true, value: { type: raw.type, id } };
    case 'run':
      return { ok: true, value: { type: 'run', id, payload: raw.payload } };
    default:
      return { ok: false, error: `Unsupported message type: ${String(raw.type)}` };
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function parseRunPayload(payload: unknown): WebSocketRunPayload | string {
  if (!isRecord(payload)) return 'Invalid run payload';
  const { type, name, input, context, threadId } = payload;

  if (!isRunType(type)) {
    return `Unsupported run type: ${String(type)}`;
  }
  if (typeof name !== 'string' || !name) return 'Invalid run payload: "name" is required';
  if (typeof input !== 'string' || !input) return 'Invalid run payload: "input" is required';
  if (context !== undefined && !isRecord(context)) {
    return 'Invalid run payload: "context" must be an object';
  }
  if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) {
    return 'Invalid run payload: "threadId" must be a non-empty string';
  }

  return {
    type,
    name,
    input,
    ...(context !== undefined && { context }),
    ...(threadId !== undefined && { threadId }),
  };
}

async function handleRun(
  ws: WebSocketType,
  id: string | undefined,
  rawPayload: unknown,
  ctx: RouteContext,
  state: ClientState
): Promise<void> {
  const payload = parseRunPayload(rawPayload);
  if (typeof payload === 'string') {
    sendResponse(ws, { type: 'error', id, error: payload });
    return;
  }

  if (state.abortController) {
    sendResponse(ws, { type: 'error', id, error: 'A run is already in progress' });
    return;
  }

  const abortController = new AbortController();
  state.abortController = abortController;
  const emit = (event: Record<string, unknown>) => {
    sendResponse(ws, { type: 'event', id, payload: event });
  };

  try {
    const result = await executeRun(payload, ctx, state.auth?.userId, abortController.signal, emit);
    if (abortController.signal.aborted) {
      emit({ type: 'cancelled' });
    } else {
      emit({ type: 'complete', result });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      emit({ type: 'cancelled' });
    } else if (error instanceof ClientFacingError) {
      sendResponse(ws, { type: 'error', id, error: error.message });
    } else {
      const { body } = resolveError(error, 'WebSocket run error');
      sendResponse(ws, { type: 'error', id, error: body.error.message });
    }
  } finally {
    if (state.abortController === abortController) {
      state.abortController = undefined;
    }
  }
}

async function executeRun(
  payload: WebSocketRunPayload,
  ctx: RouteContext,
  userId: string | undefined,
  signal: AbortSignal,
  emit: (event: Record<string, unknown>) => void
): Promise<unknown> {
  switch (payload.type) {
    case 'agent': {
      const agent = getOwn(ctx.agents, payload.name);
      if (!agent) throw new ClientFacingError(`Agent '${payload.name}' not found`);

      return ctx.runtime.run(agent, {
        input: payload.input,
        context: payload.context,
        threadId: payload.threadId,
        userId,
        stream: true,
        signal,
        onToken: (token: string) => emit({ type: 'token', delta: token }),
        onToolCall: (toolCall: ToolCall) => emit({ type: 'tool-call', ...toolCall }),
        onToolResult: (toolResult: ToolResult) => emit({ type: 'tool-result', ...toolResult }),
      });
    }

    case 'workflow': {
      const workflow = getOwn(ctx.workflows, payload.name);
      if (!workflow) throw new ClientFacingError(`Workflow '${payload.name}' not found`);

      const { WorkflowExecutor } = await importOptional(
        () => import('@cogitator-ai/workflows'),
        'Workflows'
      );
      const executor = new WorkflowExecutor(ctx.runtime);
      const result = await executor.execute(workflow, { input: payload.input }, { signal });
      if (result.error) throw result.error;
      return toWorkflowRunResponse(result);
    }

    case 'swarm': {
      const swarmConfig = getOwn(ctx.swarms, payload.name);
      if (!swarmConfig) throw new ClientFacingError(`Swarm '${payload.name}' not found`);

      const { Swarm } = await importOptional(() => import('@cogitator-ai/swarms'), 'Swarms');
      const swarm = new Swarm(ctx.runtime, swarmConfig);
      const onAbort = () => swarm.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await swarm.run({
          input: payload.input,
          context: payload.context,
          threadId: payload.threadId,
          userId,
        });
        return toSwarmRunResponse(swarm, result);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }
}

async function importOptional<T>(load: () => Promise<T>, label: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new ClientFacingError(`${label} package not installed`);
    }
    throw error;
  }
}

function sendResponse(ws: WebSocketType, response: WebSocketResponse): void {
  if (ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify(response));
  } catch (error) {
    console.error('[CogitatorKoa] WebSocket send error:', error);
  }
}
