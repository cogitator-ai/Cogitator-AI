import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Agent } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import type { AuthContext, WebSocketMessage, WebSocketResponse } from '../types.js';
import {
  isJsonObject,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
  toAgentToolCall,
  type ContextPolicy,
  type ResumeRequestBody,
} from '@cogitator-ai/server-shared';
import { generateId } from '../streaming/helpers.js';
import { resolveError } from '../routes/utils.js';

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

interface ResumePayload extends ResumeRequestBody {
  name: string;
}

type AgentRunControls = Pick<
  RunOptions,
  'userId' | 'signal' | 'stream' | 'onToken' | 'onReasoning' | 'onToolCall' | 'onToolResult'
>;

interface WebSocketRoutesOptions {
  path?: string;
}

/**
 * Run events fan out only to subscribers acting as the user who started the run,
 * so one user's prompts and results never reach another user's socket.
 */
class ChannelHub {
  private readonly channels = new Map<string, Map<WebSocket, string | undefined>>();

  subscribe(socket: WebSocket, channel: string, userId: string | undefined): void {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Map();
      this.channels.set(channel, members);
    }
    members.set(socket, userId);
  }

  unsubscribe(socket: WebSocket, channel: string): void {
    const members = this.channels.get(channel);
    if (!members) return;
    members.delete(socket);
    if (members.size === 0) this.channels.delete(channel);
  }

  publish(
    channel: string,
    response: WebSocketResponse,
    origin: { socket: WebSocket; userId: string | undefined }
  ): void {
    const members = this.channels.get(channel);
    if (!members) return;
    for (const [member, userId] of members) {
      if (member !== origin.socket && userId === origin.userId) {
        sendResponse(member, { ...response, channel });
      }
    }
  }
}

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

export const websocketRoutes: FastifyPluginAsync<WebSocketRoutesOptions> = async (
  fastify,
  opts
) => {
  const path = opts.path ?? '/ws';
  const hub = new ChannelHub();

  fastify.get(path, { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const clientState: ClientState = {
      id: generateId('ws'),
      auth: request.cogitatorAuth,
      subscriptions: new Set(),
    };

    socket.on('message', (data: Buffer) => {
      const message = parseMessage(data.toString());
      if (!message) {
        sendResponse(socket, { type: 'error', error: 'Invalid message' });
        return;
      }
      void handleMessage(socket, message, fastify, clientState, hub);
    });

    const cleanup = () => {
      clientState.abortController?.abort();
      clientState.abortController = undefined;
      for (const channel of clientState.subscriptions) hub.unsubscribe(socket, channel);
      clientState.subscriptions.clear();
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
};

async function handleMessage(
  socket: WebSocket,
  message: WebSocketMessage,
  fastify: FastifyInstance,
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  switch (message.type) {
    case 'ping':
      sendResponse(socket, { type: 'pong', id: message.id });
      break;

    case 'subscribe': {
      const channel = message.channel;
      if (!channel || channel.length > MAX_CHANNEL_LENGTH) {
        sendResponse(socket, { type: 'error', id: message.id, error: 'Invalid channel' });
        break;
      }
      if (!state.subscriptions.has(channel) && state.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        sendResponse(socket, {
          type: 'error',
          id: message.id,
          error: `Subscription limit reached (max ${MAX_SUBSCRIPTIONS})`,
        });
        break;
      }
      state.subscriptions.add(channel);
      hub.subscribe(socket, channel, state.auth?.userId);
      sendResponse(socket, { type: 'subscribed', id: message.id, channel });
      break;
    }

    case 'unsubscribe':
      if (message.channel) {
        state.subscriptions.delete(message.channel);
        hub.unsubscribe(socket, message.channel);
        sendResponse(socket, { type: 'unsubscribed', id: message.id, channel: message.channel });
      }
      break;

    case 'run':
      await handleRun(socket, message, fastify, state, hub);
      break;

    case 'resume':
      await handleResume(socket, message, fastify, state, hub);
      break;

    case 'stop':
      state.abortController?.abort();
      break;
  }
}

async function handleRun(
  socket: WebSocket,
  message: WebSocketMessage,
  fastify: FastifyInstance,
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  const payload = parseRunPayload(message.payload, fastify.cogitator.acceptContext ?? false);
  if (!payload) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'Invalid run payload' });
    return;
  }

  if (state.abortController) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'A run is already in progress' });
    return;
  }

  if (payload.type !== 'agent') {
    sendResponse(socket, {
      type: 'error',
      id: message.id,
      error: `Run type '${payload.type}' is not supported over WebSocket`,
    });
    return;
  }

  await streamAgentRun(socket, message, fastify, state, hub, payload.name, (agent, options) =>
    fastify.cogitator.runtime.run(agent, {
      ...options,
      input: payload.input,
      context: payload.context,
      threadId: payload.threadId,
    })
  );
}

async function handleResume(
  socket: WebSocket,
  message: WebSocketMessage,
  fastify: FastifyInstance,
  state: ClientState,
  hub: ChannelHub
): Promise<void> {
  const payload = parseResumePayload(message.payload);
  if (!payload) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'Invalid resume payload' });
    return;
  }

  if (state.abortController) {
    sendResponse(socket, { type: 'error', id: message.id, error: 'A run is already in progress' });
    return;
  }

  await streamAgentRun(socket, message, fastify, state, hub, payload.name, (agent, options) =>
    fastify.cogitator.runtime.resume(agent, payload.threadId, {
      ...options,
      decisions: payload.decisions,
      defaultDecision: payload.defaultDecision,
    })
  );
}

async function streamAgentRun(
  socket: WebSocket,
  message: WebSocketMessage,
  fastify: FastifyInstance,
  state: ClientState,
  hub: ChannelHub,
  name: string,
  execute: (agent: Agent, options: AgentRunControls) => Promise<RunResult>
): Promise<void> {
  const agent = Object.hasOwn(fastify.cogitator.agents, name)
    ? fastify.cogitator.agents[name]
    : undefined;
  if (!agent) {
    sendResponse(socket, {
      type: 'error',
      id: message.id,
      error: `Agent '${name}' not found`,
    });
    return;
  }

  const controller = new AbortController();
  state.abortController = controller;

  const channel = `agent:${name}`;
  const emit = (eventPayload: Record<string, unknown>) => {
    const response: WebSocketResponse = { type: 'event', id: message.id, payload: eventPayload };
    sendResponse(socket, response);
    hub.publish(channel, response, { socket, userId: state.auth?.userId });
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
      sendResponse(socket, {
        type: 'error',
        id: message.id,
        error: resolveError(fastify, error, 'websocket run error').message,
      });
    }
  } finally {
    if (state.abortController === controller) state.abortController = undefined;
  }
}

function sendResponse(socket: WebSocket, response: WebSocketResponse): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(response));
  } catch {}
}
