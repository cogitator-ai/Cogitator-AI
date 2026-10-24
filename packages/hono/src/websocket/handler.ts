import { Hono } from 'hono';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type {
  AuthContext,
  CogitatorContext,
  HonoEnv,
  WebSocketClientState,
  WebSocketConfig,
  WebSocketLike,
  WebSocketResponse,
  WebSocketResumePayload,
  WebSocketRunPayload,
} from '../types.js';
import type { RunOptions, ToolCall, ToolResult } from '@cogitator-ai/types';
import {
  authorizeThreadAccess,
  generateId,
  isJsonObject,
  parseResumeRequest,
  parseRunRequest,
  runRequestRunOptions,
  swarmTimeoutWithin,
  toAgentRunResponse,
  toAgentToolCall,
  withSwarm,
  workflowOptionsWithin,
  type ContextPolicy,
} from '@cogitator-ai/server-shared';
import { getOwn } from '../utils/lookup.js';
import { describeError, isModuleNotFoundError } from '../utils/errors.js';
import { sendError } from '../utils/request.js';
import { toSwarmRunResponse, toWorkflowRunResponse } from '../utils/results.js';

type ParsedMessage =
  | { type: 'ping'; id?: string }
  | { type: 'stop'; id?: string }
  | { type: 'run'; id?: string; payload: unknown }
  | { type: 'resume'; id?: string; payload: unknown };

const WS_OPEN = 1;
const WS_MESSAGE_TOO_BIG = 1009;
const DEFAULT_PATH = '/ws';
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const RUN_TYPES: readonly WebSocketRunPayload['type'][] = ['agent', 'workflow', 'swarm'];

type EmitEvent = (event: Record<string, unknown>) => void;

class ClientFacingError extends Error {}

