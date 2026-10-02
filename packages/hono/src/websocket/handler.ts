import { Hono } from 'hono';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type {
  CogitatorContext,
  HonoEnv,
  WebSocketClientState,
  WebSocketConfig,
  WebSocketLike,
  WebSocketResponse,
  WebSocketRunPayload,
} from '../types.js';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { generateId } from '@cogitator-ai/server-shared';
import { getOwn } from '../utils/lookup.js';
import { isModuleNotFoundError, resolveError } from '../utils/errors.js';
import { toSwarmRunResponse, toWorkflowRunResponse } from '../utils/results.js';
import { isRecord } from '../utils/validation.js';

type ParsedMessage =
  | { type: 'ping'; id?: string }
  | { type: 'stop'; id?: string }
  | { type: 'run'; id?: string; payload: unknown };

const WS_OPEN = 1;
const WS_MESSAGE_TOO_BIG = 1009;
const DEFAULT_PATH = '/ws';
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const RUN_TYPES: readonly WebSocketRunPayload['type'][] = ['agent', 'workflow', 'swarm'];

class ClientFacingError extends Error {}

export function createWebSocketRoutes(config: WebSocketConfig | string = {}): Hono<HonoEnv> {
  const options: WebSocketConfig = typeof config === 'string' ? { path: config } : config;
  const path = options.path ?? DEFAULT_PATH;
  const maxPayloadSize = options.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD;
  const app = new Hono<HonoEnv>();

  if (!options.upgradeWebSocket) {
    app.get(path, (c) =>
      c.json(
        {
          error: {
            message:
              'WebSocket is not configured: pass websocket.upgradeWebSocket from your runtime adapter',
            code: 'UNIMPLEMENTED',
          },
        },
        501
      )
    );
    return app;
  }

  app.get(
    path,
    options.upgradeWebSocket((c) => {
      const ctx: CogitatorContext = c.get('cogitator');
      const state = createClientState();

      return {
        onMessage(event, ws) {
          void receiveMessage(ws, event.data, ctx, state, maxPayloadSize);
        },
        onClose() {
          state.abortController?.abort();
        },
        onError() {
          state.abortController?.abort();
        },
      };
    })
  );

  return app;
}

async function receiveMessage(
  ws: WSContext,
  data: WSMessageReceive,
  ctx: CogitatorContext,
  state: WebSocketClientState,
  maxPayloadSize: number
): Promise<void> {
  const text = await messageToText(data);
  if (Buffer.byteLength(text) > maxPayloadSize) {
    sendResponse(ws, { type: 'error', error: 'Message too large' });
    ws.close(WS_MESSAGE_TOO_BIG, 'Message too large');
    return;
  }
  await handleWebSocketMessage(ws, text, ctx, state);
}

async function messageToText(data: WSMessageReceive): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  return new TextDecoder().decode(new Uint8Array(data));
}

export function createClientState(): WebSocketClientState {
  return { id: generateId('ws') };
}

export async function handleWebSocketMessage(
  socket: WebSocketLike,
  data: string,
  ctx: CogitatorContext,
  state: WebSocketClientState
): Promise<void> {
  const message = parseMessage(data);
  if (!message.ok) {
    sendResponse(socket, { type: 'error', error: message.error });
    return;
  }

  switch (message.value.type) {
    case 'ping':
      sendResponse(socket, { type: 'pong', id: message.value.id });
      return;
    case 'stop':
      state.abortController?.abort();
      return;
    case 'run':
      await handleRun(socket, message.value.id, message.value.payload, ctx, state);
      return;
  }
}

function parseMessage(
  data: string
): { ok: true; value: ParsedMessage } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
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

function isRunType(value: unknown): value is WebSocketRunPayload['type'] {
  return RUN_TYPES.some((runType) => runType === value);
}

function parseRunPayload(payload: unknown): WebSocketRunPayload | string {
  if (!isRecord(payload)) return 'Invalid run payload';
  const { type, name, input, context, threadId } = payload;

  if (!isRunType(type)) return `Unsupported run type: ${String(type)}`;
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
  socket: WebSocketLike,
  id: string | undefined,
  rawPayload: unknown,
  ctx: CogitatorContext,
  state: WebSocketClientState
): Promise<void> {
  const payload = parseRunPayload(rawPayload);
  if (typeof payload === 'string') {
    sendResponse(socket, { type: 'error', id, error: payload });
    return;
  }

  if (state.abortController) {
    sendResponse(socket, { type: 'error', id, error: 'A run is already in progress' });
    return;
  }

  const abortController = new AbortController();
  state.abortController = abortController;
  const emit = (event: Record<string, unknown>) => {
    sendResponse(socket, { type: 'event', id, payload: event });
  };

  try {
    const result = await executeRun(payload, ctx, abortController.signal, emit);
    if (abortController.signal.aborted) {
      emit({ type: 'cancelled' });
    } else {
      emit({ type: 'complete', result });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      emit({ type: 'cancelled' });
    } else if (error instanceof ClientFacingError) {
      sendResponse(socket, { type: 'error', id, error: error.message });
    } else {
      const { body } = resolveError(error, 'WebSocket run error');
      sendResponse(socket, { type: 'error', id, error: body.error.message });
    }
  } finally {
    if (state.abortController === abortController) {
      state.abortController = undefined;
    }
  }
}

async function executeRun(
  payload: WebSocketRunPayload,
  ctx: CogitatorContext,
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

function sendResponse(socket: WebSocketLike, response: WebSocketResponse): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(response));
  } catch (error) {
    console.error('[CogitatorHono] WebSocket send error:', error);
  }
}
