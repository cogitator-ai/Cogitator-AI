import { hook, ws } from '@tetsujs/core';
import type { ValidationIssue } from '@tetsujs/core';
import type { z } from 'zod';
import type { anonymousHook, CallerHook } from './auth.js';
import { describeError } from './errors.js';
import { toAgentRunResponse } from '@cogitator-ai/server-shared';
import {
  checkThreadAccess,
  executeSwarm,
  executeWorkflow,
  findAgent,
  findSwarm,
  findWorkflow,
  resumeAgent,
  runAgent,
  runDepsOf,
  toResumeDecisions,
  toSwarmRunResponse,
  toWorkflowRunResponse,
} from './operations.js';
import type { RunDeps } from './operations.js';
import { requestSchemas, type SocketMessage } from './schemas.js';
import { resolveSignal } from './streaming.js';
import type { AgentStreamCallbacks } from './streaming.js';
import type { AuthContext, CogitatorDeps, WebSocketServerMessage } from './types.js';

type ClientMessage = z.output<typeof SocketMessage>;
type RunMessage = Extract<ClientMessage, { type: 'run' | 'resume' }>;
type RunPayload = Extract<ClientMessage, { type: 'run' }>['payload'];
type ResumePayload = Extract<ClientMessage, { type: 'resume' }>['payload'];
type Emit = (event: Record<string, unknown>) => void;

interface SocketLike {
  readonly readyState: number;
  send(data: string): unknown;
}

const OPEN = 1;
const DEFAULT_PATH = '/ws' as const;

/** What the handshake adds to a socket: the `deps` of every agent run on the connection */
export interface ConnectionDeps {
  cogitatorDeps: RunDeps;
}

/**
 * The `beforeParse` hook of the handshake that builds the connection's `deps` with the `deps`
 * hook. A Tetsu context belongs to its request, not to the connection that outlives it, so
 * they are built once, from the handshake, rather than for each run.
 */
function connectionDeps(deps: CogitatorDeps) {
  return hook.beforeParse(async (ctx): Promise<ConnectionDeps> => ({
    cogitatorDeps: await runDepsOf(deps, ctx),
  }));
}

/**
 * The WebSocket endpoint of `cogitatorController()`.
 *
 * The handshake runs the same `auth` and `anonymous` policy as the HTTP routes. Each
 * socket runs one agent, workflow or swarm at a time; `stop` cancels it, and so does
 * closing the socket. Workflow and swarm runs are held to the server's `limits`.
 */
export function cogitatorSocket(
  deps: CogitatorDeps,
  caller: CallerHook,
  admitted: ReturnType<typeof anonymousHook>,
  path: `/${string}` = DEFAULT_PATH
) {
  const running = new WeakMap<object, AbortController>();

  return ws({
    path,
    hooks: { beforeParse: [caller, admitted, connectionDeps(deps)] },
    schema: { message: requestSchemas(deps).SocketMessage },
    docs: {
      summary: 'Run agents, workflows and swarms over a WebSocket',
      description:
        'Send `{ type: "run", id, payload: { type, name, input } }`, `{ type: "resume", id, payload: { name, threadId, decisions } }` to continue an agent run paused for approvals, `{ type: "stop" }` or `{ type: "ping" }`.',
    },
    until: () => resolveSignal(deps.until),
    message: (socket, message) => {
      switch (message.type) {
        case 'ping':
          send(socket, { type: 'pong', id: message.id });
          return;
        case 'stop':
          running.get(socket)?.abort();
          return;
        case 'run':
        case 'resume': {
          if (running.has(socket)) {
            send(socket, {
              type: 'error',
              id: message.id,
              error: 'A run is already in progress',
              code: 'RUN_IN_PROGRESS',
            });
            return;
          }
          const controller = new AbortController();
          running.set(socket, controller);
          const connection: Caller = {
            auth: socket.data.cogitatorAuth,
            runDeps: socket.data.cogitatorDeps,
          };
          return handleRun(deps, socket, message, connection, {
            signal: controller.signal,
          }).finally(() => {
            if (running.get(socket) === controller) running.delete(socket);
          });
        }
      }
    },
    invalid: (socket, issues: readonly ValidationIssue[]) => {
      send(socket, {
        type: 'error',
        error: issues[0]?.message ?? 'Invalid message',
        code: 'INVALID_MESSAGE',
      });
    },
    close: (socket) => {
      running.get(socket)?.abort();
      running.delete(socket);
    },
  });
}