export function createWebSocketRoutes(config: WebSocketConfig | string = {}): Hono<HonoEnv> {
  const options: WebSocketConfig = typeof config === 'string' ? { path: config } : config;
  const path = options.path ?? DEFAULT_PATH;
  const maxPayloadSize = options.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD;
  const app = new Hono<HonoEnv>();

  if (!options.upgradeWebSocket) {
    app.get(path, (c) =>
      sendError(c, {
        status: 501,
        code: 'UNIMPLEMENTED',
        message:
          'WebSocket is not configured: pass websocket.upgradeWebSocket from your runtime adapter',
      })
    );
    return app;
  }

  app.get(
    path,
    options.upgradeWebSocket((c) => {
      const ctx: CogitatorContext = c.get('cogitator');
      const deps = ctx.deps;
      const state = createClientState(c.get('cogitatorAuth'), deps && (() => deps(c)));

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

/**
 * The state of a new connection: who opened it, and what builds the `deps` of each agent run
 * on it (the app's `deps` hook, called with the upgrade request)
 */
export function createClientState(
  auth?: AuthContext,
  deps?: WebSocketClientState['deps']
): WebSocketClientState {
  return { id: generateId('ws'), ...(auth && { auth }), ...(deps && { deps }) };
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
    case 'resume':
      await handleResume(socket, message.value.id, message.value.payload, ctx, state);
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

  if (!isJsonObject(raw)) return { ok: false, error: 'Message must be a JSON object' };
  if (raw.id !== undefined && typeof raw.id !== 'string') {
    return { ok: false, error: 'Message "id" must be a string' };
  }

  const id = raw.id;
  switch (raw.type) {
    case 'ping':
    case 'stop':
      return { ok: true, value: { type: raw.type, id } };
    case 'run':
    case 'resume':
      return { ok: true, value: { type: raw.type, id, payload: raw.payload } };
    default:
      return { ok: false, error: `Unsupported message type: ${String(raw.type)}` };
  }
}

function isRunType(value: unknown): value is WebSocketRunPayload['type'] {
  return RUN_TYPES.some((runType) => runType === value);
}

function parseRunPayload(
  payload: unknown,
  acceptContext: ContextPolicy
): WebSocketRunPayload | string {
  if (!isJsonObject(payload)) return 'Invalid run payload';
  const { type, name } = payload;

  if (!isRunType(type)) return `Unsupported run type: ${String(type)}`;
  if (typeof name !== 'string' || !name) return 'Invalid run payload: "name" is required';
  const parsed = parseRunRequest(payload, { acceptContext });
  if (!parsed.ok) return `Invalid run payload: ${parsed.message}`;
  return { type, name, ...parsed.value };
}

function parseResumePayload(payload: unknown): WebSocketResumePayload | string {
  if (!isJsonObject(payload)) return 'Invalid resume payload';
  const { name } = payload;
  if (typeof name !== 'string' || !name) return 'Invalid resume payload: "name" is required';
  const parsed = parseResumeRequest(payload);
  if (!parsed.ok) return `Invalid resume payload: ${parsed.message}`;
  return { name, ...parsed.value };
}

async function handleRun(
  socket: WebSocketLike,
  id: string | undefined,
  rawPayload: unknown,
  ctx: CogitatorContext,
  state: WebSocketClientState
): Promise<void> {
  const payload = parseRunPayload(rawPayload, ctx.acceptContext ?? false);
  if (typeof payload === 'string') {
    sendResponse(socket, { type: 'error', id, error: payload });
    return;
  }

  await runOverSocket(socket, id, state, 'WebSocket run error', async (signal, emit) => {
    await authorizeThread(ctx, state, payload.threadId);
    return executeRun(payload, ctx, state, signal, emit);
  });
}

async function handleResume(
  socket: WebSocketLike,
  id: string | undefined,
  rawPayload: unknown,
  ctx: CogitatorContext,
  state: WebSocketClientState
): Promise<void> {
  const payload = parseResumePayload(rawPayload);
  if (typeof payload === 'string') {
    sendResponse(socket, { type: 'error', id, error: payload });
    return;
  }

  await runOverSocket(socket, id, state, 'WebSocket resume error', async (signal, emit) => {
    await authorizeThread(ctx, state, payload.threadId);
    return executeResume(payload, ctx, state, signal, emit);
  });
}

async function runOverSocket(
  socket: WebSocketLike,
  id: string | undefined,
  state: WebSocketClientState,
  label: string,
  execute: (signal: AbortSignal, emit: EmitEvent) => Promise<unknown>
): Promise<void> {
  if (state.abortController) {
    sendResponse(socket, { type: 'error', id, error: 'A run is already in progress' });
    return;
  }

  const abortController = new AbortController();
  state.abortController = abortController;
  const emit: EmitEvent = (event) => {
    sendResponse(socket, { type: 'event', id, payload: event });
  };

  try {
    const result = await execute(abortController.signal, emit);
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
      sendResponse(socket, { type: 'error', id, error: describeError(error, label).message });
    }
  } finally {
    if (state.abortController === abortController) {
      state.abortController = undefined;
    }
  }
}

/** Refuses a run on a thread the app's `authorizeThread` keeps the connection's caller from */
async function authorizeThread(
  ctx: CogitatorContext,
  state: WebSocketClientState,
  threadId: string | undefined
): Promise<void> {
  const refusal = await authorizeThreadAccess(ctx.authorizeThread, state.auth, threadId);
  if (refusal) throw new ClientFacingError(refusal.message);
}

/** The `deps` an agent run on the connection gets, none without the app's `deps` hook */
async function runDeps(state: WebSocketClientState): Promise<{ deps?: unknown }> {
  return state.deps ? { deps: await state.deps() } : {};
}

function agentStreamCallbacks(
  emit: EmitEvent
): Pick<RunOptions, 'onToken' | 'onReasoning' | 'onToolCall' | 'onToolResult'> {
  return {
    onToken: (token: string) => emit({ type: 'token', delta: token }),
    onReasoning: (delta: string) => emit({ type: 'reasoning', delta }),
    onToolCall: (toolCall: ToolCall) => emit({ type: 'tool-call', ...toAgentToolCall(toolCall) }),
    onToolResult: (toolResult: ToolResult) => emit({ type: 'tool-result', ...toolResult }),
  };
}

async function executeResume(
  payload: WebSocketResumePayload,
  ctx: CogitatorContext,
  state: WebSocketClientState,
  signal: AbortSignal,
  emit: EmitEvent
): Promise<unknown> {
  const agent = getOwn(ctx.agents, payload.name);
  if (!agent) throw new ClientFacingError(`Agent '${payload.name}' not found`);

  const result = await ctx.runtime.resume(agent, payload.threadId, {
    userId: state.auth?.userId,
    ...(await runDeps(state)),
    decisions: payload.decisions,
    defaultDecision: payload.defaultDecision,
    responses: payload.responses,
    stream: true,
    signal,
    ...agentStreamCallbacks(emit),
  });
  return toAgentRunResponse(result);
}

async function executeRun(
  payload: WebSocketRunPayload,
  ctx: CogitatorContext,
  state: WebSocketClientState,
  signal: AbortSignal,
  emit: EmitEvent
): Promise<unknown> {
  const userId = state.auth?.userId;
  switch (payload.type) {
    case 'agent': {
      const agent = getOwn(ctx.agents, payload.name);
      if (!agent) throw new ClientFacingError(`Agent '${payload.name}' not found`);

      const result = await ctx.runtime.run(agent, {
        input: payload.input,
        context: payload.context,
        threadId: payload.threadId,
        ...runRequestRunOptions(payload),
        userId,
        ...(await runDeps(state)),
        stream: true,
        signal,
        ...agentStreamCallbacks(emit),
      });
      return toAgentRunResponse(result);
    }

    case 'workflow': {
      const workflow = getOwn(ctx.workflows, payload.name);
      if (!workflow) throw new ClientFacingError(`Workflow '${payload.name}' not found`);

      const { WorkflowExecutor } = await importOptional(
        () => import('@cogitator-ai/workflows'),
        'Workflows'
      );
      const executor = new WorkflowExecutor(ctx.runtime);
      const result = await executor.execute(
        workflow,
        { input: payload.input },
        { ...workflowOptionsWithin({}, ctx.limits), signal }
      );
      if (result.error) throw result.error;
      return toWorkflowRunResponse(result);
    }

    case 'swarm': {
      const swarmConfig = getOwn(ctx.swarms, payload.name);
      if (!swarmConfig) throw new ClientFacingError(`Swarm '${payload.name}' not found`);

      const { Swarm } = await importOptional(() => import('@cogitator-ai/swarms'), 'Swarms');
      return withSwarm(new Swarm(ctx.runtime, swarmConfig), async (swarm) => {
        const onAbort = () => swarm.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await swarm.run({
            input: payload.input,
            context: payload.context,
            threadId: payload.threadId,
            timeout: swarmTimeoutWithin(undefined, ctx.limits),
            userId,
          });
          return toSwarmRunResponse(swarm, result);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      });
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
