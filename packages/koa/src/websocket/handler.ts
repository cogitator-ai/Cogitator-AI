import type { Server as HttpServer } from 'http';
import type {
  WebSocketMessage,
  WebSocketResponse,
  RouteContext,
  WebSocketConfig,
} from '../types.js';
import { generateId } from '@cogitator-ai/server-shared';
import type { ToolCall } from '@cogitator-ai/types';

type WebSocketType = import('ws').WebSocket;
type WebSocketServerType = import('ws').WebSocketServer;

interface ClientState {
  id: string;
  abortController?: AbortController;
}

const WS_OPEN = 1;

export async function setupWebSocket(
  server: HttpServer,
  ctx: RouteContext,
  config: WebSocketConfig = {}
): Promise<WebSocketServerType | null> {
  try {
    const { WebSocketServer } = await import('ws');

    const wss = new WebSocketServer({
      server,
      path: config.path ?? '/ws',
      maxPayload: config.maxPayloadSize ?? 1024 * 1024,
    });

    const pingInterval = config.pingInterval ?? 30000;

    wss.on('connection', (ws: WebSocketType) => {
      const clientState: ClientState = {
        id: generateId('ws'),
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

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketMessage;
          await handleMessage(ws, message, ctx, clientState);
        } catch (error) {
          sendResponse(ws, {
            type: 'error',
            error: error instanceof Error ? error.message : 'Invalid message',
          });
        }
      });

      ws.on('close', () => {
        clearInterval(heartbeat);
        clientState.abortController?.abort();
      });

      ws.on('error', () => {
        clearInterval(heartbeat);
        clientState.abortController?.abort();
      });
    });

    console.log('[CogitatorKoa] WebSocket enabled');
    return wss;
  } catch {
    console.warn('[CogitatorKoa] WebSocket setup failed (ws package not installed)');
    return null;
  }
}

async function handleMessage(
  ws: WebSocketType,
  message: WebSocketMessage,
  ctx: RouteContext,
  state: ClientState
): Promise<void> {
  switch (message.type) {
    case 'ping':
      sendResponse(ws, { type: 'pong' });
      break;

    case 'run':
      await handleRun(ws, message, ctx, state);
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
  state: ClientState
): Promise<void> {
  const payload = message.payload as {
    type: 'agent' | 'workflow' | 'swarm';
    name: string;
    input: string;
    context?: Record<string, unknown>;
  };

  if (!payload?.type || !payload?.name || !payload?.input) {
    sendResponse(ws, { type: 'error', id: message.id, error: 'Invalid run payload' });
    return;
  }

  if (state.abortController) {
    sendResponse(ws, { type: 'error', id: message.id, error: 'A run is already in progress' });
    return;
  }

  state.abortController = new AbortController();

  try {
    if (payload.type === 'agent') {
      const agent = ctx.agents[payload.name];
      if (!agent) {
        sendResponse(ws, {
          type: 'error',
          id: message.id,
          error: `Agent '${payload.name}' not found`,
        });
        return;
      }

      const result = await ctx.runtime.run(agent, {
        input: payload.input,
        context: payload.context,
        stream: true,
        onToken: (token: string) => {
          sendResponse(ws, {
            type: 'event',
            id: message.id,
            payload: { type: 'token', delta: token },
          });
        },
        onToolCall: (toolCall: ToolCall) => {
          sendResponse(ws, {
            type: 'event',
            id: message.id,
            payload: { type: 'tool-call', ...toolCall },
          });
        },
        onToolResult: (toolResult: { callId: string; result: unknown }) => {
          sendResponse(ws, {
            type: 'event',
            id: message.id,
            payload: { type: 'tool-result', ...toolResult },
          });
        },
      });

      sendResponse(ws, {
        type: 'event',
        id: message.id,
        payload: { type: 'complete', result },
      });
    } else if (payload.type === 'workflow') {
      const workflow = ctx.workflows[payload.name];
      if (!workflow) {
        sendResponse(ws, {
          type: 'error',
          id: message.id,
          error: `Workflow '${payload.name}' not found`,
        });
        return;
      }

      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.runtime);
      const result = await executor.execute(workflow, { input: payload.input });

      sendResponse(ws, {
        type: 'event',
        id: message.id,
        payload: { type: 'complete', result },
      });
    } else if (payload.type === 'swarm') {
      const swarmConfig = ctx.swarms[payload.name];
      if (!swarmConfig) {
        sendResponse(ws, {
          type: 'error',
          id: message.id,
          error: `Swarm '${payload.name}' not found`,
        });
        return;
      }

      const { Swarm } = await import('@cogitator-ai/swarms');
      const swarm = new Swarm(ctx.runtime, swarmConfig);
      const result = await swarm.run({
        input: payload.input,
        context: payload.context,
      });

      sendResponse(ws, {
        type: 'event',
        id: message.id,
        payload: { type: 'complete', result },
      });
    }
  } catch (error) {
    if (state.abortController?.signal.aborted) {
      sendResponse(ws, { type: 'event', id: message.id, payload: { type: 'cancelled' } });
    } else {
      sendResponse(ws, {
        type: 'error',
        id: message.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  } finally {
    state.abortController = undefined;
  }
}

function sendResponse(ws: WebSocketType, response: WebSocketResponse): void {
  try {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(response));
    }
  } catch {}
}
