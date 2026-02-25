import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { WebSocketMessage, WebSocketResponse } from '../types.js';
import { generateId } from '../streaming/helpers.js';
import type { ToolCall } from '@cogitator-ai/types';

interface ClientState {
  id: string;
  subscriptions: Set<string>;
  abortController?: AbortController;
}

interface WebSocketRoutesOptions {
  path?: string;
}

export const websocketRoutes: FastifyPluginAsync<WebSocketRoutesOptions> = async (
  fastify,
  opts
) => {
  const path = opts.path ?? '/ws';

  fastify.get(path, { websocket: true }, (socket: WebSocket, _request: FastifyRequest) => {
    const clientState: ClientState = {
      id: generateId('ws'),
      subscriptions: new Set(),
    };

    socket.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as WebSocketMessage;
        await handleMessage(socket, message, fastify, clientState);
      } catch (error) {
        sendResponse(socket, {
          type: 'error',
          error: error instanceof Error ? error.message : 'Invalid message',
        });
      }
    });

    socket.on('close', () => {
      clientState.abortController?.abort();
    });

    socket.on('error', () => {
      clientState.abortController?.abort();
    });
  });
};

async function handleMessage(
  socket: WebSocket,
  message: WebSocketMessage,
  fastify: Parameters<FastifyPluginAsync>[0],
  state: ClientState
): Promise<void> {
  switch (message.type) {
    case 'ping':
      sendResponse(socket, { type: 'pong' });
      break;

    case 'subscribe':
      if (message.channel) {
        if (state.subscriptions.size < 64) {
          state.subscriptions.add(message.channel);
        }
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
      await handleRun(socket, message, fastify, state);
      break;

    case 'stop':
      state.abortController?.abort();
      state.abortController = undefined;
      break;
  }
}

async function handleRun(
  socket: WebSocket,
  message: WebSocketMessage,
  fastify: Parameters<FastifyPluginAsync>[0],
  state: ClientState
): Promise<void> {
  const payload = message.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).type !== 'string' ||
    typeof (payload as Record<string, unknown>).name !== 'string' ||
    typeof (payload as Record<string, unknown>).input !== 'string'
  ) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'Invalid run payload' });
    return;
  }

  const { type, name, input, context } = payload as {
    type: string;
    name: string;
    input: string;
    context?: Record<string, unknown>;
  };

  if (state.abortController) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'A run is already in progress' });
    return;
  }

  if (type !== 'agent' && type !== 'workflow' && type !== 'swarm') {
    sendResponse(socket, { type: 'error', id: message.id, error: `Unknown run type: ${type}` });
    return;
  }

  state.abortController = new AbortController();

  try {
    if (type === 'agent') {
      const agent = fastify.cogitator.agents[name];
      if (!agent) {
        sendResponse(socket, {
          type: 'error',
          id: message.id,
          error: 'Agent not found',
        });
        return;
      }

      const result = await fastify.cogitator.runtime.run(agent, {
        input,
        context,
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
    } else {
      sendResponse(socket, {
        type: 'error',
        id: message.id,
        error: `Run type '${type}' is not supported over WebSocket`,
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
  } finally {
    state.abortController = undefined;
  }
}

function sendResponse(socket: WebSocket, response: WebSocketResponse): void {
  try {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(response));
    }
  } catch {}
}
