import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { WebSocket } from 'ws';
import type { Agent } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import type { AuthContext, WebSocketMessage, WebSocketResponse } from '../types.js';
import {
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
import { requestDeps, resolveError } from '../routes/utils.js';

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
  /** The upgrade request, which the `deps` hook builds a run's deps from */
  request: FastifyRequest;
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

interface WebSocketRoutesOptions {
  path?: string;
}

/**
 * The subscribers of each channel, with what authentication returned for them. A run's events
 * reach a subscriber only when it acts as the user who started the run and `authorizeThread`
 * lets it on the run's thread, so a caller never sees the prompts and results of a run it
 * could not open itself.
 */
class ChannelHub {
  private readonly channels = new Map<string, Map<WebSocket, AuthContext | undefined>>();

  constructor(
    private readonly authorizeThread: AuthorizeThread<AuthContext> | undefined,
    private readonly log: FastifyBaseLogger
  ) {}

  subscribe(socket: WebSocket, channel: string, auth: AuthContext | undefined): void {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Map();
      this.channels.set(channel, members);
    }
    members.set(socket, auth);
  }

  unsubscribe(socket: WebSocket, channel: string): void {
    const members = this.channels.get(channel);
    if (!members) return;
    members.delete(socket);
    if (members.size === 0) this.channels.delete(channel);
  }

  /** The fan-out of one run's events to the subscribers of `channel` */
  broadcast(
    channel: string,
    origin: { socket: WebSocket; auth: AuthContext | undefined }
  ): RunBroadcast {
    return new RunBroadcast(
      () => this.channels.get(channel),
      channel,
      origin,
      this.authorizeThread,
      this.log
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
  private readonly deliveries = new Map<WebSocket, Promise<boolean>>();

  constructor(
    private readonly members: () => ReadonlyMap<WebSocket, AuthContext | undefined> | undefined,
    private readonly channel: string,
    private readonly origin: { socket: WebSocket; auth: AuthContext | undefined },
    private readonly authorizeThread: AuthorizeThread<AuthContext> | undefined,
    private readonly log: FastifyBaseLogger
  ) {}

  /** Names the thread the run is on, once it is known */
  onThread(threadId: string): void {
    this.threadId = threadId;
  }

  publish(response: WebSocketResponse): void {
    const members = this.members();
    if (!members) return;
    for (const [member, auth] of members) {
      if (member === this.origin.socket || auth?.userId !== this.origin.auth?.userId) continue;
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
    } catch (err) {
      this.log.error({ err }, 'authorizeThread failed for a websocket subscriber');
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

export const websocketRoutes: FastifyPluginAsync<WebSocketRoutesOptions> = async (
  fastify,
  opts
) => {
  const path = opts.path ?? '/ws';
  const hub = new ChannelHub(fastify.cogitator.authorizeThread, fastify.log);

  fastify.get(path, { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const clientState: ClientState = {
      id: generateId('ws'),
      request,
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
      hub.subscribe(socket, channel, state.auth);
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

  await streamAgentRun(socket, message, fastify, state, hub, payload, (agent, options) =>
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

  await streamAgentRun(socket, message, fastify, state, hub, payload, (agent, options) =>
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
  target: { name: string; threadId?: string },
  execute: (agent: Agent, options: AgentRunControls) => Promise<RunResult>
): Promise<void> {
  const { name } = target;
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

  const broadcast = hub.broadcast(`agent:${name}`, { socket, auth: state.auth });
  if (target.threadId !== undefined) broadcast.onThread(target.threadId);
  const emit = (eventPayload: Record<string, unknown>) => {
    const response: WebSocketResponse = { type: 'event', id: message.id, payload: eventPayload };
    sendResponse(socket, response);
    broadcast.publish(response);
  };

  try {
    const refusal = await authorizeThreadAccess(
      fastify.cogitator.authorizeThread,
      state.auth,
      target.threadId
    );
    if (refusal) {
      sendResponse(socket, { type: 'error', id: message.id, error: refusal.message });
      return;
    }
    const deps = await requestDeps(state.request);

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
