import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Agent } from '@cogitator-ai/core';
import type { RunOptions, RunResult, ToolApprovalDecision } from '@cogitator-ai/types';
import type {
  AgentResumeRequest,
  AuthContext,
  WebSocketMessage,
  WebSocketResponse,
} from '../types.js';
import { generateId } from '../streaming/helpers.js';
import { resolveError, withoutCheckpoint } from '../routes/utils.js';

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

interface WebSocketRoutesOptions {
  path?: string;
}

class ChannelHub {
  private readonly channels = new Map<string, Set<WebSocket>>();

  subscribe(socket: WebSocket, channel: string): void {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Set();
      this.channels.set(channel, members);
    }
    members.add(socket);
  }

  unsubscribe(socket: WebSocket, channel: string): void {
    const members = this.channels.get(channel);
    if (!members) return;
    members.delete(socket);
    if (members.size === 0) this.channels.delete(channel);
  }

  publish(channel: string, response: WebSocketResponse, exclude?: WebSocket): void {
    const members = this.channels.get(channel);
    if (!members) return;
    for (const member of members) {
      if (member !== exclude) sendResponse(member, { ...response, channel });
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
  if (typeof input !== 'string' || !input.trim()) return null;
  if (context !== undefined && !isPlainObject(context)) return null;
  if (threadId !== undefined && typeof threadId !== 'string') return null;
  return { type, name, input, context, threadId };
}

function parseDecision(value: unknown): ToolApprovalDecision | null {
  if (!isPlainObject(value) || typeof value.approved !== 'boolean') return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.approved) return { approved: true };
  return value.reason === undefined
    ? { approved: false }
    : { approved: false, reason: value.reason };
}

function parseResumePayload(payload: unknown): ResumePayload | null {
  if (!isPlainObject(payload)) return null;
  const { name, threadId, decisions, defaultDecision } = payload;
  if (typeof name !== 'string' || !name) return null;
  if (typeof threadId !== 'string' || !threadId.trim()) return null;

  const resume: ResumePayload = { name, threadId };
  if (decisions !== undefined) {
    if (!isPlainObject(decisions)) return null;
    const entries: Array<[string, ToolApprovalDecision]> = [];
    for (const [toolCallId, value] of Object.entries(decisions)) {
      const decision = parseDecision(value);
      if (!decision) return null;
      entries.push([toolCallId, decision]);
    }
    resume.decisions = Object.fromEntries(entries);
  }
  if (defaultDecision !== undefined) {
    const decision = parseDecision(defaultDecision);
    if (!decision) return null;
    resume.defaultDecision = decision;
  }
  return resume;
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
      hub.subscribe(socket, channel);
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
  const payload = parseRunPayload(message.payload);
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
    hub.publish(channel, response, socket);
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