/** Who opened a connection, and the `deps` the handshake built for its agent runs */
interface Caller {
  auth: AuthContext | undefined;
  runDeps: RunDeps;
}

async function handleRun(
  deps: CogitatorDeps,
  socket: SocketLike,
  message: RunMessage,
  caller: Caller,
  { signal }: { signal: AbortSignal }
): Promise<void> {
  const id = message.id;
  const emit: Emit = (event) => send(socket, { type: 'event', id, payload: event });

  try {
    const result =
      message.type === 'resume'
        ? await resume(deps, message.payload, caller, signal, emit)
        : await execute(deps, message.payload, caller, signal, emit);
    emit(signal.aborted ? { type: 'cancelled' } : { type: 'complete', result });
  } catch (error) {
    if (signal.aborted) {
      emit({ type: 'cancelled' });
      return;
    }
    const described = describeError(error);
    send(socket, { type: 'error', id, error: described.message, code: described.code });
    if (described.unexpected) throw error;
  }
}

function agentCallbacks(signal: AbortSignal, emit: Emit): AgentStreamCallbacks {
  return {
    stream: true,
    signal,
    onToken: (delta) => emit({ type: 'token', delta }),
    onReasoning: (delta) => emit({ type: 'reasoning', delta }),
    onToolCall: (call) =>
      emit({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }),
    onToolResult: (toolResult) => emit({ type: 'tool-result', ...toolResult }),
  };
}

async function resume(
  deps: CogitatorDeps,
  payload: ResumePayload,
  { auth, runDeps }: Caller,
  signal: AbortSignal,
  emit: Emit
): Promise<unknown> {
  const agent = findAgent(deps, payload.name);
  await checkThreadAccess(deps, auth, payload.threadId);
  const result = await resumeAgent(
    deps,
    agent,
    payload.threadId,
    { ...toResumeDecisions(payload), ...agentCallbacks(signal, emit) },
    auth,
    runDeps
  );
  return toAgentRunResponse(result);
}

async function execute(
  deps: CogitatorDeps,
  payload: RunPayload,
  { auth, runDeps }: Caller,
  signal: AbortSignal,
  emit: Emit
): Promise<unknown> {
  switch (payload.type) {
    case 'agent': {
      const agent = findAgent(deps, payload.name);
      await checkThreadAccess(deps, auth, payload.threadId);
      const result = await runAgent(
        deps,
        agent,
        {
          input: payload.input,
          context: payload.context,
          threadId: payload.threadId,
          ...agentCallbacks(signal, emit),
        },
        auth,
        runDeps
      );
      return toAgentRunResponse(result);
    }

    case 'workflow': {
      const workflow = findWorkflow(deps, payload.name);
      const result = await executeWorkflow(deps, workflow, { input: payload.input }, {}, signal);
      return toWorkflowRunResponse(result);
    }

    case 'swarm': {
      const config = findSwarm(deps, payload.name);
      await checkThreadAccess(deps, auth, payload.threadId);
      return executeSwarm(
        deps,
        config,
        { input: payload.input, context: payload.context, threadId: payload.threadId },
        auth,
        signal,
        toSwarmRunResponse
      );
    }
  }
}

function send(socket: SocketLike, message: WebSocketServerMessage): void {
  if (socket.readyState !== OPEN) return;
  socket.send(JSON.stringify(message));
}
