import { Hono } from 'hono';
import { generateId } from '@cogitator-ai/server-shared';
import type { HonoEnv, WebSocketMessage, WebSocketResponse, CogitatorContext } from '../types.js';
import type { ToolCall } from '@cogitator-ai/types';

interface Subscription {
  channel: string;
  callback: (data: unknown) => void;
}

interface ClientState {
  id: string;
  subscriptions: Map<string, Subscription>;
  abortController?: AbortController;
}

export function createWebSocketRoutes(_path: string = '/ws'): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get(_path, async (c) => {
    return c.text(
      'WebSocket support varies by runtime. Use upgradeWebSocket from hono/ws with your runtime adapter.',
      501
    );
  });

  return app;
}

export async function handleWebSocketMessage(
  socket: { send: (data: string) => void; readyState: number },
  data: string,
  ctx: CogitatorContext,
  state: ClientState
): Promise<void> {
  try {
    const message = JSON.parse(data) as WebSocketMessage;
    await processMessage(socket, message, ctx, state);
  } catch (error) {
    sendResponse(socket, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Invalid message',
    });
  }
}

export function createClientState(): ClientState {
  return {
    id: generateId('ws'),
    subscriptions: new Map(),
  };
}

async function processMessage(
  socket: { send: (data: string) => void; readyState: number },
  message: WebSocketMessage,
  ctx: CogitatorContext,
  state: ClientState
): Promise<void> {
  switch (message.type) {
    case 'ping':
      sendResponse(socket, { type: 'pong' });
      break;

    case 'subscribe':
      if (message.channel) {
        state.subscriptions.set(message.channel, {
          channel: message.channel,
          callback: (payload) => {
            sendResponse(socket, { type: 'event', channel: message.channel, payload });
          },
        });
        sendResponse(socket, { type: 'subscribed', channel: message.channel });
      }
      break;

    case 'unsubscribe':
      if (message.channel) {
        state.subscriptions.delete(message.channel);
        sendResponse(socket, { type: 'unsubscribed', channel: message.channel });
      }
      break;

    case 'run':
      await handleRun(socket, message, ctx, state);
      break;

    case 'stop':
      state.abortController?.abort();
      state.abortController = undefined;
      break;
  }
}

async function handleRun(
  socket: { send: (data: string) => void; readyState: number },
  message: WebSocketMessage,
  ctx: CogitatorContext,
  state: ClientState
): Promise<void> {
  const payload = message.payload as {
    type: 'agent' | 'workflow' | 'swarm';
    name: string;
    input: string;
    context?: Record<string, unknown>;
  };

  if (!payload?.type || !payload?.name || !payload?.input) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'Invalid run payload' });
    return;
  }

  state.abortController = new AbortController();

  try {
    if (payload.type === 'agent') {
      const agent = ctx.agents[payload.name];
      if (!agent) {
        sendResponse(socket, {
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
          sendResponse(socket, {
            type: 'event',
            id: message.id,
            payload: { type: 'token', delta: token },
          });
        },
        onToolCall: (toolCall: ToolCall) => {
          sendResponse(socket, {
            type: 'event',
            id: message.id,
            payload: { type: 'tool-call', ...toolCall },
          });
        },
        onToolResult: (toolResult: { callId: string; result: unknown }) => {
          sendResponse(socket, {
            type: 'event',
            id: message.id,
            payload: { type: 'tool-result', ...toolResult },
          });
        },
      });

      sendResponse(socket, {
        type: 'event',
        id: message.id,
        payload: { type: 'complete', result },
      });
    }
  } catch (error) {
    if (state.abortController?.signal.aborted) {
      sendResponse(socket, { type: 'event', id: message.id, payload: { type: 'cancelled' } });
    } else {
      sendResponse(socket, {
        type: 'error',
        id: message.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

function sendResponse(
  socket: { send: (data: string) => void; readyState: number },
  response: WebSocketResponse
): void {
  try {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(response));
    }
  } catch {}
}
